// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"math"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sky"
)

// logWorld is a world of ghosts with ports, an edge and the weather given.
func logWorld(t testing.TB, ports []Disc) *World {
	t.Helper()
	w, err := New(Config{Capacity: 8, Kinds: kinds(t), Workers: 1, Tick: 3000, Grace: 30, Edge: &testEdge,
		Terrain: &Terrain{Ports: ports}, Capacities: []int{4}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	return w
}

// sailFor ticks w n times, adding up how far the boat in slot s moves each
// tick, and returns that.
func sailFor(w *World, s int32, n int) float64 {
	run := 0.0
	for range n {
		a := w.Latest().State[s]
		w.Tick()
		b := w.Latest().State[s]
		run += math.Hypot(b.X-a.X, b.Y-a.Y)
	}
	return run
}

// The odometer, a straight line a second, reads a course of reaches and
// turns within 1% of the distance sailed tick by tick; a jump adds nothing;
// and the voyage's end is a record with the run.
func TestOdometer(t *testing.T) {
	w := logWorld(t, nil)
	do(t, w, bus.Command{Op: bus.SetWeather, Weather: steady(6, 0)})
	r := do(t, w, bus.Command{Op: bus.Join, Account: acct(1)})
	s := r.Slot
	run := 0.0
	// A course: a reach east, a turn to the south-east, a reach back west,
	// each a minute.
	for i, heading := range []float64{math.Pi / 2, 3 * math.Pi / 4, 3 * math.Pi / 2, math.Pi / 2} {
		st := w.Latest().State[s]
		st.Heading, st.SheetLimit = heading, 0.7
		if i == 0 {
			st.Surge = 2
		}
		do(t, w, bus.Command{Op: bus.Place, Boat: r.Boat, State: st})
		run += sailFor(w, s, 60*physics.StepsPerSecond)
	}
	lg := w.Latest().Voyage[s].Log
	if run < 150 {
		t.Fatalf("the boat sailed only %.0f m", run)
	}
	if d := math.Abs(lg.Run-run) / run; d > 0.01 {
		t.Errorf("the odometer reads %.1f m of %.1f m sailed: %.2f%% off", lg.Run, run, 100*d)
	}
	t.Logf("the odometer reads %.1f m of %.1f m sailed tick by tick (%.3f%%)", lg.Run, run, 100*(run-lg.Run)/run)

	// A jump of a kilometre adds nothing.
	before := lg.Run
	st := w.Latest().State[s]
	st.X += 1000
	do(t, w, bus.Command{Op: bus.Place, Boat: r.Boat, State: st})
	sailFor(w, s, 2*physics.StepsPerSecond)
	if got := w.Latest().Voyage[s].Log.Run; got-before > 20 {
		t.Errorf("a jump of 1,000 m added %.1f m", got-before)
	}

	// Leaving ends the voyage, a record of the frame.
	do(t, w, bus.Command{Op: bus.Leave, Boat: r.Boat})
	f := w.Latest()
	if len(f.VoyageEnds) != 1 {
		t.Fatalf("voyages ended: %+v", f.VoyageEnds)
	}
	if e := f.VoyageEnds[0]; e.How != bus.EndReturned || e.Owner != acct(1) || e.Boat != r.Boat || e.Placed || e.Log.Began == 0 ||
		e.Log.Run < before {
		t.Errorf("the voyage ended: %+v", e)
	}
}

// Every way a voyage ends is a record of the frame: leaving, the grace
// running out, going over the lip, going aboard another's boat, and the
// world's end; a placed voyage is marked.
func TestVoyageEnds(t *testing.T) {
	w := logWorld(t, nil)
	ended := func(t *testing.T, how uint8, boat uint64) bus.VoyageEnded {
		t.Helper()
		f := w.Latest()
		for _, e := range f.VoyageEnds {
			if e.Boat == boat {
				if e.How != how {
					t.Fatalf("boat %d ended %d, not %d", boat, e.How, how)
				}
				return e
			}
		}
		t.Fatalf("boat %d's voyage did not end at tick %d: %+v", boat, f.Tick, f.VoyageEnds)
		return bus.VoyageEnded{}
	}
	t.Run("expired", func(t *testing.T) {
		r := do(t, w, bus.Command{Op: bus.Join, Account: acct(10), Conn: 7})
		do(t, w, bus.Command{Op: bus.Disconnect, Boat: r.Boat, Conn: 7})
		for range 40 {
			w.Tick()
			if len(w.Latest().VoyageEnds) > 0 {
				break
			}
		}
		ended(t, bus.EndExpired, r.Boat)
	})
	t.Run("over", func(t *testing.T) {
		r := do(t, w, bus.Command{Op: bus.Join, Account: acct(11)})
		overTheLip(t, w, r.Boat, r.Slot)
		e := ended(t, bus.EndOver, r.Boat)
		if e.Placed {
			t.Error("a voyage placed by the developer's command is marked placed")
		}
		do(t, w, bus.Command{Op: bus.Leave, Boat: r.Boat})
		if len(w.Latest().VoyageEnds) != 0 {
			t.Error("a voyage ended over the lip ends again as the boat leaves mid-fall")
		}
	})
	t.Run("aboard and placed", func(t *testing.T) {
		skipper := do(t, w, bus.Command{Op: bus.Join, Account: acct(12), Conn: 1})
		own := do(t, w, bus.Command{Op: bus.Join, Account: acct(13), Conn: 2})
		do(t, w, bus.Command{Op: bus.Teleport, Boat: own.Boat, Start: true})
		do(t, w, bus.Command{Op: bus.Board, Boat: skipper.Boat, Account: acct(13), Conn: 2, Name: "Tom"})
		if e := ended(t, bus.EndAboard, own.Boat); !e.Placed {
			t.Error("a teleported voyage is not marked placed")
		}
		sailFor(w, skipper.Slot, 3*physics.StepsPerSecond)
		do(t, w, bus.Command{Op: bus.Leave, Boat: skipper.Boat})
		f := w.Latest()
		ended(t, bus.EndReturned, skipper.Boat)
		if len(f.AboardEnds) != 1 {
			t.Fatalf("times aboard ended: %+v", f.AboardEnds)
		}
		a := f.AboardEnds[0]
		if a.Account != acct(13) || a.Skipper != acct(12) || a.How != bus.EndLanded || a.Boat != skipper.Boat || a.Run > f.VoyageEnds[0].Log.Run {
			t.Errorf("Tom's time aboard: %+v; the voyage's run %.2f", a, f.VoyageEnds[0].Log.Run)
		}
	})
	t.Run("taken", func(t *testing.T) {
		r := do(t, w, bus.Command{Op: bus.Join, Account: acct(14)})
		do(t, w, bus.Command{Op: bus.End, At: w.Now() + 2})
		w.Tick()
		w.Tick()
		ended(t, bus.EndTaken, r.Boat)
	})
}

// Someone going ashore from a boat sailing on ends their time aboard: a
// record with what the boat ran while they were aboard.
func TestAboardEnds(t *testing.T) {
	w := logWorld(t, nil)
	do(t, w, bus.Command{Op: bus.SetWeather, Weather: steady(6, 0)})
	skipper := do(t, w, bus.Command{Op: bus.Join, Account: acct(1), Conn: 1})
	st := w.Latest().State[skipper.Slot]
	st.Heading, st.Surge, st.SheetLimit = math.Pi/2, 2, 0.7
	do(t, w, bus.Command{Op: bus.Place, Boat: skipper.Boat, State: st})
	sailFor(w, skipper.Slot, 60*physics.StepsPerSecond)
	do(t, w, bus.Command{Op: bus.Join, Account: acct(2), Conn: 2})
	do(t, w, bus.Command{Op: bus.Board, Boat: skipper.Boat, Account: acct(2), Conn: 2, Name: "Tom", Machine: true})
	runAt := w.Latest().Voyage[skipper.Slot].Log.Run
	sailFor(w, skipper.Slot, 60*physics.StepsPerSecond)
	do(t, w, bus.Command{Op: bus.Ashore, Account: acct(2)})
	f := w.Latest()
	if len(f.AboardEnds) != 1 {
		t.Fatalf("times aboard ended: %+v", f.AboardEnds)
	}
	a := f.AboardEnds[0]
	want := f.Voyage[skipper.Slot].Log.Run - runAt
	if a.How != bus.EndAshore || !a.Machine || a.Skipper != acct(1) || math.Abs(a.Run-want) > 1e-9 || a.Run < 20 {
		t.Errorf("the time aboard: %+v, the boat ran %.2f m meanwhile", a, want)
	}
}

// The wind's ten-minute mean: a gale is met once ten minute means average
// Force 8, a storm Force 10; ridden out once the mean falls below Force
// 7, or the voyage ends in port.
func TestGaleRiddenOut(t *testing.T) {
	w := logWorld(t, nil)
	var lg bus.VoyageLog
	blow := func(ws float64, minutes int) {
		for range minutes * 60 {
			lg.Seconds++
			w.windRead(&lg, ws, 10, 20)
		}
	}
	blow(10, 30)
	if lg.Met != 0 || lg.Minutes != bus.WindMinutes {
		t.Fatalf("Force 7 met a gale: %+v", lg)
	}
	// Nine minutes of a gale do not make the mean one.
	blow(20, 4)
	if lg.Met != 0 {
		t.Fatalf("four minutes of Force 8 met a gale: mean of %v", lg.Wind)
	}
	blow(20, 6)
	if lg.Met != bus.MetGale || lg.Blow != bus.BlowGale || lg.GaleX != 10 || lg.GaleY != 20 {
		t.Fatalf("ten minutes of Force 8: %+v", lg)
	}
	blow(26, 10)
	if lg.Met != bus.MetGale|bus.MetStorm || lg.Blow != bus.BlowStorm {
		t.Fatalf("ten minutes of Force 10: %+v", lg)
	}
	// Force 7 holds it: not yet ridden out.
	blow(15, 10)
	if lg.Met&(bus.RodeGale|bus.RodeStorm) != 0 {
		t.Fatalf("Force 7 rode out the storm: %+v", lg)
	}
	blow(8, 10)
	if lg.Met != bus.MetGale|bus.MetStorm|bus.RodeGale|bus.RodeStorm || lg.Blow != bus.BlowNone {
		t.Fatalf("the storm not ridden out: %+v", lg)
	}

	// A gale under way as the voyage ends in port is ridden out.
	w2 := logWorld(t, []Disc{{X: 0, Y: -640, R: 200}})
	r := do(t, w2, bus.Command{Op: bus.Join, Account: acct(1)})
	f := w2.Latest()
	f.Voyage[r.Slot].Log.Blow, f.Voyage[r.Slot].Log.Met = bus.BlowGale, bus.MetGale
	st := f.State[r.Slot]
	st.X, st.Y = 0, -640
	do(t, w2, bus.Command{Op: bus.Place, Boat: r.Boat, State: st})
	do(t, w2, bus.Command{Op: bus.Leave, Boat: r.Boat})
	if e := w2.Latest().VoyageEnds; len(e) != 1 || e[0].Log.Met&bus.RodeGale == 0 {
		t.Errorf("a gale under way, the voyage ended in port: %+v", e)
	}
}

// A port made from the sea with the visibility under a nautical mile is a
// landfall in fog; in clear air it is not, nor is a voyage begun in port.
func TestLandfallInFog(t *testing.T) {
	for _, c := range []struct {
		name       string
		visibility float64
		inPort     bool // the voyage begins in port
		fog        bool
	}{
		{"fog", 400, false, true},
		{"clear", 9000, false, false},
		{"begun in port", 400, true, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			port := Disc{X: 0, Y: 0, R: 100}
			if c.inPort {
				// About the start, where the boat begins.
				at := spawnAt(0)
				port.X, port.Y = at.X, at.Y
			}
			w := logWorld(t, []Disc{port})
			w.visibility = func(x, y float64) float64 { return c.visibility }
			r := do(t, w, bus.Command{Op: bus.Join, Account: acct(1)})
			if !c.inPort {
				st := w.Latest().State[r.Slot]
				st.X, st.Y, st.Heading, st.Surge = 0, 150, 0, 0
				do(t, w, bus.Command{Op: bus.Place, Boat: r.Boat, State: st})
				sailFor(w, r.Slot, 2*physics.StepsPerSecond)
				// Into port, a short way.
				st = w.Latest().State[r.Slot]
				st.X, st.Y = 0, 60
				do(t, w, bus.Command{Op: bus.Place, Boat: r.Boat, State: st})
			}
			sailFor(w, r.Slot, 2*physics.StepsPerSecond)
			lg := w.Latest().Voyage[r.Slot].Log
			if got := lg.Met&bus.MetFog != 0; got != c.fog || c.fog && (math.Abs(lg.FogX) > 5 || math.Abs(lg.FogY-60) > 5) {
				t.Errorf("a landfall in fog: %v, want %v (%+v)", got, c.fog, lg)
			}
		})
	}
}

// Half an hour in the water with the sun below the horizon is a night at
// sea; a quarter of an hour is not.
func TestNightAtSea(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	sk := cat.PrepareSky()
	// A minute after a sunset at the world's centre: the game's night is
	// 59 minutes long.
	alt := func(e int64) float64 { return sky.SunAltitude(sk, sky.Time(sk, float64(e), 0), 0, 0) }
	epoch := int64(0)
	for m := range int64(240) {
		e := int64(1_800_000_000_000_000) + m*60_000_000
		if alt(e-60_000_000) >= 0 && alt(e) < 0 {
			epoch = e + 60_000_000
			break
		}
	}
	if epoch == 0 {
		t.Fatal("no sunset in four hours")
	}
	w, err := New(Config{Capacity: 4, Kinds: kinds(t), Workers: 1, Tick: 0, Sight: &Sight{Sky: sk, Epoch: epoch}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	// Two minutes stand for the half hour, so the test sails minutes, not
	// a night: the rule is the same.
	defer func(n int32) { nightSeconds = n }(nightSeconds)
	nightSeconds = 2 * 60
	r := do(t, w, bus.Command{Op: bus.Join, Account: acct(1)})
	for range 60 * physics.StepsPerSecond {
		w.Tick()
	}
	if lg := w.Latest().Voyage[r.Slot].Log; lg.Met&bus.MetNight != 0 || lg.Dark < 55 {
		t.Fatalf("half the time in the dark: %+v", lg)
	}
	for range 65 * physics.StepsPerSecond {
		w.Tick()
	}
	if lg := w.Latest().Voyage[r.Slot].Log; lg.Met&bus.MetNight == 0 {
		t.Errorf("the whole time in the dark: %d seconds dark of %d", lg.Dark, lg.Seconds)
	}
}

// A voyage's log goes through a snapshot whole, and those aboard keep
// their run: a restart mid-voyage loses nothing of it.
func TestVoyageLogInTheSnapshot(t *testing.T) {
	w := logWorld(t, nil)
	do(t, w, bus.Command{Op: bus.SetWeather, Weather: steady(6, 0)})
	skipper := do(t, w, bus.Command{Op: bus.Join, Account: acct(1), Conn: 1})
	do(t, w, bus.Command{Op: bus.Join, Account: acct(2), Conn: 2})
	do(t, w, bus.Command{Op: bus.Board, Boat: skipper.Boat, Account: acct(2), Conn: 2, Name: "Tom"})
	st := w.Latest().State[skipper.Slot]
	st.Heading, st.Surge, st.SheetLimit = math.Pi/2, 2, 0.7
	do(t, w, bus.Command{Op: bus.Place, Boat: skipper.Boat, State: st})
	sailFor(w, skipper.Slot, 90*physics.StepsPerSecond)
	f := w.Latest()
	snap := AppendCheckpoint(nil, f)
	g := bus.NewFrame(f.Capacity())
	if err := ReadSnapshot(snap, g); err != nil {
		t.Fatal(err)
	}
	if g.Voyage[skipper.Slot].Log != f.Voyage[skipper.Slot].Log || g.Crew[0].Run != f.Crew[0].Run || f.Crew[0].Run <= 0 {
		t.Fatalf("through a snapshot %+v became %+v; aboard %.2f became %.2f", f.Voyage[skipper.Slot].Log, g.Voyage[skipper.Slot].Log,
			f.Crew[0].Run, g.Crew[0].Run)
	}
	// Restored a minute on, the voyage sails on with its run.
	w2 := logWorld(t, nil)
	if _, err := w2.Restore(snap, f.Tick+60*physics.StepsPerSecond); err != nil {
		t.Fatal(err)
	}
	run := f.Voyage[skipper.Slot].Log.Run
	sailFor(w2, skipper.Slot, 5*physics.StepsPerSecond)
	if got := w2.Latest().Voyage[skipper.Slot].Log; got.Run < run || got.Began != f.Voyage[skipper.Slot].Log.Began {
		t.Errorf("restored, the run went from %.1f to %.1f m, began %d (was %d)", run, got.Run, got.Began, f.Voyage[skipper.Slot].Log.Began)
	}
}

// Each bump counts in both voyages: at fault for the boat at fault.
func TestBumpsPerVoyage(t *testing.T) {
	w := edgeWorld(t, true)
	a := do(t, w, bus.Command{Op: bus.Join, Account: acct(1)})
	b := do(t, w, bus.Command{Op: bus.Join, Account: acct(2)})
	// Two boats closing head on.
	placeAtEdge(t, w, a.Boat, 0, 0, math.Pi/2, 3)
	placeAtEdge(t, w, b.Boat, 12, 0, 3*math.Pi/2, 3)
	var bumps int
	for range 300 {
		w.Tick()
		for _, bp := range w.Latest().Bumps {
			if bp.Tick == w.Now() {
				bumps++
			}
		}
	}
	if bumps == 0 {
		t.Skip("the boats never bumped")
	}
	la, lb := w.Latest().Voyage[a.Slot].Log, w.Latest().Voyage[b.Slot].Log
	if int(la.BumpsAt+la.BumpsNot) != bumps || int(lb.BumpsAt+lb.BumpsNot) != bumps {
		t.Errorf("%d bumps: %+v and %+v", bumps, la, lb)
	}
}
