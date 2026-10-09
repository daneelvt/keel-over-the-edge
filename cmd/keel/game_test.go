// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"testing/synctest"
	"time"

	"github.com/coder/websocket"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/edge/edgetest"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// gameServer is keel serve on db, with a guest's session, and the guest's
// cookie; it is ready when it returns.
func gameServer(t *testing.T, vars map[string]string, db *memDB) (*server, string) {
	t.Helper()
	if db.sessions == nil {
		db.sessions = edgetest.NewSessions()
	}
	token, _ := db.sessions.Add("Ann", "human")
	return again(t, vars, db), token
}

// again is a keel serve on db, as the process after a restart; it is ready
// when it returns.
func again(t *testing.T, vars map[string]string, db *memDB) *server {
	t.Helper()
	s := startServer(t, vars, newMemNet(), db.with(serveOptions{}))
	time.Sleep(time.Second)
	return s
}

// connect opens the game connection through the play listener and waits
// for the Welcome; the connection is then read on a goroutine of its own.
func connect(t *testing.T, s *server, token string) (*websocket.Conn, *client.Inbox, *pb.Welcome) {
	t.Helper()
	h := http.Header{}
	h.Set("Cookie", auth.CookieName+"="+token)
	ws, _, err := websocket.Dial(t.Context(), "ws://127.0.0.1:8080/ws", &websocket.DialOptions{HTTPClient: s.client, HTTPHeader: h})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Send(t.Context(), ws, client.Hello()); err != nil {
		t.Fatal(err)
	}
	in := client.Read(ws)
	for r := range in.C {
		if w := r.Message.GetWelcome(); w != nil {
			return ws, in, w
		}
	}
	t.Fatalf("no welcome: %v", in.Err())
	return nil, nil, nil
}

// heard is what a connection heard as the server stopped.
type heard struct {
	bell      time.Time // when Restart came
	inMs      uint32
	afterBell int                // snapshots after it
	first     *protocol.Snapshot // the first snapshot
	last      *protocol.Snapshot // the last snapshot
	closed    time.Time
	code      websocket.StatusCode
}

// listen reads a connection to its end.
func listen(in *client.Inbox) heard {
	var h heard
	for r := range in.C {
		if rs := r.Message.GetRestart(); rs != nil && h.bell.IsZero() {
			h.bell, h.inMs = time.Now(), rs.GetInMs()
		}
		if r.Snapshot != nil {
			if h.first == nil {
				h.first = r.Snapshot
			}
			h.last = r.Snapshot
			if !h.bell.IsZero() {
				h.afterBell++
			}
		}
	}
	h.closed, h.code = time.Now(), websocket.CloseStatus(in.Err())
	return h
}

// TestStopRingsTheBell: as keel serve stops, every connection is told it
// is restarting, the world sails on through the bell and no further, the
// final checkpoint is the last frame, and only then are the connections
// closed with 1012.
func TestStopRingsTheBell(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		db := &memDB{epoch: bubbleEpoch}
		s, token := gameServer(t, map[string]string{}, db)
		_, in, _ := connect(t, s, token)
		time.Sleep(time.Second)
		heardCh := make(chan heard, 1)
		go func() { heardCh <- listen(in) }()
		stopped := time.Now()
		s.stop(t)
		h := <-heardCh
		if h.inMs != 3000 || h.code != websocket.StatusServiceRestart || h.bell.Sub(stopped) > 100*time.Millisecond {
			t.Fatalf("the bell %v after the stop, in %d ms; closed with %d", h.bell.Sub(stopped), h.inMs, h.code)
		}
		if d := h.closed.Sub(h.bell); d < 3*time.Second || d > 3*time.Second+time.Second/5 {
			t.Fatalf("closed %v after the bell", d)
		}
		// Snapshots go 15 a second: the world sailed through the bell.
		if n := h.afterBell; n < 40 || n > 47 {
			t.Fatalf("%d snapshots after the bell", n)
		}
		cp, _, _ := db.state()
		if cp == nil || cp.Tick < h.last.Tick || cp.Tick > h.last.Tick+2 || cp.Boats != 1 {
			t.Fatalf("the final checkpoint %+v; the last snapshot's tick %d", cp, h.last.Tick)
		}
		if !strings.Contains(s.logs.String(), `"msg":"the final checkpoint is written"`) {
			t.Fatal("the logs lack the final checkpoint")
		}
	})
}

// TestBellOfNone: with KEEL_BELL=0 the bell is still sent, and the world
// stops at once.
func TestBellOfNone(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		db := &memDB{epoch: bubbleEpoch}
		s, token := gameServer(t, map[string]string{"KEEL_BELL": "0s"}, db)
		_, in, _ := connect(t, s, token)
		time.Sleep(time.Second)
		heardCh := make(chan heard, 1)
		go func() { heardCh <- listen(in) }()
		s.stop(t)
		h := <-heardCh
		if h.bell.IsZero() || h.inMs != 0 || h.code != websocket.StatusServiceRestart || h.closed.Sub(h.bell) > 100*time.Millisecond || h.afterBell > 1 {
			t.Fatalf("bell %v, in %d ms, %d snapshots after it, closed %v after with %d", h.bell, h.inMs, h.afterBell, h.closed.Sub(h.bell), h.code)
		}
		if cp, _, _ := db.state(); cp == nil || cp.Tick > h.last.Tick+2 {
			t.Fatalf("the final checkpoint %+v", cp)
		}
	})
}

// TestStopWithDeadPeer: a client that has stopped answering holds the stop
// no longer than the closes' bound, after the final checkpoint.
func TestStopWithDeadPeer(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		db := &memDB{epoch: bubbleEpoch}
		s, token := gameServer(t, map[string]string{"KEEL_BELL": "0s"}, db)
		h := http.Header{}
		h.Set("Cookie", auth.CookieName+"="+token)
		ws, _, err := websocket.Dial(t.Context(), "ws://127.0.0.1:8080/ws", &websocket.DialOptions{HTTPClient: s.client, HTTPHeader: h})
		if err != nil {
			t.Fatal(err)
		}
		defer ws.CloseNow()
		client.Send(t.Context(), ws, client.Hello())
		// It never reads again: the in-memory pipe holds nothing, so the
		// server's writes wait.
		time.Sleep(time.Second)
		start := time.Now()
		s.stop(t)
		if d := time.Since(start); d < closeTimeout || d > closeTimeout+time.Second {
			t.Fatalf("stopping took %v", d)
		}
		if cp, _, _ := db.state(); cp == nil {
			t.Fatal("no final checkpoint")
		}
	})
}

// TestRestartKeepsTheBoats: a server stopped and a new one started on the
// same database: the player is welcomed back to their own boat, where it
// was; the scripted sailors find theirs; the lease's epoch is one higher.
func TestRestartKeepsTheBoats(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		db := &memDB{epoch: bubbleEpoch}
		vars := map[string]string{"KEEL_DEV_SAILORS": "5", "KEEL_DEV_COMMANDS": "1", "KEEL_BELL": "1s"}
		s, token := gameServer(t, vars, db)
		ws, in, welcome := connect(t, s, token)
		heardCh := make(chan heard, 1)
		go func() { heardCh <- listen(in) }()
		// Sail away from the start, then let the wind die, so the boat
		// lies still where it is.
		if err := client.Send(t.Context(), ws, &pb.ClientMessage{Body: &pb.ClientMessage_Input{Input: &pb.Input{Helm: 512, Sheet: 400}}}); err != nil {
			t.Fatal(err)
		}
		for i := range 70 / 5 {
			if i == 20/5 {
				res, err := s.client.Post(internalURL+"/debug/wind?knots=0&from=0", "", nil)
				if err != nil {
					t.Fatal(err)
				}
				res.Body.Close()
			}
			time.Sleep(5 * time.Second)
			client.Send(t.Context(), ws, &pb.ClientMessage{Body: &pb.ClientMessage_Ping{Ping: &pb.Ping{}}})
		}
		s.stop(t)
		h := <-heardCh
		if h.code != websocket.StatusServiceRestart || h.inMs != 1000 {
			t.Fatalf("closed with %d, bell in %d ms", h.code, h.inMs)
		}
		start, before := h.first.State, h.last.State

		s2 := again(t, vars, db)
		_, in2, w2 := connect(t, s2, token)
		if !w2.GetRejoined() || w2.GetBoat() != welcome.GetBoat() {
			t.Fatalf("welcomed back to boat %d (rejoined %v), had %d", w2.GetBoat(), w2.GetRejoined(), welcome.GetBoat())
		}
		var after *protocol.Snapshot
		for r := range in2.C {
			if r.Snapshot != nil {
				after = r.Snapshot
				break
			}
		}
		if math.Hypot(before.X-start.X, before.Y-start.Y) < 20 {
			t.Fatalf("the boat never left the start: %v, %v", before.X, before.Y)
		}
		if d := math.Hypot(after.State.X-before.X, after.State.Y-before.Y); d > 1 {
			t.Fatalf("the boat is %.2f m from where it was", d)
		}
		time.Sleep(time.Second)
		_, metrics, _ := get(t, s2.client, internalURL+"/metrics")
		for _, want := range []string{
			`keel_sim_restores_total{result="restored"} 1`, "keel_sim_restored_boats 6", "keel_sim_boats 6",
			"keel_sim_lease_epoch 2", `keel_sim_admissions_total{result="rejoined"} 6`, `keel_sim_admissions_total{result="joined"} 0`,
		} {
			if !strings.Contains(metrics, want) {
				t.Errorf("/metrics lacks %q", want)
			}
		}
		s2.stop(t)
		_, events, _ := db.state()
		launched := 0
		for _, e := range events {
			if e.Kind == store.EventLaunched {
				launched++
			}
		}
		if launched != 6 {
			t.Fatalf("%d boats launched in all: %+v", launched, events)
		}
	})
}

// TestSecondServerWaitsForTheLease: a server started while another runs the
// world waits, not ready and saying who holds the lease, and takes over
// once the other has stopped; a server stopped while it waits stops at once.
func TestSecondServerWaitsForTheLease(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		db := &memDB{epoch: bubbleEpoch}
		vars := map[string]string{"KEEL_BELL": "0s"}
		first, _ := gameServer(t, vars, db)
		second := startServer(t, vars, newMemNet(), db.with(serveOptions{}))
		time.Sleep(2 * time.Second)
		host, _ := os.Hostname()
		if code, body, _ := get(t, second.client, internalURL+"/readyz"); code != 503 || !strings.Contains(body, "waiting for the simulation lease (held by "+host+" dev)") {
			t.Fatalf("/readyz %d %q while the other holds the lease", code, body)
		}
		if code, _, _ := get(t, second.client, internalURL+"/livez"); code != 200 {
			t.Fatalf("/livez %d while waiting", code)
		}
		third := startServer(t, vars, newMemNet(), db.with(serveOptions{}))
		time.Sleep(time.Second)
		start := time.Now()
		third.stop(t)
		if d := time.Since(start); d > 100*time.Millisecond {
			t.Fatalf("a server waiting for the lease took %v to stop", d)
		}

		first.stop(t)
		start = time.Now()
		for {
			if code, _, _ := get(t, second.client, internalURL+"/readyz"); code == 200 {
				break
			}
			if time.Since(start) > 2*time.Second {
				t.Fatal("the second never took over")
			}
			time.Sleep(100 * time.Millisecond)
		}
		_, metrics, _ := get(t, second.client, internalURL+"/metrics")
		if !strings.Contains(metrics, "keel_sim_lease_epoch 2") || !strings.Contains(metrics, `keel_sim_restores_total{result="restored"} 1`) {
			t.Fatal("the second's lease or restore is not in its metrics")
		}
		second.stop(t)
	})
}

// TestLeaseLostStops: a lease lost for good stops the server at once,
// with no final checkpoint, and keel serve fails.
func TestLeaseLostStops(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		db := &memDB{epoch: bubbleEpoch}
		s, token := gameServer(t, map[string]string{}, db)
		_, in, _ := connect(t, s, token)
		time.Sleep(10 * time.Second)
		cp, _, _ := db.state()
		if cp == nil {
			t.Fatal("no checkpoint after 11 s")
		}
		heardCh := make(chan heard, 1)
		go func() { heardCh <- listen(in) }()
		close(db.lose)
		err := <-s.done
		s.done <- nil
		if !errors.Is(err, store.ErrLeaseLost) {
			t.Fatalf("keel serve: %v", err)
		}
		h := <-heardCh
		if h.inMs != 0 || h.code != websocket.StatusServiceRestart {
			t.Fatalf("bell in %d ms, closed with %d", h.inMs, h.code)
		}
		if after, _, _ := db.state(); after.Tick != cp.Tick {
			t.Fatalf("a checkpoint written after the lease was lost: tick %d, was %d", after.Tick, cp.Tick)
		}
	})
}

// TestFencedStops: another process has raised the lease's epoch: the next
// batch is refused, and the server stops as for a lost lease.
func TestFencedStops(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		db := &memDB{epoch: bubbleEpoch}
		s, _ := gameServer(t, map[string]string{"KEEL_DEV_SAILORS": "2"}, db)
		db.mu.Lock()
		db.leaseEpoch++
		db.mu.Unlock()
		select {
		case err := <-s.done:
			s.done <- nil
			if !errors.Is(err, store.ErrFenced) {
				t.Fatalf("keel serve: %v", err)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("still running, fenced")
		}
		if !strings.Contains(s.logs.String(), `"bell":"0s"`) {
			t.Fatal("the bell rang, fenced")
		}
	})
}

// TestRestoreRefuses: a checkpoint older than the grace, or of another
// format, catalog or physics layout, is not restored; the world starts
// empty, and the metrics say why.
func TestRestoreRefuses(t *testing.T) {
	// One restorable checkpoint, from a server that sailed a while.
	var good store.Checkpoint
	synctest.Test(t, func(t *testing.T) {
		db := &memDB{epoch: bubbleEpoch}
		s, _ := gameServer(t, map[string]string{"KEEL_DEV_SAILORS": "3", "KEEL_BELL": "0s"}, db)
		s.stop(t)
		cp, _, _ := db.state()
		good = *cp
	})
	for _, tc := range []struct {
		name   string
		change func(c *store.Checkpoint)
		wait   time.Duration
		result string
	}{
		{"none", nil, 0, "none"},
		{"too old", func(*store.Checkpoint) {}, 61 * time.Second, "too_old"},
		{"another format", func(c *store.Checkpoint) { c.Format = sim.SnapshotVersion - 1 }, 0, "incompatible"},
		{"another catalog", func(c *store.Checkpoint) { c.Catalog = "elsewhere" }, 0, "incompatible"},
		{"another layout", func(c *store.Checkpoint) { c.Layout++ }, 0, "incompatible"},
		{"unreadable", func(c *store.Checkpoint) { c.Data = c.Data[:len(c.Data)/2] }, 0, "incompatible"},
		{"in its grace", func(*store.Checkpoint) {}, 58 * time.Second, "restored"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				db := &memDB{epoch: bubbleEpoch}
				// A bubble's clock starts at the epoch: on to the
				// checkpoint's tick, and on by the wait.
				time.Sleep(time.Duration(good.Tick)*time.Second/30 + tc.wait)
				if tc.change != nil {
					c := good
					tc.change(&c)
					db.checkpoint = &c
				}
				s := again(t, map[string]string{"KEEL_BELL": "0s"}, db)
				_, metrics, _ := get(t, s.client, internalURL+"/metrics")
				boats := "keel_sim_boats 0"
				if tc.result == "restored" {
					boats = "keel_sim_boats 3"
				}
				for _, want := range []string{fmt.Sprintf(`keel_sim_restores_total{result=%q} 1`, tc.result), boats} {
					if !strings.Contains(metrics, want) {
						t.Errorf("/metrics lacks %q", want)
					}
				}
				s.stop(t)
			})
		})
	}
}

// TestSecondSignalKills: run again as a subprocess, keel serve is sent a
// signal, and while its bell rings, another: it dies at once.
func TestSecondSignalKills(t *testing.T) {
	if os.Getenv("KEEL_TEST_SIGNALS") == "1" {
		ctx, stop := signalContext()
		defer stop()
		vars := map[string]string{
			"KEEL_PLAY_ORIGIN": "https://play.example.com", "KEEL_DATABASE_URL": "postgres://keel@db.example.com/keel", "KEEL_BELL": "10s",
		}
		err := runServer(ctx, env(vars), os.Stdout, (&memDB{epoch: firstEpoch}).with(serveOptions{listen: newMemNet().listen, workers: 2}))
		fmt.Println("runServer returned:", err)
		os.Exit(0)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestSecondSignalKills$")
	cmd.Env = append(os.Environ(), "KEEL_TEST_SIGNALS=1")
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	logs := make(chan string, 64)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := out.Read(buf)
			if n > 0 {
				logs <- string(buf[:n])
			}
			if err != nil {
				close(logs)
				return
			}
		}
	}()
	waitFor := func(msg string) {
		t.Helper()
		deadline := time.After(20 * time.Second)
		for {
			select {
			case l, ok := <-logs:
				if !ok {
					t.Fatalf("the server ended before %s", msg)
				}
				if strings.Contains(l, msg) {
					return
				}
			case <-deadline:
				t.Fatalf("no %s", msg)
			}
		}
	}
	waitFor(`"msg":"ready"`)
	cmd.Process.Signal(syscall.SIGTERM)
	waitFor(`"msg":"stopping"`)
	start := time.Now()
	cmd.Process.Signal(syscall.SIGTERM)
	err = cmd.Wait()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.Sys().(syscall.WaitStatus).Signal() != syscall.SIGTERM || time.Since(start) > 5*time.Second {
		t.Fatalf("after a second signal: %v, %v later", err, time.Since(start))
	}
}

// TestWindRoute: POST /debug/wind is on the internal listener only with
// KEEL_DEV_COMMANDS=1, and the next snapshot carries the new wind.
func TestWindRoute(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s, _ := gameServer(t, map[string]string{}, &memDB{epoch: bubbleEpoch})
		res, err := s.client.Post(internalURL+"/debug/wind?knots=12&from=90", "", nil)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusNotFound && res.StatusCode != http.StatusMethodNotAllowed {
			t.Fatalf("without KEEL_DEV_COMMANDS: %d", res.StatusCode)
		}
		s.stop(t)
	})
	synctest.Test(t, func(t *testing.T) {
		s, token := gameServer(t, map[string]string{"KEEL_DEV_COMMANDS": "1"}, &memDB{epoch: bubbleEpoch})
		_, in, _ := connect(t, s, token)
		for _, base := range []string{playURL, agentsURL} {
			res, err := s.client.Post(base+"/debug/wind?knots=12&from=90", "", nil)
			if err != nil {
				t.Fatal(err)
			}
			res.Body.Close()
			if res.StatusCode == http.StatusNoContent {
				t.Fatalf("%s serves the wind route", base)
			}
		}
		res, err := s.client.Post(internalURL+"/debug/wind?knots=x", "", nil)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("a bad wind: %d", res.StatusCode)
		}
		res, err = s.client.Post(internalURL+"/debug/wind?knots=12&from=90", "", nil)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusNoContent {
			t.Fatalf("the wind route answered %d", res.StatusCode)
		}
		var sn *protocol.Snapshot
		for r := range in.C {
			if r.Snapshot != nil && r.Snapshot.Wind.Speed == 12*1852.0/3600 {
				sn = r.Snapshot
				break
			}
		}
		if sn == nil || sn.Wind.From != 90*3.141592653589793/180 {
			t.Fatalf("snapshot %+v", sn)
		}
		s.stop(t)
	})
}
