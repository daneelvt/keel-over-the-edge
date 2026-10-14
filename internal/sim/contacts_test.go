// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"math"
	"math/rand/v2"
	"runtime"
	"slices"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// meetingWorld is a world whose boats meet, in a steady wind of speed m/s
// from the north, or a calm; flat water.
func meetingWorld(t testing.TB, capacity, workers int, speed float64) *World {
	t.Helper()
	w, err := New(Config{Capacity: capacity, Kinds: kinds(t), Workers: workers, Tick: 100,
		Weather: weather.Fixed(physics.SteadySpell(speed, 0, 0)), Encounters: encounters(t)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	return w
}

// joinAll gives n accounts a boat each.
func joinAll(t testing.TB, w *World, n int) {
	t.Helper()
	for i := range n {
		send(t, w, bus.Command{Op: bus.Join, Account: acct(uint64(i + 1)), Conn: uint64(i + 1)})
	}
	w.Tick()
	if got := len(w.Latest().Live); got != n {
		t.Fatalf("%d boats joined, not %d", got, n)
	}
}

// place puts boat (its ID) where s says, in the next tick.
func place(t testing.TB, w *World, boat uint64, s physics.State) {
	t.Helper()
	send(t, w, bus.Command{Op: bus.Place, Boat: boat, State: s})
}

// newBumps are the bumps of the latest frame's own tick.
func newBumps(w *World) []bus.Bump {
	f := w.Latest()
	var out []bus.Bump
	for _, b := range f.Bumps {
		if b.Tick == f.Tick {
			out = append(out, b)
		}
	}
	return out
}

// Two boats pressed together for ten seconds make one bump; parted for half
// a second and touching again, a second.
func TestBumpEpisodes(t *testing.T) {
	w := meetingWorld(t, 8, 1, 0)
	joinAll(t, w, 2)
	place(t, w, 1, physics.State{X: 500, Y: 500})
	place(t, w, 2, physics.State{X: 501.38, Y: 500})
	bumps := 0
	for range 300 {
		w.Tick()
		bumps += len(newBumps(w))
	}
	if bumps != 1 {
		t.Fatalf("pressed together for 10 s: %d bumps, want 1", bumps)
	}
	f := w.Latest()
	if len(f.Pairs) != 1 || f.Pairs[0].Touched != f.Tick {
		t.Fatalf("pairs %+v at tick %d", f.Pairs, f.Tick)
	}
	place(t, w, 2, physics.State{X: 504, Y: 500})
	for range 16 {
		w.Tick()
		bumps += len(newBumps(w))
	}
	place(t, w, 2, physics.State{X: 501.38, Y: 500})
	for range 30 {
		w.Tick()
		bumps += len(newBumps(w))
	}
	if bumps != 2 {
		t.Fatalf("parted for half a second and touching again: %d bumps, want 2", bumps)
	}
	// A frame keeps a bump for a second, no longer.
	for range bus.BumpTicks {
		w.Tick()
	}
	if f := w.Latest(); len(f.Bumps) != 0 {
		t.Fatalf("bumps kept %d ticks later: %+v", bus.BumpTicks, f.Bumps)
	}
}

// Two boats sailing into each other head on bump and part, and their hulls
// never pass through each other. Their bows glance off each other: they may
// touch again, gently, as they swing.
func TestBumpHeadOn(t *testing.T) {
	w := meetingWorld(t, 8, 1, 0)
	joinAll(t, w, 2)
	place(t, w, 1, physics.State{X: 500, Y: 500, Surge: 2})
	place(t, w, 2, physics.State{X: 500.3, Y: 506, Heading: math.Pi, Surge: 2})
	var all []bus.Bump
	var h physics.Hulls
	k := &w.kinds[0]
	for range 120 {
		w.Tick()
		all = append(all, newBumps(w)...)
		f := w.Latest()
		var c physics.Contact
		if h.Touch(&f.State[0], &f.State[1], k, k, &c) && c.Depth > 0.1 {
			t.Fatalf("tick %d: the hulls are %.3f m inside each other", f.Tick, c.Depth)
		}
	}
	if len(all) == 0 {
		t.Fatal("no bump")
	}
	b := all[0]
	if b.A != 0 || b.B != 1 || b.BoatA != 1 || b.BoatB != 2 || b.OwnerA != acct(1) || b.OwnerB != acct(2) || !(b.Closing > 2) {
		t.Errorf("bump %+v", b)
	}
	for _, later := range all[1:] {
		if !(later.Closing < b.Closing/2) {
			t.Errorf("a later bump at %g m/s, after the first at %g", later.Closing, b.Closing)
		}
	}
	f := w.Latest()
	// The bows glance off and the boats slide past each other, slowed.
	if !(f.State[0].Surge < 1.5) || !(f.State[1].Surge < 1.5) {
		t.Errorf("after the bump the boats still sail on at %g and %g m/s", f.State[0].Surge, f.State[1].Surge)
	}
}

// ring places n boats on a circle of radius r about (x, y), each heading
// for the centre at speed.
func ring(t testing.TB, w *World, first uint64, n int, x, y, r, speed float64) {
	for i := range n {
		a := 2 * math.Pi * float64(i) / float64(n)
		place(t, w, first+uint64(i), physics.State{
			X: x + r*math.Sin(a), Y: y + r*math.Cos(a), Heading: a + math.Pi, Surge: speed, SheetLimit: 0.3,
		})
	}
}

// crowd is a world of 100 boats, rings of eight of them sailing into each
// other in a breeze, the rest scattered: the digest of every tick after
// the rings are placed.
func crowd(t testing.TB, workers int, ticks int, snapAt int64) (digests []uint64, snap []byte, w *World) {
	w = meetingWorld(t, 128, workers, 5)
	joinAll(t, w, 100)
	for k := range 4 {
		ring(t, w, uint64(1+8*k), 8, float64(200*k), 300, 6, 2)
	}
	w.Tick()
	for range ticks {
		w.Tick()
		f := w.Latest()
		digests = append(digests, Digest(f))
		if f.Tick == snapAt {
			snap = AppendSnapshot(nil, f)
		}
	}
	return digests, snap, w
}

// Bumps are deterministic: one worker and eight give the same digests,
// the pairs come in the order of their slots, and a world restored from a
// snapshot taken while boats touch goes on tick for tick as the world it
// was taken from.
func TestBumpsReplay(t *testing.T) {
	one, _, w1 := crowd(t, 1, 150, 0)
	f := w1.Latest()
	if !slices.IsSortedFunc(f.Pairs, func(a, b bus.Pair) int {
		if a.A != b.A {
			return int(a.A - b.A)
		}
		return int(a.B - b.B)
	}) {
		t.Fatalf("pairs out of order: %+v", f.Pairs)
	}
	// Find a tick at which boats touch, mid-contact.
	var mid int64
	_, _, probe := crowd(t, 1, 60, 0)
	for _, p := range probe.Latest().Pairs {
		if p.Touched == probe.Latest().Tick {
			mid = p.Touched
		}
	}
	if mid == 0 {
		t.Fatal("no boats touch 60 ticks in")
	}
	eight, snap, w8 := crowd(t, 8, 150, mid)
	if w8.Workers() < 2 {
		t.Fatalf("%d workers stepped the boats", w8.Workers())
	}
	if !slices.Equal(one, eight) {
		t.Fatal("one worker and eight give different digests")
	}
	if len(snap) == 0 {
		t.Fatalf("no snapshot at tick %d", mid)
	}

	r := meetingWorld(t, 128, 4, 5)
	if err := r.Load(snap); err != nil {
		t.Fatal(err)
	}
	start := int(mid - (w1.Latest().Tick - int64(len(one))))
	for i := start; i < len(one); i++ {
		r.Tick()
		if got := Digest(r.Latest()); got != one[i] {
			t.Fatalf("restored mid-contact at tick %d, the world differs at tick %d", mid, r.Now())
		}
	}
	bumps := 0
	for _, b := range w1.Latest().Bumps {
		_ = b
		bumps++
	}
	t.Logf("%d pairs, %d bumps in the last second", len(f.Pairs), bumps)
}

// A boat joining where a boat lies appears at the next free place of the
// spawn grid.
func TestSpawnAtAFreePlace(t *testing.T) {
	w := meetingWorld(t, 8, 1, 5)
	joinAll(t, w, 1)
	place(t, w, 1, spawnAt(1))
	w.Tick()
	joinAll(t, w, 2)
	f := w.Latest()
	if got, want := f.State[1], spawnAt(2); math.Abs(got.X-want.X) > 0.01 || math.Abs(got.Y-want.Y) > 0.01 {
		t.Fatalf("the new boat appeared at (%g, %g), want (%g, %g)", got.X, got.Y, want.X, want.Y)
	}
}

// Boats beyond each other's wakes sail as in a world of ghosts, bit for
// bit: the shadow and the contacts change nothing they do not reach.
func TestFarApartAsGhosts(t *testing.T) {
	run := func(enc *physics.EncounterPrepared) []physics.State {
		w, err := New(Config{Capacity: 8, Kinds: kinds(t), Workers: 1, Tick: 100,
			Weather: weather.Fixed(physics.SteadySpell(6, 0.3, 0)), Encounters: enc})
		if err != nil {
			t.Fatal(err)
		}
		defer w.Close()
		joinAll(t, w, 3)
		for range 600 {
			w.Tick()
		}
		f := w.Latest()
		return slices.Clone(f.State[:3])
	}
	ghosts, solid := run(nil), run(encounters(t))
	for i := range ghosts {
		if !sameState(ghosts[i], solid[i]) {
			t.Errorf("boat %d sails differently among solid boats 20 m apart in clean air", i)
		}
	}
}

// BenchmarkTickEncounters times the tick with 1,000 boats in the stormy
// spell, as ghosts and as solid boats: on the spawn grid where they join,
// 20 m apart, and spread over the disk.
func BenchmarkTickEncounters(b *testing.B) {
	for _, layout := range []string{"grid", "spread"} {
		for _, solid := range []bool{false, true} {
			name := layout + "/ghosts"
			var enc *physics.EncounterPrepared
			if solid {
				name, enc = layout+"/solid", encounters(b)
			}
			b.Run(name, func(b *testing.B) {
				w, err := New(Config{Kinds: kinds(b), Waves: waves(b), Weather: sequence(b), Encounters: enc,
					Workers: runtime.GOMAXPROCS(0), Tick: 740_000_000})
				if err != nil {
					b.Fatal(err)
				}
				b.Cleanup(w.Close)
				fill(b, w, 1000, 1)
				if layout == "spread" {
					rng := rand.New(rand.NewPCG(7, 7))
					for i := range 1000 {
						r, a := 7000*math.Sqrt(rng.Float64()), 2*math.Pi*rng.Float64()
						send(b, w, bus.Command{Op: bus.Place, Boat: uint64(i + 1),
							State: physics.State{X: r * math.Sin(a), Y: r * math.Cos(a), Heading: 2 * math.Pi * rng.Float64(), SheetLimit: 0.5}})
					}
				}
				send(b, w, bus.Command{Op: bus.SetWeather, Weather: bus.Weather{Mode: bus.WeatherHeld, Regime: 3}})
				sail(w, 4*bus.SeaPeriod, 2)
				bumps := 0
				var phases phaseClock
				w.Observe(&phases)
				b.ReportAllocs()
				for b.Loop() {
					phases.start = time.Now()
					w.Tick()
					bumps += len(newBumps(w))
				}
				w.Observe(nil)
				b.ReportMetric(float64(len(w.Latest().Pairs)), "pairs")
				b.ReportMetric(float64(bumps)/float64(b.N)*30, "bumps/s")
				for _, p := range []Phase{PhasePhysics, PhaseContacts} {
					b.ReportMetric(float64(phases.total[p].Microseconds())/float64(b.N), p.String()+"-µs")
				}
			})
		}
	}
}

// phaseClock times each phase of the ticks it observes.
type phaseClock struct {
	start time.Time
	total [Phases]time.Duration
}

func (c *phaseClock) PhaseDone(p Phase) {
	now := time.Now()
	c.total[p] += now.Sub(c.start)
	c.start = now
}
