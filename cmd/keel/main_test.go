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
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/edge/edgetest"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/replay"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
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
// cannot wait on a real one: one world, no guests; the simulation's lease,
// the world's checkpoint and its events. Two servers given one share them,
// as two processes share a database.
type memDB struct {
	epoch    time.Time
	onClose  func()
	sessions *edgetest.Sessions // nil for none
	mu       sync.Mutex
	closed   bool

	once       sync.Once
	free       chan struct{} // holds a token while the lease is free
	leaseEpoch int64
	holder     string
	lose       chan struct{} // closed: the holder's lease is lost for good
	checkpoint *store.Checkpoint
	events     []store.Event
	chartings  []store.Charting
	down       bool // the world's writes fail
	bundle     *store.Bundle
	number     int // worlds ended before the active one
	// The active world's beginning and end; the next world; the jobs'
	// runs, by job and due time; the news of worlds' ends; and how many
	// switches there have been.
	begins, ends time.Time
	next         *memNext
	runs         map[string]*memRun
	news         []store.WorldNews
	switches     int
}

// emptyWorld makes a world of open sea at once: the generator of the
// servers in tests, which have no seconds to spend on a real one.
func emptyWorld(seed uint64) (*worldgen.Bundle, error) { return worldgen.Empty(seed), nil }

func (d *memDB) WorldSeed(_ context.Context, world [16]byte) (uint64, int, bool, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if n := d.next; n != nil && worldID(n.number) == world {
		return n.seed, 0, true, nil
	}
	if d.bundle == nil {
		return 0, 0, false, nil
	}
	return d.bundle.Seed, d.bundle.Generator, true, nil
}

func (d *memDB) LoadBundle(_ context.Context, world [16]byte) (*store.Bundle, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if n := d.next; n != nil && worldID(n.number) == world {
		if n.bundle == nil {
			return nil, store.ErrNotFound
		}
		b := *n.bundle
		return &b, nil
	}
	if d.bundle == nil {
		return nil, store.ErrNotFound
	}
	b := *d.bundle
	return &b, nil
}

// StoreBundle is fenced by the lease's epoch, as the world's writes are,
// and keeps the first bundle stored.
func (d *memDB) StoreBundle(_ context.Context, world [16]byte, epoch int64, b *store.Bundle) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if epoch != d.leaseEpoch {
		return fmt.Errorf("%w: the epoch is %d, the writer's %d", store.ErrFenced, d.leaseEpoch, epoch)
	}
	if n := d.next; n != nil && worldID(n.number) == world {
		if n.bundle == nil {
			c := *b
			c.Stored = time.Now()
			n.bundle = &c
		}
		return nil
	}
	if d.bundle == nil {
		c := *b
		d.bundle = &c
	}
	return nil
}

// SetChunkKey is fenced by the lease's epoch, and keeps the first key set.
func (d *memDB) SetChunkKey(_ context.Context, _ [16]byte, epoch int64, key []byte) ([]byte, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.bundle == nil {
		return nil, store.ErrNotFound
	}
	if d.bundle.ChunkKey == nil {
		if epoch != d.leaseEpoch {
			return nil, fmt.Errorf("%w: the epoch is %d, the writer's %d", store.ErrFenced, d.leaseEpoch, epoch)
		}
		d.bundle.ChunkKey = bytes.Clone(key)
	}
	return d.bundle.ChunkKey, nil
}

func (d *memDB) init() {
	d.once.Do(func() {
		d.free = make(chan struct{}, 1)
		d.free <- struct{}{}
		d.lose = make(chan struct{})
	})
}

func (d *memDB) LatestCheckpoint(context.Context, [16]byte) (store.Checkpoint, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.checkpoint == nil {
		return store.Checkpoint{}, store.ErrNotFound
	}
	return *d.checkpoint, nil
}

// state is the world's checkpoint, its events and the lease's epoch.
func (d *memDB) state() (*store.Checkpoint, []store.Event, int64) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.checkpoint, slices.Clone(d.events), d.leaseEpoch
}

func (d *memDB) openLease(_ string, opt store.LeaseOptions) (lease, error) {
	d.init()
	return &memLease{d: d, opt: opt}, nil
}

// memLease is the lease in a memDB: a token, taken or put back.
type memLease struct {
	d    *memDB
	opt  store.LeaseOptions
	held bool
}

func (l *memLease) Take(ctx context.Context) (int64, error) {
	d := l.d
	t := time.NewTicker(store.LeasePoll)
	defer t.Stop()
	for {
		select {
		case <-d.free:
			d.mu.Lock()
			defer d.mu.Unlock()
			d.leaseEpoch++
			d.holder = l.opt.Holder
			l.held = true
			return d.leaseEpoch, nil
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-t.C:
			d.mu.Lock()
			holder := d.holder
			d.mu.Unlock()
			l.opt.Beat()
			l.opt.Waiting(holder)
		}
	}
}

func (l *memLease) Watch(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return nil
	case <-l.d.lose:
		l.opt.Lost("lost")
		return store.ErrLeaseLost
	}
}

func (l *memLease) Release(context.Context) {
	if l.held {
		l.held = false
		l.d.free <- struct{}{}
	}
}

func (d *memDB) openWriter(context.Context, string, store.Options) (worldWriter, error) {
	return memWriter{d}, nil
}

// memWriter is the world's writer on a memDB, with a pool of its own to
// close.
type memWriter struct{ *memDB }

func (memWriter) Close() {}

// with has a server use d for its database, its lease and its writer.
func (d *memDB) with(opt serveOptions) serveOptions {
	opt.openDB, opt.openLease, opt.openWriter = d.open, d.openLease, d.openWriter
	return opt
}

// Write is the world's writer's: fenced by the lease's epoch.
func (d *memDB) Write(_ context.Context, b store.Batch) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	switch {
	case b.Epoch != d.leaseEpoch:
		return fmt.Errorf("%w: the epoch is %d, the writer's %d", store.ErrFenced, d.leaseEpoch, b.Epoch)
	case d.down:
		return errors.New("the database is down")
	}
	d.events = append(d.events, b.Events...)
	for i := range b.Charting {
		c := &b.Charting[i]
		if slices.ContainsFunc(d.chartings, func(o store.Charting) bool { return o.Subject == c.Subject && o.Number == c.Number }) {
			continue
		}
		c.Written, c.At = true, time.Now()
		if c.Credited {
			c.Sailor, c.AccountKind = "a sailor", string(store.Human)
		}
		d.chartings = append(d.chartings, *c)
	}
	if b.Checkpoint != nil {
		c := *b.Checkpoint
		c.Data = slices.Clone(c.Data)
		c.Epoch, c.WrittenAt = b.Epoch, time.Now()
		d.checkpoint = &c
	}
	return nil
}

func (d *memDB) Chartings(context.Context, [16]byte) ([]store.Charting, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return slices.Clone(d.chartings), nil
}

func (d *memDB) News(context.Context, [16]byte, *[16]byte, int) ([]store.News, error) {
	return nil, nil
}

func (d *memDB) SetNoticesOff(context.Context, store.AccountID, []string) error { return nil }

func (d *memDB) CreateGuest(context.Context, store.Guest) (store.AccountID, error) {
	return store.AccountID{}, errors.New("memDB makes no guests")
}

func (d *memDB) Session(ctx context.Context, hash [32]byte) (store.Session, error) {
	if d.sessions != nil {
		return d.sessions.Session(ctx, hash)
	}
	return store.Session{}, store.ErrNotFound
}

func (d *memDB) Accounts(ctx context.Context, ids []store.AccountID) (map[store.AccountID]store.Account, error) {
	if d.sessions != nil {
		return d.sessions.Accounts(ctx, ids)
	}
	return map[store.AccountID]store.Account{}, nil
}

func (d *memDB) SetTools(ctx context.Context, id store.AccountID, on bool) error {
	if d.sessions != nil {
		return d.sessions.SetTools(ctx, id, on)
	}
	return store.ErrNotFound
}

func (d *memDB) Touch(context.Context, [32]byte) error      { return nil }
func (d *memDB) CheckSchema(context.Context) (int64, error) { return store.Latest, nil }
func (d *memDB) Stats() store.PoolStats                     { return store.PoolStats{Max: store.MaxConns} }

// worldID is the ID of world n in a memDB: the first world's is zero.
func worldID(n int) [16]byte {
	if n <= 1 {
		return [16]byte{}
	}
	return [16]byte{0xff, byte(n >> 8), byte(n)}
}

// memNext is the next world in a memDB.
type memNext struct {
	number  int
	seed    uint64
	bundle  *store.Bundle
	created time.Time
}

// memRun is a job's run in a memDB.
type memRun struct {
	outcome, detail string
	epoch           int64
	attempts        int
	finished        time.Time
}

func (d *memDB) active() store.World {
	n := d.number + 1
	return store.World{ID: worldID(n), Number: n, Epoch: d.epoch, BeginsAt: d.begins, EndsAt: d.ends}
}

func (d *memDB) ActiveOrFirstWorld(context.Context, time.Time) (store.World, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.active(), nil
}

func (d *memDB) SetWorldEnd(_ context.Context, lease int64, _ [16]byte, end time.Time) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if lease != d.leaseEpoch {
		return store.ErrFenced
	}
	d.ends = end
	return nil
}

func (d *memDB) NextWorld(context.Context) (store.NextWorld, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.next == nil {
		return store.NextWorld{}, store.ErrNotFound
	}
	nw := store.NextWorld{World: store.World{ID: worldID(d.next.number), Number: d.next.number}, Seed: d.next.seed, Created: d.next.created,
		Stored: d.next.bundle != nil}
	if b := d.next.bundle; b != nil {
		nw.Attempts, nw.GenerationMs, nw.StoredAt = b.Attempts, b.GenerationMs, b.Stored
	}
	return nw, nil
}

func (d *memDB) CreateNextWorld(_ context.Context, lease int64, seed uint64, _ int, _ time.Time) (store.World, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if lease != d.leaseEpoch {
		return store.World{}, store.ErrFenced
	}
	if d.next != nil {
		return store.World{}, store.ErrNoNext
	}
	d.next = &memNext{number: d.number + 2, seed: seed, created: time.Now()}
	return store.World{ID: worldID(d.next.number), Number: d.next.number}, nil
}

// SwitchWorld begins the next world: the old one's checkpoint and chart
// go with it; its events are kept.
func (d *memDB) SwitchWorld(_ context.Context, lease int64, number int, next [16]byte, begins, ends time.Time) (store.World, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if lease != d.leaseEpoch {
		return store.World{}, store.ErrFenced
	}
	if number != d.number+1 {
		return store.World{}, store.ErrNotActive
	}
	if d.next == nil || worldID(d.next.number) != next {
		return store.World{}, store.ErrNoNext
	}
	d.number = d.next.number - 1
	d.bundle, d.next = d.next.bundle, nil
	d.checkpoint, d.chartings = nil, nil
	d.epoch, d.begins, d.ends = begins, begins, ends
	d.switches++
	return d.active(), nil
}

func (d *memDB) DiscardNextWorld(_ context.Context, lease int64, number int) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if lease != d.leaseEpoch {
		return store.ErrFenced
	}
	if d.next == nil || d.next.number != number {
		return store.ErrNoNext
	}
	d.next = nil
	return nil
}

func (d *memDB) WorldsToDrop(context.Context, time.Time) ([]store.World, error) { return nil, nil }
func (d *memDB) DropWorld(context.Context, int64, store.World) error            { return nil }
func (d *memDB) DeleteSessions(context.Context, time.Time) (int64, error)       { return 0, nil }
func (d *memDB) DeleteJobRuns(context.Context, time.Time) (int64, error)        { return 0, nil }

func (d *memDB) WriteWorldNews(_ context.Context, lease int64, _ [16]byte, n store.WorldNews) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if lease != d.leaseEpoch {
		return store.ErrFenced
	}
	d.news = append(d.news, n)
	return nil
}

func (d *memDB) ClaimJob(_ context.Context, lease int64, job string, due time.Time, retry time.Duration) (store.JobClaim, bool, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if lease != d.leaseEpoch {
		return store.JobClaim{}, false, nil
	}
	if d.runs == nil {
		d.runs = map[string]*memRun{}
	}
	k := job + " " + due.UTC().Format(time.RFC3339Nano)
	r := d.runs[k]
	switch {
	case r == nil:
		r = &memRun{}
		d.runs[k] = r
	case r.outcome == store.JobFailed && time.Since(r.finished) > retry:
	case r.outcome == "" && r.epoch < lease:
	default:
		return store.JobClaim{}, false, nil
	}
	r.outcome, r.epoch = "", lease
	r.attempts++
	return store.JobClaim{Job: job, Due: due, Attempt: r.attempts}, true, nil
}

func (d *memDB) FinishJob(_ context.Context, c store.JobClaim, outcome, detail string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if r := d.runs[c.Job+" "+c.Due.UTC().Format(time.RFC3339Nano)]; r != nil && r.outcome == "" {
		r.outcome, r.detail, r.finished = outcome, detail, time.Now()
	}
	return nil
}

func (d *memDB) JobRuns(context.Context, int) ([]store.JobRun, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []store.JobRun
	for k, r := range d.runs {
		job, _, _ := strings.Cut(k, " ")
		out = append(out, store.JobRun{Job: job, Outcome: r.outcome, Detail: r.detail, Attempts: r.attempts, Finished: r.finished})
	}
	return out, nil
}

// run is how a job's run due at due ended, "" if it has not.
func (d *memDB) run(job string, due time.Time) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	if r := d.runs[job+" "+due.UTC().Format(time.RFC3339Nano)]; r != nil {
		return r.outcome
	}
	return ""
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
		opt = (&memDB{epoch: bubbleEpoch}).with(opt)
	}
	if opt.generate == nil {
		opt.generate = emptyWorld
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
		res, err := replay.Run(f, replay.Options{Kinds: kinds(t), Waves: waves(t), Weather: timeline(t), Encounters: encounters(t), Workers: 3})
		if err != nil {
			t.Fatal(err)
		}
		if res.Diverged != nil || res.To < 2730 || res.Digests < 90 {
			t.Fatalf("replay: %+v, %v", res, res.Diverged)
		}
	})
}

// physicsOnce prepares the catalog's sea and boats once for the package's
// tests.
var physicsOnce = sync.OnceValues(func() (*physics.Waves, []physics.Prepared) {
	cat, err := catalog.Load()
	if err != nil {
		panic(err)
	}
	return cat.Prepare()
})

// kinds is the catalog's boats, prepared for its sea.
func kinds(t *testing.T) []physics.Prepared {
	_, ks := physicsOnce()
	return ks
}

// waves is the catalog's sea.
func waves(t *testing.T) *physics.Waves {
	w, _ := physicsOnce()
	return w
}

// encounters is the catalog's encounters, as keel serve meets them.
func encounters(t *testing.T) *physics.EncounterPrepared {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	return cat.PrepareEncounters()
}

// timeline is the catalog's weather, as keel serve sails in it.
func timeline(t *testing.T) *weather.Timeline {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	tl, err := weather.FromCatalog(cat)
	if err != nil {
		t.Fatal(err)
	}
	return tl
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
		for _, path := range []string{"/livez", "/metrics", "/debug/pprof/", "/debug/pprof/goroutine", "/debug/pprof/cmdline", "/debug/replay",
			"/owner/api/world.json", "/owner/api/gusts.bin", "/owner/api/islands.json", "/owner/api/current.json"} {
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

// TestMetricsListener: with KEEL_METRICS_ADDR, the metrics are served on a
// listener of their own, which serves nothing else; the internal listener
// still serves them. A metrics address that cannot open stops the server,
// its internal listener closed.
func TestMetricsListener(t *testing.T) {
	const metricsURL = "http://127.0.0.1:9091"
	synctest.Test(t, func(t *testing.T) {
		s := startServer(t, map[string]string{"KEEL_METRICS_ADDR": "127.0.0.1:9091"}, newMemNet(), serveOptions{})
		time.Sleep(time.Second)
		for _, base := range []string{metricsURL, internalURL} {
			if code, body, _ := get(t, s.client, base+"/metrics"); code != 200 || !strings.Contains(body, "keel_build_info") {
				t.Errorf("%s/metrics answered %d", base, code)
			}
		}
		for _, path := range append(slices.Clone(obs.InternalPaths), "/", "/api/version") {
			if path == "/metrics" {
				continue
			}
			if code, _, _ := get(t, s.client, metricsURL+path); code != 404 {
				t.Errorf("the metrics listener answered %s with %d", path, code)
			}
		}
		s.stop(t)
	})
	synctest.Test(t, func(t *testing.T) {
		n := newMemNet()
		if _, err := n.listen("tcp", "127.0.0.1:9091"); err != nil {
			t.Fatal(err)
		}
		s := startServer(t, map[string]string{"KEEL_METRICS_ADDR": "127.0.0.1:9091"}, n, serveOptions{})
		if err := <-s.done; err == nil || !strings.Contains(err.Error(), "address in use") {
			t.Fatalf("keel serve with its metrics address taken: %v", err)
		}
		if _, err := n.listen("tcp", "127.0.0.1:9090"); err != nil {
			t.Errorf("the internal listener was left open: %v", err)
		}
	})
}

// TestBuildOverride: an ID given at build time is the build every report
// names, over the VCS information.
func TestBuildOverride(t *testing.T) {
	buildOverride = "0123456789ab-dirty-20261010T120000Z"
	t.Cleanup(func() { buildOverride = "" })
	synctest.Test(t, func(t *testing.T) {
		s := startServer(t, map[string]string{}, newMemNet(), serveOptions{})
		time.Sleep(time.Second)
		if code, body, _ := get(t, s.client, playURL+"/api/version"); code != 200 || !strings.Contains(body, `"build":"`+buildOverride+`"`) {
			t.Errorf("/api/version %d %s", code, body)
		}
		if _, metrics, _ := get(t, s.client, internalURL+"/metrics"); !strings.Contains(metrics, `keel_build_info{build="`+buildOverride+`"`) {
			t.Error("keel_build_info does not name the build")
		}
		s.stop(t)
		if logs := s.logs.String(); !strings.Contains(logs, `"build":"`+buildOverride+`"`) {
			t.Error("the logs do not name the build")
		}
	})
}

// TestServesThePage: with KEEL_CLIENT_DIR the game's listener serves the
// page; a directory without index.html stops the server before it listens.
func TestServesThePage(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "owner", "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"index.html": "<title>Keel Over the Edge</title>", "assets/main-abc.js": "1",
		"owner/index.html": "<title>The world</title>", "owner/assets/owner-abc.js": "2",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	synctest.Test(t, func(t *testing.T) {
		s := startServer(t, map[string]string{"KEEL_CLIENT_DIR": dir}, newMemNet(), serveOptions{})
		time.Sleep(time.Second)
		if code, body, h := get(t, s.client, playURL+"/"); code != 200 || !strings.Contains(body, "Keel Over the Edge") || h.Get("Cache-Control") != "no-cache" {
			t.Errorf("/ %d %q %v", code, body, h)
		}
		if code, _, h := get(t, s.client, playURL+"/assets/main-abc.js"); code != 200 || !strings.Contains(h.Get("Cache-Control"), "immutable") {
			t.Errorf("an asset %d %v", code, h)
		}
		if code, _, _ := get(t, s.client, agentsURL+"/"); code != 404 {
			t.Errorf("the agents' listener serves the page: %d", code)
		}
		// The world page, in the page's directory, on the internal
		// listener alone.
		for _, path := range []string{"/owner/", "/owner/index.html", "/owner/assets/owner-abc.js", "/owner/owner-abc.js", "/assets/owner-abc.js"} {
			if code, _, _ := get(t, s.client, playURL+path); code != 404 {
				t.Errorf("the game's listener serves %s: %d", path, code)
			}
		}
		if code, body, h := get(t, s.client, internalURL+"/owner/"); code != 200 || !strings.Contains(body, "The world") || h.Get("Content-Security-Policy") == "" {
			t.Errorf("the world page %d %q %v", code, body, h)
		}
		if code, _, _ := get(t, s.client, internalURL+"/owner/assets/owner-abc.js"); code != 200 {
			t.Errorf("the world page's asset %d", code)
		}
		s.stop(t)
	})
	if err := os.Remove(filepath.Join(dir, "index.html")); err != nil {
		t.Fatal(err)
	}
	synctest.Test(t, func(t *testing.T) {
		n := newMemNet()
		s := startServer(t, map[string]string{"KEEL_CLIENT_DIR": dir}, n, serveOptions{})
		if err := <-s.done; err == nil || !strings.Contains(err.Error(), "index.html") {
			t.Fatalf("keel serve with no index.html: %v", err)
		}
		if _, err := n.listen("tcp", "127.0.0.1:9090"); err != nil {
			t.Errorf("the internal listener was left open: %v", err)
		}
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
		err := runServer(context.Background(), env(vars), io.Discard, (&memDB{epoch: firstEpoch}).with(serveOptions{
			generate: emptyWorld,
			listen:   n.listen, workers: 2,
			afterTick: func(int64) {
				if ticks++; ticks == 4 {
					panic("a planted panic in the tick")
				}
			},
		}))
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
// input log's file, and a file of the test world's terrain it sailed.
func recordLog(t *testing.T) (log, world string) {
	t.Helper()
	dir := t.TempDir()
	synctest.Test(t, func(t *testing.T) {
		s := startServer(t, map[string]string{"KEEL_REPLAY_DIR": dir, "KEEL_DEV_SAILORS": "12", "KEEL_WORLD_SEED": "7"}, newMemNet(), serveOptions{})
		time.Sleep(40 * time.Second)
		s.stop(t)
	})
	names, _ := filepath.Glob(filepath.Join(dir, "*.log"))
	if len(names) != 1 {
		t.Fatalf("logs %v", names)
	}
	b, _ := emptyWorld(7)
	world = filepath.Join(t.TempDir(), "world.bundle")
	f, err := os.Create(world)
	if err != nil {
		t.Fatal(err)
	}
	if err := b.WriteFile(f); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	return names[0], world
}

func TestReplayCommand(t *testing.T) {
	name, world := recordLog(t)
	var out, errOut bytes.Buffer
	// The test world is not one the generator makes: it is given.
	if status := run(context.Background(), []string{"replay", name}, env(nil), &out, &errOut); status != 1 || !strings.Contains(errOut.String(), "the log's terrain: its digest") {
		t.Fatalf("a log of another terrain: status %d: %s", status, errOut.String())
	}
	out.Reset()
	errOut.Reset()
	if status := run(context.Background(), []string{"replay", "-workers", "3", "-world", world, name}, env(nil), &out, &errOut); status != 0 {
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
	if status := run(context.Background(), []string{"replay", "-world", world, cut}, env(nil), &out, &errOut); status != 0 || !strings.Contains(errOut.String(), "partway") {
		t.Fatalf("status %d, %q, %q", status, out.String(), errOut.String())
	}
}

func TestReplayDump(t *testing.T) {
	name, world := recordLog(t)
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
	if _, err := replay.Run(f, replay.Options{Kinds: kinds(t), Waves: waves(t), Weather: timeline(t), Encounters: encounters(t), Workers: 1, At: func(fr *bus.Frame) {
		if fr.Tick == at {
			if err := sim.ReadSnapshot(sim.AppendSnapshot(nil, fr), want); err != nil {
				t.Fatal(err)
			}
		}
	}}); err != nil {
		t.Fatal(err)
	}

	var out, errOut bytes.Buffer
	if status := run(context.Background(), []string{"replay", "-dump", strconv.Itoa(at), "-world", world, name}, env(nil), &out, &errOut); status != 0 {
		t.Fatalf("status %d: %s", status, errOut.String())
	}
	var got struct {
		Tick     int64
		Weathers []struct {
			From  int64
			Mode  uint8
			Speed uint32
		}
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
	if len(got.Weathers) != len(want.Weathers) {
		t.Fatalf("the developer's weathers %+v, the world's %+v", got.Weathers, want.Weathers)
	}
	for i, w := range got.Weathers {
		if x := want.Weathers[i]; w.From != x.From || w.Mode != uint8(x.Mode) || w.Speed != x.Speed {
			t.Fatalf("the developer's weathers %+v, the world's %+v", got.Weathers, want.Weathers)
		}
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
