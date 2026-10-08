// SPDX-License-Identifier: AGPL-3.0-only

// Package storetest gives each test a database of its own: empty, or
// migrated, on the PostgreSQL server named by KEEL_TEST_DATABASE_URL, or else
// by .dev/db.env, which go run ./tools/dev -db writes. Without either, a test
// that needs a database is skipped, unless CI is set, where it fails: CI
// never passes by skipping.
//
// A migrated database is a copy of a template migrated once (CREATE
// DATABASE … TEMPLATE), so it costs one copy, not every migration. The
// template is named by a hash of the migrations, made by whichever test
// process gets there first under an advisory lock, and made again only when
// a migration changes. Each test's database is dropped when the test ends.
//
// Tests that use a database cannot run in synctest bubbles: waiting on a
// socket does not block a bubble durably.
package storetest

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// ServerURL is the test server's URL, the maintenance database on it, or ""
// when none is configured.
func ServerURL() string {
	if u := os.Getenv("KEEL_TEST_DATABASE_URL"); u != "" {
		return u
	}
	root, err := moduleRoot()
	if err != nil {
		return ""
	}
	f, err := os.Open(filepath.Join(root, ".dev", "db.env"))
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if v, ok := strings.CutPrefix(strings.TrimSpace(sc.Text()), "KEEL_TEST_DATABASE_URL="); ok {
			return v
		}
	}
	return ""
}

// moduleRoot is the nearest directory above this one with a go.mod.
func moduleRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("storetest: no go.mod above the working directory")
		}
		dir = parent
	}
}

// server returns the test server's URL, or skips or fails the test.
func server(t testing.TB) string {
	t.Helper()
	u := ServerURL()
	if u == "" {
		const why = "no test database: run go run ./tools/dev -db, or set KEEL_TEST_DATABASE_URL"
		if os.Getenv("CI") != "" {
			t.Fatal(why)
		}
		t.Skip(why)
	}
	return u
}

// WithDatabase is srv with its database changed to name: a postgres:// URL's
// path, or a key=value string's dbname, a later one of which wins.
func WithDatabase(srv, name string) (string, error) {
	if _, err := pgx.ParseConfig(srv); err != nil {
		return "", err
	}
	if !strings.HasPrefix(srv, "postgres://") && !strings.HasPrefix(srv, "postgresql://") {
		return srv + " dbname=" + name, nil
	}
	u, err := url.Parse(srv)
	if err != nil {
		return "", err
	}
	u.Path = "/" + name
	return u.String(), nil
}

// Empty makes an empty database for the test and returns its URL.
func Empty(t testing.TB) string {
	t.Helper()
	return create(t, "")
}

// URL makes a migrated database for the test and returns its URL.
func URL(t testing.TB) string {
	t.Helper()
	srv := server(t)
	tmpl, err := Template(context.Background(), srv)
	if err != nil {
		t.Fatal(err)
	}
	return create(t, tmpl)
}

// Pool opens a pool on a migrated database for the test.
func Pool(t testing.TB) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// Store opens a store on a migrated database for the test.
func Store(t testing.TB, opt store.Options) (*store.Store, string) {
	t.Helper()
	u := URL(t)
	s, err := store.Open(context.Background(), u, opt)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s, u
}

func create(t testing.TB, template string) string {
	t.Helper()
	srv := server(t)
	name := "keel_test_" + strings.ToLower(rand.Text()[:16])
	ctx := context.Background()
	if err := CreateDatabase(ctx, srv, name, template); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := DropDatabase(context.Background(), srv, name); err != nil {
			t.Errorf("dropping the test's database: %v", err)
		}
	})
	u, err := WithDatabase(srv, name)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// CreateDatabase makes a database on the server at srv, a copy of template
// when it is not "".
func CreateDatabase(ctx context.Context, srv, name, template string) error {
	conn, err := pgx.Connect(ctx, srv)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	q := "CREATE DATABASE " + pgx.Identifier{name}.Sanitize()
	if template != "" {
		q += " TEMPLATE " + pgx.Identifier{template}.Sanitize()
	}
	// A template being copied by another process at the same moment is
	// reported as in use; it is free again in moments.
	for range 50 {
		_, err = conn.Exec(ctx, q)
		if err == nil || !strings.Contains(err.Error(), "is being accessed by other users") {
			return err
		}
		time.Sleep(100 * time.Millisecond)
	}
	return err
}

// DropDatabase drops a database, closing any connections to it.
func DropDatabase(ctx context.Context, srv, name string) error {
	conn, err := pgx.Connect(ctx, srv)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, "DROP DATABASE IF EXISTS "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)")
	return err
}

// templateLock is the advisory lock held while a template is made, so two
// test processes do not both make it.
const templateLock = 7_461_293_008_117_340_211

// Template returns the name of the migrated template for this build's
// migrations on the server at srv, making it if it is not there.
func Template(ctx context.Context, srv string) (string, error) {
	sum, err := migrationsHash()
	if err != nil {
		return "", err
	}
	name := "keel_tmpl_" + sum
	conn, err := pgx.Connect(ctx, srv)
	if err != nil {
		return "", fmt.Errorf("storetest: the test database: %w", err)
	}
	defer conn.Close(ctx)
	exists := func() (bool, error) {
		var ok bool
		err := conn.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)", name).Scan(&ok)
		return ok, err
	}
	if ok, err := exists(); err != nil || ok {
		return name, err
	}
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", int64(templateLock)); err != nil {
		return "", err
	}
	defer conn.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", int64(templateLock))
	if ok, err := exists(); err != nil || ok {
		return name, err
	}
	// Made under another name and renamed when whole, so a run cut short
	// never leaves a half-migrated template behind.
	building := name + "_new"
	if err := DropDatabase(ctx, srv, building); err != nil {
		return "", err
	}
	if err := CreateDatabase(ctx, srv, building, ""); err != nil {
		return "", err
	}
	u, err := WithDatabase(srv, building)
	if err != nil {
		return "", err
	}
	if _, err := store.Migrate(ctx, u, 0); err != nil {
		return "", fmt.Errorf("storetest: migrating the template: %w", err)
	}
	if _, err := conn.Exec(ctx, "ALTER DATABASE "+pgx.Identifier{building}.Sanitize()+" RENAME TO "+pgx.Identifier{name}.Sanitize()); err != nil {
		return "", err
	}
	return name, nil
}

// migrationsHash is the first 16 hex digits of a SHA-256 over every
// migration's name and contents.
func migrationsHash() (string, error) {
	h := sha256.New()
	err := fs.WalkDir(store.Migrations(), ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := fs.ReadFile(store.Migrations(), p)
		if err != nil {
			return err
		}
		fmt.Fprintf(h, "%s\x00%d\x00", p, len(data))
		h.Write(data)
		return nil
	})
	return hex.EncodeToString(h.Sum(nil))[:16], err
}
