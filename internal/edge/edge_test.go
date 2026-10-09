// SPDX-License-Identifier: AGPL-3.0-only

package edge_test

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/coder/websocket"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/edge/edgetest"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/sim/loop"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// closedWith reads until the connection ends and returns the close code the
// server sent, or −1 if it sent none.
func closedWith(t *testing.T, ws *websocket.Conn) websocket.StatusCode {
	t.Helper()
	for {
		if _, _, err := ws.Read(context.Background()); err != nil {
			return websocket.CloseStatus(err)
		}
	}
}

func count(t *testing.T, s *edgetest.Server, vec string, labels ...string) float64 {
	t.Helper()
	m := s.Metrics
	switch vec {
	case "upgrades":
		return testutil.ToFloat64(m.EdgeUpgrades.WithLabelValues(labels...))
	case "hello":
		return testutil.ToFloat64(m.EdgeHellos.WithLabelValues(labels...))
	case "joins":
		return testutil.ToFloat64(m.EdgeJoins.WithLabelValues(labels...))
	case "closes":
		return testutil.ToFloat64(m.EdgeCloses.WithLabelValues(labels...))
	case "dropped":
		return testutil.ToFloat64(m.EdgeDropped.WithLabelValues(labels...))
	}
	t.Fatalf("no metric %s", vec)
	return 0
}

// boat is the frame's boat of an account's slot, read from the latest
// frame.
func boatOf(s *edgetest.Server, slot int32) (occupied bool, conn uint64, grace int64) {
	f := s.World.Bus().Frames.Acquire()
	defer f.Release()
	return f.Occupied[slot], f.Conn[slot], f.Grace[slot]
}

func TestNoSessionNoUpgrade(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := edgetest.NewServer(t, edgetest.Config{})
		_, resp, err := s.Dial(t.Context(), edgetest.DialOptions{})
		if err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("without a cookie: %v, %v", resp, err)
		}
		_, resp, err = s.Dial(t.Context(), edgetest.DialOptions{Cookie: "not-a-session"})
		if err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("with an unknown cookie: %v, %v", resp, err)
		}
		if n := count(t, s, "upgrades", "no_session"); n != 2 {
			t.Fatalf("%v counted", n)
		}
	})
}

func TestAIAccountRefused(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := edgetest.NewServer(t, edgetest.Config{})
		token, _ := s.Sessions.Add("Agent", store.AI)
		_, resp, err := s.Dial(t.Context(), edgetest.DialOptions{Cookie: token})
		if err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
			t.Fatalf("an AI account: %v, %v", resp, err)
		}
		if n := count(t, s, "upgrades", "ai_account"); n != 1 {
			t.Fatalf("%v counted", n)
		}
	})
}

// TestOrigins: the upgrade's Origin against the server's own host
// (example.com, on the in-memory network) and the players' origin.
func TestOrigins(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := edgetest.NewServer(t, edgetest.Config{})
		token, _ := s.Guest("Ann")
		for _, tc := range []struct {
			origin string
			ok     bool
		}{
			{"", true},                            // not a browser
			{"http://example.com", true},          // the request's own host
			{edgetest.PlayOrigin, true},           // the players' origin
			{"https://play.keel.test:444", false}, // another port
			{"https://keel.test", false},          // the website, not the game
			{"https://evil.example", false},       // another site
			{"null", false},                       // a sandboxed or file: page
		} {
			ws, resp, err := s.Dial(t.Context(), edgetest.DialOptions{Cookie: token, Origin: tc.origin})
			if tc.ok != (err == nil) {
				t.Errorf("Origin %q: %v (%v)", tc.origin, err, resp)
			}
			if !tc.ok && (resp == nil || resp.StatusCode != http.StatusForbidden) {
				t.Errorf("Origin %q: answered %v", tc.origin, resp)
			}
			if ws != nil {
				ws.Close(websocket.StatusNormalClosure, "")
			}
		}
		if n := count(t, s, "upgrades", "origin"); n != 4 {
			t.Fatalf("%v refused for their origin", n)
		}
	})
}

func TestHelloVersions(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := edgetest.NewServer(t, edgetest.Config{})
		token, _ := s.Guest("Ann")
		for _, tc := range []struct {
			label string
			edit  func(h *pb.Hello)
		}{
			{"protocol", func(h *pb.Hello) { h.Protocol = "0000000000000000" }},
			{"catalog", func(h *pb.Hello) { h.Catalog = "old" }},
			{"layout", func(h *pb.Hello) { h.PhysicsLayout++ }},
		} {
			ws, _, err := s.Dial(t.Context(), edgetest.DialOptions{Cookie: token})
			if err != nil {
				t.Fatal(err)
			}
			hello := edgetest.Hello()
			tc.edit(hello.GetHello())
			if err := edgetest.Send(t.Context(), ws, hello); err != nil {
				t.Fatal(err)
			}
			if code := closedWith(t, ws); code != edge.CloseVersion {
				t.Errorf("%s differs: closed with %d", tc.label, code)
			}
			if n := count(t, s, "hello", tc.label); n != 1 {
				t.Errorf("%s: %v counted", tc.label, n)
			}
		}
	})
}

func TestNoHello(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := edgetest.NewServer(t, edgetest.Config{})
		token, _ := s.Guest("Ann")
		ws, _, err := s.Dial(t.Context(), edgetest.DialOptions{Cookie: token})
		if err != nil {
			t.Fatal(err)
		}
		start := time.Now()
		if code := closedWith(t, ws); code != websocket.StatusPolicyViolation {
			t.Fatalf("closed with %d", code)
		}
		if d := time.Since(start); d != edge.DefaultLimits.Hello {
			t.Fatalf("closed after %v", d)
		}
		if n := count(t, s, "hello", "timeout"); n != 1 {
			t.Fatalf("%v counted", n)
		}
	})
}

// TestWelcome: the Welcome names the boat and the tick of the first frame
// that holds it, the snapshots follow on even ticks, and the account's
// next connection finds the same boat.
func TestWelcome(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := edgetest.NewServer(t, edgetest.Config{})
		token, _ := s.Guest("Ann")
		ws, w, err := s.Connect(t.Context(), edgetest.DialOptions{Cookie: token})
		if err != nil {
			t.Fatal(err)
		}
		if w.GetWorld() != edgetest.WorldID || w.GetBoat() != 1 || w.GetRejoined() || w.GetKind() != 0 {
			t.Fatalf("welcome %v", w)
		}
		f := s.World.Bus().Frames.Acquire()
		if f.Tick < w.GetTick() || !f.Occupied[0] || f.Boat[0] != 1 {
			t.Fatalf("frame %d, welcome of tick %d", f.Tick, w.GetTick())
		}
		f.Release()
		if wt, now := w.GetWorldTimeUs(), time.Since(edgetest.Epoch).Microseconds(); wt != now {
			t.Fatalf("world time %d µs, now %d", wt, now)
		}
		last := int64(0)
		for range 10 {
			r, err := edgetest.Receive(t.Context(), ws)
			if err != nil {
				t.Fatal(err)
			}
			sn := r.Snapshot
			if sn == nil {
				t.Fatalf("not a snapshot: %v", r.Message)
			}
			if sn.Tick%2 != 0 || sn.Tick < w.GetTick() || last != 0 && sn.Tick != last+2 {
				t.Fatalf("a snapshot of tick %d after %d (welcome %d)", sn.Tick, last, w.GetTick())
			}
			if sn.Helm != bus.Steps/2 || sn.Sheet != bus.Steps/2 || sn.Margin != protocol.NoMargin || len(r.Bytes) != protocol.SnapshotSize {
				t.Fatalf("snapshot %+v", sn)
			}
			last = sn.Tick
		}
		if first := last - 18; first-w.GetTick() > 2 {
			t.Fatalf("the first snapshot, of tick %d, came %d ticks after the welcome", first, first-w.GetTick())
		}
		ws.Close(websocket.StatusNormalClosure, "")
		time.Sleep(time.Second)
		if _, _, grace := boatOf(s, 0); grace == 0 {
			t.Fatal("no grace after the connection ended")
		}
		ws, w, err = s.Connect(t.Context(), edgetest.DialOptions{Cookie: token})
		if err != nil {
			t.Fatal(err)
		}
		defer ws.CloseNow()
		if w.GetBoat() != 1 || !w.GetRejoined() {
			t.Fatalf("again: %v", w)
		}
		if _, _, grace := boatOf(s, 0); grace != 0 {
			t.Fatal("the grace runs on after the account came back")
		}
		if j, r := count(t, s, "joins", "joined"), count(t, s, "joins", "rejoined"); j != 1 || r != 1 {
			t.Fatalf("joined %v, rejoined %v", j, r)
		}
	})
}

func TestFull(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := edgetest.NewServer(t, edgetest.Config{Capacity: 1})
		ann, _ := s.Guest("Ann")
		bob, _ := s.Guest("Bob")
		ws, _, err := s.Connect(t.Context(), edgetest.DialOptions{Cookie: ann})
		if err != nil {
			t.Fatal(err)
		}
		defer ws.CloseNow()
		ws2, _, err := s.Dial(t.Context(), edgetest.DialOptions{Cookie: bob})
		if err != nil {
			t.Fatal(err)
		}
		edgetest.Send(t.Context(), ws2, edgetest.Hello())
		if code := closedWith(t, ws2); code != websocket.StatusTryAgainLater {
			t.Fatalf("a full world closed with %d", code)
		}
		if n := count(t, s, "joins", "full"); n != 1 {
			t.Fatalf("%v counted", n)
		}
	})
}

// TestHeldTenMinutes: a connection that pings every 2 s outlives every
// timeout the server has.
func TestHeldTenMinutes(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := edgetest.NewServer(t, edgetest.Config{})
		token, _ := s.Guest("Ann")
		ws, _, err := s.Connect(t.Context(), edgetest.DialOptions{Cookie: token})
		if err != nil {
			t.Fatal(err)
		}
		defer ws.CloseNow()
		in := edgetest.Read(ws)
		pongs, snapshots := 0, 0
		for i := range 300 {
			edgetest.Send(t.Context(), ws, &pb.ClientMessage{Body: &pb.ClientMessage_Ping{Ping: &pb.Ping{ClientTimeUs: int64(i)}}})
			timer := time.After(2 * time.Second)
			for waiting := true; waiting; {
				select {
				case r, ok := <-in.C:
					if !ok {
						t.Fatalf("after %d pings: %v", i, in.Err())
					}
					if p := r.Message.GetPong(); p != nil {
						if p.GetClientTimeUs() != int64(i) {
							t.Fatalf("pong %v to ping %d", p, i)
						}
						pongs++
					}
					if r.Snapshot != nil {
						snapshots++
					}
				case <-timer:
					waiting = false
				}
			}
		}
		if pongs != 300 || snapshots < 300*2*15-30 {
			t.Fatalf("%d pongs, %d snapshots in ten minutes", pongs, snapshots)
		}
	})
}

func TestMessageTooBig(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := edgetest.NewServer(t, edgetest.Config{})
		token, _ := s.Guest("Ann")
		ws, _, err := s.Connect(t.Context(), edgetest.DialOptions{Cookie: token})
		if err != nil {
			t.Fatal(err)
		}
		ws.Write(t.Context(), websocket.MessageBinary, make([]byte, 2000))
		if code := closedWith(t, ws); code != websocket.StatusMessageTooBig {
			t.Fatalf("closed with %d", code)
		}
		synctest.Wait()
		if n := count(t, s, "closes", "1009"); n != 1 {
			t.Fatalf("%v counted", n)
		}
	})
}

func TestUnsupportedData(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := edgetest.NewServer(t, edgetest.Config{})
		token, _ := s.Guest("Ann")
		for _, send := range []func(ws *websocket.Conn){
			func(ws *websocket.Conn) { ws.Write(t.Context(), websocket.MessageText, []byte("hello")) },
			func(ws *websocket.Conn) { ws.Write(t.Context(), websocket.MessageBinary, []byte{9, 1, 2}) },
			func(ws *websocket.Conn) {
				ws.Write(t.Context(), websocket.MessageBinary, []byte{protocol.KindSnapshot, 1})
			},
			func(ws *websocket.Conn) {
				ws.Write(t.Context(), websocket.MessageBinary, []byte{protocol.KindMessage, 0xff})
			},
		} {
			ws, _, err := s.Connect(t.Context(), edgetest.DialOptions{Cookie: token})
			if err != nil {
				t.Fatal(err)
			}
			send(ws)
			if code := closedWith(t, ws); code != websocket.StatusUnsupportedData {
				t.Fatalf("closed with %d", code)
			}
		}
	})
}

// TestIdle: a connection silent for 60 s is dropped without a close frame,
// and its boat's grace begins.
func TestIdle(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := edgetest.NewServer(t, edgetest.Config{})
		token, _ := s.Guest("Ann")
		ws, _, err := s.Connect(t.Context(), edgetest.DialOptions{Cookie: token})
		if err != nil {
			t.Fatal(err)
		}
		start := time.Now()
		if code := closedWith(t, ws); code != -1 {
			t.Fatalf("closed with %d", code)
		}
		// The minute runs from the Hello, a tick or two before the Welcome.
		if d := time.Since(start); d < edge.DefaultLimits.Idle-time.Second || d > edge.DefaultLimits.Idle {
			t.Fatalf("dropped after %v", d)
		}
		time.Sleep(100 * time.Millisecond)
		if occupied, _, grace := boatOf(s, 0); !occupied || grace == 0 {
			t.Fatalf("occupied %v, grace %d", occupied, grace)
		}
		if n := count(t, s, "closes", "none"); n != 1 {
			t.Fatalf("%v counted", n)
		}
	})
}

// TestRate: 60 messages a second go on for ever; 200 a second close the
// connection within seconds.
func TestRate(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := edgetest.NewServer(t, edgetest.Config{})
		token, _ := s.Guest("Ann")
		ack := &pb.ClientMessage{Body: &pb.ClientMessage_Input{Input: &pb.Input{AckOnly: true}}}
		ws, _, err := s.Connect(t.Context(), edgetest.DialOptions{Cookie: token})
		if err != nil {
			t.Fatal(err)
		}
		ended := make(chan websocket.StatusCode, 1)
		go func() { ended <- closedWith(t, ws) }()
		for range 60 * 30 {
			if err := edgetest.Send(t.Context(), ws, ack); err != nil {
				t.Fatalf("at 60 a second: %v", err)
			}
			time.Sleep(time.Second / 60)
		}
		select {
		case code := <-ended:
			t.Fatalf("60 a second closed with %d", code)
		default:
		}
		ws.Close(websocket.StatusNormalClosure, "")
		<-ended

		ws, _, err = s.Connect(t.Context(), edgetest.DialOptions{Cookie: token})
		if err != nil {
			t.Fatal(err)
		}
		go func() { ended <- closedWith(t, ws) }()
		start := time.Now()
		for time.Since(start) < 10*time.Second {
			if edgetest.Send(t.Context(), ws, ack) != nil {
				break
			}
			time.Sleep(time.Second / 200)
		}
		if code := <-ended; code != websocket.StatusPolicyViolation {
			t.Fatalf("200 a second closed with %d", code)
		}
		if d := time.Since(start); d > 3*time.Second {
			t.Fatalf("closed after %v", d)
		}
		if n := count(t, s, "dropped", "rate"); n < 120 {
			t.Fatalf("%v dropped", n)
		}
	})
}

// changes records the control words each tick applied.
type changes struct {
	mu    sync.Mutex
	words map[int64][]bus.Word
}

func (c *changes) Record(f *bus.Frame) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, sw := range f.Changed {
		c.words[f.Tick] = append(c.words[f.Tick], sw.Word)
	}
}

// TestTakeover: a second connection for the account takes its boat; the
// first is closed with 4001, and no word it sent is applied after the
// second's Welcome, though it sends them as fast as it may to the end.
func TestTakeover(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		rec := &changes{words: map[int64][]bus.Word{}}
		s := edgetest.NewServer(t, edgetest.Config{Record: rec})
		token, _ := s.Guest("Ann")
		first, _, err := s.Connect(t.Context(), edgetest.DialOptions{Cookie: token})
		if err != nil {
			t.Fatal(err)
		}
		// The first connection floods words with helm 7, each stamped a
		// few ticks ahead, as a client that runs ahead does.
		ended := make(chan websocket.StatusCode, 1)
		go func() {
			in := edgetest.Read(first)
			var tick int64
			for {
				select {
				case r, ok := <-in.C:
					if !ok {
						ended <- websocket.CloseStatus(in.Err())
						return
					}
					if r.Snapshot != nil {
						tick = r.Snapshot.Tick
					}
				case <-time.After(time.Second / 60):
				}
				if tick != 0 {
					edgetest.Send(t.Context(), first, &pb.ClientMessage{Body: &pb.ClientMessage_Input{Input: &pb.Input{
						Seq: uint32(tick + 5), Helm: 7, Sheet: uint32(tick % 1000),
					}}})
				}
			}
		}()
		time.Sleep(2 * time.Second)
		second, w, err := s.Connect(t.Context(), edgetest.DialOptions{Cookie: token})
		if err != nil {
			t.Fatal(err)
		}
		defer second.CloseNow()
		if !w.GetRejoined() || w.GetBoat() != 1 {
			t.Fatalf("the second connection's welcome: %v", w)
		}
		if code := <-ended; code != edge.CloseReplaced {
			t.Fatalf("the first connection closed with %d", code)
		}
		time.Sleep(3 * time.Second)
		rec.mu.Lock()
		defer rec.mu.Unlock()
		before := 0
		for tick, words := range rec.words {
			for _, word := range words {
				if word.HelmIndex() != 7 {
					continue
				}
				if tick > w.GetTick() {
					t.Errorf("tick %d, after the second connection's welcome at %d, applied the first's word %#x", tick, w.GetTick(), word)
				}
				before++
			}
		}
		if before == 0 {
			t.Fatal("the first connection's words were never applied")
		}
		if _, conn, _ := boatOf(s, 0); conn != 2 {
			t.Fatalf("the boat is connection %d's", conn)
		}
	})
}

// TestMargin: the margin is how many ticks before its tick an input
// arrived, and each snapshot carries the lowest since the one before.
func TestMargin(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := edgetest.NewServer(t, edgetest.Config{})
		token, _ := s.Guest("Ann")
		ws, _, err := s.Connect(t.Context(), edgetest.DialOptions{Cookie: token})
		if err != nil {
			t.Fatal(err)
		}
		defer ws.CloseNow()
		next := func() *protocol.Snapshot {
			t.Helper()
			for {
				r, err := edgetest.Receive(t.Context(), ws)
				if err != nil {
					t.Fatal(err)
				}
				if r.Snapshot != nil {
					return r.Snapshot
				}
			}
		}
		input := func(seq int64, helm uint32) {
			edgetest.Send(t.Context(), ws, &pb.ClientMessage{Body: &pb.ClientMessage_Input{Input: &pb.Input{Seq: uint32(seq), Helm: helm, Sheet: 512}}})
		}
		sn := next()
		// In the bubble no time passes between the snapshot and the input:
		// the latest tick is still the snapshot's, the next to run one on.
		input(sn.Tick+5, 100) // margin 4
		synctest.Wait()
		input(sn.Tick+3, 200) // margin 2, and it replaces the first
		sn2 := next()
		if sn2.Margin != 2 {
			t.Fatalf("margin %d, want 2", sn2.Margin)
		}
		if sn3 := next(); sn3.Margin != protocol.NoMargin || sn3.Seq != uint32(sn.Tick+3) || sn3.Helm != 200 {
			t.Fatalf("the next: %+v", sn3)
		}
		late := next()
		input(late.Tick-4, 300) // margin −5
		if sn := next(); sn.Margin != -5 || sn.Helm != 300 {
			t.Fatalf("late: margin %d, helm %d", sn.Margin, sn.Helm)
		}
	})
}

// TestStalledReader: a client that stops reading holds up the server's
// writes; after 10 s the connection is dropped.
func TestStalledReader(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := edgetest.NewServer(t, edgetest.Config{})
		token, _ := s.Guest("Ann")
		ws, _, err := s.Connect(t.Context(), edgetest.DialOptions{Cookie: token, Wrap: edgetest.SmallReadBuffer(4096)})
		if err != nil {
			t.Fatal(err)
		}
		defer ws.CloseNow()
		// Pings keep the connection from being idle, and their pongs queue.
		start := time.Now()
		for time.Since(start) < 20*time.Second && testutil.ToFloat64(s.Metrics.EdgeConnections) == 1 {
			edgetest.Send(t.Context(), ws, &pb.ClientMessage{Body: &pb.ClientMessage_Ping{Ping: &pb.Ping{}}})
			time.Sleep(time.Second / 30)
		}
		if n := testutil.ToFloat64(s.Metrics.EdgeConnections); n != 0 {
			t.Fatalf("%v connections after 20 s of not reading", n)
		}
		// 30 pings a second fill the queue of 256 in under 10 s: the
		// connection is closed for that first.
		if n := count(t, s, "closes", "1008"); n != 1 {
			t.Fatalf("closes: 1008 %v", n)
		}
	})
}

// TestStalledWriteDropped: with nothing queued, a write held up for 10 s
// drops the connection.
func TestStalledWriteDropped(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := edgetest.NewServer(t, edgetest.Config{Limits: edge.Limits{Idle: time.Hour}})
		token, _ := s.Guest("Ann")
		ws, _, err := s.Connect(t.Context(), edgetest.DialOptions{Cookie: token, Wrap: edgetest.SmallReadBuffer(4096)})
		if err != nil {
			t.Fatal(err)
		}
		defer ws.CloseNow()
		start := time.Now()
		for testutil.ToFloat64(s.Metrics.EdgeConnections) == 1 && time.Since(start) < time.Minute {
			time.Sleep(100 * time.Millisecond)
		}
		// The buffer holds about 26 snapshots, under 2 s of them; then a
		// write waits 10 s.
		if d := time.Since(start); d < 10*time.Second || d > 13*time.Second {
			t.Fatalf("dropped after %v", d)
		}
		if n := count(t, s, "closes", "none"); n != 1 {
			t.Fatalf("closes: none %v", n)
		}
		if n := count(t, s, "dropped", "snapshot_replaced"); n == 0 {
			t.Fatal("no snapshot was replaced while the write waited")
		}
	})
}

// TestShutdown: every connection is closed with 1012, and new ones are
// refused.
func TestShutdown(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := edgetest.NewServer(t, edgetest.Config{})
		token, _ := s.Guest("Ann")
		ws, _, err := s.Connect(t.Context(), edgetest.DialOptions{Cookie: token})
		if err != nil {
			t.Fatal(err)
		}
		ended := make(chan websocket.StatusCode, 1)
		go func() { ended <- closedWith(t, ws) }()
		if err := s.Edge.Shutdown(t.Context()); err != nil {
			t.Fatal(err)
		}
		if code := <-ended; code != websocket.StatusServiceRestart {
			t.Fatalf("closed with %d", code)
		}
		_, resp, err := s.Dial(t.Context(), edgetest.DialOptions{Cookie: token})
		if err == nil || resp == nil || resp.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("after shutting down: %v, %v", resp, err)
		}
	})
}

// TestDrag: a word a tick, each stamped a few ticks ahead, as while the
// tiller is dragged: every one is applied, at the tick it was stamped for.
func TestDrag(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		rec := &changes{words: map[int64][]bus.Word{}}
		s := edgetest.NewServer(t, edgetest.Config{Record: rec})
		token, _ := s.Guest("Ann")
		ws, _, err := s.Connect(t.Context(), edgetest.DialOptions{Cookie: token})
		if err != nil {
			t.Fatal(err)
		}
		defer ws.CloseNow()
		edgetest.Read(ws)
		// Halfway between ticks, as a client's frames fall.
		time.Sleep(time.Second / 60)
		sent := 0
		for range 300 {
			seq := loop.TickAt(time.Now(), edgetest.Epoch) + 3
			edgetest.Send(t.Context(), ws, &pb.ClientMessage{Body: &pb.ClientMessage_Input{Input: &pb.Input{
				Seq: uint32(seq), Helm: uint32(seq % 1000), Sheet: 512,
			}}})
			sent++
			time.Sleep(time.Second / 30)
		}
		time.Sleep(time.Second)
		rec.mu.Lock()
		defer rec.mu.Unlock()
		applied := 0
		for tick, words := range rec.words {
			for _, w := range words {
				if uint32(tick) != w.Seq() {
					t.Errorf("a word for tick %d applied at %d", w.Seq(), tick)
				}
				applied++
			}
		}
		if applied != sent {
			t.Fatalf("%d words sent, %d applied", sent, applied)
		}
	})
}
