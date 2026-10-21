// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"testing"
)

// reefShelter is the shelter of a reef 2 m high running north and south
// for 600 m through the cells of column 300, wind and waves both.
func reefShelter(t testing.TB) *Shelter {
	t.Helper()
	var s ShelterPrepared
	PrepareShelter(&testShelterParams, &s)
	heights := make(ShelterHeights, ShelterFieldSize)
	land := &ShelterLand{Land: make([]bool, ShelterFieldSize), Across: make([]bool, ShelterFieldSize), Near: make([]bool, ShelterFieldSize)}
	for b := int32(255); b < 275; b++ {
		heights[ShelterIndex(300, b)] = 2
		land.Land[ShelterIndex(300, b)] = true
	}
	sh := new(Shelter)
	chunk := func(n int32) *ShelterChunk {
		if sh.Chunks[n] == nil {
			ch := new(ShelterChunk)
			for v := 0; v < len(ch.Values); v += ShelterStride {
				ch.Values[v] = ShelterFactorOne
			}
			sh.Chunks[n] = ch
		}
		return sh.Chunks[n]
	}
	cols, rows := ShelterGrid()
	for k := range int32(ShelterDirections) {
		f := newShelterField()
		ShelterDirection(heights, k, &s, &f)
		for a := range cols {
			for b := range rows {
				fb, tb := ShelterBytes(ShelterAt(&f, ShelterIndex(a, b), &s))
				if fb == ShelterFactorOne && tb == 0 {
					continue
				}
				n, i, _ := ShelterCellOf(a, b)
				v := chunk(n).Values[(i*ShelterDirections+k)*ShelterStride:]
				v[0], v[1] = fb, tb
			}
		}
	}
	ShelterLee(land, testLeeReach, chunk)
	return sh
}

// leeSea is a sea of one wind over open water in every area about (x, y),
// in the lee of sh.
func leeSea(t testing.TB, sh *Shelter, knots, from float64, swell Swell, x, y float64) *Sea {
	t.Helper()
	w := testWaves(t)
	in := w.OpenSea(knots*knot, from)
	in.SetSwell(swell)
	win := newWindow(SeaAreaOf(x)-2, SeaAreaOf(y)-2, 5)
	for i := range int32(25) {
		SeaArea(w, win, i, in)
	}
	win.Seal()
	var tick SeaTick
	SeaAt(w, &tick, 7.4e8)
	return &Sea{Waves: w, Window: win, Tick: &tick, Lee: sh}
}

// Behind a reef 2 m high the wind sea falls, while the wind, which a reef
// that low shelters only within a few tens of metres, does not.
func TestReefCalmsTheWaves(t *testing.T) {
	sh := reefShelter(t)
	x0, y0 := ShelterCellCentre(300, 265)
	// A wind from the west: its lee is to the east.
	from := 1.5 * math.Pi
	sea := leeSea(t, sh, 20, from, Swell{}, x0, y0)
	for _, d := range []float64{100, 200, 400} {
		x, y := x0+d, y0
		wind, _ := sh.At(x, y, from)
		lee := LeeAt(sea, x, y)
		if wind < 0.99 || !(lee < 0.3) {
			t.Errorf("%g m behind the reef: the wind's factor %.3f, the waves' %.3f", d, wind, lee)
		}
		// Upwind of it, the open sea.
		if f := LeeAt(sea, x0-d, y0); f != 1 {
			t.Errorf("%g m upwind of the reef the waves' factor is %v", d, f)
		}
	}
	// A swell is shadowed behind it, never wholly.
	swell := leeSea(t, sh, 0.1, from, Swell{Height: 0.8, Period: 6, From: from}, x0, y0)
	if f := LeeAt(swell, x0+100, y0); !(f > sea.Waves.shadowLeast-1e-9) || !(f < 0.4) {
		t.Errorf("100 m behind the reef a swell keeps %.3f of itself", f)
	}
	// The step feels it: the effective wave under a hull in the lee is
	// lower by the factor, its depth's cap aside.
	open, lee := WaveUnder(sea, nil, 3.8, 1.1, x0-300, y0, 0), WaveUnder(sea, nil, 3.8, 1.1, x0+150, y0, 0)
	if math.Abs(lee.Height) > 0.5*math.Max(math.Abs(open.Height), 0.05) {
		t.Errorf("the wave under a hull in the lee is %.3f m, in the open %.3f m", lee.Height, open.Height)
	}
}

// The lee's factor on the wind sea is the band's own: within a quarter of
// the height the band's spectrum has over the lee's fetch, for winds of 10
// to 30 knots, up to where it begins to give way to the open sea's.
func TestLeeFollowsTheBand(t *testing.T) {
	w := testWaves(t)
	win := newWindow(0, 0, 2)
	for _, knots := range []float64{10, 20, 30} {
		u := float64(SeaInputOf(knots*knot, 0, 0).Speed) * SeaSpeedStep
		SeaArea(w, win, 0, w.OpenSea(knots*knot, 0))
		open := win.Hs[0]
		for _, fetch := range []float64{100, 200, 300, 400} {
			SeaArea(w, win, 1, SeaInputOf(knots*knot, 0, fetch))
			band := win.Hs[1] / open
			got := w.leeFactor(LeeByte(fetch), u, win.Parts[0].WindBand, false)
			if math.Abs(got-band) > 0.25*band+0.02 {
				t.Errorf("%g knots over %g m: the lee leaves %.3f, the band's spectrum %.3f", knots, fetch, got, band)
			}
		}
		// And it gives way to the open sea's by the reach's end.
		if f := w.leeFactor(LeeByte(w.leeReach-2), u, win.Parts[0].WindBand, false); f < 0.99 {
			t.Errorf("%g knots: at the reach's end the lee leaves %.3f", knots, f)
		}
	}
}

// LeeByte and its reading hold a fetch to the step, and beyond the most a
// byte holds, or no number, are open water, as a table without the byte is.
func TestLeeByte(t *testing.T) {
	for _, f := range []float64{0, 3.9, 4, 100, 1016} {
		got, open := leeFetch(LeeByte(f))
		if open || math.Abs(got-f) > ShelterLeeStep/2 {
			t.Errorf("a fetch of %g m reads as %g m, open %v", f, got, open)
		}
	}
	for _, f := range []float64{1019, 5000, math.NaN(), -1} {
		if b := LeeByte(f); b != ShelterLeeOpen {
			t.Errorf("a fetch of %g m is byte %d, not open water", f, b)
		}
	}
	var zero ShelterChunk
	sh := &Shelter{}
	sh.Chunks[0] = &zero
	x, y := ShelterCellCentre(2, 2)
	sea := leeSea(t, sh, 20, 0, Swell{}, x, y)
	if f := LeeAt(sea, x, y); f != 1 {
		t.Errorf("a table with no lee's bytes gives %v", f)
	}
}

func BenchmarkLeeAt(bm *testing.B) {
	sh := reefShelter(bm)
	x0, y0 := ShelterCellCentre(300, 265)
	sea := leeSea(bm, sh, 20, 1.5*math.Pi, Swell{Height: 0.6, Period: 6, From: 1.5 * math.Pi}, x0, y0)
	for _, c := range []struct {
		name string
		x, y float64
	}{{"near", x0 + 150, y0 + 7}, {"open", x0 + 3000, y0}} {
		bm.Run(c.name, func(bm *testing.B) {
			for bm.Loop() {
				LeeAt(sea, c.x, c.y)
			}
		})
	}
}

// BenchmarkStepInTheLee times a step in the reef's lee and on the open sea
// with the shelter held, beside the step with none.
func BenchmarkStepInTheLee(bm *testing.B) {
	b := jolly(bm)
	sh := reefShelter(bm)
	x0, y0 := ShelterCellCentre(300, 265)
	for _, c := range []struct {
		name string
		x    float64
		lee  *Shelter
	}{{"none", x0 + 3000, nil}, {"open", x0 + 3000, sh}, {"lee", x0 + 150, sh}} {
		sea := leeSea(bm, sh, 12, 1.5*math.Pi, Swell{}, x0, y0)
		sea.Lee = c.lee
		bm.Run(c.name, func(bm *testing.B) {
			s := State{X: c.x, Y: y0, Heading: 0, Surge: 3, SheetLimit: 0.6}
			ctl := Control{Sheet: 0.35}
			e := Env{WindSpeed: 6, WindFrom: 1.5 * math.Pi}
			var o Out
			for bm.Loop() {
				s.X, s.Y = c.x, y0
				Step(&s, &ctl, &e, sea, nil, b, &o)
			}
		})
	}
}
