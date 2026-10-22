// SPDX-License-Identifier: AGPL-3.0-only

package chart

import (
	"flag"
	"math"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sight"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

var runSeeds = flag.Int("runs", 0, "tally the subjects charted by eight runs from the main port in this many seeds' worlds")

// TestRuns tallies, in the first -runs seeds' worlds, what eight straight
// runs from the main port's island to the rim chart, by day, with what is
// known charted first, a look every 7.5 m (half a second at 30 knots):
//
//	go test ./internal/chart -run TestRuns -runs 40 -v
func TestRuns(t *testing.T) {
	if *runSeeds == 0 {
		t.Skip("a tally: -runs N")
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	var perRun, perKm, share []float64
	kinds := map[string]int{}
	total := 0
	for seed := 1; seed <= *runSeeds; seed++ {
		b, err := worldgen.Generate(uint64(seed), cat)
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		w := Build(b, cat)
		charted := make([]uint64, sight.Words(len(w.Subjects)))
		for _, k := range w.Known {
			charted[k>>6] |= 1 << (k & 63)
		}
		home := w.Subjects[w.Known[0]]
		l := w.Table.Lookout(2)
		calm := &sight.Conditions{Weather: w.Calm()}
		var seen []sight.Seen
		all := 0
		for r := range 8 {
			a := float64(r) * math.Pi / 4
			n := 0
			start := 400.0
			for d := start; d < cat.World.Disk.Radius; d += 7.5 {
				l.X, l.Y = home.X+d*math.Sin(a), home.Y+d*math.Cos(a)
				seen = w.Table.Look(&l, charted, calm, seen[:0])
				for _, s := range seen {
					charted[s.Subject>>6] |= 1 << (s.Subject & 63)
					n++
					kinds[kindOf(cat, &w.Subjects[s.Subject])]++
				}
			}
			perRun = append(perRun, float64(n))
			perKm = append(perKm, float64(n)/((cat.World.Disk.Radius-start)/1000))
			all += n
		}
		share = append(share, float64(all)/float64(len(w.Subjects)))
		total += all
	}
	t.Logf("%d seeds: a run charts a median of %.0f (%.0f–%.0f), %.2f a km; eight runs chart %.0f%% of a world (%.0f–%.0f%%)",
		*runSeeds, median(perRun), slices.Min(perRun), slices.Max(perRun), median(perKm),
		100*median(share), 100*slices.Min(share), 100*slices.Max(share))
	for k, n := range kinds {
		t.Logf("  %s: %.0f%%", k, 100*float64(n)/float64(total))
	}
}

func kindOf(cat *catalog.Catalog, s *Subject) string {
	switch s.Kind {
	case sight.Island:
		return "islands"
	case sight.Place:
		return cat.World.Places.Kinds[s.Sort].Name
	}
	return "features"
}

func median(v []float64) float64 {
	s := slices.Clone(v)
	slices.Sort(s)
	if len(s) == 0 {
		return 0
	}
	return s[len(s)/2]
}

// BenchmarkSighting is a tick of a world of n boats spread over seed 1's
// disk, sailing, with sighting on and off, and on with half of them in a
// fog bank: what sighting costs a tick.
func BenchmarkSighting(bm *testing.B) {
	b, cat := world1(bm)
	w := Build(b, cat)
	waves, kinds := cat.Prepare()
	tl, err := weather.FromCatalog(cat)
	if err != nil {
		bm.Fatal(err)
	}
	fogKind := -1
	for i, k := range cat.Weather.Systems {
		if k.Fog != nil {
			fogKind = i
		}
	}
	// The fog bank's centre, m east.
	const bank = 2500
	for _, n := range []int{100, 1000} {
		for _, name := range []string{"off", "on", "fog"} {
			on, fog := name != "off", name == "fog"
			bm.Run(name+"/"+strconv.Itoa(n), func(bm *testing.B) {
				cfg := sim.Config{Kinds: kinds, Waves: waves, Workers: 4, Tick: 100, Capacity: n + 16, Weather: tl}
				if on {
					cfg.Sight = &sim.Sight{Table: w.Table, Every: 15, Lookouts: w.Lookouts}
				}
				world, err := sim.New(cfg)
				if err != nil {
					bm.Fatal(err)
				}
				defer world.Close()
				q := world.Bus().Commands.Developer()
				for i := range n {
					if err := q.TrySend(bus.Command{Op: bus.Join, Account: bus.Account{byte(i), byte(i >> 8), 1}, Conn: uint64(i + 1)}); err != nil {
						bm.Fatal(err)
					}
				}
				world.Tick()
				f := world.Latest()
				for i, s := range f.Live {
					a := float64(i) * 2.399963
					r := 7000 * math.Sqrt(float64(i)/float64(n))
					x, y := r*math.Sin(a), r*math.Cos(a)
					if fog && i%2 == 0 {
						// Half of them in the bank's very poor core.
						r = 700 * math.Sqrt(float64(i)/float64(n))
						x, y = bank+r*math.Sin(a), r*math.Cos(a)
					}
					_ = q.TrySend(bus.Command{Op: bus.Place, Boat: f.Boat[s], State: physics.State{X: x, Y: y, Heading: a}})
				}
				world.Tick()
				// A steady breeze, and in the fog variant a fog bank at its
				// whole over the boats.
				_ = q.TrySend(bus.Command{Op: bus.SetWeather, Weather: bus.Weather{Mode: bus.WeatherSteady, Speed: 300, Dir: 0}})
				world.Tick()
				if fog {
					_ = q.TrySend(bus.Command{Op: bus.SetWeather, Weather: bus.Weather{Mode: bus.WeatherSystem, Kind: uint16(fogKind), East: bank * 4, In: 30}})
					for range 60 {
						world.Tick()
					}
					if len(world.Latest().Systems) == 0 {
						bm.Fatal("no fog bank placed")
					}
				}
				phases := &phaseClock{}
				world.Observe(phases)
				bm.ResetTimer()
				for range bm.N {
					world.Tick()
				}
				bm.ReportMetric(float64(phases.rules.Nanoseconds())/1000/float64(bm.N), "µs-rules/tick")
			})
		}
	}
}

// phaseClock times the rules phase: from the contacts' end to its own.
type phaseClock struct {
	last  time.Time
	rules time.Duration
}

func (c *phaseClock) PhaseDone(p sim.Phase) {
	now := time.Now()
	if p == sim.PhaseRules {
		c.rules += now.Sub(c.last)
	}
	c.last = now
}
