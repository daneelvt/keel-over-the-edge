// SPDX-License-Identifier: AGPL-3.0-only

package store_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// The schema's rules, tested in the database: no code path can get round
// them.

func exec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) error {
	t.Helper()
	_, err := pool.Exec(context.Background(), sql, args...)
	return err
}

func must(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if err := exec(t, pool, sql, args...); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
}

func uuidOf(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) [16]byte {
	t.Helper()
	var id [16]byte
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&id); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return id
}

func refused(t *testing.T, err error, code string) {
	t.Helper()
	var pg *pgconn.PgError
	if !errors.As(err, &pg) || (code != "" && pg.Code != code) {
		t.Fatalf("not refused with %s: %v", code, err)
	}
}

const integrity = "23000" // integrity_constraint_violation, which the trigger raises

func TestAccountKindAndOwner(t *testing.T) {
	pool := storetest.Pool(t)
	guest := uuidOf(t, pool, "INSERT INTO account (kind) VALUES ('human') RETURNING id")
	saved := uuidOf(t, pool, "INSERT INTO account (kind, saved_at) VALUES ('human', now()) RETURNING id")
	other := uuidOf(t, pool, "INSERT INTO account (kind, saved_at) VALUES ('human', now()) RETURNING id")
	ai := uuidOf(t, pool, "INSERT INTO account (kind, owner_id) VALUES ('ai', $1) RETURNING id", saved)

	// A kind never changes, by any update.
	refused(t, exec(t, pool, "UPDATE account SET kind = 'ai', owner_id = $2 WHERE id = $1", guest, saved), integrity)
	refused(t, exec(t, pool, "UPDATE account SET kind = 'ai' WHERE id = $1", guest), "")
	refused(t, exec(t, pool, "UPDATE account SET kind = 'human', owner_id = NULL WHERE id = $1", ai), integrity)
	refused(t, exec(t, pool, "UPDATE account SET kind = 'human' WHERE true"), "")
	// An owner never changes, even to another saved human.
	refused(t, exec(t, pool, "UPDATE account SET owner_id = $2 WHERE id = $1", ai, other), integrity)
	refused(t, exec(t, pool, "UPDATE account SET owner_id = NULL WHERE id = $1", ai), "")
	// Other columns change freely.
	must(t, pool, "UPDATE account SET last_seen_at = now(), saved_at = now() WHERE id = $1", guest)

	// An AI account has an owner, a human has none.
	refused(t, exec(t, pool, "INSERT INTO account (kind) VALUES ('ai')"), "23514")
	refused(t, exec(t, pool, "INSERT INTO account (kind, owner_id) VALUES ('human', $1)", saved), "23514")
	refused(t, exec(t, pool, "INSERT INTO account (kind) VALUES ('robot')"), "23514")
	// The owner is a saved human: not a guest, not an AI account.
	guest2 := uuidOf(t, pool, "INSERT INTO account (kind) VALUES ('human') RETURNING id")
	refused(t, exec(t, pool, "INSERT INTO account (kind, owner_id) VALUES ('ai', $1)", guest2), integrity)
	refused(t, exec(t, pool, "INSERT INTO account (kind, owner_id) VALUES ('ai', $1)", ai), integrity)

	// An owner with AI accounts cannot be deleted.
	refused(t, exec(t, pool, "DELETE FROM account WHERE id = $1", saved), "23001") // restrict_violation
}

func TestDeletingAnAccountFreesItsName(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	pool, err := pgxpool.New(ctx, u)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	g := store.Guest{Name: "Sea Wolf", NameKey: "seawolf", Look: "a", TokenHash: sha256.Sum256([]byte("one"))}
	id, err := s.CreateGuest(ctx, g)
	if err != nil {
		t.Fatal(err)
	}
	g.TokenHash = sha256.Sum256([]byte("two"))
	if _, err := s.CreateGuest(ctx, g); !errors.Is(err, store.ErrNameTaken) {
		t.Fatalf("the name again: %v", err)
	}
	must(t, pool, "DELETE FROM account WHERE id = $1", id)
	for _, table := range []string{"sailor", "session"} {
		var n int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n); err != nil || n != 0 {
			t.Fatalf("%s: %d rows left, %v", table, n, err)
		}
	}
	if _, err := s.CreateGuest(ctx, g); err != nil {
		t.Fatalf("the name once freed: %v", err)
	}
}

func TestKeysAreUUIDv7(t *testing.T) {
	pool := storetest.Pool(t)
	ctx := context.Background()
	var tables []string
	rows, err := pool.Query(ctx, `
		SELECT c.table_name FROM information_schema.columns c
		JOIN information_schema.tables t USING (table_schema, table_name)
		WHERE c.table_schema = current_schema() AND c.column_name = 'id' AND t.table_type = 'BASE TABLE'
		  AND c.table_name <> 'goose_db_version'`)
	if err != nil {
		t.Fatal(err)
	}
	tables, err = pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	if len(tables) < 3 {
		t.Fatalf("tables with an id: %v", tables)
	}
	for _, table := range tables {
		var def, typ string
		if err := pool.QueryRow(ctx, `SELECT column_default, data_type FROM information_schema.columns
			WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'id'`, table).Scan(&def, &typ); err != nil {
			t.Fatal(err)
		}
		if typ != "uuid" || def != "uuidv7()" {
			t.Errorf("%s.id is %s DEFAULT %s, want uuid DEFAULT uuidv7()", table, typ, def)
		}
	}
	id := uuidOf(t, pool, "INSERT INTO account (kind) VALUES ('human') RETURNING id")
	if id[6]>>4 != 7 || id[8]>>6 != 2 {
		t.Fatalf("%x is not a version 7 UUID", id)
	}
}

func TestOneActiveWorld(t *testing.T) {
	ctx := context.Background()
	s, _ := storetest.Store(t, store.Options{})
	epoch := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if _, err := s.ActiveWorld(ctx); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a world before any was made: %v", err)
	}
	w, err := s.ActiveOrFirstWorld(ctx, epoch)
	if err != nil {
		t.Fatal(err)
	}
	if w.Number != 1 || !w.Epoch.Equal(epoch) {
		t.Fatalf("the first world: %+v", w)
	}
	again, err := s.ActiveOrFirstWorld(ctx, epoch.Add(time.Hour))
	if err != nil || again != w {
		t.Fatalf("again: %+v, %v", again, err)
	}
	if _, err := s.CreateWorld(ctx, epoch); err == nil || !strings.Contains(err.Error(), "world_one_active") {
		t.Fatalf("a second active world: %v", err)
	}
}

// TestWorldTablesPartitioned checks every table with a world_id column is
// partitioned by list on it, and that CreateWorld makes each one's
// partition: shown on a scratch table, as no world table exists yet beside
// world itself.
func TestWorldTablesPartitioned(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	pool, err := pgxpool.New(ctx, u)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	checkPartitioned(t, pool)

	must(t, pool, `CREATE TABLE scratch (world_id uuid NOT NULL REFERENCES world (id), x integer) PARTITION BY LIST (world_id)`)
	// A table partitioned on something else is left alone.
	must(t, pool, `CREATE TABLE other_scratch (k integer) PARTITION BY LIST (k)`)
	checkPartitioned(t, pool)
	w, err := s.CreateWorld(ctx, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	var parts []string
	rows, err := pool.Query(ctx, `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
		WHERE i.inhparent IN ('scratch'::regclass, 'other_scratch'::regclass) ORDER BY 1`)
	if err != nil {
		t.Fatal(err)
	}
	if parts, err = pgx.CollectRows(rows, pgx.RowTo[string]); err != nil {
		t.Fatal(err)
	}
	if len(parts) != 1 || parts[0] != "scratch_w1" {
		t.Fatalf("partitions %v", parts)
	}
	must(t, pool, "INSERT INTO scratch (world_id, x) VALUES ($1, 1)", w.ID)

	// A world without its partitions: its rows are refused.
	must(t, pool, "UPDATE world SET state = 'ended'")
	bare := uuidOf(t, pool, "INSERT INTO world (number, epoch, state) VALUES (2, now(), 'active') RETURNING id")
	refused(t, exec(t, pool, "INSERT INTO scratch (world_id, x) VALUES ($1, 1)", bare), "23514")
	// Making them again is harmless, and fills the gap.
	must(t, pool, "SELECT create_world_partitions(id) FROM world")
	must(t, pool, "INSERT INTO scratch (world_id, x) VALUES ($1, 1)", bare)
	checkPartitioned(t, pool)
}

func checkPartitioned(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	rows, err := pool.Query(context.Background(), `
		SELECT c.relname,
		       coalesce((SELECT p.partstrat = 'l' AND p.partnatts = 1 AND a.attname = 'world_id'
		                 FROM pg_partitioned_table p
		                 JOIN pg_attribute a ON a.attrelid = p.partrelid AND a.attnum = p.partattrs[0]
		                 WHERE p.partrelid = c.oid), false)
		FROM pg_class c JOIN pg_attribute col ON col.attrelid = c.oid
		WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'p')
		  AND NOT c.relispartition AND col.attname = 'world_id' AND NOT col.attisdropped`)
	if err != nil {
		t.Fatal(err)
	}
	type table struct {
		Name        string
		Partitioned bool
	}
	tables, err := pgx.CollectRows(rows, pgx.RowToStructByPos[table])
	if err != nil {
		t.Fatal(err)
	}
	for _, tb := range tables {
		if !tb.Partitioned {
			t.Errorf("%s has a world_id but is not PARTITION BY LIST (world_id)", tb.Name)
		}
	}
}

// TestPersistenceTables: the checkpoint and event tables are partitioned by
// world, and every world has their partitions: one made before the
// migration that adds them gets them from it, one made after from
// CreateWorld. The lease is one row, always; an event is of a known kind.
func TestPersistenceTables(t *testing.T) {
	ctx := context.Background()
	u := storetest.Empty(t)
	if _, err := store.Migrate(ctx, u, 2); err != nil {
		t.Fatal(err)
	}
	s, err := store.Open(ctx, u, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	before, err := s.ActiveOrFirstWorld(ctx, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Migrate(ctx, u, 0); err != nil {
		t.Fatal(err)
	}
	pool := storetest.PoolOn(t, u)
	checkPartitioned(t, pool)
	must(t, pool, "UPDATE world SET state = 'ended'")
	after, err := s.CreateWorld(ctx, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	rows, err := pool.Query(ctx, `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
		WHERE i.inhparent IN ('checkpoint'::regclass, 'event'::regclass) ORDER BY 1`)
	if err != nil {
		t.Fatal(err)
	}
	parts, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(parts, " ") != "checkpoint_w1 checkpoint_w2 event_w1 event_w2" {
		t.Fatalf("partitions %v", parts)
	}
	for _, w := range [][16]byte{before.ID, after.ID} {
		must(t, pool, "INSERT INTO event (world_id, tick, kind, account_id, boat) VALUES ($1, 1, 'launched', $2, 1)", w, [16]byte{1})
		must(t, pool, `INSERT INTO checkpoint (world_id, tick, format, build, catalog, layout, epoch, boats, data)
			VALUES ($1, 1, 4, 'dev', 'c', 1, 1, 0, '\x00')`, w)
	}
	// One checkpoint a world.
	refused(t, exec(t, pool, `INSERT INTO checkpoint (world_id, tick, format, build, catalog, layout, epoch, boats, data)
		VALUES ($1, 2, 4, 'dev', 'c', 1, 1, 0, '\x00')`, after.ID), "23505")
	refused(t, exec(t, pool, "INSERT INTO event (world_id, tick, kind, account_id, boat) VALUES ($1, 1, 'sank', $2, 1)", after.ID, [16]byte{1}), "23514")

	var n int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM sim_lease").Scan(&n); err != nil || n != 1 {
		t.Fatalf("sim_lease has %d rows (%v)", n, err)
	}
	refused(t, exec(t, pool, "INSERT INTO sim_lease (epoch, holder) VALUES (0, 'another')"), "23505")
	refused(t, exec(t, pool, "INSERT INTO sim_lease (singleton, epoch, holder) VALUES (false, 0, 'another')"), "23514")
	refused(t, exec(t, pool, "UPDATE sim_lease SET epoch = -1"), "23514")
}
