// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/sim/loop"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// The server with a real database, on real sockets in real time: a
// database cannot be waited on inside a synctest bubble.

// realNet opens each listener on a free loopback port and remembers which.
type realNet struct {
	mu    sync.Mutex
	addrs map[string]string
}

func (n *realNet) listen(_, addr string) (net.Listener, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	n.mu.Lock()
	n.addrs[addr] = ln.Addr().String()
	n.mu.Unlock()
	return ln, nil
}

// url waits for the listener asked for at addr and returns its URL.
func (n *realNet) url(t *testing.T, addr string) string {
	t.Helper()
	for start := time.Now(); time.Since(start) < 10*time.Second; time.Sleep(10 * time.Millisecond) {
		n.mu.Lock()
		a := n.addrs[addr]
		n.mu.Unlock()
		if a != "" {
			return "http://" + a
		}
	}
	t.Fatalf("nothing listens for %s", addr)
	return ""
}

type realServer struct {
	net    *realNet
	logs   *syncBuffer
	cancel context.CancelFunc
	done   chan error
}

// startReal starts keel serve on the database at dbURL, with no bell.
func startReal(t *testing.T, dbURL string) *realServer {
	t.Helper()
	return startRealWith(t, dbURL, nil)
}

// startRealWith is startReal with more of the environment.
func startRealWith(t *testing.T, dbURL string, extra map[string]string) *realServer {
	t.Helper()
	vars := map[string]string{"KEEL_PLAY_ORIGIN": "http://localhost:5181", "KEEL_DATABASE_URL": dbURL, "KEEL_BELL": "0s"}
	for k, v := range extra {
		vars[k] = v
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &realServer{net: &realNet{addrs: map[string]string{}}, logs: &syncBuffer{}, cancel: cancel, done: make(chan error, 1)}
	go func() {
		s.done <- runServer(ctx, env(vars), s.logs, serveOptions{listen: s.net.listen, workers: 2, dbRetry: 50 * time.Millisecond})
	}()
	t.Cleanup(func() {
		cancel()
		<-s.done
	})
	return s
}

func (s *realServer) get(t *testing.T, addr, path string) (int, string) {
	t.Helper()
	res, err := http.Get(s.net.url(t, addr) + path)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

// waitReady polls /readyz until it passes.
func (s *realServer) waitReady(t *testing.T) {
	t.Helper()
	for start := time.Now(); time.Since(start) < 20*time.Second; time.Sleep(20 * time.Millisecond) {
		if code, _ := s.get(t, "127.0.0.1:9090", "/readyz"); code == 200 {
			return
		}
	}
	t.Fatalf("never ready:\n%s", s.logs.String())
}

func (s *realServer) stop(t *testing.T) {
	t.Helper()
	s.cancel()
	if err := <-s.done; err != nil {
		t.Fatalf("keel serve: %v\n%s", err, s.logs.String())
	}
	s.done <- nil // for the cleanup
}

// gated is u reached through a proxy that refuses connections until
// opened.
func gated(t *testing.T, u string) (string, *atomic.Bool) {
	t.Helper()
	parsed, err := url.Parse(u)
	if err != nil || parsed.Host == "" {
		t.Skip("the test database's URL is not a postgres:// URL with a host")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	var open atomic.Bool
	target := parsed.Host
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			if !open.Load() {
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
	parsed.Host = ln.Addr().String()
	return parsed.String(), &open
}

// TestServeWaitsForTheDatabase starts the server while its database
// refuses connections: live, not ready, until the database answers.
func TestServeWaitsForTheDatabase(t *testing.T) {
	u, open := gated(t, storetest.URL(t))
	s := startReal(t, u)
	time.Sleep(time.Second)
	if code, body := s.get(t, "127.0.0.1:9090", "/readyz"); code != 503 || !strings.Contains(body, "waiting for the database") {
		t.Fatalf("/readyz %d %q while the database refuses", code, body)
	}
	if code, _ := s.get(t, "127.0.0.1:9090", "/livez"); code != 200 {
		t.Fatalf("/livez %d while waiting", code)
	}
	open.Store(true)
	s.waitReady(t)
	if code, body := s.get(t, "127.0.0.1:8080", "/api/me"); code != 401 {
		t.Fatalf("/api/me %d %s", code, body)
	}
	_, metrics := s.get(t, "127.0.0.1:9090", "/metrics")
	for _, want := range []string{
		`keel_db_pool_max_connections 17`, `keel_db_pool_connections{state="idle"}`, "keel_db_schema_version " + strconv.FormatInt(store.Latest, 10),
		`keel_db_query_duration_seconds_count{query="ActiveWorld"} 1`, `keel_guests_refused_total{reason="taken"} 0`,
	} {
		if !strings.Contains(metrics, want) {
			t.Errorf("/metrics lacks %q", want)
		}
	}
	s.stop(t)
}

func TestServeRefusesASchemaBehind(t *testing.T) {
	u := storetest.Empty(t)
	if _, err := store.Migrate(context.Background(), u, store.Latest-1); err != nil {
		t.Fatal(err)
	}
	s := startReal(t, u)
	err := <-s.done
	s.done <- nil
	if err == nil || !strings.Contains(err.Error(), "run keel migrate") {
		t.Fatalf("keel serve on a database behind: %v", err)
	}
}

var tickMetric = regexp.MustCompile(`(?m)^keel_sim_tick (\S+)$`)

// tickNow is the world's tick, from the metrics.
func (s *realServer) tickNow(t *testing.T) float64 {
	t.Helper()
	_, metrics := s.get(t, "127.0.0.1:9090", "/metrics")
	m := tickMetric.FindStringSubmatch(metrics)
	if m == nil {
		t.Fatal("no keel_sim_tick")
	}
	v, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// TestServeSailsTheActiveWorld starts on an empty database, which gets
// world 1 at the first epoch, then on one whose world has an epoch of its
// own, which the clock follows.
func TestServeSailsTheActiveWorld(t *testing.T) {
	ctx := context.Background()
	u := storetest.URL(t)
	s := startReal(t, u)
	s.waitReady(t)
	if tick, want := s.tickNow(t), float64(loop.TickAt(time.Now(), firstEpoch)); tick < want-300 || tick > want+30 {
		t.Fatalf("tick %v, want about %v", tick, want)
	}
	s.stop(t)
	st, err := store.Open(ctx, u, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	w, err := st.ActiveWorld(ctx)
	if err != nil || w.Number != 1 || !w.Epoch.Equal(firstEpoch) {
		t.Fatalf("the first world: %+v, %v", w, err)
	}

	u2 := storetest.URL(t)
	st2, err := store.Open(ctx, u2, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer st2.Close()
	epoch := time.Date(2020, time.March, 1, 0, 0, 0, 0, time.UTC)
	if _, err := st2.CreateWorld(ctx, epoch); err != nil {
		t.Fatal(err)
	}
	s2 := startReal(t, u2)
	s2.waitReady(t)
	if tick, want := s2.tickNow(t), float64(loop.TickAt(time.Now(), epoch)); tick < want-300 || tick > want+30 {
		t.Fatalf("tick %v, want about %v", tick, want)
	}
	s2.stop(t)
	if w, err := st2.ActiveWorld(ctx); err != nil || !w.Epoch.Equal(epoch) || w.Number != 1 {
		t.Fatalf("the world: %+v, %v", w, err)
	}
}

// TestStopClosesTheDatabaseAfterTheLoop checks the stopping order: the
// pool closes once the loop has stopped, while the internal listener still
// answers.
func TestStopClosesTheDatabaseAfterTheLoop(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		n := newMemNet()
		db := &memDB{epoch: bubbleEpoch}
		var ticksAfterClose atomic.Int64
		livezAtClose := make(chan int, 1)
		client := n.client()
		db.onClose = func() {
			res, err := client.Get(internalURL + "/livez")
			if err != nil {
				livezAtClose <- 0
				return
			}
			res.Body.Close()
			livezAtClose <- res.StatusCode
		}
		s := startServer(t, map[string]string{}, n, db.with(serveOptions{
			afterTick: func(int64) {
				if db.isClosed() {
					ticksAfterClose.Add(1)
				}
			},
		}))
		time.Sleep(2 * time.Second)
		if db.isClosed() {
			t.Fatal("closed while running")
		}
		s.stop(t)
		if !db.isClosed() || ticksAfterClose.Load() != 0 {
			t.Fatalf("closed %v, %d ticks after", db.isClosed(), ticksAfterClose.Load())
		}
		if code := <-livezAtClose; code != 200 {
			t.Fatalf("/livez answered %d as the pool closed", code)
		}
	})
}

func TestMigrateCommand(t *testing.T) {
	u := storetest.Empty(t)
	vars := env(map[string]string{"KEEL_DATABASE_URL": u})
	var out, errOut strings.Builder
	if status := run(context.Background(), []string{"migrate"}, vars, &out, &errOut); status != 0 {
		t.Fatalf("status %d: %s", status, errOut.String())
	}
	if strings.Count(out.String(), "applied ") != int(store.Latest) {
		t.Fatalf("first run: %q", out.String())
	}
	out.Reset()
	if status := run(context.Background(), []string{"migrate"}, vars, &out, &errOut); status != 0 || !strings.HasPrefix(out.String(), "nothing to apply") {
		t.Fatalf("again: %d %q", status, out.String())
	}
	out.Reset()
	if status := run(context.Background(), []string{"migrate", "-status"}, vars, &out, &errOut); status != 0 ||
		strings.Count(out.String(), " applied ") != int(store.Latest) || strings.Contains(out.String(), "pending") {
		t.Fatalf("-status: %d %q", status, out.String())
	}
	for _, c := range []struct {
		args   []string
		vars   map[string]string
		status int
	}{
		{[]string{"migrate", "now"}, nil, 2},
		{[]string{"migrate", "-x"}, nil, 2},
		{[]string{"migrate"}, map[string]string{}, 1},
		{[]string{"migrate"}, map[string]string{"KEEL_DATABASE_URL": "mysql://x/y"}, 1},
	} {
		errOut.Reset()
		if status := run(context.Background(), c.args, env(c.vars), &out, &errOut); status != c.status {
			t.Errorf("%v %v: status %d (%s)", c.args, c.vars, status, errOut.String())
		}
	}
}
