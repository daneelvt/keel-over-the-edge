// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/replay"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

func TestUsage(t *testing.T) {
	cases := map[string]struct {
		args   []string
		status int
	}{
		"no command":       {nil, 2},
		"unknown command":  {[]string{"sail"}, 2},
		"help":             {[]string{"help"}, 0},
		"serve extra arg":  {[]string{"serve", "now"}, 2},
		"serve bad flag":   {[]string{"serve", "-x"}, 2},
		"replay no file":   {[]string{"replay"}, 2},
		"replay two files": {[]string{"replay", "a", "b"}, 2},
		"replay workers":   {[]string{"replay", "-workers", "0", "a"}, 2},
		"replay missing":   {[]string{"replay", "/nonexistent/keel.log"}, 1},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			var out, errOut bytes.Buffer
			got := run(context.Background(), tc.args, func(string) string { return "" }, &out, &errOut)
			if got != tc.status {
				t.Fatalf("status %d, want %d (stderr: %s)", got, tc.status, errOut.String())
			}
		})
	}
}

func TestServeRefusesBadConfig(t *testing.T) {
	var out, errOut bytes.Buffer
	status := run(context.Background(), []string{"serve"}, env(map[string]string{"KEEL_DEV_SAILORS": "lots"}), &out, &errOut)
	for _, want := range []string{"KEEL_PLAY_ORIGIN", "KEEL_DEV_SAILORS", "KEEL_DATABASE_URL"} {
		if status != 1 || !strings.Contains(errOut.String(), want) {
			t.Fatalf("status %d, stderr %q", status, errOut.String())
		}
	}
}

func env(vars map[string]string) func(string) string {
	return func(k string) string { return vars[k] }
}

// memNet is an in-memory network of listeners, for servers inside a
// synctest bubble, where real sockets would keep the clock from moving.
type memNet struct {
	mu        sync.Mutex
	listeners map[string]*memListener
	gates     map[string]chan struct{} // listening on an address waits for its gate
}

func newMemNet() *memNet {
	return &memNet{listeners: map[string]*memListener{}, gates: map[string]chan struct{}{}}
}

// gate makes listening on addr wait until the returned function is called.
func (n *memNet) gate(addr string) func() {
	ch := make(chan struct{})
	n.mu.Lock()
	n.gates[addr] = ch
	n.mu.Unlock()
	return func() { close(ch) }
}

func (n *memNet) listen(_, addr string) (net.Listener, error) {
	n.mu.Lock()
	gate := n.gates[addr]
	n.mu.Unlock()
	if gate != nil {
		<-gate
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if l := n.listeners[addr]; l != nil && !l.closed() {
		return nil, fmt.Errorf("listen %s: address in use", addr)
	}
	l := &memListener{addr: addr, conns: make(chan net.Conn), done: make(chan struct{})}
	n.listeners[addr] = l
	return l, nil
}

func (n *memNet) dial(ctx context.Context, _, addr string) (net.Conn, error) {
	n.mu.Lock()
	l := n.listeners[addr]
	n.mu.Unlock()
	if l == nil {
		return nil, fmt.Errorf("dial %s: connection refused", addr)
	}
	client, server := net.Pipe()
	select {
	case l.conns <- server:
		return client, nil
	case <-l.done:
		return nil, fmt.Errorf("dial %s: connection refused", addr)
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (n *memNet) client() *http.Client {
	return &http.Client{Transport: &http.Transport{DialContext: n.dial, DisableKeepAlives: true}}
}

type memListener struct {
	addr  string
	conns chan net.Conn
	done  chan struct{}
	once  sync.Once
}

func (l *memListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.conns:
		return c, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}

func (l *memListener) Close() error {
	l.once.Do(func() { close(l.done) })
	return nil
}

func (l *memListener) closed() bool {
	select {
	case <-l.done:
		return true
	default:
		return false
	}
}

func (l *memListener) Addr() net.Addr { return memAddr(l.addr) }

type memAddr string

func (a memAddr) Network() string { return "mem" }
func (a memAddr) String() string  { return string(a) }

func get(t *testing.T, c *http.Client, url string) (int, string, http.Header) {
	t.Helper()
	res, err := c.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, string(body), res.Header
}

const (
	playURL     = "http://127.0.0.1:8080"
	agentsURL   = "http://127.0.0.1:8081"
	internalURL = "http://127.0.0.1:9090"
)

// bubbleEpoch is when a synctest bubble's clock starts.
var bubbleEpoch = time.Date(2000, time.January, 1, 0, 0, 0, 0, time.UTC)

// memDB is a database in memory, for servers in synctest bubbles, which
// cannot wait on a real one: one world, no guests.
type memDB struct {
	epoch   time.Time
	onClose func()
	mu      sync.Mutex
	closed  bool
}

func (d *memDB) CreateGuest(context.Context, store.Guest) (store.AccountID, error) {
	return store.AccountID{}, errors.New("memDB makes no guests")
}

func (d *memDB) Session(context.Context, [32]byte) (store.Session, error) {
	return store.Session{}, store.ErrNotFound
}

func (d *memDB) Touch(context.Context, [32]byte) error      { return nil }
func (d *memDB) CheckSchema(context.Context) (int64, error) { return store.Latest, nil }
func (d *memDB) Stats() store.PoolStats                     { return store.PoolStats{Max: store.MaxConns} }

func (d *memDB) ActiveOrFirstWorld(context.Context, time.Time) (store.World, error) {
	return store.World{Number: 1, Epoch: d.epoch}, nil
}

func (d *memDB) Close() {
	d.mu.Lock()
	d.closed = true
	d.mu.Unlock()
	if d.onClose != nil {
		d.onClose()
	}
}

func (d *memDB) isClosed() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.closed
}

func (d *memDB) open(context.Context, string, store.Options) (database, error) { return d, nil }

// server is keel serve running in a test.
type server struct {
	net    *memNet
	client *http.Client
	logs   *syncBuffer
	cancel context.CancelFunc
	done   chan error
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}

func startServer(t *testing.T, vars map[string]string, n *memNet, opt serveOptions) *server {
	t.Helper()
	vars["KEEL_PLAY_ORIGIN"] = "https://play.example.com"
	vars["KEEL_DATABASE_URL"] = "postgres://keel@db.example.com/keel"
	opt.listen = n.listen
	if opt.openDB == nil {
		opt.openDB = (&memDB{epoch: bubbleEpoch}).open
	}
	if opt.workers == 0 {
		opt.workers = 2
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &server{net: n, client: n.client(), logs: &syncBuffer{}, cancel: cancel, done: make(chan error, 1)}
	go func() { s.done <- runServer(ctx, env(vars), s.logs, opt) }()
	return s
}

func (s *server) stop(t *testing.T) {
	t.Helper()
	s.cancel()
	if err := <-s.done; err != nil {
		t.Fatalf("keel serve: %v\n%s", err, s.logs.String())
	}
}

// TestServe runs keel serve from start to stop in fake time.
func TestServe(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		n := newMemNet()
		openPlay := n.gate("127.0.0.1:8080")
		replays := t.TempDir()
		var readyWhileStopping int
		var s *server
		s = startServer(t, map[string]string{"KEEL_REPLAY_DIR": replays, "KEEL_DEV_SAILORS": "20"}, n, serveOptions{
			stopping: func() {
				readyWhileStopping, _, _ = get(t, s.client, internalURL+"/readyz")
			},
		})
		synctest.Wait()
		// The internal listener answers at once; nothing has ticked yet.
		if code, _, _ := get(t, s.client, internalURL+"/livez"); code != 200 {
			t.Fatalf("/livez %d before the first tick", code)
		}
		if code, body, _ := get(t, s.client, internalURL+"/readyz"); code != 503 || !strings.Contains(body, "not ticked") {
			t.Fatalf("/readyz %d %q before the first tick", code, body)
		}
		time.Sleep(time.Second)
		if code, body, _ := get(t, s.client, internalURL+"/readyz"); code != 503 || !strings.Contains(body, "listeners") {
			t.Fatalf("/readyz %d %q before the listeners are open", code, body)
		}
		openPlay()
		synctest.Wait()
		if code, body, _ := get(t, s.client, internalURL+"/readyz"); code != 200 {
			t.Fatalf("/readyz %d %q when started", code, body)
		}
		if code, body, h := get(t, s.client, playURL+"/api/version"); code != 200 || !strings.Contains(body, catalog.Version) || h.Get("X-Request-Id") == "" {
			t.Fatalf("/api/version %d %q", code, body)
		}

		time.Sleep(90 * time.Second)
		synctest.Wait()
		_, metrics, _ := get(t, s.client, internalURL+"/metrics")
		for _, want := range []string{
			"keel_sim_boats 20", "keel_sim_ticks_total 2730", "keel_sim_ticks_skipped_total 0",
			"keel_sim_frames_allocated_total 0", "keel_replay_records_dropped_total 0", "keel_replay_segments_total 4",
			`keel_sim_commands_total{kind="join",result="joined"} 20`, "keel_sim_commands_refused_total 0",
			`keel_sim_tick_duration_seconds_bucket{le="0.0005"} 2730`,
		} {
			if !strings.Contains(metrics, want) {
				t.Errorf("/metrics lacks %q", want)
			}
		}

		s.stop(t)
		if readyWhileStopping != 503 {
			t.Errorf("/readyz answered %d as the server began to stop", readyWhileStopping)
		}
		logs := s.logs.String()
		for _, want := range []string{`"msg":"ready"`, `"msg":"stopping"`, `"msg":"stopped"`, `"route":"GET /api/version"`, `"build":"dev"`} {
			if !strings.Contains(logs, want) {
				t.Errorf("the logs lack %s", want)
			}
		}

		// The input log was flushed, and replays to the world the server
		// stopped in.
		names, _ := filepath.Glob(filepath.Join(replays, "*.log"))
		if len(names) != 1 {
			t.Fatalf("input logs %v", names)
		}
		data, err := os.ReadFile(names[0])
		if err != nil {
			t.Fatal(err)
		}
		f, err := replay.Read(data)
		if err != nil {
			t.Fatal(err)
		}
		res, err := replay.Run(f, replay.Options{Kinds: kinds(t), Workers: 3})
		if err != nil {
			t.Fatal(err)
		}
		if res.Diverged != nil || res.To < 2730 || res.Digests < 90 {
			t.Fatalf("replay: %+v, %v", res, res.Diverged)
		}
	})
}

func kinds(t *testing.T) []physics.Prepared {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	ks := make([]physics.Prepared, len(cat.Boats))
	for i := range cat.Boats {
		p := catalog.PhysicsParams(&cat.Boats[i])
		physics.Prepare(&p, &ks[i])
	}
	return ks
}

// TestPublicListeners checks that neither public listener serves an
// internal path, and that the agents' listener serves nothing.
func TestPublicListeners(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := startServer(t, map[string]string{}, newMemNet(), serveOptions{})
		time.Sleep(time.Second)
		for _, path := range obs.InternalPaths {
			for _, base := range []string{playURL, agentsURL} {
				if code, _, _ := get(t, s.client, base+path); code != 404 {
					t.Errorf("%s%s answered %d", base, path, code)
				}
			}
		}
		// The internal listener serves them (the flight recorder aside, off
		// in tests; profiles and traces, which take seconds, are not asked).
		for _, path := range []string{"/livez", "/metrics", "/debug/pprof/", "/debug/pprof/goroutine", "/debug/pprof/cmdline", "/debug/replay"} {
			if code, _, _ := get(t, s.client, internalURL+path); code != 200 {
				t.Errorf("the internal listener answers %s with %d", path, code)
			}
		}
		for _, path := range []string{"/", "/mcp", "/api/version", "/sse"} {
			if code, _, _ := get(t, s.client, agentsURL+path); code != 404 {
				t.Errorf("agents %s answered %d", path, code)
			}
		}
		s.stop(t)
	})
}

// TestStartFails checks that a listener that cannot open stops the server
// with the error, in order.
func TestStartFails(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		n := newMemNet()
		if _, err := n.listen("tcp", "127.0.0.1:8081"); err != nil {
			t.Fatal(err)
		}
		s := startServer(t, map[string]string{}, n, serveOptions{})
		if err := <-s.done; err == nil || !strings.Contains(err.Error(), "address in use") {
			t.Fatalf("keel serve with its address taken: %v", err)
		}
	})
}

// TestLongConnection holds a response open far past every server timeout.
func TestLongConnection(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		n := newMemNet()
		ln, _ := n.listen("tcp", "127.0.0.1:8080")
		srv := newServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			rc := http.NewResponseController(w)
			for range 10 {
				_, _ = w.Write([]byte("x"))
				_ = rc.Flush()
				time.Sleep(30 * time.Second)
			}
		}), slog.New(slog.DiscardHandler))
		done := make(chan error, 1)
		go func() { done <- serveUntilClosed(srv, ln) }()
		start := time.Now()
		code, body, _ := get(t, n.client(), playURL+"/")
		if code != 200 || body != "xxxxxxxxxx" || time.Since(start) != 300*time.Second {
			t.Fatalf("%d %q after %v", code, body, time.Since(start))
		}
		srv.Close()
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	})
}

// TestPanicInTheTick checks that a panic in the tick ends the process: run
// again as a subprocess, the server panics in its fourth tick.
func TestPanicInTheTick(t *testing.T) {
	if os.Getenv("KEEL_TEST_PANIC") == "1" {
		n := newMemNet()
		ticks := 0
		vars := map[string]string{"KEEL_PLAY_ORIGIN": "https://play.example.com", "KEEL_DATABASE_URL": "postgres://keel@db.example.com/keel"}
		err := runServer(context.Background(), env(vars), io.Discard, serveOptions{
			listen: n.listen, workers: 2, openDB: (&memDB{epoch: firstEpoch}).open,
			afterTick: func(int64) {
				if ticks++; ticks == 4 {
					panic("a planted panic in the tick")
				}
			},
		})
		fmt.Println("runServer returned:", err)
		os.Exit(0)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestPanicInTheTick$")
	cmd.Env = append(os.Environ(), "KEEL_TEST_PANIC=1")
	out, err := cmd.CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() == 0 || !strings.Contains(string(out), "panic: a planted panic in the tick") {
		t.Fatalf("the process went on (%v):\n%s", err, out)
	}
}

// recordLog runs a server with scripted sailors for a while and returns its
// input log's file.
func recordLog(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	synctest.Test(t, func(t *testing.T) {
		s := startServer(t, map[string]string{"KEEL_REPLAY_DIR": dir, "KEEL_DEV_SAILORS": "12"}, newMemNet(), serveOptions{})
		time.Sleep(40 * time.Second)
		s.stop(t)
	})
	names, _ := filepath.Glob(filepath.Join(dir, "*.log"))
	if len(names) != 1 {
		t.Fatalf("logs %v", names)
	}
	return names[0]
}

func TestReplayCommand(t *testing.T) {
	name := recordLog(t)
	var out, errOut bytes.Buffer
	if status := run(context.Background(), []string{"replay", "-workers", "3", name}, env(nil), &out, &errOut); status != 0 {
		t.Fatalf("status %d: %s", status, errOut.String())
	}
	if !strings.HasPrefix(out.String(), "replayed ") || !strings.HasSuffix(out.String(), " ticks: identical\n") {
		t.Fatalf("stdout %q", out.String())
	}

	// Cut short, it replays what is whole and says so.
	data, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	cut := filepath.Join(t.TempDir(), "cut.log")
	if err := os.WriteFile(cut, data[:len(data)*2/3], 0o644); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	errOut.Reset()
	if status := run(context.Background(), []string{"replay", cut}, env(nil), &out, &errOut); status != 0 || !strings.Contains(errOut.String(), "partway") {
		t.Fatalf("status %d, %q, %q", status, out.String(), errOut.String())
	}
}

func TestReplayDump(t *testing.T) {
	name := recordLog(t)
	data, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	f, err := replay.Read(data)
	if err != nil {
		t.Fatal(err)
	}
	const at = 900
	want := bus.NewFrame(f.Header.Capacity)
	if _, err := replay.Run(f, replay.Options{Kinds: kinds(t), Workers: 1, At: func(fr *bus.Frame) {
		if fr.Tick == at {
			if err := sim.ReadSnapshot(sim.AppendSnapshot(nil, fr), want); err != nil {
				t.Fatal(err)
			}
		}
	}}); err != nil {
		t.Fatal(err)
	}

	var out, errOut bytes.Buffer
	if status := run(context.Background(), []string{"replay", "-dump", strconv.Itoa(at), name}, env(nil), &out, &errOut); status != 0 {
		t.Fatalf("status %d: %s", status, errOut.String())
	}
	var got struct {
		Tick  int64
		Wind  map[string]json.RawMessage
		Boats []struct {
			Slot       int32
			Boat       uint64
			Generation uint16
			Control    struct{ Word string }
			State      map[string]json.RawMessage
		}
	}
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("%v: %s", err, out.String())
	}
	if got.Tick != at || len(got.Boats) != len(want.Live) || len(got.Boats) != 12 {
		t.Fatalf("tick %d, %d boats; want %d boats", got.Tick, len(got.Boats), len(want.Live))
	}
	names := stateNames()
	for i, s := range want.Live {
		b := got.Boats[i]
		if b.Slot != s || b.Boat != want.Boat[s] || b.Generation != want.Gen[s] || b.Control.Word != fmt.Sprintf("%#016x", uint64(want.Control[s])) {
			t.Fatalf("boat %d: %+v", i, b)
		}
		for j, v := range sim.StateFields(&want.State[s]) {
			if x := parseExact(t, b.State[names[j]]); math.Float64bits(x) != math.Float64bits(*v) && !(math.IsNaN(x) && math.IsNaN(*v)) {
				t.Fatalf("boat %d's %s: %v in the dump, %v in the world", i, names[j], x, *v)
			}
		}
	}
	if x := parseExact(t, got.Wind["speed"]); x != want.Wind.Speed {
		t.Fatalf("wind %v", x)
	}
}

func parseExact(t *testing.T, raw json.RawMessage) float64 {
	t.Helper()
	s := strings.Trim(string(raw), `"`)
	x, err := strconv.ParseFloat(s, 64)
	if err != nil {
		t.Fatalf("%s: %v", raw, err)
	}
	return x
}

func TestExactJSON(t *testing.T) {
	for _, x := range []float64{0, math.Copysign(0, -1), 0.1, 1e-310, math.MaxFloat64, math.Inf(1), math.Inf(-1), math.NaN(), 5.144444444444445} {
		b, err := exact(x).MarshalJSON()
		if err != nil {
			t.Fatal(err)
		}
		if y := parseExact(t, b); math.Float64bits(x) != math.Float64bits(y) && !(math.IsNaN(x) && math.IsNaN(y)) {
			t.Errorf("%v reads back as %v from %s", x, y, b)
		}
	}
}
