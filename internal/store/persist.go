// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/daneelvt/keel-over-the-edge/internal/store/db"
)

// PersistConns is the size of the pool that writes the world: with the
// main pool's MaxConns and the lease's one connection, the server's 20.
const PersistConns = 2

// WriteLimit bounds a batch's transaction.
const WriteLimit = 5 * time.Second

// The kinds of event the simulation records.
const (
	EventLaunched = "launched" // a boat joined the world
	EventReturned = "returned" // it left
	EventExpired  = "expired"  // its grace ended
)

// Event is something the simulation decided that lasts.
type Event struct {
	Tick    int64
	Kind    string // EventLaunched, EventReturned or EventExpired
	Account [16]byte
	Boat    uint64
}

// Checkpoint is a world's whole state at a tick: the simulation's
// snapshot, of the format given, and what it needs to be read again.
type Checkpoint struct {
	Tick      int64
	Format    int    // the snapshot's format
	Build     string // the build that wrote it
	Catalog   string
	Layout    uint32 // the physics layout
	Epoch     int64  // the lease's, when written
	Boats     int
	Data      []byte
	WrittenAt time.Time
}

// Batch is what a fenced transaction writes: events in order, then the
// checkpoint, if any.
type Batch struct {
	World      [16]byte
	Epoch      int64 // the writer's lease epoch
	Events     []Event
	Checkpoint *Checkpoint
}

// ErrFenced is a batch refused because the lease's epoch is no longer the
// writer's: another process has taken the world.
var ErrFenced = errors.New("store: fenced: another simulation holds the lease")

// Persister writes the world through a pool of its own, so the API's
// requests never wait behind the simulation's writes, nor these behind
// them.
type Persister struct {
	pool *pgxpool.Pool
	q    *db.Queries
}

// OpenPersister opens the world's writer on the database at url, waiting
// for it as Open does.
func OpenPersister(ctx context.Context, url string, opt Options) (*Persister, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrConfig, err)
	}
	cfg.MaxConns = PersistConns
	cfg.MinConns = 1
	cfg.ConnConfig.RuntimeParams["application_name"] = "keel persist"
	if opt.QueryDuration != nil || opt.QueryErrors != nil {
		cfg.ConnConfig.Tracer = newTracer(opt.QueryDuration, opt.QueryErrors)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := waitUp(ctx, pool, cfg.ConnConfig, opt); err != nil {
		pool.Close()
		return nil, err
	}
	return &Persister{pool: pool, q: db.New(pool)}, nil
}

// Close closes the pool.
func (p *Persister) Close() { p.pool.Close() }

// Write writes a batch in one transaction, fenced: its first statement
// reads the lease's epoch FOR SHARE, which a new holder's raise waits for,
// and if the epoch is not the batch's, nothing is written and the error is
// ErrFenced. It takes at most WriteLimit.
func (p *Persister) Write(ctx context.Context, b Batch) error {
	ctx, cancel := context.WithTimeout(ctx, WriteLimit)
	defer cancel()
	world := pgtype.UUID{Bytes: b.World, Valid: true}
	return pgx.BeginFunc(ctx, p.pool, func(tx pgx.Tx) error {
		q := p.q.WithTx(tx)
		epoch, err := q.LeaseEpochForShare(ctx)
		if err != nil {
			return err
		}
		if epoch != b.Epoch {
			return fmt.Errorf("%w: the epoch is %d, the writer's %d", ErrFenced, epoch, b.Epoch)
		}
		if len(b.Events) > 0 {
			rows := make([]db.InsertEventsParams, len(b.Events))
			for i, e := range b.Events {
				rows[i] = db.InsertEventsParams{
					WorldID: world, Tick: e.Tick, Kind: e.Kind,
					AccountID: pgtype.UUID{Bytes: e.Account, Valid: true}, Boat: int64(e.Boat),
				}
			}
			if _, err := q.InsertEvents(ctx, rows); err != nil {
				return err
			}
		}
		if c := b.Checkpoint; c != nil {
			err := q.UpsertCheckpoint(ctx, db.UpsertCheckpointParams{
				WorldID: world, Tick: c.Tick, Format: int16(c.Format), Build: c.Build, Catalog: c.Catalog,
				Layout: int32(c.Layout), Epoch: b.Epoch, Boats: int32(c.Boats), Data: c.Data,
			})
			if err != nil {
				return err
			}
		}
		return nil
	})
}

// LatestCheckpoint is the world's checkpoint, or ErrNotFound.
func (s *Store) LatestCheckpoint(ctx context.Context, world [16]byte) (Checkpoint, error) {
	row, err := s.q.LatestCheckpoint(ctx, pgtype.UUID{Bytes: world, Valid: true})
	if errors.Is(err, pgx.ErrNoRows) {
		return Checkpoint{}, ErrNotFound
	}
	if err != nil {
		return Checkpoint{}, err
	}
	return Checkpoint{
		Tick: row.Tick, Format: int(row.Format), Build: row.Build, Catalog: row.Catalog, Layout: uint32(row.Layout),
		Epoch: row.Epoch, Boats: int(row.Boats), Data: row.Data, WrittenAt: row.WrittenAt.UTC(),
	}, nil
}

// Lease reads the lease's row.
func (s *Store) Lease(ctx context.Context) (LeaseState, error) {
	row, err := s.q.LeaseHolder(ctx)
	if err != nil {
		return LeaseState{}, err
	}
	return LeaseState{Epoch: row.Epoch, Holder: row.Holder, Since: row.Since.Time}, nil
}
