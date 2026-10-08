// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"errors"
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
