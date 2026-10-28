// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"context"
	"math"
	"slices"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/coder/websocket"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// viewer is a game connection read raw, as a spectator's is: its
// messages, and its snapshots decoded into views.
type viewer struct {
	t     *testing.T
	ws    *websocket.Conn
	in    *client.Inbox
	views client.Views
	// welcome is the latest Welcome; snap and view the latest snapshot's
	// header and view, and snaps how many have come since the Welcome.
	welcome *pb.Welcome
	snap    protocol.Snapshot
	view    protocol.View
	snaps   int
	// ended is the latest WatchEnded; queued the latest Queued; watchers
	// the latest count told.
	ended    *pb.WatchEnded
	queued   *pb.Queued
	watchers *pb.Watchers
	// lamps are the agent's lamps told, in order.
	lamps  []pb.Lamp
	closed bool
}

// dial opens the game connection with the cookie and says hello.
func dial(t *testing.T, s *Server, cookie string, hello *pb.ClientMessage) *viewer {
	t.Helper()
	ws, _, err := s.Dial(t.Context(), DialOptions{Cookie: cookie})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.CloseNow() })
	if err := client.Send(t.Context(), ws, hello); err != nil {
		t.Fatal(err)
	}
	return &viewer{t: t, ws: ws, in: client.Read(ws)}
}

// send sends a client's message.
func (v *viewer) send(m *pb.ClientMessage) {
	v.t.Helper()
	if err := client.Send(v.t.Context(), v.ws, m); err != nil {
		v.t.Fatal(err)
	}
}

// read takes in what has come for d, or until done says so.
func (v *viewer) read(d time.Duration, done func() bool) bool {
	v.t.Helper()
	timeout := time.After(d)
	for done == nil || !done() {
		select {
		case r, ok := <-v.in.C:
			if !ok {
				v.closed = true
				return done != nil && done()
			}
			v.take(r)
		case <-timeout:
			return done == nil
		}
	}
	return true
}

func (v *viewer) take(r client.Received) {
	v.t.Helper()
	if r.Snapshot != nil {
		view, _, err := v.views.Decode(r.Bytes, r.Snapshot)
		if err != nil {
			v.t.Fatalf("a snapshot: %v", err)
		}
		v.snap, v.view = *r.Snapshot, *view
		v.snaps++
		return
	}
	switch m := r.Message.Body.(type) {
	case *pb.ServerMessage_Welcome:
		v.welcome, v.snaps, v.queued = m.Welcome, 0, nil
	case *pb.ServerMessage_WatchEnded:
		v.ended = m.WatchEnded
	case *pb.ServerMessage_Queued:
		v.queued = m.Queued
	case *pb.ServerMessage_Watchers:
		v.watchers = m.Watchers
	case *pb.ServerMessage_AgentLamp:
		v.lamps = append(v.lamps, m.AgentLamp.GetState())
	}
}

// lamp is the latest lamp told, unspecified for none.
func (v *viewer) lamp() pb.Lamp {
	if len(v.lamps) == 0 {
		return pb.Lamp_LAMP_UNSPECIFIED
	}
	return v.lamps[len(v.lamps)-1]
}

// welcomed reads until a Welcome and a snapshot after it have come.
func (v *viewer) welcomed() *pb.Welcome {
	v.t.Helper()
	v.welcome = nil
	if !v.read(5*time.Second, func() bool { return v.welcome != nil && v.snaps > 0 }) {
		v.t.Fatalf("no Welcome and snapshot (ended %v, queued %v, closed %v)", v.ended, v.queued, v.closed)
	}
	return v.welcome
}

// endedWith reads until a WatchEnded comes, and returns why.
func (v *viewer) endedWith() pb.WatchEnd {
	v.t.Helper()
	v.ended = nil
	if !v.read(5*time.Second, func() bool { return v.ended != nil }) {
		v.t.Fatalf("no WatchEnded (closed %v)", v.closed)
	}
	return v.ended.GetWhy()
}

// near is a state 100 m off the start, at rest.
func near(i int) physics.State {
	return physics.State{X: 100 + 60*float64(i), Y: 100, Heading: 1}
}

// slotOf is the slot an account's boat is in, −1 for none, and its boat.
func slotOf(s *Server, a bus.Account) (int32, uint64) {
	f := s.World.Bus().Frames.Acquire()
	defer f.Release()
	for _, slot := range f.Live {
		if f.Owner[slot] == a {
			return slot, f.Boat[slot]
		}
	}
	return -1, 0
}

func watchCount(s *Server, result string) float64 {
	return testutil.ToFloat64(s.Metrics.EdgeWatches.WithLabelValues(result))
}

// TestWatchOwnMachine: a player opens the game connection to watch their
// machine sailor, named by a look-alike of its name: the Welcome is the
// machine's boat's, mine, and the snapshots' header is that boat as the
// world has it. The player's controls are dropped and counted; the boat's
// controls stay as its agent left them.
func TestWatchOwnMachine(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{})
		token, ann := srv.Sailor("Ann Bonny")
		mary, boat := srv.Machine(t, "Iron Mary", ann, near(0))
		v := dial(t, srv, token, client.HelloWatch("IRON  MARY"))
		w := v.welcomed()
		if w.GetBoat() != boat || w.GetWatching().GetSailor() != "Iron Mary" || !w.GetWatching().GetMachine() || !w.GetWatching().GetMine() {
			t.Fatalf("the Welcome: %v", w)
		}
		if slot, _ := slotOf(srv, bus.Account(ann)); slot >= 0 {
			t.Fatal("the spectator has a boat")
		}
		v.read(time.Second, nil)
		slot, _ := slotOf(srv, bus.Account(mary))
		f := srv.World.Bus().Frames.Acquire()
		at := f.State[slot]
		before := f.Control[slot]
		f.Release()
		if d := math.Hypot(v.snap.State.X-at.X, v.snap.State.Y-at.Y); d > 1 {
			t.Fatalf("the header is %.1f m from the machine's boat", d)
		}
		if v.snap.Margin != protocol.NoMargin {
			t.Fatalf("a spectator's margin: %d", v.snap.Margin)
		}
		for i := range 30 {
			v.send(&pb.ClientMessage{Body: &pb.ClientMessage_Input{Input: &pb.Input{
				Seq: uint32(v.snap.Tick + 3 + int64(i)), Helm: 0, Sheet: 0, AckTick: v.snap.Tick, Pilot: 2, Target: 100,
			}}})
			v.read(time.Second/30, nil)
		}
		v.read(time.Second, nil)
		f = srv.World.Bus().Frames.Acquire()
		after := f.Control[slot]
		f.Release()
		if after != before {
			t.Fatalf("the spectator's controls reached the boat: %v, then %v", before, after)
		}
		if n := testutil.ToFloat64(srv.Metrics.EdgeRefused.WithLabelValues("input")); n != 30 {
			t.Fatalf("%v inputs refused", n)
		}
		if n := watchCount(srv, "started"); n != 1 {
			t.Fatalf("%v watches started", n)
		}
		if n := srv.Edge.Watchers(bus.Account(mary)); n != 1 {
			t.Fatalf("%d watch Iron Mary", n)
		}
	})
}

// TestWatchRefused: each refusal and its reason, the connection open and
// idle after it; a human who does not allow spectators reads the same
// whether at sea or not; one who allows them is watched.
func TestWatchRefused(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{})
		token, _ := srv.Sailor("Ann Bonny")
		_, bob := srv.Sailor("Bob")
		_, cid := srv.Sailor("Cid")
		_, owner := srv.Sailor("Dee")
		srv.Machine(t, "Iron Mary", owner, near(0))
		srv.Sessions.addMachine("Tin Tom", owner) // not at sea
		srv.Launch(t, bob, false, near(1))        // at sea, not allowing
		v := dial(t, srv, token, client.HelloWatch("Nobody"))
		for i, tc := range []struct {
			name string
			why  pb.WatchEnd
		}{
			{"Nobody", pb.WatchEnd_WATCH_END_NO_SAILOR},
			{"Ann Bonny", pb.WatchEnd_WATCH_END_OWN},
			{"Tin Tom", pb.WatchEnd_WATCH_END_NOT_AT_SEA},
			{"Bob", pb.WatchEnd_WATCH_END_CANNOT},
			{"Cid", pb.WatchEnd_WATCH_END_CANNOT},
		} {
			if i > 0 {
				time.Sleep(time.Second)
				v.send(client.Watch(tc.name))
			}
			if why := v.endedWith(); why != tc.why || v.ended.GetSailor() != tc.name {
				t.Errorf("%s: %v", tc.name, v.ended)
			}
		}
		// Asked again within the second.
		time.Sleep(time.Second)
		v.ended, v.welcome = nil, nil
		v.send(client.Watch("Iron Mary"))
		v.send(client.Watch("Iron Mary"))
		if !v.read(5*time.Second, func() bool { return v.welcome != nil && v.ended != nil }) || v.ended.GetWhy() != pb.WatchEnd_WATCH_END_QUICK {
			t.Fatalf("a second watch at once: %v, %v", v.welcome, v.ended)
		}
		// Bob allows spectators: watched.
		time.Sleep(time.Second)
		srv.Allowing.Set(bob, true)
		v.send(client.Watch("bob"))
		if w := v.welcomed(); w.GetWatching().GetSailor() != "Bob" || w.GetWatching().GetMachine() {
			t.Fatalf("watching Bob: %v", w)
		}
		_ = cid
		if n := watchCount(srv, "refused_not_allowed"); n != 4 {
			t.Fatalf("%v refused by the rule", n)
		}
	})
}

// TestSpectatorSeesWhatTheSailorSees: a spectator of a boat is sent, at
// the same tick, the same boats about it as the boat's own sailor, and
// nothing more: no boat its sailor is not sent, none kept unseen.
func TestSpectatorSeesWhatTheSailorSees(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{Capacity: 32})
		bobToken, bob := srv.Sailor("Bob")
		annToken, _ := srv.Sailor("Ann")
		srv.Allowing.Set(bob, true)
		sailor := dial(t, srv, bobToken, client.Hello())
		sailor.welcomed()
		srv.Place(sailor.welcome.GetBoat(), physics.State{X: 0, Y: 0, Heading: 1})
		// Boats about Bob, near and far, and one beyond the view.
		boats := srv.Crowd(t, 8, func(i int) physics.State {
			return physics.State{X: float64(i+1) * 80, Y: -200 + float64(i%3)*40, Heading: 1}
		})
		srv.Place(boats[7], physics.State{X: 2000, Y: 0, Heading: 1})
		srv.Owned(bus.Command{Op: bus.Unseen, Boat: boats[3], On: true})
		spectator := dial(t, srv, annToken, client.HelloWatch("Bob"))
		spectator.welcomed()
		// Both read for a while, then compare the views of one tick.
		seen := func(v *viewer) map[[2]int32]bool {
			out := map[[2]int32]bool{}
			for slot := range protocol.ViewSlots {
				if v.view.Has(slot) {
					b := &v.view.Boats[slot]
					out[[2]int32{b.X / 100, b.Y / 100}] = true
				}
			}
			return out
		}
		matched := 0
		for range 20 {
			sailor.read(time.Second/5, nil)
			spectator.read(time.Second/5, nil)
			for sailor.snap.Tick != spectator.snap.Tick {
				if sailor.snap.Tick < spectator.snap.Tick {
					sailor.read(time.Second, func() bool { return sailor.snap.Tick >= spectator.snap.Tick })
				} else {
					spectator.read(time.Second, func() bool { return spectator.snap.Tick >= sailor.snap.Tick })
				}
			}
			if sailor.snap.State != spectator.snap.State {
				t.Fatalf("tick %d: the header differs", sailor.snap.Tick)
			}
			// The far band is sampled on each connection's own snapshots:
			// near boats are compared.
			a, b := seen(sailor), seen(spectator)
			for k := range b {
				x, y := float64(k[0]), float64(k[1])
				if math.Hypot(x-sailor.snap.State.X, y-sailor.snap.State.Y) < 250 && !a[k] {
					t.Fatalf("tick %d: the spectator sees a boat at %v the sailor does not", sailor.snap.Tick, k)
				}
			}
			if len(a) != len(b) {
				t.Fatalf("tick %d: the sailor sees %d boats, the spectator %d", sailor.snap.Tick, len(a), len(b))
			}
			matched++
		}
		if matched == 0 {
			t.Fatal("no tick compared")
		}
		if n := len(seen(spectator)); n != 6 {
			t.Fatalf("the spectator sees %d boats, not the 6 in view and seen", n)
		}
	})
}

// TestWatchEnds: a watch ends, told why, when the watched sailor turns
// spectators off, when the boat is kept unseen, and when it leaves the
// water; the connection stays open, idle; and the owner's own machine
// sailor kept unseen is watched all the same.
func TestWatchEnds(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{})
		annToken, ann := srv.Sailor("Ann")
		_, bob := srv.Sailor("Bob")
		mary, maryBoat := srv.Machine(t, "Iron Mary", ann, near(0))
		bobBoat := srv.Launch(t, bob, false, near(1))
		srv.Allowing.Set(bob, true)
		v := dial(t, srv, annToken, client.HelloWatch("Bob"))
		v.welcomed()
		srv.Allowing.Set(bob, false)
		if why := v.endedWith(); why != pb.WatchEnd_WATCH_END_OFF {
			t.Fatalf("spectators off: %v", why)
		}
		srv.Allowing.Set(bob, true)
		time.Sleep(time.Second)
		v.send(client.Watch("Bob"))
		v.welcomed()
		srv.Owned(bus.Command{Op: bus.Unseen, Boat: bobBoat, On: true})
		if why := v.endedWith(); why != pb.WatchEnd_WATCH_END_CANNOT {
			t.Fatalf("unseen: %v", why)
		}
		// The own machine sailor, unseen.
		srv.Owned(bus.Command{Op: bus.Unseen, Boat: maryBoat, On: true})
		time.Sleep(time.Second)
		v.send(client.Watch("Iron Mary"))
		v.welcomed()
		v.ended = nil
		v.read(2*time.Second, nil)
		if v.ended != nil {
			t.Fatalf("the own unseen machine sailor's watch ended: %v", v.ended)
		}
		srv.Edge.Remove(bus.Account(mary), edge.ReasonStopped)
		if why := v.endedWith(); why != pb.WatchEnd_WATCH_END_LEFT || v.ended.GetSailor() != "Iron Mary" {
			t.Fatalf("the boat gone: %v", v.ended)
		}
		// Idle: no snapshots, pings answered.
		n := v.snaps
		v.send(&pb.ClientMessage{Body: &pb.ClientMessage_Ping{Ping: &pb.Ping{ClientTimeUs: 1}}})
		v.read(2*time.Second, nil)
		if v.snaps != n || v.closed {
			t.Fatalf("idle: %d snapshots more, closed %v", v.snaps-n, v.closed)
		}
		if srv.Edge.Spectators().Watching != 0 {
			t.Fatalf("an idle connection holds a place: %+v", srv.Edge.Spectators())
		}
	})
}

// TestSailToWatchAndBack: a sailor who watches leaves the water at once,
// their place freed to the first waiting; sailing again, they have a new
// boat at the start.
func TestSailToWatchAndBack(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{Limit: 2})
		annToken, ann := srv.Sailor("Ann")
		cidToken, cidID := srv.Sailor("Cid")
		srv.Machine(t, "Iron Mary", ann, near(0))
		v := dial(t, srv, annToken, client.Hello())
		w := v.welcomed()
		srv.Place(w.GetBoat(), physics.State{X: 300, Y: 300, Heading: 1})
		cid := dial(t, srv, cidToken, client.Hello())
		cid.read(2*time.Second, func() bool { return cid.queued != nil })
		if cid.queued == nil || cid.queued.GetSpectators() {
			t.Fatalf("Cid does not wait for a boat: %v", cid.queued)
		}
		v.send(client.Watch("Iron Mary"))
		v.welcomed()
		time.Sleep(time.Second / 15)
		if slot, _ := slotOf(srv, bus.Account(ann)); slot >= 0 {
			t.Fatal("Ann's boat is still in the water")
		}
		if w := cid.welcomed(); w.GetWatching() != nil {
			t.Fatalf("Cid's Welcome: %v", w)
		}
		// Ann sails again: the sea is full, so she waits, watching.
		v.send(client.Sail())
		v.read(2*time.Second, func() bool { return v.queued != nil })
		if v.queued == nil || v.queued.GetSpectators() {
			t.Fatalf("Ann does not wait for a boat: %v", v.queued)
		}
		n := v.snaps
		v.read(time.Second, nil)
		if v.snaps == n {
			t.Fatal("the watch stopped while Ann waits")
		}
		srv.Edge.Remove(bus.Account(cidID), edge.ReasonDeleted)
		w = v.welcomed()
		if w.GetWatching() != nil || w.GetBoat() == 0 || w.GetRejoined() {
			t.Fatalf("Ann's Welcome to her boat: %v", w)
		}
		if srv.Edge.Watchers(bus.Account(ann)) != 0 || srv.Edge.Spectators().Watching != 0 {
			t.Fatalf("the watch did not end: %+v", srv.Edge.Spectators())
		}
		if n := testutil.ToFloat64(srv.Metrics.EdgeJoins.WithLabelValues("sail")); n != 1 {
			t.Fatalf("%v joins from watching", n)
		}
	})
}

// TestHelloWatchTakesTheBoatOut: a connection that opens watching while
// the account's boat is in its grace takes the boat out of the water.
func TestHelloWatchTakesTheBoatOut(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{})
		annToken, ann := srv.Sailor("Ann")
		srv.Machine(t, "Iron Mary", ann, near(0))
		v := dial(t, srv, annToken, client.Hello())
		v.welcomed()
		v.ws.Close(websocket.StatusNormalClosure, "")
		time.Sleep(time.Second)
		if slot, _ := slotOf(srv, bus.Account(ann)); slot < 0 {
			t.Fatal("no boat in its grace")
		}
		v = dial(t, srv, annToken, client.HelloWatch("Iron Mary"))
		v.welcomed()
		time.Sleep(time.Second / 10)
		if slot, _ := slotOf(srv, bus.Account(ann)); slot >= 0 {
			t.Fatal("the boat in its grace is still in the water")
		}
	})
}

// TestSpectatorLimit: at the limit a spectator waits, told its place, and
// watches when a place frees; an owner watching their machine sailor, a
// priority account and a player waiting for a boat never wait; an idle
// connection holds no place.
func TestSpectatorLimit(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{SpectatorLimit: 1})
		_, owner := srv.Sailor("Owner")
		annToken, ann := srv.Sailor("Ann")
		bobToken, _ := srv.Sailor("Bob")
		pipToken, _ := srv.Priority("Pip")
		srv.Machine(t, "Iron Mary", owner, near(0))
		srv.Machine(t, "Ann's Own", ann, near(1))
		bob := dial(t, srv, bobToken, client.HelloWatch("Iron Mary"))
		bob.welcomed()
		annV := dial(t, srv, annToken, client.HelloWatch("Iron Mary"))
		annV.read(2*time.Second, func() bool { return annV.queued != nil })
		if q := annV.queued; q == nil || !q.GetSpectators() || q.GetPosition() != 1 {
			t.Fatalf("Ann's place: %v", q)
		}
		// Ann's own machine sailor: at once, past the limit.
		time.Sleep(time.Second)
		annV.send(client.Watch("Ann's Own"))
		if w := annV.welcomed(); !w.GetWatching().GetMine() {
			t.Fatalf("Ann's own: %v", w)
		}
		pip := dial(t, srv, pipToken, client.HelloWatch("Iron Mary"))
		pip.welcomed()
		if s := srv.Edge.Spectators(); s.Watching != 3 || s.Waiting != 0 {
			t.Fatalf("the spectators: %+v", s)
		}
		// Bob stops watching; Cid, waiting, watches.
		cidToken, _ := srv.Sailor("Cid")
		cid := dial(t, srv, cidToken, client.HelloWatch("Iron Mary"))
		cid.read(2*time.Second, func() bool { return cid.queued != nil })
		bob.send(client.Unwatch())
		bob.read(time.Second, nil)
		annV.send(client.Unwatch())
		pip.send(client.Unwatch())
		cid.welcomed()
		if s := srv.Edge.Spectators(); s.Watching != 1 || s.Waiting != 0 {
			t.Fatalf("after three stopped and one let in: %+v", s)
		}
	})
}

// TestWatchersTold: a sailor is told how many watch their boat, as it
// changes.
func TestWatchersTold(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{})
		bobToken, bob := srv.Sailor("Bob")
		annToken, _ := srv.Sailor("Ann")
		srv.Allowing.Set(bob, true)
		sailor := dial(t, srv, bobToken, client.Hello())
		sailor.welcomed()
		spectator := dial(t, srv, annToken, client.HelloWatch("Bob"))
		spectator.welcomed()
		if !sailor.read(3*time.Second, func() bool { return sailor.watchers.GetCount() == 1 }) {
			t.Fatalf("Bob was told %v", sailor.watchers)
		}
		spectator.ws.Close(websocket.StatusNormalClosure, "")
		if !sailor.read(3*time.Second, func() bool { return sailor.watchers != nil && sailor.watchers.GetCount() == 0 }) {
			t.Fatalf("Bob was told %v", sailor.watchers)
		}
	})
}

// TestStoppedSpectator: a spectator stopped by the game's operator is
// closed with 4003, and an AI account cannot watch.
func TestStoppedSpectator(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{})
		annToken, ann := srv.Sailor("Ann")
		srv.Machine(t, "Iron Mary", ann, near(0))
		v := dial(t, srv, annToken, client.HelloWatch("Iron Mary"))
		v.welcomed()
		srv.Edge.Remove(bus.Account(ann), edge.ReasonStopped)
		v.read(2*time.Second, func() bool { return v.closed })
		time.Sleep(time.Second / 10)
		if code := websocket.CloseStatus(v.in.Err()); code != edge.CloseRemoved {
			t.Fatalf("closed with %d", code)
		}
		if s := srv.Edge.Spectators(); s.Watching != 0 {
			t.Fatalf("the spectators: %+v", s)
		}
		agent, _ := srv.Sessions.Add("Agent", store.AI)
		if _, resp, err := srv.Dial(t.Context(), DialOptions{Cookie: agent}); err == nil || resp.StatusCode != 403 {
			t.Fatalf("an AI account: %v", err)
		}
	})
}

// TestGoSpectator: the Go client's spectator watches a machine sailor's
// boat, its snapshots decoded, as the load bot's spectators do.
func TestGoSpectator(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{})
		token, _ := srv.Sailor("Ann")
		_, owner := srv.Sailor("Dee")
		srv.Machine(t, "Iron Mary", owner, near(0))
		s := client.NewSpectator(func(ctx context.Context) (*websocket.Conn, error) {
			ws, _, err := srv.Dial(ctx, DialOptions{Cookie: token})
			return ws, err
		}, "Iron Mary")
		if err := s.Watch(t.Context(), 3*time.Second); err != nil {
			t.Fatal(err)
		}
		if s.Welcomed != 1 || s.Stats.Views < 40 || s.Stats.Dropped != 0 || s.Ended != 0 {
			t.Fatalf("welcomed %d, %d views, %d dropped, %d ended", s.Welcomed, s.Stats.Views, s.Stats.Dropped, s.Ended)
		}
	})
}

// agents stands in for the machine sailors' agents: each one's last call
// and whether a wait of its is under way.
type agents struct {
	mu      sync.Mutex
	last    map[bus.Account]time.Time
	waiting map[bus.Account]bool
}

func newAgents() *agents {
	return &agents{last: map[bus.Account]time.Time{}, waiting: map[bus.Account]bool{}}
}

func (a *agents) read(acc bus.Account) (time.Time, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.last[acc], a.waiting[acc]
}

// call is a call of the agent's now, a wait begun or ended with it.
func (a *agents) call(acc bus.Account, wait bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.last[acc], a.waiting[acc] = time.Now(), wait
}

// alive keeps connections open for d, reading them and pinging each as a
// client does.
func alive(d time.Duration, vs ...*viewer) {
	for end := time.Now().Add(d); time.Now().Before(end); {
		for _, v := range vs {
			v.send(&pb.ClientMessage{Body: &pb.ClientMessage_Ping{Ping: &pb.Ping{ClientTimeUs: 1}}})
			v.read(time.Second, nil)
		}
	}
}

// TestLampTold: an owner watching their own machine sailor is told its
// agent is at the helm while a wait of its is under way, and for a minute
// after its last call; quiet after that minute, and at the helm again at
// its next call; and nothing once the boat is gone. Another account
// watching the same boat is never told, nor a sailing connection.
func TestLampTold(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ag := newAgents()
		srv := NewServer(t, Config{Agent: ag.read})
		annToken, ann := srv.Sailor("Ann")
		bobToken, _ := srv.Sailor("Bob")
		carolToken, _ := srv.Sailor("Carol")
		mary, _ := srv.Machine(t, "Iron Mary", ann, near(0))
		maryAcc := bus.Account(mary)
		ag.call(maryAcc, true)
		owner := dial(t, srv, annToken, client.HelloWatch("Iron Mary"))
		if !owner.welcomed().GetWatching().GetMine() {
			t.Fatal("not Ann's own")
		}
		other := dial(t, srv, bobToken, client.HelloWatch("Iron Mary"))
		if other.welcomed().GetWatching().GetMine() {
			t.Fatal("Bob's own")
		}
		sailor := dial(t, srv, carolToken, client.Hello())
		sailor.welcomed()
		if !owner.read(3*time.Second, func() bool { return owner.lamp() == pb.Lamp_LAMP_AT_HELM }) {
			t.Fatalf("waiting: %v", owner.lamps)
		}
		// The wait ends with a call: at the helm for a minute more.
		ag.call(maryAcc, false)
		alive(edge.LampQuiet-5*time.Second, owner, other, sailor)
		if owner.lamp() != pb.Lamp_LAMP_AT_HELM {
			t.Fatalf("within the minute: %v", owner.lamps)
		}
		alive(6*time.Second, owner, other, sailor)
		if owner.lamp() != pb.Lamp_LAMP_QUIET {
			t.Fatalf("a minute without a call: %v (ended %v, closed %v)", owner.lamps, owner.ended, owner.closed)
		}
		ag.call(maryAcc, false)
		if !owner.read(3*time.Second, func() bool { return owner.lamp() == pb.Lamp_LAMP_AT_HELM }) {
			t.Fatalf("a call: %v", owner.lamps)
		}
		// Told on change only.
		if want := []pb.Lamp{pb.Lamp_LAMP_AT_HELM, pb.Lamp_LAMP_QUIET, pb.Lamp_LAMP_AT_HELM}; !slices.Equal(owner.lamps, want) {
			t.Fatalf("told %v, want %v", owner.lamps, want)
		}
		srv.Edge.Remove(maryAcc, edge.ReasonStopped)
		if why := owner.endedWith(); why != pb.WatchEnd_WATCH_END_LEFT {
			t.Fatalf("the boat gone: %v", why)
		}
		n := len(owner.lamps)
		owner.read(3*time.Second, nil)
		other.read(time.Second, nil)
		sailor.read(time.Second, nil)
		if len(owner.lamps) != n {
			t.Fatalf("told after the boat was gone: %v", owner.lamps[n:])
		}
		if len(other.lamps) != 0 || len(sailor.lamps) != 0 {
			t.Fatalf("told another account %v, a sailor %v", other.lamps, sailor.lamps)
		}
	})
}
