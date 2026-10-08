// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

// The migrations, numbered in sequence and applied in order by goose, each
// in a transaction. They only ever go up, and they only add: a build may run
// against a database migrated by a newer one, so nothing an older build
// reads is removed or renamed until no running build reads it. A migration
// once applied is never edited; migrations/SUMS holds each file's SHA-256,
// and a test fails when one changes or disappears.
//
//go:embed migrations/*.sql
var embedded embed.FS

// Migrations is the migrations' files.
func Migrations() fs.FS {
	sub, err := fs.Sub(embedded, "migrations")
	if err != nil {
		panic(err) // the directory is embedded
	}
	return sub
}

// Latest is the newest migration this build has: the schema it needs.
var Latest = latest()

func latest() int64 {
	names, err := fs.Glob(Migrations(), "*.sql")
	if err != nil || len(names) == 0 {
		panic("store: no migrations embedded")
	}
	var v int64
	for _, name := range names {
		n, err := strconv.ParseInt(strings.SplitN(name, "_", 2)[0], 10, 64)
		if err != nil {
			panic("store: a migration's name does not start with its number: " + name)
		}
		v = max(v, n)
	}
	return v
}

// versionTable is goose's table of applied migrations.
const versionTable = "goose_db_version"

// lockID is the advisory lock that keeps two runs of the migrations from
// interleaving: goose's own, so another goose against the same database
// waits too.
const lockID = lock.DefaultLockID

// provider opens the migrations on the database at url. Close the provider
// when done; it closes its connections.
func provider(url string) (*goose.Provider, error) {
	cc, err := pgx.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrConfig, err)
	}
	cc.RuntimeParams["application_name"] = "keel migrate"
	sqlDB := stdlib.OpenDB(*cc)
	// A session-level advisory lock, held on one connection for the whole
	// run: a second run waits for the first, checking every second for up
	// to five minutes.
	locker, err := lock.NewPostgresSessionLocker(lock.WithLockID(lockID), lock.WithLockTimeout(1, 300))
	if err != nil {
		sqlDB.Close()
		return nil, err
	}
	p, err := goose.NewProvider(goose.DialectPostgres, sqlDB, Migrations(),
		goose.WithSessionLocker(locker), goose.WithTableName(versionTable))
	if err != nil {
		sqlDB.Close()
		return nil, err
	}
	return p, nil
}

// Applied is a migration a run applied.
type Applied struct {
	Version  int64
	Name     string
	Duration time.Duration
}

// Migrate applies the migrations the database at url has not had, in order,
// up to and including version to (every one when to is 0). It is a no-op on
// a database already there.
func Migrate(ctx context.Context, url string, to int64) ([]Applied, error) {
	p, err := provider(url)
	if err != nil {
		return nil, err
	}
	defer p.Close()
	var res []*goose.MigrationResult
	if to == 0 {
		res, err = p.Up(ctx)
	} else {
		res, err = p.UpTo(ctx, to)
	}
	var out []Applied
	for _, r := range res {
		if r.Error == nil {
			out = append(out, Applied{Version: r.Source.Version, Name: baseName(r.Source.Path), Duration: r.Duration})
		}
	}
	return out, err
}

// MigrationState is whether a migration has been applied.
type MigrationState struct {
	Version   int64
	Name      string
	Applied   bool
	AppliedAt time.Time
}

// Status lists this build's migrations and whether the database at url has
// each one.
func Status(ctx context.Context, url string) ([]MigrationState, error) {
	p, err := provider(url)
	if err != nil {
		return nil, err
	}
	defer p.Close()
	st, err := p.Status(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]MigrationState, len(st))
	for i, s := range st {
		out[i] = MigrationState{
			Version: s.Source.Version, Name: baseName(s.Source.Path),
			Applied: s.State == goose.StateApplied, AppliedAt: s.AppliedAt,
		}
	}
	return out, nil
}

func baseName(p string) string {
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		return p[i+1:]
	}
	return p
}

// ErrSchemaBehind is a database without every migration this build needs.
var ErrSchemaBehind = errors.New("the database is behind this build: run keel migrate")

// SchemaVersion is the newest migration the database has had, 0 if none.
// It reads the table goose keeps, as goose does, and writes nothing.
func (s *Store) SchemaVersion(ctx context.Context) (int64, error) {
	var exists bool
	if err := s.pool.QueryRow(ctx, "SELECT to_regclass($1) IS NOT NULL", versionTable).Scan(&exists); err != nil {
		return 0, err
	}
	if !exists {
		return 0, nil
	}
	var v *int64
	if err := s.pool.QueryRow(ctx, "SELECT max(version_id) FROM "+versionTable).Scan(&v); err != nil {
		return 0, err
	}
	if v == nil {
		return 0, nil
	}
	return *v, nil
}

// CheckSchema returns the database's schema version, or ErrSchemaBehind if
// it lacks a migration this build has. A database ahead of the build is
// accepted: migrations only add, so an older build still finds what it
// reads.
func (s *Store) CheckSchema(ctx context.Context) (int64, error) {
	v, err := s.SchemaVersion(ctx)
	if err != nil {
		return 0, err
	}
	if v < Latest {
		return v, fmt.Errorf("%w (it is at migration %d, this build needs %d)", ErrSchemaBehind, v, Latest)
	}
	return v, nil
}
