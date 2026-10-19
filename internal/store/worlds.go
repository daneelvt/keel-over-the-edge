// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/daneelvt/keel-over-the-edge/internal/store/db"
)

// World is a world: its number, shown to players, and its epoch, when its
// tick 0 happened; when it began, and when it ends, each zero when not
// known.
type World struct {
	ID       [16]byte
	Number   int
	Epoch    time.Time
	BeginsAt time.Time
	EndsAt   time.Time
}

// The states a world's row may be in.
const (
	WorldNext    = "next"    // made ahead, not yet sailed
	WorldActive  = "active"  // sailed
	WorldEnded   = "ended"   // no longer sailed, its data kept
	WorldDropped = "dropped" // its data dropped, its row kept
)

func timeOf(t pgtype.Timestamptz) time.Time {
	if !t.Valid {
		return time.Time{}
	}
	return t.Time.UTC()
}

func stamp(t time.Time) pgtype.Timestamptz { return pgtype.Timestamptz{Time: t, Valid: true} }

// ActiveWorld is the world being sailed, or ErrNotFound.
func (s *Store) ActiveWorld(ctx context.Context) (World, error) {
	w, err := s.q.ActiveWorld(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return World{}, ErrNotFound
	}
	if err != nil {
		return World{}, err
	}
	return World{ID: w.ID.Bytes, Number: int(w.Number), Epoch: w.Epoch.UTC(), BeginsAt: timeOf(w.BeginsAt), EndsAt: timeOf(w.EndsAt)}, nil
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

// ErrNoNext is a next world asked for that is not there, or not next.
var ErrNoNext = errors.New("store: that world is not the next one")

// fenced runs fn in a transaction whose first statement reads the lease's
// epoch FOR SHARE, as the world's writes do: another epoch's is ErrFenced
// and nothing is written.
func (s *Store) fenced(ctx context.Context, lease int64, fn func(q *db.Queries) error) error {
	return s.inTx(ctx, func(q *db.Queries) error {
		e, err := q.LeaseEpochForShare(ctx)
		if err != nil {
			return err
		}
		if e != lease {
			return fmt.Errorf("%w: the epoch is %d, the writer's %d", ErrFenced, e, lease)
		}
		return fn(q)
	})
}

// SetWorldEnd sets when the active world ends, fenced by the lease's epoch.
func (s *Store) SetWorldEnd(ctx context.Context, lease int64, world [16]byte, end time.Time) error {
	return s.fenced(ctx, lease, func(q *db.Queries) error {
		n, err := q.SetWorldEnd(ctx, db.SetWorldEndParams{EndsAt: stamp(end), ID: pgtype.UUID{Bytes: world, Valid: true}})
		if err == nil && n == 0 {
			err = ErrNotActive
		}
		return err
	})
}

// NextWorld is the world made ahead of the active one's end: its row, and
// its terrain's bundle if stored.
type NextWorld struct {
	World
	Seed    uint64
	Created time.Time
	// Stored says its bundle is stored: when, of how many attempts, made
	// from which attempt's seed, and how long making it took.
	Stored       bool
	StoredAt     time.Time
	Attempts     int
	Made         uint64
	GenerationMs int
}

// NextWorld is the next world, or ErrNotFound.
func (s *Store) NextWorld(ctx context.Context) (NextWorld, error) {
	r, err := s.q.NextWorld(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return NextWorld{}, ErrNotFound
	}
	if err != nil {
		return NextWorld{}, err
	}
	return NextWorld{
		World: World{ID: r.ID.Bytes, Number: int(r.Number)},
		Seed:  uint64(r.Seed.Int64), Created: r.CreatedAt.UTC(),
		Stored: r.Stored, StoredAt: timeOf(r.StoredAt), Attempts: int(r.Attempts.Int32),
		Made: uint64(r.Made.Int64), GenerationMs: int(r.GenerationMs.Int32),
	}, nil
}

// CreateNextWorld makes the next world's row, numbered after every world
// there is, with the seed its terrain is made from and its partitions, in
// one transaction fenced by the lease's epoch. Its epoch is a placeholder
// until it begins. A next world already there is ErrNoNext.
func (s *Store) CreateNextWorld(ctx context.Context, lease int64, seed uint64, generator int, epoch time.Time) (World, error) {
	var w World
	err := s.fenced(ctx, lease, func(q *db.Queries) error {
		row, err := q.InsertNextWorld(ctx, db.InsertNextWorldParams{
			Epoch: epoch, Seed: pgtype.Int8{Int64: int64(seed), Valid: true}, Generator: pgtype.Int4{Int32: int32(generator), Valid: true},
		})
		if err != nil {
			return err
		}
		w = World{ID: row.ID.Bytes, Number: int(row.Number), Epoch: row.Epoch.UTC()}
		return q.CreateWorldPartitions(ctx, row.ID)
	})
	if uniqueViolation(err, "world_one_next") {
		return World{}, fmt.Errorf("%w: a next world is already there", ErrNoNext)
	}
	return w, err
}

// SwitchWorld ends the active world, whose number must be the number given,
// at begins, and makes the next world of the id given the active one, its
// epoch and beginning begins and its end ends: in one transaction fenced by
// the lease's epoch, so there is never a moment with two active worlds or
// none. A world that is not active, or another's number, is ErrNotActive;
// a next world that is not there, ErrNoNext; another epoch's write,
// ErrFenced.
func (s *Store) SwitchWorld(ctx context.Context, lease int64, number int, next [16]byte, begins, ends time.Time) (World, error) {
	var w World
	err := s.fenced(ctx, lease, func(q *db.Queries) error {
		n, err := q.EndActiveWorld(ctx, db.EndActiveWorldParams{EndsAt: stamp(begins), Number: int32(number)})
		if err != nil {
			return err
		}
		if n == 0 {
			return fmt.Errorf("%w: world %d", ErrNotActive, number)
		}
		row, err := q.ActivateNextWorld(ctx, db.ActivateNextWorldParams{
			BeginsAt: begins, EndsAt: stamp(ends), ID: pgtype.UUID{Bytes: next, Valid: true},
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNoNext
		}
		if err != nil {
			return err
		}
		w = World{ID: row.ID.Bytes, Number: int(row.Number), Epoch: row.Epoch.UTC(), BeginsAt: begins.UTC(), EndsAt: ends.UTC()}
		return nil
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
	if err != nil {
		return w, err
	}
	return s.ActiveWorld(ctx)
}

// DiscardNextWorld drops the next world of the number given, which no one
// has sailed: its partitions detached and dropped, then its row deleted,
// fenced by the lease's epoch, so its number is the next world's again.
func (s *Store) DiscardNextWorld(ctx context.Context, lease int64, number int) error {
	nw, err := s.NextWorld(ctx)
	if errors.Is(err, ErrNotFound) || err == nil && nw.Number != number {
		return fmt.Errorf("%w: world %d", ErrNoNext, number)
	}
	if err != nil {
		return err
	}
	if err := s.DropPartitions(ctx, number); err != nil {
		return err
	}
	return s.fenced(ctx, lease, func(q *db.Queries) error {
		n, err := q.DeleteNextWorld(ctx, pgtype.UUID{Bytes: nw.ID, Valid: true})
		if err == nil && n == 0 {
			err = ErrNoNext
		}
		return err
	})
}

// WorldsToDrop are the worlds that ended before the time given and whose
// data is still kept, the oldest first.
func (s *Store) WorldsToDrop(ctx context.Context, before time.Time) ([]World, error) {
	rows, err := s.q.WorldsToDrop(ctx, stamp(before))
	if err != nil {
		return nil, err
	}
	out := make([]World, len(rows))
	for i, r := range rows {
		out[i] = World{ID: r.ID.Bytes, Number: int(r.Number)}
	}
	return out, nil
}

// DropWorld drops an ended world's data: its partitions detached and
// dropped, then its row marked dropped, fenced by the lease's epoch.
func (s *Store) DropWorld(ctx context.Context, lease int64, w World) error {
	if err := s.DropPartitions(ctx, w.Number); err != nil {
		return err
	}
	return s.fenced(ctx, lease, func(q *db.Queries) error {
		_, err := q.MarkWorldDropped(ctx, pgtype.UUID{Bytes: w.ID, Valid: true})
		return err
	})
}

// RecentWorld is a world as the owner's page lists it.
type RecentWorld struct {
	Number           int
	State            string
	Seed             uint64
	HasSeed          bool
	BeginsAt, EndsAt time.Time
	Created          time.Time
}

// RecentWorlds are the newest worlds, of every state, the newest first.
func (s *Store) RecentWorlds(ctx context.Context, limit int) ([]RecentWorld, error) {
	rows, err := s.q.RecentWorlds(ctx, int32(limit))
	if err != nil {
		return nil, err
	}
	out := make([]RecentWorld, len(rows))
	for i, r := range rows {
		out[i] = RecentWorld{Number: int(r.Number), State: r.State, Seed: uint64(r.Seed.Int64), HasSeed: r.Seed.Valid,
			BeginsAt: timeOf(r.BeginsAt), EndsAt: timeOf(r.EndsAt), Created: r.CreatedAt.UTC()}
	}
	return out, nil
}

// LockTimeout bounds how long a step of dropping a world's partitions waits
// for a lock; one that times out is tried again at the next run.
const LockTimeout = 2 * time.Second

// partitionTable is a table of a world's data named for one world.
type partitionTable struct {
	parent, name      string
	pending, attached bool
	present           bool
	references        []string // the parents its parent references
}

// worldTables lists, for every table partitioned by world, the table named
// for the world's number: still a partition, detached but not finalized
// (an interrupted DETACH … CONCURRENTLY), detached, or gone; with the
// partitioned tables its parent references.
const worldTables = `
SELECT p.relname::text,
  coalesce(bool_or(i.inhdetachpending), false),
  count(i.inhrelid) > 0,
  EXISTS (SELECT 1 FROM pg_class c WHERE c.relname = p.relname || '_w' || $1::integer AND c.relnamespace = p.relnamespace),
  coalesce((SELECT array_agg(f.relname::text) FROM pg_constraint k JOIN pg_class f ON f.oid = k.confrelid
            WHERE k.conrelid = p.oid AND k.contype = 'f' AND f.relkind = 'p'), '{}')
FROM pg_partitioned_table pt
JOIN pg_class p ON p.oid = pt.partrelid
JOIN pg_attribute a ON a.attrelid = pt.partrelid AND a.attnum = pt.partattrs[0]
LEFT JOIN pg_inherits i ON i.inhparent = p.oid
  AND i.inhrelid = (SELECT c.oid FROM pg_class c WHERE c.relname = p.relname || '_w' || $1::integer AND c.relnamespace = p.relnamespace)
WHERE p.relnamespace = current_schema()::regnamespace
  AND NOT p.relispartition AND pt.partstrat = 'l' AND pt.partnatts = 1 AND a.attname = 'world_id'
GROUP BY p.oid, p.relname, p.relnamespace
ORDER BY p.relname`

// DropPartitions drops a world's partition of every table partitioned by
// world, one at a time, on a connection of its own with LockTimeout: each
// detached with DETACH PARTITION … CONCURRENTLY, which takes only a SHARE
// UPDATE EXCLUSIVE lock on the parent, so the writes to the other
// partitions go on, where a plain DROP TABLE of a partition would take an
// ACCESS EXCLUSIVE lock on the parent; then dropped, no longer a partition
// (PostgreSQL, ALTER TABLE: DETACH PARTITION … CONCURRENTLY). A detach
// that was interrupted is finished with FINALIZE first. A table whose
// parent another references by a foreign key goes after the referencing
// one's. Run again, it finishes what a failed run left.
func (s *Store) DropPartitions(ctx context.Context, number int) error {
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	rows, err := conn.Query(ctx, worldTables, number)
	if err != nil {
		return err
	}
	tables, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (partitionTable, error) {
		var t partitionTable
		err := r.Scan(&t.parent, &t.pending, &t.attached, &t.present, &t.references)
		t.name = fmt.Sprintf("%s_w%d", t.parent, number)
		return t, err
	})
	if err != nil {
		return err
	}
	if _, err := conn.Exec(ctx, fmt.Sprintf("SET lock_timeout = %d", LockTimeout.Milliseconds())); err != nil {
		return err
	}
	defer func() { _, _ = conn.Exec(context.Background(), "RESET lock_timeout") }()
	for _, t := range referencingFirst(tables) {
		parent, name := pgx.Identifier{t.parent}.Sanitize(), pgx.Identifier{t.name}.Sanitize()
		switch {
		case t.pending:
			if _, err := conn.Exec(ctx, "ALTER TABLE "+parent+" DETACH PARTITION "+name+" FINALIZE"); err != nil {
				return fmt.Errorf("finishing the detach of %s: %w", t.name, err)
			}
		case t.attached:
			if _, err := conn.Exec(ctx, "ALTER TABLE "+parent+" DETACH PARTITION "+name+" CONCURRENTLY"); err != nil {
				return fmt.Errorf("detaching %s: %w", t.name, err)
			}
		}
		if t.present {
			if _, err := conn.Exec(ctx, "DROP TABLE IF EXISTS "+name); err != nil {
				return fmt.Errorf("dropping %s: %w", t.name, err)
			}
		}
	}
	return nil
}

// referencingFirst orders tables so that a table whose parent references
// another's parent comes before it.
func referencingFirst(tables []partitionTable) []partitionTable {
	byParent := map[string]partitionTable{}
	for _, t := range tables {
		byParent[t.parent] = t
	}
	// referencedBy[b] are the parents that reference b.
	referencedBy := map[string][]string{}
	for _, t := range tables {
		for _, r := range t.references {
			if r != t.parent {
				referencedBy[r] = append(referencedBy[r], t.parent)
			}
		}
	}
	var out []partitionTable
	done := map[string]bool{}
	var visit func(p string)
	visit = func(p string) {
		if done[p] {
			return
		}
		done[p] = true
		refs := slices.Clone(referencedBy[p])
		slices.Sort(refs)
		for _, r := range refs {
			visit(r)
		}
		if t, ok := byParent[p]; ok {
			out = append(out, t)
		}
	}
	for _, t := range tables {
		visit(t.parent)
	}
	return out
}
