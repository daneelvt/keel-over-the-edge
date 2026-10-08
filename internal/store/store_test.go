// SPDX-License-Identifier: AGPL-3.0-only

package store_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

func TestMigrate(t *testing.T) {
	ctx := context.Background()
	u := storetest.Empty(t)
	applied, err := store.Migrate(ctx, u, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != int(store.Latest) || applied[0].Name != "00001_players.sql" {
		t.Fatalf("applied %+v", applied)
	}
	// Again, a no-op.
	applied, err = store.Migrate(ctx, u, 0)
	if err != nil || len(applied) != 0 {
		t.Fatalf("again: %+v, %v", applied, err)
	}
	st, err := store.Status(ctx, u)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range st {
		if !m.Applied || m.AppliedAt.IsZero() {
			t.Errorf("not applied: %+v", m)
		}
	}
}

// TestMigrateTwiceAtOnce runs two migrations against one database at once:
// one waits for the other's lock, and both succeed.
func TestMigrateTwiceAtOnce(t *testing.T) {
	u := storetest.Empty(t)
	var wg sync.WaitGroup
	var total atomic.Int64
	errs := make([]error, 2)
	for i := range 2 {
		wg.Go(func() {
			applied, err := store.Migrate(context.Background(), u, 0)
			errs[i] = err
			total.Add(int64(len(applied)))
		})
	}
	wg.Wait()
	if err := errors.Join(errs...); err != nil {
		t.Fatal(err)
	}
	if total.Load() != store.Latest {
		t.Fatalf("%d migrations applied in all, want %d", total.Load(), store.Latest)
	}
}

// TestCheckSchema refuses a database one migration behind the build and
// accepts one ahead of it.
func TestCheckSchema(t *testing.T) {
	ctx := context.Background()
	u := storetest.Empty(t)
	s, err := store.Open(ctx, u, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if v, err := s.CheckSchema(ctx); !errors.Is(err, store.ErrSchemaBehind) || v != 0 {
		t.Fatalf("an empty database: %d, %v", v, err)
	}
	if _, err := store.Migrate(ctx, u, store.Latest-1); err != nil {
		t.Fatal(err)
	}
	if v, err := s.CheckSchema(ctx); !errors.Is(err, store.ErrSchemaBehind) || v != store.Latest-1 {
		t.Fatalf("one behind: %d, %v", v, err)
	}
	if _, err := store.Migrate(ctx, u, 0); err != nil {
		t.Fatal(err)
	}
	if v, err := s.CheckSchema(ctx); err != nil || v != store.Latest {
		t.Fatalf("current: %d, %v", v, err)
	}
	// A newer build's migration.
	conn, err := pgx.Connect(ctx, u)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, "INSERT INTO goose_db_version (version_id, is_applied) VALUES ($1, true)", store.Latest+1); err != nil {
		t.Fatal(err)
	}
	if v, err := s.CheckSchema(ctx); err != nil || v != store.Latest+1 {
		t.Fatalf("one ahead: %d, %v", v, err)
	}
}

// gate is a TCP proxy that refuses connections until opened, then forwards
// them to target.
type gate struct {
	ln     net.Listener
	target string
	open   atomic.Bool
	tried  atomic.Int64
}

func newGate(t *testing.T, target string) *gate {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	g := &gate{ln: ln, target: target}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			g.tried.Add(1)
			if !g.open.Load() {
				c.Close()
				continue
			}
			go func() {
				defer c.Close()
				up, err := net.Dial("tcp", target)
				if err != nil {
					return
				}
				defer up.Close()
				go func() { _, _ = io.Copy(up, c) }()
				_, _ = io.Copy(c, up)
			}()
		}
	}()
	return g
}

// throughGate is u with its host and port the gate's.
func throughGate(t *testing.T, u string) (string, *gate) {
	t.Helper()
	parsed, err := url.Parse(u)
	if err != nil || parsed.Host == "" {
		t.Skipf("the test database's URL is not a postgres:// URL with a host")
	}
	g := newGate(t, parsed.Host)
	parsed.Host = g.ln.Addr().String()
	return parsed.String(), g
}

// TestOpenWaitsForTheDatabase opens a store on a database that refuses
// connections until it opens: Open keeps trying, beating, and returns once
// it answers.
func TestOpenWaitsForTheDatabase(t *testing.T) {
	u, g := throughGate(t, storetest.URL(t))
	var beats atomic.Int64
	done := make(chan error, 1)
	var s *store.Store
	go func() {
		var err error
		s, err = store.Open(context.Background(), u, store.Options{
			Log:        slog.New(slog.DiscardHandler),
			Beat:       func() { beats.Add(1) },
			FirstRetry: 50 * time.Millisecond, LastRetry: 200 * time.Millisecond,
		})
		done <- err
	}()
	deadline := time.Now().Add(10 * time.Second)
	for g.tried.Load() < 3 {
		if time.Now().After(deadline) {
			t.Fatal("Open stopped trying")
		}
		time.Sleep(20 * time.Millisecond)
	}
	select {
	case err := <-done:
		t.Fatalf("Open returned while the database refused: %v", err)
	default:
	}
	g.open.Store(true)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if beats.Load() < 2 {
		t.Fatalf("beat %d times", beats.Load())
	}
	if _, err := s.CheckSchema(context.Background()); err != nil {
		t.Fatal(err)
	}
}

// TestOpenStopsWithItsContext gives up when its context ends.
func TestOpenStopsWithItsContext(t *testing.T) {
	u, _ := throughGate(t, storetest.URL(t))
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if _, err := store.Open(ctx, u, store.Options{FirstRetry: 50 * time.Millisecond}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Open: %v", err)
	}
}

func TestOpenRefusesABadURL(t *testing.T) {
	if _, err := store.Open(context.Background(), "postgres://a:b@host:notaport/x", store.Options{}); !errors.Is(err, store.ErrConfig) {
		t.Fatalf("Open: %v", err)
	}
}
