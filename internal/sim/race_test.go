// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"math"
	"slices"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/race/committee"
)

// raceWorld is a world of the catalog's boats with a racing area of 450 m
// about its centre.
func raceWorld(t testing.TB) (*World, *catalog.Catalog) {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	st := &committee.Stage{Areas: []committee.Area{{Number: 1, Radius: 450}}}
	for i := range cat.Boats {
		st.Kinds = append(st.Kinds, committee.Kind{Polar: cat.Polar(i), Length: cat.Boats[i].LengthOverall})
	}
	w, err := New(Config{Capacity: 16, Kinds: kinds(t), Workers: 1, Tick: 100, Encounters: encounters(t), Capacities: cat.Capacities(), Races: st})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	return w, cat
}

// kindOf is the catalog's boat of an id's index.
func kindOf(t testing.TB, cat *catalog.Catalog, id string) uint16 {
	for i := range cat.Boats {
		if string(cat.Boats[i].ID) == id {
			return uint16(i)
		}
	}
	t.Fatalf("no boat %s", id)
	return 0
}

// A race's boats are placed on its line at its warning signal, wherever
// they were, in an order drawn by lot: a skipper in another kind of boat
// changes to the race's, the voyage in the old one ended and a new one
// begun and not marked placed; those aboard stay with a skipper who
// entered with them and go ashore from one who did not; an entrant not at
// sea did not start.
func TestARaceIsPlaced(t *testing.T) {
	w, cat := raceWorld(t)
	keelboat := kindOf(t, cat, "keelboat")
	var slots [4]int32
	for i := range 3 {
		kind := keelboat
		if i == 2 {
			kind = 0
		}
		r := do(t, w, bus.Command{Op: bus.Join, Account: acct(uint64(i + 1)), Conn: uint64(i + 1), BoatKind: kind})
		slots[i] = r.Slot
	}
	// Crew aboard the first two boats.
	for i, boat := range []uint64{1, 2} {
		if r := do(t, w, bus.Command{Op: bus.Board, Account: acct(uint64(10 + i)), Conn: uint64(10 + i), Boat: boat}); r.Result != bus.Crewed {
			t.Fatalf("boarding: %+v", r)
		}
	}
	for range 30 {
		w.Tick()
	}
	call := &bus.RaceCall{ID: [16]byte{1}, Course: 1, Kind: keelboat, Start: w.Now() + committee.Warning, Entrants: []bus.RaceEntrant{
		{Account: acct(1), Number: 1, Crew: true},
		{Account: acct(2), Number: 2},
		{Account: acct(3), Number: 3, BoatLook: 77, BoatName: "Gull"},
		{Account: acct(4), Number: 4},
	}}
	if r := do(t, w, bus.Command{Op: bus.RacePlace, Race: call}); r.Result != bus.Done {
		t.Fatalf("the race placed: %+v", r)
	}
	f := w.Latest()
	if len(f.Races) != 1 || len(f.Racers) != 4 {
		t.Fatalf("%d races of %d boats", len(f.Races), len(f.Racers))
	}
	c := f.Races[0].Course
	spots := committee.Spots(c, 2*physics.Radius(&w.kinds[keelboat]))
	// The boats in the order drawn, each on the next spot behind the line.
	k := 0
	for _, i := range committee.Lot(call) {
		if i == 3 {
			continue
		}
		s := slots[i]
		if st := f.State[s]; math.Abs(st.X-spots[k].X) > 0.1 || math.Abs(st.Y-spots[k].Y) > 0.1 {
			t.Errorf("entrant %d at (%.1f, %.1f), want spot %d (%.1f, %.1f)", i+1, st.X, st.Y, k, spots[k].X, spots[k].Y)
		}
		k++
	}
	for i, rc := range f.Racers {
		want := bus.RacerPlaced
		if i == 3 {
			want = bus.RacerDNS
		}
		if rc.State != want {
			t.Errorf("boat %d in state %d", rc.Number, rc.State)
		}
	}
	// The Jolly boat's skipper races a keelboat from their fleet, on a new
	// voyage; the old one ended.
	s := slots[2]
	if f.Kind[s] != keelboat || f.BoatName[s] != "Gull" || f.BoatLook[s] != 77 || f.Voyage[s].Log.Began != f.Tick || f.Voyage[s].Placed {
		t.Errorf("the keelboat's skipper's boat: kind %d %q, voyage %+v", f.Kind[s], f.BoatName[s], f.Voyage[s])
	}
	if i := slices.IndexFunc(f.VoyageEnds, func(v bus.VoyageEnded) bool { return v.Owner == acct(3) }); i < 0 ||
		f.VoyageEnds[i].Kind != 0 || f.VoyageEnds[i].Placed {
		t.Errorf("the keelboat's voyage ended: %+v", f.VoyageEnds)
	}
	// The crew of the skipper who entered with them stays; the other goes
	// ashore, into a boat of their own.
	if i := f.Aboard(acct(10)); i < 0 || f.Crew[i].Slot != slots[0] {
		t.Error("the crew of a skipper entered with them went ashore")
	}
	if f.Aboard(acct(11)) >= 0 || afloatIn(f, acct(11)) < 0 {
		t.Error("the crew of a skipper entered alone stayed aboard")
	}
	// The same race twice is the same race.
	if r := do(t, w, bus.Command{Op: bus.RacePlace, Race: call}); r.Result != bus.Stale {
		t.Errorf("the race placed again: %+v", r)
	}
}

// A world restored in the middle of a race's sequence runs it on as the
// world it was taken from: the same signals, the same digests.
func TestARaceRestores(t *testing.T) {
	defer func(a, b int64) { committee.Warning, committee.Preparatory = a, b }(committee.Warning, committee.Preparatory)
	committee.Warning, committee.Preparatory = 20*committee.Second, 10*committee.Second
	w, _ := raceWorld(t)
	for i := range 3 {
		do(t, w, bus.Command{Op: bus.Join, Account: acct(uint64(i + 1)), Conn: uint64(i + 1)})
	}
	call := &bus.RaceCall{ID: [16]byte{2}, Course: 1, Start: w.Now() + committee.Warning, Entrants: []bus.RaceEntrant{
		{Account: acct(1), Number: 1}, {Account: acct(2), Number: 2}, {Account: acct(3), Number: 3}}}
	do(t, w, bus.Command{Op: bus.RacePlace, Race: call})
	start := w.Latest().Races[0].Start
	for w.Now() < start-committee.Preparatory-5*committee.Second {
		w.Tick()
	}
	w2, _ := raceWorld(t)
	if err := w2.Load(AppendSnapshot(nil, w.Latest())); err != nil {
		t.Fatal(err)
	}
	if Digest(w2.Latest()) != Digest(w.Latest()) {
		t.Fatal("the restored world differs")
	}
	var signals [2][]uint8
	for w.Now() < start+30 {
		for i, x := range []*World{w, w2} {
			x.Tick()
			for _, e := range x.Latest().RaceEvents {
				if e.Kind == bus.RaceSignalled && e.Tick == x.Now() {
					signals[i] = append(signals[i], e.Signal)
				}
			}
		}
		if w.Now()%10 == 0 && Digest(w2.Latest()) != Digest(w.Latest()) {
			t.Fatalf("the worlds part at tick %d", w.Now())
		}
	}
	if want := []uint8{bus.SignalPreparatory, bus.SignalStart}; !slices.Equal(signals[0], want) || !slices.Equal(signals[1], want) {
		t.Errorf("signals %v and %v, want %v", signals[0], signals[1], want)
	}
	if f := w.Latest(); f.Races[0].Phase != bus.RaceStarted || f.Racers[0].State != bus.RacerRacing {
		t.Errorf("after the start: phase %d, boat 1 %d", f.Races[0].Phase, f.Racers[0].State)
	}
	// Cheered by its spectators, counted in the world.
	if r := do(t, w, bus.Command{Op: bus.RaceCheer, Account: acct(2), Cheers: 4}); r.Result != bus.Done || w.Latest().Racers[1].Cheers != 4 {
		t.Errorf("cheered: %+v, %d", r, w.Latest().Racers[1].Cheers)
	}
	if r := do(t, w, bus.Command{Op: bus.RaceCheer, Account: acct(9), Cheers: 1}); r.Result != bus.NoBoat {
		t.Errorf("one racing in none cheered: %+v", r)
	}
	// Retired at the skipper's word; written, the race goes.
	if r := do(t, w, bus.Command{Op: bus.RaceRetire, Account: acct(2)}); r.Result != bus.Done || w.Latest().Racers[1].State != bus.RacerRetired {
		t.Errorf("retired: %+v", r)
	}
	if r := do(t, w, bus.Command{Op: bus.RaceWritten, Race: &bus.RaceCall{ID: call.ID}}); r.Result != bus.NoBoat {
		t.Errorf("a race under way written: %+v", r)
	}
}
