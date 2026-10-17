// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"math"
	"slices"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
)

// The owner's free camera on the wire: Roam from an account with the
// owner's flag moves the connection's eye, and its boat stays; from any
// other account it does nothing at all.

// boatIn is the server's boat of an account: its slot and what the frame
// says of it.
type boatIn struct {
	slot   int32
	state  physics.State
	stays  bool
	unseen bool
}

func boatAt(s *Server, account bus.Account) boatIn {
	f := s.World.Bus().Frames.Acquire()
	defer f.Release()
	for _, slot := range f.Live {
		if f.Owner[slot] == account {
			return boatIn{slot, f.State[slot], f.Stay[slot], f.Unseen[slot]}
		}
	}
	return boatIn{slot: -1}
}

// seen is what a sailor's views have held: the furthest any boat in view
// was from where the sailor's own boat was, and the boats' places by the
// tick, as the views had them.
type seen struct {
	mu       sync.Mutex
	furthest float64
	at       map[int64][][2]float64
}

func watchViews(s *client.Sailor) *seen {
	w := &seen{at: map[int64][][2]float64{}}
	s.OnView = func(ev *client.Event) {
		w.mu.Lock()
		defer w.mu.Unlock()
		own := ev.Snapshot.State
		var at [][2]float64
		for slot := range protocol.ViewSlots {
			if !ev.View.Has(slot) {
				continue
			}
			b := &ev.View.Boats[slot]
			x, y := float64(b.X)/100, float64(b.Y)/100
			w.furthest = max(w.furthest, math.Hypot(x-own.X, y-own.Y))
			at = append(at, [2]float64{x, y})
		}
		w.at[ev.Snapshot.Tick] = at
	}
	return w
}

// holds reports whether the latest view held a boat within 5 m of (x, y),
// and the furthest any view's boat was from the sailor's own.
func (w *seen) holds(x, y float64) (bool, float64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	var last int64 = math.MinInt64
	for t := range w.at {
		last = max(last, t)
	}
	for _, p := range w.at[last] {
		if math.Hypot(p[0]-x, p[1]-y) < 5 {
			return true, w.furthest
		}
	}
	return false, w.furthest
}

// roamWorld is landWorld with a handout for the free camera, from 500 m.
func roamWorld(t testing.TB) Config {
	t.Helper()
	cfg := landWorld(t)
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	h := &cat.World.Handout
	rule := edge.HandoutRule{Near: h.Near, Camera: 500, Dome: h.Dome, Margin: h.Margin, Shallow: h.Shallows, Look: h.Look,
		FarSea: max(h.FarSeaLeast, h.FarSeaHorizon*math.Sqrt(2*h.Dome*500))}
	cfg.RoamChunks = edge.NewHandout(cfg.Terrain.Ground, cfg.Payloads.Paths(), rule)
	return cfg
}

// The hill's chunk, 6 km east of the start, which no boat at the start
// could see.
func hillChunk(t testing.TB) string {
	t.Helper()
	n, _, _ := physics.ChunkOf(physics.HexCell(physics.HexAt(6000, 0)))
	return roamWorld(t).Payloads.Paths()[n]
}

// TestRoamRefused: a connection whose account does not carry the owner's
// flag sends Roam, as a modified client could, and receives nothing beyond
// its boat's view: no other boat, sea area or chunk past what its boat
// sees; its boat sails on; and the refusal is counted.
func TestRoamRefused(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, roamWorld(t))
		token, id := srv.Guest("Bob")
		far := srv.Crowd(t, 1, func(int) physics.State { return physics.State{X: 3000, Heading: 1} })
		bob := srv.NewSailor(DialOptions{Cookie: token}, letGo)
		views := watchViews(bob)
		if err := bob.Connect(t.Context()); err != nil {
			t.Fatal(err)
		}
		sailFor(t, []*client.Sailor{bob}, time.Second)
		before := boatAt(srv, bus.Account(id))
		for _, at := range [][3]float64{{3000, 0, 100}, {6000, 0, 300}, {-3000, 2000, 500}} {
			if err := bob.Roam(t.Context(), true, at[0], at[1], at[2]); err != nil {
				t.Fatal(err)
			}
			sailFor(t, []*client.Sailor{bob}, 2*time.Second)
		}
		after := boatAt(srv, bus.Account(id))
		if after.stays || after.state == before.state {
			t.Fatalf("the boat stays (%v), or stopped", after.stays)
		}
		if ok, furthest := views.holds(3000, 0); ok || furthest > edge.ViewKeep {
			t.Fatalf("Bob saw boat %d at 3 km (%v), or a boat %.0f m from his own", far[0], ok, furthest)
		}
		if slices.Contains(bob.Handed, hillChunk(t)) {
			t.Fatal("Bob was handed the hill's chunk")
		}
		if sea := bob.LastSea; sea == nil || physics.SeaAreaOf(after.state.X)-sea.GetCol() != edge.SeaWindow/2 {
			t.Fatalf("Bob's sea window %+v, his boat at %.0f", sea, after.state.X)
		}
		if bob.Tools || len(bob.Welcomes) != 1 {
			t.Fatal("Bob is told he has the owner's tools")
		}
		if n := testutil.ToFloat64(srv.Metrics.OwnerRefused.WithLabelValues("roam")); n != 3 {
			t.Fatalf("%v refusals counted", n)
		}
		if _, _, ok := srv.Edge.Eye(bus.Account(id)); ok {
			t.Fatal("Bob's connection has an eye")
		}
	})
}

// TestRoam: the owner's connection roams: its view, its sea's window and
// the chunks it is handed follow its eye, clamped to the reach; its boat
// stays where it was, unstepped, its prediction held with no correction,
// and still in the view of a sailor near it; back on the boat, the boat
// sails again and the prediction starts again once.
func TestRoam(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, roamWorld(t))
		annToken, annID := srv.Owner("Ann")
		bobToken, _ := srv.Guest("Bob")
		srv.Crowd(t, 1, func(int) physics.State { return physics.State{X: 3000, Heading: 1} })
		ann := srv.NewSailor(DialOptions{Cookie: annToken}, letGo)
		bob := srv.NewSailor(DialOptions{Cookie: bobToken}, letGo)
		annViews, bobViews := watchViews(ann), watchViews(bob)
		both := []*client.Sailor{ann, bob}
		for _, s := range both {
			if err := s.Connect(t.Context()); err != nil {
				t.Fatal(err)
			}
		}
		sailFor(t, both, time.Second)
		if !ann.Tools {
			t.Fatal("Ann's Welcome does not say she has the owner's tools")
		}
		if err := ann.Roam(t.Context(), true, 3000, 0, 100); err != nil {
			t.Fatal(err)
		}
		sailFor(t, both, time.Second)
		held := boatAt(srv, bus.Account(annID))
		if !held.stays {
			t.Fatal("Ann's boat does not stay")
		}
		resets, corrections := ann.Stats.Resets, ann.Stats.Corrections
		sailFor(t, both, 2*time.Second)
		if now := boatAt(srv, bus.Account(annID)); now.state != held.state {
			t.Fatalf("a staying boat moved from %+v to %+v", held.state, now.state)
		}
		if !ann.Predictor.Stays || ann.Stats.Resets != resets || ann.Stats.Corrections != corrections {
			t.Fatalf("Ann's prediction: stays %v, %d resets and %d corrections while it stays", ann.Predictor.Stays,
				ann.Stats.Resets-resets, ann.Stats.Corrections-corrections)
		}
		if ok, _ := annViews.holds(3000, 0); !ok {
			t.Fatal("Ann's eye at 3 km does not see the boat there")
		}
		if ok, _ := bobViews.holds(held.state.X, held.state.Y); !ok {
			t.Fatal("Bob, beside it, does not see Ann's staying boat")
		}
		if sea := ann.LastSea; sea == nil || physics.SeaAreaOf(3000)-sea.GetCol() != edge.SeaWindow/2 {
			t.Fatalf("Ann's sea window %+v, her eye at 3000", sea)
		}
		// Over the hill, from 300 m: its chunk is handed.
		if err := ann.Roam(t.Context(), true, 5800, 0, 300); err != nil {
			t.Fatal(err)
		}
		sailFor(t, both, time.Second)
		if !slices.Contains(ann.Handed, hillChunk(t)) {
			t.Fatal("the hill's chunk was not handed to Ann's eye")
		}
		// Clamped: 500 m beyond the lip at most.
		if err := ann.Roam(t.Context(), true, 20000, 0, 10000); err != nil {
			t.Fatal(err)
		}
		sailFor(t, both, time.Second)
		lip := srv.Weather.Prepared().Edge()
		if x, y, ok := srv.Edge.Eye(bus.Account(annID)); !ok || math.Abs(x-(lip+500)) > 1e-9 || y != 0 {
			t.Fatalf("the eye at (%v, %v), %v", x, y, ok)
		}
		// Back on the boat.
		if err := ann.Roam(t.Context(), false, 0, 0, 0); err != nil {
			t.Fatal(err)
		}
		sailFor(t, both, 2*time.Second)
		after := boatAt(srv, bus.Account(annID))
		if after.stays || after.state == held.state {
			t.Fatal("back on the boat, it does not sail")
		}
		if ann.Predictor.Stays || ann.Stats.Resets != resets+1 {
			t.Fatalf("Ann's prediction after the camera came back: stays %v, %d resets", ann.Predictor.Stays, ann.Stats.Resets-resets)
		}
		if _, _, ok := srv.Edge.Eye(bus.Account(annID)); ok {
			t.Fatal("back on the boat, Ann's connection has an eye")
		}
	})
}

// TestRoamEnds: the boat sails again when the connection ends with the
// camera roaming, when the owner's flag is cleared, and when the server
// restarts.
func TestRoamEnds(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{})
		token, id := srv.Owner("Ann")
		account := bus.Account(id)
		ann := srv.NewSailor(DialOptions{Cookie: token}, letGo)
		roam := func() {
			t.Helper()
			if err := ann.Connect(t.Context()); err != nil {
				t.Fatal(err)
			}
			sailFor(t, []*client.Sailor{ann}, time.Second)
			if err := ann.Roam(t.Context(), true, 100, 100, 50); err != nil {
				t.Fatal(err)
			}
			sailFor(t, []*client.Sailor{ann}, time.Second)
			if !boatAt(srv, account).stays {
				t.Fatal("the boat does not stay")
			}
		}
		roam()
		ann.Drop()
		time.Sleep(time.Second)
		if boatAt(srv, account).stays {
			t.Fatal("the connection ended, and the boat stays")
		}
		roam()
		srv.Edge.Tools(account, false)
		sailFor(t, []*client.Sailor{ann}, time.Second)
		if boatAt(srv, account).stays || ann.Tools {
			t.Fatalf("the flag cleared, the boat stays (%v), or Ann is told she has the tools (%v)", boatAt(srv, account).stays, ann.Tools)
		}
		if err := ann.Roam(t.Context(), true, 100, 100, 50); err != nil {
			t.Fatal(err)
		}
		sailFor(t, []*client.Sailor{ann}, time.Second)
		if boatAt(srv, account).stays {
			t.Fatal("the flag cleared, the camera still roams")
		}
		srv.Edge.Tools(account, true)
		sailFor(t, []*client.Sailor{ann}, time.Second)
		if !ann.Tools {
			t.Fatal("the flag set again, Ann is not told")
		}
		ann.Drop()
		roam()
		srv.Owned(bus.Command{Op: bus.Unseen, Boat: boatOf(srv, account), On: true})
		time.Sleep(time.Second)
		ann.Drop()
		srv.Restart(t, time.Second)
		if b := boatAt(srv, account); b.slot < 0 || b.stays || b.unseen {
			t.Fatalf("after a restart: %+v", b)
		}
	})
}

// TestUnseen: a boat its owner's tools keep unseen is in no other
// connection's view, and in its own sailor's prediction still.
func TestUnseen(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{})
		annToken, annID := srv.Owner("Ann")
		bobToken, _ := srv.Guest("Bob")
		ann := srv.NewSailor(DialOptions{Cookie: annToken}, letGo)
		bob := srv.NewSailor(DialOptions{Cookie: bobToken}, letGo)
		bobViews := watchViews(bob)
		both := []*client.Sailor{ann, bob}
		for _, s := range both {
			if err := s.Connect(t.Context()); err != nil {
				t.Fatal(err)
			}
		}
		sailFor(t, both, time.Second)
		annBoat := boatOf(srv, bus.Account(annID))
		at := func() (float64, float64) { b := boatAt(srv, bus.Account(annID)); return b.state.X, b.state.Y }
		if ok, _ := bobViews.holds(at()); !ok {
			t.Fatal("Bob does not see Ann's boat")
		}
		srv.Owned(bus.Command{Op: bus.Unseen, Boat: annBoat, On: true})
		sailFor(t, both, time.Second)
		if ok, _ := bobViews.holds(at()); ok {
			t.Fatal("Bob sees Ann's unseen boat")
		}
		srv.Owned(bus.Command{Op: bus.Unseen, Boat: annBoat, On: false})
		sailFor(t, both, time.Second)
		if ok, _ := bobViews.holds(at()); !ok {
			t.Fatal("Bob does not see Ann's boat again")
		}
	})
}
