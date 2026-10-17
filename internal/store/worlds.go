// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/daneelvt/keel-over-the-edge/internal/store/db"
)

// World is a world: its number, shown to players, and its epoch, when its
// tick 0 happened.
type World struct {
	ID     [16]byte
	Number int
	Epoch  time.Time
}

// ActiveWorld is the world being sailed, or ErrNotFound.
func (s *Store) ActiveWorld(ctx context.Context) (World, error) {
	w, err := s.q.ActiveWorld(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return World{}, ErrNotFound
	}
	if err != nil {
		return World{}, err
	}
	return World{ID: w.ID.Bytes, Number: int(w.Number), Epoch: w.Epoch.UTC()}, nil
}

// CreateWorld makes the next world, active from now with the epoch given,
// and in the same transaction its partition of every table partitioned by
// world. It fails if another world is active.
func (s *Store) CreateWorld(ctx context.Context, epoch time.Time) (World, error) {
	var w World
	err := s.inTx(ctx, func(q *db.Queries) error {
		row, err := q.InsertWorld(ctx, epoch)
		if err != nil {
			return err
		}
		w = World{ID: row.ID.Bytes, Number: int(row.Number), Epoch: row.Epoch.UTC()}
		return q.CreateWorldPartitions(ctx, row.ID)
	})
	return w, err
}

// ErrNotActive is a world asked to end that is not the active one.
var ErrNotActive = errors.New("store: that world is not the active one")

// BeginWorld ends the active world, whose number must be the number given,
// and makes the next, active from now with the epoch given, with its
// partitions: in one transaction fenced by the lease's epoch, as the
// world's writes are. A world that is not active, or another's number, is
// ErrNotActive; another epoch's write, ErrFenced. The ended world's data
// stays, in its partitions.
func (s *Store) BeginWorld(ctx context.Context, lease int64, number int, epoch time.Time) (World, error) {
	var w World
	err := s.inTx(ctx, func(q *db.Queries) error {
		e, err := q.LeaseEpochForShare(ctx)
		if err != nil {
			return err
		}
		if e != lease {
			return fmt.Errorf("%w: the epoch is %d, the writer's %d", ErrFenced, e, lease)
		}
		n, err := q.EndWorld(ctx, int32(number))
		if err != nil {
			return err
		}
		if n == 0 {
			return fmt.Errorf("%w: world %d", ErrNotActive, number)
		}
		row, err := q.InsertWorld(ctx, epoch)
		if err != nil {
			return err
		}
		w = World{ID: row.ID.Bytes, Number: int(row.Number), Epoch: row.Epoch.UTC()}
		return q.CreateWorldPartitions(ctx, row.ID)
	})
	return w, err
}

// ActiveOrFirstWorld is the active world, or a new one with the epoch given
// when there is none. Two servers starting at once both get the one world.
func (s *Store) ActiveOrFirstWorld(ctx context.Context, epoch time.Time) (World, error) {
	w, err := s.ActiveWorld(ctx)
	if !errors.Is(err, ErrNotFound) {
		return w, err
	}
	w, err = s.CreateWorld(ctx, epoch)
	if uniqueViolation(err, "world_one_active") || uniqueViolation(err, "world_number_key") {
		return s.ActiveWorld(ctx)
	}
	return w, err
}
