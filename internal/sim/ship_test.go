// SPDX-License-Identifier: AGPL-3.0-only

package sim_test

import (
	"fmt"
	"math"
	"sync"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// shipSeeds are the worlds the largest boat is tried in: seeds 1 to 8.
const shipSeeds = 8

// The largest boat has a place in every world: in seeds 1 to 8, joining
// after a dozen dinghies, she starts where the water under her middle and
// both ends is her draught and a metre deep and her hull is 5 m clear of
// every other's, and sails a minute untouched without touching the
// bottom. Blown onto the lee shore of Port Royal's basin, and laid on a
// bank, she gets off: every push off puts her in water her draught and a
// metre deep, and she is not held aground after. A dinghy in the basin's
// deepest water may swap to her; one in its shallows may not.
func TestTheLargestBoatHasAPlaceInEveryWorld(t *testing.T) {
	if testing.Short() {
		t.Skip("makes whole worlds")
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	_, kinds := cat.Prepare()
	big := 0
	for i := range kinds {
		if physics.Radius(&kinds[i]) > physics.Radius(&kinds[big]) {
			big = i
		}
	}
	if big == 0 {
		t.Fatal("the first boat is the largest")
	}
	b := &kinds[big]
	need := physics.Draught(b) + 1
	r := physics.Radius(b)
	var wg sync.WaitGroup
	var mu sync.Mutex
	pushes := 0
	for seed := uint64(1); seed <= shipSeeds; seed++ {
		wg.Go(func() {
			bd, err := worldgen.Generate(seed, cat)
			if err != nil {
				t.Error(err)
				return
			}
			terrain := bd.Terrain(cat.PrepareGround())
			if terrain.Harbour == nil {
				t.Errorf("seed %d has no harbour", seed)
				return
			}
			n := largestInWorld(t, seed, cat, kinds, uint16(big), terrain, need, r)
			mu.Lock()
			pushes += n
			mu.Unlock()
		})
	}
	wg.Wait()
	if pushes == 0 {
		t.Error("she was never pushed off")
	}
}

// largestInWorld tries the boat of kind big in seed's world of terrain.
func largestInWorld(t *testing.T, seed uint64, cat *catalog.Catalog, kinds []physics.Prepared, big uint16, terrain *sim.Terrain,
	need, r float64) int {
	t.Helper()
	g := terrain.Ground
	depth := func(x, y float64) float64 { e, _ := g.At(x, y); return -e }
	// The least depth under her middle and her ends.
	under := func(st *physics.State) float64 {
		sin, cos := math.Sincos(st.Heading)
		d := math.Inf(1)
		for _, along := range [3]float64{0, r, -r} {
			d = min(d, depth(st.X+along*sin, st.Y+along*cos))
		}
		return d
	}
	wind := float64(seed) * 0.7
	tl := weather.FixedIn(cat.PrepareWeather(), physics.SteadySpell(6, wind, 0)).InHarbour(terrain.Harbour)
	w, err := sim.New(sim.Config{Capacity: 64, Kinds: kinds, StartSheets: cat.StartSheets(), Weather: tl, Terrain: terrain,
		Encounters: cat.PrepareEncounters(), Workers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	cmd := func(c bus.Command) bus.Reply {
		reply := make(chan bus.Reply, 1)
		c.Reply = reply
		if err := w.Bus().Commands.Developer().TrySend(c); err != nil {
			t.Fatal(err)
		}
		w.Tick()
		return <-reply
	}
	const dinghies = 12
	for i := range dinghies {
		if r := cmd(bus.Command{Op: bus.Join, Account: bus.Account{15: byte(i + 1)}}); r.Result != bus.Joined {
			t.Fatalf("seed %d: dinghy %d: %+v", seed, i, r)
		}
	}
	ship := cmd(bus.Command{Op: bus.Join, Account: bus.Account{15: 100}, BoatKind: big})
	f := w.Latest()
	if ship.Result != bus.Joined || f.Kind[ship.Slot] != big {
		t.Fatalf("seed %d: the ship's join: %+v, of kind %d", seed, ship, f.Kind[ship.Slot])
	}
	st := f.State[ship.Slot]
	place := -1
	for i, p := range terrain.Start {
		if math.Hypot(p.X-st.X, p.Y-st.Y) < 0.5 {
			place = i
		}
	}
	if d := under(&st); d < need {
		t.Errorf("seed %d: she starts at place %d in %.1f m of water under her hull", seed, place, d)
	}
	for _, o := range f.Live {
		if o != ship.Slot {
			p := f.State[o]
			if d := math.Hypot(p.X-st.X, p.Y-st.Y) - r - physics.Radius(&kinds[f.Kind[o]]); d < 5 {
				t.Errorf("seed %d: she starts %.1f m from a dinghy's hull", seed, d)
			}
		}
	}
	// A minute untouched: she sails off the start without touching.
	least := math.Inf(1)
	for range 60 * physics.StepsPerSecond {
		w.Tick()
		f := w.Latest()
		least = min(least, under(&f.State[ship.Slot]))
		if f.State[ship.Slot].GroundTimer > 0 {
			t.Errorf("seed %d: she touched the bottom within a minute of her start", seed)
			break
		}
	}
	t.Logf("seed %d: she starts at place %d, %.1f m under her, %.1f m the least in her first minute", seed, place, under(&st), least)

	// Blown onto the lee shore of Port Royal's basin from the middle of
	// its deepest water, her yards square.
	h := terrain.Harbour
	var lee physics.State
	most := 0.0
	for x := h.X - h.Radius; x <= h.X+h.Radius; x += 4 {
		for y := h.Y - h.Radius; y <= h.Y+h.Radius; y += 4 {
			st := physics.State{X: x, Y: y, Heading: math.Remainder(wind+math.Pi, 2*math.Pi)}
			if d := under(&st); d > most && w.InPort(x, y) {
				lee, most = st, d
			}
		}
	}
	lee.Surge = 1
	still := cat.World.Grounding.StillTime
	pushes, stuck := pushedOff(t, w, ship, lee, bus.Steps, still)
	t.Logf("seed %d: blown onto the basin's lee shore from %.1f m of water, pushed off%s", seed, most, pushWords(depth, r, pushes))
	if stuck > 0 || len(pushes) > 2 {
		t.Errorf("seed %d: blown onto the basin's lee shore she is pushed off %d times and left aground %d", seed, len(pushes), stuck)
	}
	all := len(pushes)
	for _, p := range pushes {
		if d := depth(p.X, p.Y); d < need {
			t.Errorf("seed %d: off the basin's lee shore she is pushed off into %.1f m of water", seed, d)
		}
	}

	// Laid on a bank, her hull over water everywhere but her keel on the
	// bottom, at rest: in Port Royal's harbour, or else off the start.
	var bank physics.State
	shoal := 0.0
	keel := physics.Draught(&kinds[big])
	for _, c := range [2][3]float64{{h.X, h.Y, h.Radius}, {terrain.Start[0].X, terrain.Start[0].Y, 600}} {
		for x := c[0] - c[2]; x <= c[0]+c[2]; x += 4 {
			for y := c[1] - c[2]; y <= c[1]+c[2]; y += 4 {
				for a := -math.Pi; a < math.Pi; a += math.Pi / 8 {
					st := physics.State{X: x, Y: y, Heading: a}
					if d := hull(depth, &st, r); d > shoal && d < keel-0.5 {
						bank, shoal = st, d
					}
				}
			}
		}
		if shoal > 0 {
			break
		}
	}
	if shoal == 0 {
		t.Errorf("seed %d: no bank for her in the harbour nor off the start", seed)
		return all
	}
	pushes, stuck = pushedOff(t, w, ship, bank, bus.Steps/2, still)
	t.Logf("seed %d: laid on a bank of %.1f m in port %v, pushed off%s", seed, shoal, w.InPort(bank.X, bank.Y), pushWords(depth, r, pushes))
	if stuck > 0 || len(pushes) > 2 {
		t.Errorf("seed %d: on a bank of %.1f m she is pushed off %d times and left aground %d", seed, shoal, len(pushes), stuck)
	}
	for _, p := range pushes {
		if d := depth(p.X, p.Y); d < need {
			t.Errorf("seed %d: off a bank of %.1f m she is pushed off into %.1f m of water", seed, shoal, d)
		}
	}
	all += len(pushes)

	// Swaps in port: a dinghy in the basin's deepest water may take her
	// there, one in shallows too shallow for her may not.
	if r := cmd(bus.Command{Op: bus.Leave, Boat: ship.Boat}); r.Result != bus.Left {
		t.Fatalf("seed %d: her leave: %+v", seed, r)
	}
	var shallows physics.State
	found := false
	for x := h.X - h.Radius; x <= h.X+h.Radius && !found; x += 4 {
		for y := h.Y - h.Radius; y <= h.Y+h.Radius && !found; y += 4 {
			st := physics.State{X: x, Y: y, Heading: lee.Heading}
			if d := depth(x, y); d > 2 && d < need && w.InPort(x, y) && math.Hypot(x-lee.X, y-lee.Y) > 4*r {
				shallows, found = st, true
			}
		}
	}
	f = w.Latest()
	dinghy := [2]int32{f.Live[0], f.Live[1]}
	for i, st := range [2]physics.State{{X: lee.X, Y: lee.Y, Heading: lee.Heading}, shallows} {
		if i == 1 && !found {
			t.Errorf("seed %d: no shallows in port too shallow for her", seed)
			break
		}
		if r := cmd(bus.Command{Op: bus.Place, Boat: f.Boat[dinghy[i]], State: st}); r.Result != bus.Done {
			t.Fatalf("seed %d: place: %+v", seed, r)
		}
		want := [2]bus.Result{bus.Done, bus.NoRoom}[i]
		r := cmd(bus.Command{Op: bus.SetBoat, Account: f.Owner[dinghy[i]], BoatKind: big})
		if r.Result != want || (w.Latest().Kind[dinghy[i]] == big) != (want == bus.Done) {
			t.Errorf("seed %d: a swap to her in %.1f m of water in port: %v (want %v), of kind %d", seed, depth(st.X, st.Y), r.Result, want,
				w.Latest().Kind[dinghy[i]])
		}
	}
	return all
}

// hull is the least depth of water under a boat of radius r at st, at its
// middle, its ends and its sides 4 m out; 0 if any of them is land or
// under half a metre deep.
func hull(depth func(x, y float64) float64, st *physics.State, r float64) float64 {
	sin, cos := math.Sincos(st.Heading)
	least := math.Inf(1)
	for _, p := range [5][2]float64{{0, 0}, {r, 0}, {-r, 0}, {0, 4}, {0, -4}} {
		d := depth(st.X+p[0]*sin+p[1]*cos, st.Y+p[0]*cos-p[1]*sin)
		if d < 0.5 {
			return 0
		}
		least = min(least, d)
	}
	return least
}

// pushedOff puts the boat at st with its sheet at sheet and sails it for
// up to three minutes, or until 20 s after it was last pushed off: where it
// was pushed off to each time, and how many times it lay still aground
// long enough to be pushed off and was not moved.
func pushedOff(t *testing.T, w *sim.World, boat bus.Reply, st physics.State, sheet uint16, still float64) (pushes []physics.State, stuck int) {
	t.Helper()
	last, afloat := st, 0
	for i := range 180 * physics.StepsPerSecond {
		f := w.Latest()
		in := sim.Input{Changed: []bus.SlotWord{{Slot: boat.Slot, Word: bus.Pack(uint32(f.Tick+1), bus.Steps/2, sheet, f.Gen[boat.Slot])}}}
		if i == 0 {
			in.Commands = []bus.Command{{Op: bus.Place, Boat: boat.Boat, State: st}}
		}
		w.TickWith(&in)
		now := w.Latest().State[boat.Slot]
		switch {
		case last.GroundTimer >= still*physics.StepsPerSecond-1 && now.GroundTimer == 0:
			if math.Hypot(now.X-last.X, now.Y-last.Y) > 0.01 || now.Heading != last.Heading {
				pushes, afloat = append(pushes, now), 0
			} else {
				stuck++
			}
		case now.GroundTimer == 0:
			afloat++
		}
		if afloat > 20*physics.StepsPerSecond && len(pushes) > 0 {
			break
		}
		last = now
	}
	return pushes, stuck
}

// pushWords are the places pushes put a boat of radius r, in words.
func pushWords(depth func(x, y float64) float64, r float64, pushes []physics.State) string {
	out := ""
	for _, p := range pushes {
		out += fmt.Sprintf(" (%.0f, %.0f) %.1f m, %.1f m under the hull;", p.X, p.Y, depth(p.X, p.Y), hull(depth, &p, r))
	}
	return out
}

// The Articles take a square-rigger's tack from her largest fore-and-aft
// sail, her mizzen on its boom (the Collision Regulations, Rule 12(b)),
// never from her yards: running by the lee with the wind on her starboard
// quarter and her mizzen boom out to starboard she is on port tack, and
// keeps clear of a Jolly boat on starboard (Article 10), whichever way her
// yards are braced; with her mizzen to port she is on starboard tack with
// it, and Article 10 says nothing.
func TestTheShipsTackIsHerMizzens(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	_, kinds := cat.Prepare()
	ep := cat.PrepareEncounters()
	big := 0
	for i := range kinds {
		if physics.Radius(&kinds[i]) > physics.Radius(&kinds[big]) {
			big = i
		}
	}
	deg := math.Pi / 180
	// The wind from the north. The Jolly boat heads 240°, the wind 120° on
	// her starboard side, her boom out to port; the ship 190°, the wind
	// 170° on her starboard quarter.
	jolly := physics.State{X: 40, Y: -40, Heading: -120 * deg, Boom: -60 * deg}
	for _, c := range []struct {
		mizzen, yards float64
		tack          float64
		keeper        float64
		article       float64
	}{
		{mizzen: 70 * deg, yards: 60 * deg, tack: -1, keeper: physics.First, article: physics.Article10},
		{mizzen: 70 * deg, yards: -60 * deg, tack: -1, keeper: physics.First, article: physics.Article10},
		{mizzen: -70 * deg, yards: 60 * deg, tack: 1},
		{mizzen: -70 * deg, yards: -60 * deg, tack: 1},
	} {
		ship := physics.State{Heading: -170 * deg, Boom: c.mizzen, Yards: c.yards, ForeYards: c.yards}
		var e physics.Encounter
		for i, b := range [2]struct {
			st   *physics.State
			kind int
		}{{&ship, big}, {&jolly, 0}} {
			var course physics.Course
			physics.TrackCourse(&course, b.st, 0, &kinds[b.kind], ep)
			e.X[i], e.Y[i], e.Heading[i], e.Heel[i], e.Boom[i] = b.st.X, b.st.Y, b.st.Heading, b.st.Heel, b.st.Boom
			e.Tack[i], e.Tacking[i], e.Settled[i], e.Course[i] = course.Tack, course.Tacking, physics.CourseSettled, course.Course
		}
		if e.Tack[0] != c.tack || e.Tack[1] != 1 {
			t.Errorf("mizzen %.0f°, yards %.0f°: the ship's tack %v (want %v), the Jolly boat's %v", c.mizzen/deg, c.yards/deg, e.Tack[0], c.tack, e.Tack[1])
		}
		v := physics.Judge(&e, &kinds[big], &kinds[0], ep)
		if c.article != 0 && (v.Keeper != c.keeper || v.Article != c.article) || c.article == 0 && v.Article == physics.Article10 {
			t.Errorf("mizzen %.0f°, yards %.0f°: %+v", c.mizzen/deg, c.yards/deg, v)
		}
	}
}
