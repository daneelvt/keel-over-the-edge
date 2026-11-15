// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"math"
	"slices"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/race/committee"
)

// TestTheWayHome: a skipper far out, racing, with a shipmate aboard, on a
// voyage the owner's tools had moved, is lifted home: retired from the
// race, the voyage ended lifted, and a new one begun at the start, at
// rest, not placed, so it earns; the shipmate still aboard. A boat not in
// the water is not lifted.
func TestTheWayHome(t *testing.T) {
	w, cat := raceWorld(t)
	keelboat := kindOf(t, cat, "keelboat")
	skipper := do(t, w, bus.Command{Op: bus.Join, Account: acct(1), Conn: 1, BoatKind: keelboat})
	if r := do(t, w, bus.Command{Op: bus.Board, Account: acct(10), Conn: 10, Boat: skipper.Boat}); r.Result != bus.Crewed {
		t.Fatalf("boarding: %+v", r)
	}
	s := skipper.Slot
	start := w.Latest().State[s]
	// Far out, by the owner's tools: the voyage is placed.
	far := start
	far.X, far.Y = start.X+300, start.Y-200
	if r := do(t, w, bus.Command{Op: bus.Teleport, Boat: skipper.Boat, State: far}); r.Result != bus.Done {
		t.Fatalf("teleport: %+v", r)
	}
	call := &bus.RaceCall{ID: [16]byte{1}, Course: 1, Kind: keelboat, Start: w.Now() + committee.Warning, Entrants: []bus.RaceEntrant{
		{Account: acct(1), Number: 1, Crew: true},
	}}
	if r := do(t, w, bus.Command{Op: bus.RacePlace, Race: call}); r.Result != bus.Done {
		t.Fatalf("the race placed: %+v", r)
	}
	for range 10 {
		w.Tick()
	}
	if f := w.Latest(); len(f.Racers) != 1 || f.Racers[0].State != bus.RacerPlaced {
		t.Fatalf("racers %+v", f.Racers)
	}

	r := do(t, w, bus.Command{Op: bus.Lift, Account: acct(1), Boat: skipper.Boat})
	if r.Result != bus.Done || r.Slot != s || r.Boat != skipper.Boat {
		t.Fatalf("lift: %+v", r)
	}
	f := w.Latest()
	if f.Racers[0].State != bus.RacerRetired {
		t.Errorf("the racer is %d, not retired", f.Racers[0].State)
	}
	i := slices.IndexFunc(f.VoyageEnds, func(v bus.VoyageEnded) bool { return v.Boat == skipper.Boat })
	if i < 0 || f.VoyageEnds[i].How != bus.EndLifted || !f.VoyageEnds[i].Placed {
		t.Fatalf("the voyage ended: %+v", f.VoyageEnds)
	}
	v := f.Voyage[s]
	if v.Log.Began != f.Tick || v.Placed || v.Over != 0 {
		t.Errorf("the new voyage: %+v", v)
	}
	st := f.State[s]
	home := false
	for p := range int64(w.capacity) {
		sp := w.placeAt(int64(s) + p)
		home = home || math.Hypot(st.X-sp.X, st.Y-sp.Y) < 1
	}
	if !home || math.Abs(st.Surge) > 0.5 || math.Abs(st.Sway) > 0.5 {
		t.Errorf("lifted to (%.1f, %.1f) at %.2f m/s, start (%.1f, %.1f)", st.X, st.Y, st.Surge, start.X, start.Y)
	}
	if a := f.Aboard(acct(10)); a < 0 || f.Crew[a].Slot != s || f.Crew[a].Boat != skipper.Boat {
		t.Error("the shipmate is no longer aboard")
	}
	if len(f.AboardEnds) != 0 {
		t.Errorf("a time aboard ended: %+v", f.AboardEnds)
	}

	if r := do(t, w, bus.Command{Op: bus.Lift, Account: acct(2), Boat: 999}); r.Result != bus.NoBoat {
		t.Errorf("a boat not in the water lifted: %+v", r)
	}
}
