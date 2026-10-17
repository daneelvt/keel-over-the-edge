// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"math/rand/v2"
	"testing"
)

// A boat is over at exactly the lip and beyond it, and not a hair inside.
func TestOverEdge(t *testing.T) {
	w := testWeather(t)
	r := w.Edge()
	if r != 8334 {
		t.Fatalf("the lip is %v m from the centre", r)
	}
	for _, bearing := range []float64{0, math.Pi / 2, math.Pi, -math.Pi / 2} {
		sin, cos := math.Sincos(bearing)
		x, y := math.Round(r*sin), math.Round(r*cos)
		if !OverEdge(w, x, y) {
			t.Errorf("at (%v, %v), on the lip, not over", x, y)
		}
		in := func(v float64) float64 { return math.Nextafter(v, 0) }
		if OverEdge(w, in(x), in(y)) {
			t.Errorf("at (%v, %v), a hair inside, over", in(x), in(y))
		}
		if !OverEdge(w, 1.001*x, 1.001*y) {
			t.Errorf("beyond the lip at %v rad, not over", bearing)
		}
	}
	if OverEdge(w, math.NaN(), 0) {
		t.Error("a NaN is over")
	}
	// The comparison is of the products as the module rounds them: x² + y²
	// against R², nothing fused.
	rng := rand.New(rand.NewPCG(24, 1))
	for range 1_000_000 {
		a := rng.Float64() * 2 * math.Pi
		d := r + (rng.Float64()-0.5)*1e-6*r
		x, y := d*math.Sin(a), d*math.Cos(a)
		want := float64(x*x)+float64(y*y) >= float64(r*r)
		if OverEdge(w, x, y) != want {
			t.Fatalf("at (%v, %v) OverEdge says %v", x, y, !want)
		}
	}
	if d := EdgeDistance(w, 0, 8234); math.Abs(d-100) > 1e-9 {
		t.Errorf("100 m inside the lip, EdgeDistance says %v", d)
	}
}

// The fall draft: nothing inside the mist band; at the lip the catalog's
// four knots toward the lip, in a steady spell and in a spell of each
// regime; in the wind with and without its gusts, not in the sea's.
func TestFallDraft(t *testing.T) {
	p, err := weatherOnce()
	if err != nil {
		t.Fatal(err)
	}
	w := testWeather(t)
	calm := *p
	calm.FallDraft = 0
	var without WeatherPrepared
	PrepareWeather(&calm, &without)
	regimes := []string{"settled", "trade", "unsettled", "stormy"}
	for k := range len(regimes) + 1 {
		var s Spell
		name := "steady"
		if k == 0 {
			s = SteadySpell(8*knot, 1, 0)
		} else {
			name = regimes[k-1]
			s = spellOfRegime(t, w, name, uint32(k), 20000, 0, 4*hourOfTicks)
		}
		with, none := weatherOf(w, s), weatherOf(&without, s)
		for _, c := range []struct{ nm, knots float64 }{{0, 0}, {3, 0}, {4.19, 0}, {4.35, 2}, {4.5, 4}} {
			for _, bearing := range []float64{0.3, 2, -1.2} {
				sin, cos := math.Sincos(bearing)
				x, y := c.nm*nm*sin, c.nm*nm*cos
				a, b := windAt(with, x, y, worldTick), windAt(none, x, y, worldTick)
				for _, pair := range [][4]float64{{a.Speed, a.From, b.Speed, b.From}, {a.MeanSpeed, a.MeanFrom, b.MeanSpeed, b.MeanFrom}} {
					// The air's velocity with the draft less without it.
					de := -pair[0]*math.Sin(pair[1]) + pair[2]*math.Sin(pair[3])
					dn := -pair[0]*math.Cos(pair[1]) + pair[2]*math.Cos(pair[3])
					want := c.knots * knot
					if math.Abs(de-want*sin) > 1e-9 || math.Abs(dn-want*cos) > 1e-9 {
						t.Errorf("%s at %g NM, %g rad: the draft is (%.4f, %.4f) m/s, want %.4f outward", name, c.nm, bearing, de, dn, want)
					}
				}
				var at, bt WeatherTick
				WeatherAt(with, &at, worldTick)
				WeatherAt(none, &bt, worldTick)
				s1, f1 := MeanWindAt(&at, x, y)
				s2, f2 := MeanWindAt(&bt, x, y)
				if s1 != s2 || f1 != f2 {
					t.Errorf("%s at %g NM: the sea's wind has the draft", name, c.nm)
				}
				e := WindAt(&at, x, y, nil)
				if e.WindSpeed != a.Speed || e.WindFrom != a.From || e.MeanFrom != a.MeanFrom {
					t.Errorf("%s at %g NM: WindAt is not the wind in full", name, c.nm)
				}
			}
		}
	}
}

// The edge scenario beats off the lip in a 12-knot breeze blowing onto it,
// gaining against the drain and the draft, then lets fly and is carried
// over.
func TestEdgeScenario(t *testing.T) {
	var sf scenarioFile
	readJSON(t, scenariosFile, &sf)
	w := testWeather(t)
	for _, sc := range sf.Scenarios {
		if sc.Name != "edge" {
			continue
		}
		g, err := runScenario(sf.Sea, sf.Params, sf.Wind, sf.Ground, sc)
		if err != nil {
			t.Fatal(err)
		}
		last := 100.0
		over := 0
		for _, cp := range g.Checkpoints {
			x, y := fromHex(t, cp.State["x"]), fromHex(t, cp.State["y"])
			d := EdgeDistance(w, x, y)
			t.Logf("step %d: %.1f m inside the lip", cp.Step, d)
			if cp.Step <= 3600 && !(d > last) {
				t.Errorf("beating off, at step %d the boat is %.1f m inside the lip, %.1f m before", cp.Step, d, last)
			}
			last = d
			if over == 0 && OverEdge(w, x, y) {
				over = cp.Step
			}
		}
		if over == 0 {
			t.Error("let fly, the boat never went over")
		}
		return
	}
	t.Fatal("no edge scenario")
}
