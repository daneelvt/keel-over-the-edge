// SPDX-License-Identifier: AGPL-3.0-only

package sim_test

import (
	"math"
	"slices"
	"sync"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// untouched is how many of the start's first places are sailed, and the
// winds at mid-disk they are sailed in, knots: a calm and a breeze, from
// eight directions.
const untouched = 64

var untouchedWinds = []float64{0.2, 10}

// A sailor who touches nothing gets under way: in seeds 1 to 8, on each of
// the start's first places, in a calm and a breeze from eight directions,
// a new boat is making 1.5 knots or more 20 s after it appears and is
// afloat a minute after. Flat water: what the light air at the start
// raises barely moves a boat, and the waves would make the test three
// times as long.
func TestUntouchedSailorsSailAway(t *testing.T) {
	if testing.Short() {
		t.Skip("makes eight whole worlds")
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	_, kinds := cat.Prepare()
	prep := cat.PrepareWeather()
	var settled physics.Regime
	for i, r := range cat.Weather.Regimes {
		if r.ID == "settled" {
			settled = catalog.Regimes(cat)[i]
		}
	}
	var mu sync.Mutex
	var speeds []float64
	var wg sync.WaitGroup
	for seed := uint64(1); seed <= 8; seed++ {
		wg.Go(func() {
			b, err := worldgen.Generate(seed, cat)
			if err != nil {
				t.Error(err)
				return
			}
			terrain := b.Terrain(cat.PrepareGround())
			if terrain.Harbour == nil {
				t.Errorf("seed %d has no harbour", seed)
				return
			}
			for d := range 8 {
				for _, knots := range untouchedWinds {
					var s physics.Spell
					physics.DrawSpell(prep, &settled, uint32(d), uint32(seed), &s)
					s.From = float64(d * physics.TurnSteps / 8)
					s.Speed = math.Round(knots * 1852 / 3600 / physics.SeaSpeedStep)
					tl := weather.FixedIn(prep, s).InHarbour(terrain.Harbour)
					got := sailUntouched(t, kinds, nil, cat.StartSheets(), tl, terrain)
					mu.Lock()
					for i, g := range got {
						speeds = append(speeds, g.at20)
						if g.at20 < 1.5 || g.aground {
							t.Errorf("seed %d, %.1f knots from %03d°: place %d is making %.2f knots at 20 s, aground at a minute %v",
								seed, knots, d*45, i, g.at20, g.aground)
						}
					}
					mu.Unlock()
				}
			}
		})
	}
	wg.Wait()
	slices.Sort(speeds)
	if len(speeds) > 0 {
		t.Logf("%d starts: at 20 s the least %.2f knots, a tenth under %.2f, the median %.2f",
			len(speeds), speeds[0], speeds[len(speeds)/10], speeds[len(speeds)/2])
	}
}

// untouchedSail is how an untouched boat fared: its speed through the
// water 20 s after it appeared, knots, and whether it was aground a minute
// after.
type untouchedSail struct {
	at20    float64
	aground bool
}

// sailUntouched starts a boat on each of the first untouched places of a
// world of terrain, in timeline's weather, and sails them a minute with
// nobody at the helm.
func sailUntouched(t *testing.T, kinds []physics.Prepared, waves *physics.Waves, sheets [][][2]float64, tl *weather.Timeline,
	terrain *sim.Terrain) []untouchedSail {
	t.Helper()
	w, err := sim.New(sim.Config{Capacity: untouched, Kinds: kinds, StartSheets: sheets, Waves: waves, Weather: tl, Terrain: terrain, Workers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	for i := range untouched {
		c := bus.Command{Op: bus.Join, Account: bus.Account{15: byte(i + 1)}}
		if err := w.Bus().Commands.Developer().TrySend(c); err != nil {
			t.Fatal(err)
		}
	}
	w.Tick()
	out := make([]untouchedSail, untouched)
	for tick := 1; tick <= 60*physics.StepsPerSecond; tick++ {
		w.Tick()
		f := w.Latest()
		if len(f.Live) != untouched {
			t.Fatalf("%d boats joined", len(f.Live))
		}
		for _, s := range f.Live {
			st := &f.State[s]
			switch tick {
			case 20 * physics.StepsPerSecond:
				out[s].at20 = math.Sqrt(st.Surge*st.Surge+st.Sway*st.Sway) * 3600 / 1852
			case 60 * physics.StepsPerSecond:
				e, _ := terrain.Ground.At(st.X, st.Y)
				out[s].aground = e > -0.5 || st.GroundTimer > 0
			}
		}
	}
	return out
}

// A new boat in a world with a start area faces 110° off the mean wind at
// its place, on the side leading away from the coast, with its kind's
// start sheet and the autopilot off.
func TestANewBoatStartsOnAReach(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	waves, kinds := cat.Prepare()
	away := 90 * math.Pi / 180
	terrain := &sim.Terrain{Start: []physics.State{{X: 0, Y: -2000}, {X: 30, Y: -2000}}, Away: []float64{away, away}}
	for _, from := range []float64{0, 90, 200, 300} {
		tl := weather.FixedIn(cat.PrepareWeather(), physics.SteadySpell(5, from*math.Pi/180, 0))
		w, err := sim.New(sim.Config{Capacity: 2, Kinds: kinds, StartSheets: cat.StartSheets(), Waves: waves, Weather: tl, Terrain: terrain})
		if err != nil {
			t.Fatal(err)
		}
		if err := w.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.Join, Account: bus.Account{15: 1}}); err != nil {
			t.Fatal(err)
		}
		w.Tick()
		f := w.Latest()
		st, word, pilot := f.State[0], f.Control[0], f.Pilot[0]
		off := math.Remainder(st.Heading-from*math.Pi/180, 2*math.Pi)
		if d := math.Abs(math.Abs(off) - 110*math.Pi/180); d > 0.02 {
			t.Errorf("wind from %03.0f°: the boat heads %.1f°, %.1f° off it", from, st.Heading*180/math.Pi, off*180/math.Pi)
		}
		// Of the two reaches, the one closer to the way away from the coast.
		other := st.Heading - 2*off
		if math.Cos(st.Heading-away) < math.Cos(other-away)-1e-9 {
			t.Errorf("wind from %03.0f°: the boat heads %.1f°, the reach toward the coast", from, st.Heading*180/math.Pi)
		}
		if want := uint16(math.Round(0.25 * bus.Steps)); word.SheetIndex() != want || word.HelmIndex() != bus.Steps/2 || pilot.Mode() != bus.PilotOff {
			t.Errorf("wind from %03.0f°: the sheet %d (want %d), the helm %d, the autopilot %d", from, word.SheetIndex(), want, word.HelmIndex(), pilot.Mode())
		}
		w.Close()
	}
}
