// SPDX-License-Identifier: AGPL-3.0-only

package store_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// TestTables: the tables read from the migrations are those a migrated
// database holds, partitions and goose's own table aside.
func TestTables(t *testing.T) {
	pool := storetest.Pool(t)
	rows, err := pool.Query(context.Background(), `
		SELECT c.relname FROM pg_class c
		WHERE c.relnamespace = current_schema()::regnamespace
		  AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND c.relname <> 'goose_db_version'
		ORDER BY c.relname`)
	if err != nil {
		t.Fatal(err)
	}
	have, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	if got := store.Tables(); !slices.Equal(got, have) {
		t.Fatalf("Tables() %v, the database's %v", got, have)
	}
}

// TestReadRestored reads a migrated database, then one with a table gone.
func TestReadRestored(t *testing.T) {
	ctx := context.Background()
	u := storetest.URL(t)
	conn, err := pgx.Connect(ctx, u)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	r, err := store.ReadRestored(ctx, store.RestoredDB{URL: u})
	if err != nil {
		t.Fatal(err)
	}
	if r.Version != store.Latest || len(r.Missing) != 0 || len(r.Rows) != len(store.Tables()) || r.Rows["sim_lease"] != 1 {
		t.Fatalf("a migrated database: %+v", r)
	}
	if !r.Checkpoint.IsZero() || !r.Event.IsZero() {
		t.Fatalf("an empty world's newest checkpoint %v and event %v", r.Checkpoint, r.Event)
	}
	if _, err := conn.Exec(ctx, `
		INSERT INTO world (number, epoch, state) VALUES (1, now(), 'active');
		SELECT create_world_partitions(id) FROM world;
		INSERT INTO checkpoint (world_id, tick, format, build, catalog, layout, epoch, boats, data, written_at)
		  SELECT id, 1, 1, 'b', 'c', 1, 1, 0, '', now() - interval '2 hours' FROM world;
		INSERT INTO event (world_id, tick, kind, account_id, boat, written_at)
		  SELECT id, 1, 'launched', uuidv7(), 1, now() - interval '3 days' FROM world;
		DROP TABLE session`); err != nil {
		t.Fatal(err)
	}
	r, err = store.ReadRestored(ctx, store.RestoredDB{URL: u})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(r.Missing, []string{"session"}) || r.Rows["world"] != 1 || r.Rows["checkpoint"] != 1 || r.Rows["event"] != 1 {
		t.Fatalf("missing %v, rows %v", r.Missing, r.Rows)
	}
	if age := time.Since(r.Checkpoint); age < 2*time.Hour || age > 3*time.Hour {
		t.Errorf("the checkpoint's age %v", age)
	}
	if age := time.Since(r.Event); age < 72*time.Hour || age > 73*time.Hour {
		t.Errorf("the event's age %v", age)
	}
}
