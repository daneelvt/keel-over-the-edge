// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"fmt"
	"math"
	"testing"
)

// testStorm is a storm of the catalog's kind, born at tick 0 at (east,
// north) m, moving toward heading degrees at knots, whole after growth
// minutes and gone after three hours, of radius 2 NM and a 22-knot peak.
func testStorm(t testing.TB, east, north, heading, knots, growth float64) (*WeatherPrepared, *SystemRecord) {
	t.Helper()
	p, kinds := testSystems(t)
	kind, ok := kinds["storm"]
	if !ok {
		t.Fatal("the catalog has no storm")
	}
	minute := 60.0 * StepsPerSecond
	return p, &SystemRecord{
		Kind: float64(kind), Seed: 12345, Born: 0, Mature: growth * minute, Decays: 120 * minute, Gone: 180 * minute,
		Track: TrackLine, East: math.Round(4 * east), North: math.Round(4 * north),
		Heading: math.Round(heading / 360 * TurnSteps), Speed: math.Round(knots * knot / SeaSpeedStep),
		Size: 2 * nauticalMile, Peak: math.Round(22 * knot / SeaSpeedStep), Depth: 1500,
	}
}

// groupSpeed is a period's group speed in deep water, m/s.
func groupSpeed(period float64) float64 { return gravity * period / (4 * math.Pi) }

// A storm held still: its swell reaches a place 2 NM from it when its
// band's longest waves have covered the distance and not before, their
// period first the band's longest, shortening to the storm's own as the rest
// arrive, and the height growing with it.
func TestSwellArrives(t *testing.T) {
	w := testWaves(t)
	p, r := testStorm(t, 0, 0, 0, 0, 1)
	band := p.kinds[toInt32(r.Kind)].swell.band
	d := 2 * nauticalMile
	first := d / groupSpeed(band[1]) * StepsPerSecond
	if s := SwellAt(w, p, r, d, 0, first-StepsPerSecond); s.Height != 0 {
		t.Fatalf("a second before its longest waves can arrive the swell is %+v", s)
	}
	period, height := math.Inf(1), 0.0
	came := false
	for tick := first; tick < first+1800*StepsPerSecond; tick += 15 * StepsPerSecond {
		s := SwellAt(w, p, r, d, 0, tick)
		if s.Height == 0 {
			if came {
				t.Fatalf("the swell went at tick %v", tick)
			}
			continue
		}
		if !came && s.Period < band[1]-0.3 {
			t.Errorf("the first swell is of %.2f s, not the band's longest %.1f", s.Period, band[1])
		}
		came = true
		if s.Period > period+1e-12 || s.Height < height-1e-12 {
			t.Errorf("at tick %v the period rose to %.3f s or the height fell to %.3f m", tick, s.Period, s.Height)
		}
		if math.Abs(wrapAngle(s.From-1.5*math.Pi)) > 1e-9 {
			t.Errorf("the swell comes from %.4f rad, the storm lies at %.4f", s.From, 1.5*math.Pi)
		}
		period, height = s.Period, s.Height
	}
	if !came {
		t.Fatal("no swell came in half an hour")
	}
	full := SwellHeight(p, r) * math.Sqrt(r.Size/d)
	if math.Abs(height-full) > 1e-9*full || period >= band[1]-0.5 {
		t.Errorf("half an hour on the swell is %.3f m of %.2f s, want %.3f m of the storm's own period", height, period, full)
	}
}

// The time the swell left a moving storm is the one a fine search finds:
// the tick whose distance from the storm the swell has travelled since.
func TestSwellRetardedTime(t *testing.T) {
	w := testWaves(t)
	for _, c := range []struct{ east, north, heading, knots float64 }{
		{-3 * nauticalMile, 0, 90, 6}, {0, 4 * nauticalMile, 200, 4.5}, {2000, -2000, 315, 3},
	} {
		_, r := testStorm(t, c.east, c.north, c.heading, c.knots, 30)
		x, y := 1000.0, 500.0
		tick := 70 * 60.0 * StepsPerSecond
		for _, period := range []float64{5, 5.8, 6.5} {
			perTick := groupSpeed(period) / StepsPerSecond
			got, _, _, _ := retarded(r, x, y, tick, perTick, w.swellSteps)
			// The emission tick by bisection.
			miss := func(tau float64) float64 {
				ex, ey := swellSource(r, tau)
				return math.Hypot(ex-x, ey-y) - perTick*(tick-tau)
			}
			lo, hi := r.Born, tick
			for hi-lo > 1e-3 {
				if m := (lo + hi) / 2; miss(m) < 0 {
					lo = m
				} else {
					hi = m
				}
			}
			if math.Abs(got-lo) > 1 {
				t.Errorf("%+v, %g s: the swell left at tick %.2f, a fine search says %.2f", c, period, got, lo)
			}
		}
	}
}

// Beyond the storm's edge the swell's height falls as the square root of
// the distance.
func TestSwellSpreads(t *testing.T) {
	w := testWaves(t)
	p, r := testStorm(t, 0, 0, 0, 0, 1)
	tick := 120 * 60.0 * StepsPerSecond
	r.Decays = tick + 1
	near := SwellAt(w, p, r, 2*r.Size, 0, tick)
	far := SwellAt(w, p, r, 0, -4*r.Size, tick)
	if want := near.Height / math.Sqrt2; math.Abs(far.Height-want) > 1e-9 {
		t.Errorf("at twice its radius %.4f m, at four times %.4f m, want %.4f", near.Height, far.Height, want)
	}
}

// The swell and the wind sea are culled apart: a light wind's sea keeps
// every wave under a swell, and the two together have the significant
// height of their variances added.
func TestSwellPartitions(t *testing.T) {
	w := testWaves(t)
	for _, c := range []struct {
		knots  float64
		swell  Swell
		within float64
	}{
		{6, Swell{Height: 0.3, Period: 5.7, From: math.Pi / 2}, 0.02},
		{12, Swell{Height: 0.3, Period: 5.7, From: math.Pi / 2}, 0.02},
		{20, Swell{Height: 0.5, Period: 5.7, From: 3}, 0.02},
		{32, Swell{Height: 0.8, Period: 6, From: 1}, 0.02},
	} {
		wind := SeaInputOf(c.knots*knot, 0, w.FetchCap())
		both := wind
		both.SetSwell(c.swell)
		alone := SeaInput{}
		alone.SetSwell(c.swell)
		win := newWindow(0, 0, 3)
		SeaArea(w, win, 0, wind)
		SeaArea(w, win, 1, both)
		SeaArea(w, win, 2, alone)
		kept := 0
		for i := range SeaComponents {
			if win.Amp[i] > 0 {
				kept++
				if !(win.Amp[SeaComponents+i] > 0) {
					t.Errorf("%g knots: wave %d of the wind sea is lost under the swell", c.knots, i)
				}
			}
		}
		hw, hs, h := win.Hs[0], win.Hs[2], win.Hs[1]
		if want := math.Hypot(hw, hs); math.Abs(h-want) > c.within*want {
			t.Errorf("%g knots: Hs %.3f m with the swell, √(%.3f² + %.3f²) = %.3f", c.knots, h, hw, hs, want)
		}
		if p := win.Parts[1]; math.Abs(p.WindHs-hw) > 1e-12 || math.Abs(p.SwellHs-hs) > 0.02*hs {
			t.Errorf("%g knots: parts %+v, the wind sea alone %.3f, the swell alone %.3f", c.knots, p, hw, hs)
		}
		if math.Abs(hs-c.swell.Height) > 0.03*c.swell.Height {
			t.Errorf("%g knots: a swell of %.2f m has Hs %.3f over the band", c.knots, c.swell.Height, hs)
		}
		t.Logf("%g knots: %d waves alone, Hs %.3f; with the swell %d waves, Hs %.3f", c.knots, kept, hw, countWaves(win.Amp[SeaComponents:2*SeaComponents]), h)
	}
}

func countWaves(amp []float64) int {
	n := 0
	for _, a := range amp {
		if a > 0 {
			n++
		}
	}
	return n
}

// An area of swell and current costs no allocation.
func TestSeaAreaWithSwellAllocatesNothing(t *testing.T) {
	w := testWaves(t)
	win := newWindow(0, 0, 1)
	i := uint32(0)
	allocs := testing.AllocsPerRun(100, func() {
		i++
		in := SeaInput{Speed: 1000 + i%500, From: i % 65536, Fetch: 11112, SwellHeight: 60, SwellPeriod: 580, SwellFrom: 9000, CurrentEast: -40, CurrentNorth: 30}
		SeaArea(w, win, 0, in)
	})
	if allocs != 0 {
		t.Errorf("SeaArea allocates %v times", allocs)
	}
}

// A wave on a current, as wave action is kept: a 3 s wave against a knot is
// raised by 1.32 and lowered with it; one the current blocks is raised by
// the most.
func TestCurrentFactor(t *testing.T) {
	w := testWaves(t)
	peak := 2 * math.Pi / 3
	if f := w.CurrentFactor(0, -knot, peak, 0); math.Abs(f-1.321) > 0.002 {
		t.Errorf("a 3 s wave against a knot is raised by %.4f, want 1.321", f)
	}
	with := w.CurrentFactor(0, knot, peak, 0)
	// c₀ / √((2U + c) c), c = ½ c₀ (1 + √(1 + 4U/c₀)).
	c0 := gravity / peak
	c := 0.5 * c0 * (1 + math.Sqrt(1+4*knot/c0))
	if want := c0 / math.Sqrt((2*knot+c)*c); math.Abs(with-want) > 1e-12 || with >= 1 {
		t.Errorf("with a knot it is %.6f, want %.6f, below 1", with, want)
	}
	if f := w.CurrentFactor(0, -0.3*c0, peak, 0); f != w.currentMost {
		t.Errorf("a blocked wave is raised by %v, want the most, %v", f, w.currentMost)
	}
	if f := w.CurrentFactor(knot, 0, peak, 0); f != 1 {
		t.Errorf("a current across the wave raises it by %v", f)
	}
}

// The outer waters are roughest with the wind against the drain: a gale
// blowing inward on the west of the disk meets the drain running out, on
// its east runs with it, and at the same distance from the centre the
// western sea is at least a fifth higher.
func TestAgainstTheDrain(t *testing.T) {
	w := testWaves(t)
	p := testWeather(t)
	for _, nm := range []float64{4.2, 4.4} {
		x := nm * nauticalMile
		col, eastCol := SeaAreaOf(-x), SeaAreaOf(x)
		row := SeaAreaOf(0)
		win := newWindow(0, 0, 2)
		for i, c := range []int32{col, eastCol} {
			// A gale from the west, its sea travelling east.
			in := w.OpenSea(34*knot, 1.5*math.Pi)
			in.SetCurrent(SeaCurrent(p, 1, c, row))
			SeaArea(w, win, int32(i), in)
		}
		west, east := win.Hs[0], win.Hs[1]
		if !(west > 1.2*east) {
			t.Errorf("%.1f NM out: Hs %.3f m against the drain, %.3f m with it", nm, west, east)
		}
		t.Logf("%.1f NM out: Hs %.3f m against the drain (×%.2f), %.3f m with it (×%.2f)",
			nm, west, west/win.Parts[0].StillHs, east, east/win.Parts[1].StillHs)
	}
}

// Areas of the same inputs, swell and current too, have the same waves,
// whether made or copied.
func TestSeaAreaCopiesSwellAndCurrent(t *testing.T) {
	w := testWaves(t)
	in := SeaInputOf(20*knot, 1, 4000)
	in.SetSwell(Swell{Height: 0.7, Period: 5.8, From: 4})
	in.SetCurrent(0.3, -0.6)
	win := newWindow(0, 0, 2)
	SeaArea(w, win, 0, in)
	SeaArea(w, win, 1, in)
	alone := newWindow(5, 5, 1)
	SeaArea(w, alone, 0, in)
	for i := range SeaComponents {
		if win.Amp[i] != win.Amp[SeaComponents+i] || win.Amp[i] != alone.Amp[i] {
			t.Fatalf("wave %d: %v, %v copied, %v alone", i, win.Amp[i], win.Amp[SeaComponents+i], alone.Amp[i])
		}
	}
	if win.Parts[0] != win.Parts[1] || win.Parts[0] != alone.Parts[0] {
		t.Errorf("the parts differ: %+v, %+v, %+v", win.Parts[0], win.Parts[1], alone.Parts[0])
	}
}

func BenchmarkSwellAt(bm *testing.B) {
	w := testWaves(bm)
	p, r := testStorm(bm, -3*nauticalMile, 0, 90, 4.5, 30)
	tick := 70 * 60.0 * StepsPerSecond
	for bm.Loop() {
		SwellAt(w, p, r, 1000, 500, tick)
	}
}

func BenchmarkSeaAreaSwell(bm *testing.B) {
	w := testWaves(bm)
	for _, c := range []struct {
		name    string
		swell   bool
		current bool
	}{{"wind", false, false}, {"swell", true, false}, {"swell-current", true, true}} {
		bm.Run(c.name, func(bm *testing.B) {
			win := newWindow(0, 0, 1)
			i := uint32(0)
			for bm.Loop() {
				i++
				in := SeaInput{Speed: 1000 + i%500, From: i % 65536, Fetch: 11112}
				if c.swell {
					in.SwellHeight, in.SwellPeriod, in.SwellFrom = 60, 580, 9000
				}
				if c.current {
					in.CurrentEast, in.CurrentNorth = -40, 30
				}
				SeaArea(w, win, 0, in)
			}
		})
	}
}

// BenchmarkStepInSwell times a step in a sea with a swell, beside the same
// sea without it.
func BenchmarkStepInSwell(bm *testing.B) {
	b := jolly(bm)
	w := testWaves(bm)
	for _, knots := range []float64{12, 34} {
		for _, swell := range []bool{false, true} {
			in := SeaInputOf(knots*knot, 0, w.FetchCap())
			if swell {
				in.SetSwell(Swell{Height: 0.6, Period: 5.8, From: 4})
			}
			win := newWindow(0, 0, 1)
			SeaArea(w, win, 0, in)
			win.Seal()
			o := &ocean{Sea: Sea{Waves: w, Window: win}}
			o.Tick = &o.tick
			o.at(7.4e8)
			bm.Run(fmt.Sprintf("%gknots-swell=%v-%dwaves", knots, swell, win.Count), func(bm *testing.B) {
				s := State{Heading: math.Pi / 2, Surge: 3, SheetLimit: 0.6}
				c := Control{Sheet: 0.35}
				e := Env{WindSpeed: 7, WindFrom: 0}
				var out Out
				for bm.Loop() {
					Step(&s, &c, &e, &o.Sea, nil, b, &out)
				}
			})
		}
	}
}
