// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"fmt"
	"math"
	"math/big"
	"sync"
	"testing"
)

// Helpers: the catalog's sea, from the scenarios file, and windows of it.

var (
	wavesOnce sync.Once
	wavesTest Waves
)

// testWaves returns the sea's waves, prepared from the scenarios file's
// copy of the catalog's values.
func testWaves(t testing.TB) *Waves {
	t.Helper()
	wavesOnce.Do(func() {
		var sf scenarioFile
		readJSON(t, scenariosFile, &sf)
		w, err := seaOf(sf.Sea)
		if err != nil {
			t.Fatal(err)
		}
		wavesTest = *w
	})
	return &wavesTest
}

// newWindow makes a window of size × size areas whose first is (col, row).
func newWindow(col, row, size int32) *SeaWindow {
	n := size * size
	return &SeaWindow{
		Col: col, Row: row, Size: size,
		Inputs: make([]SeaInput, n),
		Amp:    make([]float64, n*SeaComponents),
		Hs:     make([]float64, n),
		Peak:   make([]float64, n),
	}
}

// ocean is a sea for a test to step boats in.
type ocean struct {
	Sea
	tick SeaTick
}

// at moves the sea to a tick.
func (o *ocean) at(tick float64) *Sea {
	SeaAt(o.Waves, &o.tick, tick)
	return &o.Sea
}

// openSea is one area under a wind of knots from the direction from, in
// radians, over a fetch in nautical miles: the same sea everywhere.
func openSea(t testing.TB, knots, from, fetchNM float64) *ocean {
	t.Helper()
	w := testWaves(t)
	win := newWindow(0, 0, 1)
	SeaArea(w, win, 0, SeaInputOf(knots*knot, from, fetchNM*nauticalMile))
	win.Seal()
	o := &ocean{Sea: Sea{Waves: w, Window: win}}
	o.Tick = &o.tick
	o.at(0)
	return o
}

// oneWave is a sea of a single wave of the given length and amplitude,
// travelling toward the bearing toward, in radians: one of the sea's own
// waves is not that long or that way, so the test makes its own.
func oneWave(length, amplitude, toward float64) *ocean {
	w := &Waves{}
	k := 2 * math.Pi / length
	omega := math.Sqrt(gravity * k)
	sin, cos := math.Sincos(toward)
	w.Omega[0], w.K[0], w.East[0], w.North[0] = omega, k, sin, cos
	w.Turns[0] = omega / (2 * math.Pi * StepsPerSecond)
	w.kEast[0], w.kNorth[0] = k*sin, k*cos
	w.speed[0] = gravity / omega
	win := newWindow(0, 0, 1)
	win.Amp[0], win.Hs[0] = amplitude, 4*amplitude/math.Sqrt2
	win.Active[0], win.Count = 0, 1
	o := &ocean{Sea: Sea{Waves: w, Window: win}}
	o.Tick = &o.tick
	o.at(0)
	return o
}

// jonswap is the spectrum's density, written straight from its formula
// with the standard library, to check the package's own against.
func jonswap(om, u, f float64) float64 {
	x := gravity * f / (u * u)
	alpha := 0.076 * math.Pow(x, -0.22)
	peak := 22 * math.Cbrt(gravity*gravity/(u*f))
	sigma := 0.07
	if om > peak {
		sigma = 0.09
	}
	r := math.Exp(-(om - peak) * (om - peak) / (2 * sigma * sigma * peak * peak))
	return alpha * gravity * gravity * math.Pow(om, -5) * math.Exp(-1.25*math.Pow(peak/om, 4)) * math.Pow(3.3, r)
}

func TestComponents(t *testing.T) {
	w := testWaves(t)
	lo, hi := math.Sqrt(gravity*2*math.Pi/76), math.Sqrt(gravity*2*math.Pi/8)
	var east, north float64
	for i := range SeaComponents {
		if om := w.Omega[i]; om < lo || om > hi {
			t.Fatalf("wave %d: ω = %g, outside the band %g … %g", i, om, lo, hi)
		}
		if d := math.Hypot(w.East[i], w.North[i]); math.Abs(d-1) > 1e-15 {
			t.Fatalf("wave %d: its direction's length is %g", i, d)
		}
		if p := w.Phase[i]; p < 0 || p >= 2*math.Pi {
			t.Fatalf("wave %d: phase %g", i, p)
		}
		if got, want := w.K[i], w.Omega[i]*w.Omega[i]/gravity; got != want {
			t.Fatalf("wave %d: k = %g, ω²/g = %g", i, got, want)
		}
		east += w.East[i]
		north += w.North[i]
	}
	// Directions all the way round: their sum is near nothing.
	if d := math.Hypot(east, north) / SeaComponents; d > 0.01 {
		t.Errorf("the directions lean %g one way", d)
	}
	// And every eighth of the frequencies' range and of the compass holds
	// its share, within a few waves.
	var byOmega, byDir [8]int
	for i := range SeaComponents {
		byOmega[min(int(8*math.Log(w.Omega[i]/lo)/math.Log(hi/lo)), 7)]++
		byDir[min(int(8*math.Mod(math.Atan2(w.East[i], w.North[i])+2*math.Pi, 2*math.Pi)/(2*math.Pi)), 7)]++
	}
	for i := range 8 {
		if byOmega[i] < 30 || byOmega[i] > 34 || byDir[i] < 30 || byDir[i] > 34 {
			t.Errorf("eighth %d holds %d waves by frequency and %d by direction, not about 32", i, byOmega[i], byDir[i])
		}
	}
}

// The band's height in each wind is the spectrum's, integrated over the
// band, whichever way the wind blows, and the peak is where the JONSWAP fit
// puts it.
func TestAreaHeight(t *testing.T) {
	lo, hi := math.Sqrt(gravity*2*math.Pi/76), math.Sqrt(gravity*2*math.Pi/8)
	for _, knots := range []float64{6, 8, 10, 12, 16, 20, 26, 34, 45, 60} {
		for _, fetchNM := range []float64{1.5, 4, 6, 9} {
			// The wind as an area holds it, in whole steps.
			u := math.Floor(knots*knot/SeaSpeedStep+0.5) * SeaSpeedStep
			f := math.Floor(fetchNM*nauticalMile + 0.5)
			// Full development, past which the fit does not apply.
			if gravity*f/(u*u) > fullFetch {
				continue
			}
			const n = 20000
			m0 := 0.0
			for i := range n {
				om := lo + (float64(i)+0.5)*(hi-lo)/n
				m0 += jonswap(om, u, f) * (hi - lo) / n
			}
			want := 4 * math.Sqrt(m0)
			for d := range 16 {
				win := openSea(t, knots, float64(d)*2*math.Pi/16, fetchNM).Window
				got := win.Hs[0]
				if math.Abs(got-want) > 0.03*want+1e-6 {
					t.Errorf("%g knots over %g NM, from %d/16 of a turn: Hs %.4f m, the spectrum's %.4f m", knots, fetchNM, d, got, want)
				}
				if peak := 22 * math.Cbrt(gravity*gravity/(u*f)); math.Abs(win.Peak[0]-peak) > 1e-9*peak {
					t.Errorf("%g knots over %g NM: peak at %g rad/s, the fit's %g", knots, fetchNM, win.Peak[0], peak)
				}
				// What the cull leaves is what Hs says.
				sum := 0.0
				for _, a := range win.Amp {
					sum += a * a / 2
				}
				if hs := 4 * math.Sqrt(sum); math.Abs(hs-got) > 1e-12 {
					t.Errorf("%g knots: Hs %g, the amplitudes' %g", knots, got, hs)
				}
			}
		}
	}
}

func TestSeaStates(t *testing.T) {
	// The four states the look was chosen in, by wind and fetch.
	for _, st := range []struct {
		name         string
		knots, fetch float64
		hs           float64
		least, most  int32
	}{
		{"calm", 6, 1.5, 0.00, 0, 30},
		{"breeze", 12, 4, 0.18, 25, 60},
		{"fresh", 20, 6.5, 0.60, 50, 100},
		{"gale", 34, 9, 1.25, 80, 130},
	} {
		win := openSea(t, st.knots, 0, st.fetch).Window
		var part float64
		sum, quad := 0.0, 0.0
		for _, a := range win.Amp {
			sum += a * a
			quad += a * a * a * a
		}
		if quad > 0 {
			part = sum * sum / quad
		}
		t.Logf("%s: Hs %.3f m, peak %.2f s, %d waves evaluated, %.0f effective", st.name, win.Hs[0], 2*math.Pi/win.Peak[0], win.Count, part)
		if math.Abs(win.Hs[0]-st.hs) > 0.04 {
			t.Errorf("%s: Hs %.2f m, want about %.2f m", st.name, win.Hs[0], st.hs)
		}
		if win.Count < st.least || win.Count > st.most {
			t.Errorf("%s: %d waves evaluated, want %d to %d", st.name, win.Count, st.least, st.most)
		}
	}
}

func TestSpreadingFollowsTheWind(t *testing.T) {
	w := testWaves(t)
	for d := range 16 {
		from := float64(d) * 2 * math.Pi / 16
		win := openSea(t, 20, from, 6).Window
		var east, north float64
		for i, a := range win.Amp {
			east += a * a * w.East[i]
			north += a * a * w.North[i]
		}
		toward := math.Atan2(east, north)
		off := math.Remainder(toward-(from+math.Pi), 2*math.Pi)
		if math.Abs(off) > 2*deg {
			t.Errorf("wind from %.0f°: the waves' energy travels toward %.1f°, %.1f° off downwind", from/deg, toward/deg, off/deg)
		}
	}
}

// A sea cannot be older than fully developed: in a light wind over a long
// fetch the peak stays at Pierson and Moskowitz's.
func TestFullDevelopment(t *testing.T) {
	for _, knots := range []float64{0.5, 1, 2, 4} {
		win := openSea(t, knots, 0, 6).Window
		u := knots * knot
		u = math.Floor(u/SeaSpeedStep+0.5) * SeaSpeedStep
		pm := 0.877 * gravity / u
		if got := win.Peak[0]; math.Abs(got-pm) > 1e-9*pm {
			t.Errorf("%g knots: peak at %g rad/s, the fully developed sea's is %g", knots, got, pm)
		}
	}
	// And where the fetch limits it, the fit's peak is the younger.
	win := openSea(t, 20, 0, 6).Window
	if pm := 0.877 * gravity / (20 * knot); win.Peak[0] < pm {
		t.Errorf("20 knots over 6 NM: peak %g, older than the fully developed %g", win.Peak[0], pm)
	}
}

func TestNoWindNoSea(t *testing.T) {
	w := testWaves(t)
	for _, in := range []SeaInput{{}, {Speed: 0, Fetch: 5000}, {Speed: 800, Fetch: 0}} {
		win := newWindow(0, 0, 1)
		win.Amp[3] = 1 // stale
		win.Inputs[0] = SeaInput{Speed: 1, From: 1, Fetch: 1}
		SeaArea(w, win, 0, in)
		win.Seal()
		if win.Count != 0 || win.Hs[0] != 0 {
			t.Errorf("%+v: %d waves, Hs %g", in, win.Count, win.Hs[0])
		}
	}
}

func TestSeaInputOf(t *testing.T) {
	for _, c := range []struct {
		speed, from, fetch float64
		want               SeaInput
	}{
		{5.144, 0, 11112, SeaInput{514, 0, 11112}},
		{5.146, math.Pi, 11112.4, SeaInput{515, 32768, 11112}},
		{-3, -math.Pi / 2, -1, SeaInput{0, 49152, 0}},
		{1e9, 2 * math.Pi, 1e12, SeaInput{10000, 0, 1 << 24}},
		{math.NaN(), math.NaN(), math.NaN(), SeaInput{}},
		{7, -1e-9, 100, SeaInput{700, 0, 100}},
	} {
		if got := SeaInputOf(c.speed, c.from, c.fetch); got != c.want {
			t.Errorf("SeaInputOf(%g, %g, %g) = %+v, want %+v", c.speed, c.from, c.fetch, got, c.want)
		}
	}
}

// Areas with the same inputs share one computation, and an area set again
// to what it holds is left alone.
func TestAreasShare(t *testing.T) {
	w := testWaves(t)
	a, b := SeaInputOf(6*knot, 1, 11112), SeaInputOf(34*knot, 1, 11112)
	win := newWindow(0, 0, 3)
	for i := range int32(9) {
		in := a
		if i%3 == 2 {
			in = b
		}
		SeaArea(w, win, i, in)
	}
	win.Seal()
	alone := newWindow(0, 0, 1)
	for i := range int32(9) {
		in := a
		if i%3 == 2 {
			in = b
		}
		alone.Inputs[0] = SeaInput{}
		SeaArea(w, alone, 0, in)
		for c := range SeaComponents {
			if got, want := win.Amp[int(i)*SeaComponents+c], alone.Amp[c]; math.Float64bits(got) != math.Float64bits(want) {
				t.Fatalf("area %d, wave %d: amplitude %g, alone %g", i, c, got, want)
			}
		}
		if win.Hs[i] != alone.Hs[0] || win.Peak[i] != alone.Peak[0] {
			t.Errorf("area %d: Hs %g and peak %g, alone %g and %g", i, win.Hs[i], win.Peak[i], alone.Hs[0], alone.Peak[0])
		}
	}
	// The gale's waves are all active, though most areas have few.
	gale := openSea(t, 34, 1, 6).Window
	if win.Count < gale.Count {
		t.Errorf("the window has %d active waves, its gale areas %d", win.Count, gale.Count)
	}
}

// The time phase is the fraction of ω t / 2π, exact however large the tick.
func TestSeaAt(t *testing.T) {
	w := testWaves(t)
	var st SeaTick
	for _, tick := range []float64{0, 1, 7.4e8, 1<<31 + 1, 1 << 52, 1<<53 - 1, 7.4e8 + 0.25} {
		SeaAt(w, &st, tick)
		for i := range SeaComponents {
			// turns × tick, exactly, and its fraction.
			p := new(big.Float).SetPrec(300).SetFloat64(w.Turns[i])
			p.Mul(p, new(big.Float).SetPrec(300).SetFloat64(tick))
			whole, _ := p.Int(nil)
			frac, _ := new(big.Float).Sub(p, new(big.Float).SetInt(whole)).Float64()
			want := frac * 2 * math.Pi
			got := st.Phase[i]
			if d := math.Abs(math.Remainder(got-want, 2*math.Pi)); d > 1e-9 {
				t.Fatalf("tick %g, wave %d: phase %g, want %g (off by %g rad)", tick, i, got, want, d)
			}
		}
	}
}

// The sea's height at a point far from the centre and late in the world's
// life is the sum written out in high precision.
func TestSeaSampleAgainstReference(t *testing.T) {
	sea := openSea(t, 34, 0.7, 6)
	w := sea.Waves
	for _, tick := range []float64{7.4e8, 1<<31 + 1, 1 << 52} {
		sea.at(tick)
		for _, pt := range [][2]float64{{0, 0}, {8300, 0}, {-5869, 5869}, {12.5, -8299.75}} {
			got := SeaSample(&sea.Sea, nil, pt[0], pt[1])
			var h, worst float64
			for i, a := range sea.Window.Amp {
				if a == 0 {
					continue
				}
				// φ₀ + k d·x − 2π frac(turns × tick), each term exact.
				arg := new(big.Float).SetPrec(300).SetFloat64(w.Phase[i])
				for _, term := range [][2]float64{{w.kEast[i], pt[0]}, {w.kNorth[i], pt[1]}} {
					p := new(big.Float).SetPrec(300).SetFloat64(term[0])
					arg.Add(arg, p.Mul(p, new(big.Float).SetPrec(300).SetFloat64(term[1])))
				}
				p := new(big.Float).SetPrec(300).SetFloat64(w.Turns[i])
				p.Mul(p, new(big.Float).SetPrec(300).SetFloat64(tick))
				whole, _ := p.Int(nil)
				frac, _ := new(big.Float).Sub(p, new(big.Float).SetInt(whole)).Float64()
				psi, _ := arg.Float64()
				psi -= frac * 2 * math.Pi
				h += a * math.Sin(psi)
				worst += a
			}
			if d := math.Abs(got.Height - h); d > 1e-9*worst {
				t.Errorf("tick %g at (%g, %g): height %g, want %g", tick, pt[0], pt[1], got.Height, h)
			}
			if got.Hs != sea.Window.Hs[0] {
				t.Errorf("Hs %g, the area's %g", got.Hs, sea.Window.Hs[0])
			}
		}
	}
}

// borderSea is a window of 6 knots west of a line of centres and 34 knots
// east of it.
func borderSea(t testing.TB) *ocean {
	t.Helper()
	w := testWaves(t)
	const size = 5
	win := newWindow(seaMiddle-2, seaMiddle-2, size)
	for i := range int32(size * size) {
		knots := 6.0
		if i%size >= 3 {
			knots = 34
		}
		SeaArea(w, win, i, SeaInputOf(knots*knot, 0.4, 6*nauticalMile))
	}
	win.Seal()
	o := &ocean{Sea: Sea{Waves: w, Window: win}}
	o.Tick = &o.tick
	o.at(7.4e8)
	return o
}

// Across a border between a calm area and a gale the surface and its slope
// are continuous: sampled every centimetre, neither jumps by more than the
// steepest wave could change it in that centimetre.
func TestBlendIsSmooth(t *testing.T) {
	sea := borderSea(t)
	var steep, curve float64
	w := sea.Waves
	gale := openSea(t, 34, 0.4, 6).Window
	for i, a := range gale.Amp {
		steep += a * w.K[i]
		curve += a * w.K[i] * w.K[i]
	}
	const step = 0.01
	// Lines running east across two lines of centres, and north along one.
	for _, line := range []struct{ x, y, dx, dy float64 }{
		{-SeaAreaSize - 3, 17.3, step, 0},
		{-3, -211, step, 0},
		{SeaAreaSize - 3, 100, step, 0},
		{231.5, -3, 0, step},
		{0, SeaAreaSize - 3, 0, step},
		{SeaAreaSize / 2.0, -SeaAreaSize - 3, step / math.Sqrt2, step / math.Sqrt2},
	} {
		prev := SeaSample(&sea.Sea, nil, line.x, line.y)
		for i := 1; i <= 600; i++ {
			p := SeaSample(&sea.Sea, nil, line.x+float64(i)*line.dx, line.y+float64(i)*line.dy)
			// The blend adds its own small part: the weights turn over
			// SeaAreaSize, the heights are a metre or so.
			if d := math.Abs(p.Height - prev.Height); d > step*(steep+0.02) {
				t.Fatalf("line from (%g, %g), step %d: the height jumps %g m in a centimetre", line.x, line.y, i, d)
			}
			for _, d := range []float64{p.East - prev.East, p.North - prev.North} {
				if math.Abs(d) > step*(curve+0.001) {
					t.Fatalf("line from (%g, %g), step %d: the slope jumps %g in a centimetre", line.x, line.y, i, d)
				}
			}
			if d := math.Abs(p.Hs - prev.Hs); d > step*0.01 {
				t.Fatalf("line from (%g, %g), step %d: Hs jumps %g m in a centimetre", line.x, line.y, i, d)
			}
			prev = p
		}
	}
	// West of the border the sea is the calm's, east of it the gale's.
	west, east := SeaSample(&sea.Sea, nil, -400, 0), SeaSample(&sea.Sea, nil, SeaAreaSize+100, 0)
	if west.Hs > 0.1 || math.Abs(east.Hs-gale.Hs[0]) > 1e-12 {
		t.Errorf("Hs %g west of the border and %g east of it, the gale's is %g", west.Hs, east.Hs, gale.Hs[0])
	}
}

// A window whose areas all have the same inputs gives the surface a single
// area gives, bit for bit, wherever the point lies among them.
func TestUniformWindowIsOneArea(t *testing.T) {
	w := testWaves(t)
	in := SeaInputOf(20*knot, 2.1, 6*nauticalMile)
	win := newWindow(seaMiddle-2, seaMiddle-2, 5)
	for i := range int32(25) {
		SeaArea(w, win, i, in)
	}
	win.Seal()
	one := openSea(t, 20, 2.1, 6)
	many := &ocean{Sea: Sea{Waves: w, Window: win}}
	many.Tick = &many.tick
	b := jolly(t)
	hullL, hullB := 2*b.halfLength, 2*b.halfBeam
	for _, tick := range []float64{7.4e8, 1<<31 + 1} {
		one.at(tick)
		many.at(tick)
		for _, pt := range [][2]float64{{0, 0}, {231.5, 231.5}, {-600.25, 17}, {463, -463}, {5000, 5000}, {-0.001, 100}} {
			a, c := SeaSample(&one.Sea, nil, pt[0], pt[1]), SeaSample(&many.Sea, nil, pt[0], pt[1])
			if a != c {
				t.Errorf("at (%g, %g): one area gives %+v, the window %+v", pt[0], pt[1], a, c)
			}
			if a, c := WaveUnder(&one.Sea, nil, hullL, hullB, pt[0], pt[1], 0.9), WaveUnder(&many.Sea, nil, hullL, hullB, pt[0], pt[1], 0.9); a != c {
				t.Errorf("at (%g, %g): under a hull one area gives %+v, the window %+v", pt[0], pt[1], a, c)
			}
		}
	}
}

// A client's window is a few areas about the boat; the server's is the
// whole world. Where both hold the four areas about a point they agree.
func TestWindowsAgree(t *testing.T) {
	w := testWaves(t)
	input := func(col, row int32) SeaInput {
		return SeaInputOf(float64(4+(col*7+row*3)%30)*knot, float64(col-row)*0.1, 6*nauticalMile)
	}
	world := newWindow(0, 0, SeaAreas)
	for i := range int32(SeaAreas * SeaAreas) {
		SeaArea(w, world, i, input(i%SeaAreas, i/SeaAreas))
	}
	world.Seal()
	const col, row = 20, 9
	near := newWindow(col-2, row-2, 5)
	for i := range int32(25) {
		SeaArea(w, near, i, input(col-2+i%5, row-2+i/5))
	}
	near.Seal()
	var tick SeaTick
	SeaAt(w, &tick, 7.4e8)
	a, c := Sea{w, world, &tick}, Sea{w, near, &tick}
	x0, y0 := float64(col-seaMiddle)*SeaAreaSize, float64(row-seaMiddle)*SeaAreaSize
	for _, d := range [][2]float64{{0, 0}, {200, -200}, {-231.5, 231.4}, {600, 100}, {-650, -650}, {3, 694}} {
		p, q := SeaSample(&a, nil, x0+d[0], y0+d[1]), SeaSample(&c, nil, x0+d[0], y0+d[1])
		if p != q {
			t.Errorf("%g, %g from the window's middle: the world gives %+v, the window %+v", d[0], d[1], p, q)
		}
	}
}

// S and G against their definitions in high precision, across the switch
// from the series.
func TestAverages(t *testing.T) {
	ref := func(x float64) (s, g float64) {
		// Series in 400 bits: fine to x = 10³ with enough terms.
		const prec = 2500
		bx := new(big.Float).SetPrec(prec).SetFloat64(x)
		x2 := new(big.Float).SetPrec(prec).Mul(bx, bx)
		// sin x / x = Σ (−x²)ⁿ/(2n+1)!;  3(sin x − x cos x)/x³ = Σ 3·2n (−1)ⁿ⁺¹ x²ⁿ⁻² /(2n+1)!
		term := new(big.Float).SetPrec(prec).SetInt64(1)
		sumS := new(big.Float).SetPrec(prec)
		sumG := new(big.Float).SetPrec(prec)
		for n := int64(0); n < 3000; n++ {
			if n > 0 {
				term.Mul(term, x2)
				term.Quo(term, new(big.Float).SetPrec(prec).SetInt64(-(2*n)*(2*n+1)))
			}
			sumS.Add(sumS, term)
			if n > 0 {
				// The term of G in x²ⁿ⁻² is −6n × term/x².
				g := new(big.Float).SetPrec(prec).Quo(term, x2)
				g.Mul(g, new(big.Float).SetPrec(prec).SetInt64(-6*n))
				sumG.Add(sumG, g)
			}
			if n > 10 && term.MantExp(nil) < -prec && n > int64(x) {
				break
			}
		}
		s, _ = sumS.Float64()
		g, _ = sumG.Float64()
		return s, g
	}
	xs := []float64{1e-8, 1e-5, 1e-3, 0.03, 0.0999, 0.09999999, 0.1, 0.10000001, 0.1001, 0.3, 1, 2, math.Pi, 4.4934, 10, 37.5, 100, 999.5, 1e3}
	for _, x := range xs {
		for _, x := range []float64{x, -x} {
			s, g := averages(x)
			ws, wg := ref(x)
			// Past the first lobes both are small and their absolute error
			// is that of the sine: 10⁻¹⁵ of a wave's height.
			if math.Abs(s-ws) > 1e-13*math.Max(math.Abs(ws), 1e-2) || math.Abs(g-wg) > 1e-12*math.Max(math.Abs(wg), 1e-2) {
				t.Errorf("averages(%g) = %.17g, %.17g; want %.17g, %.17g", x, s, g, ws, wg)
			}
		}
	}
	if s, g := averages(0); s != 1 || g != 1 {
		t.Errorf("averages(0) = %g, %g", s, g)
	}
	// Across the switch neither steps.
	lo, hi := math.Nextafter(0.1, 0), 0.1
	s0, g0 := averages(lo)
	s1, g1 := averages(hi)
	if math.Abs(s1-s0) > 1e-15 || math.Abs(g1-g0) > 1e-13 {
		t.Errorf("across the series' end S steps by %g and G by %g", s1-s0, g1-g0)
	}
}

// A wave as long as the hull, along it, averages to nothing; a long wave
// passes unchanged; a wave across a narrow hull is hardly averaged at all.
func TestEffectiveWave(t *testing.T) {
	b := jolly(t)
	length := 2 * b.halfLength
	for _, c := range []struct {
		name           string
		length, toward float64
		height, slope  float64 // as fractions of the wave's own
		tolerance      float64
	}{
		{"as long as the hull, along it", length, 0, 0, 3 / (math.Pi * math.Pi), 1e-12},
		{"600 m, along", 600, 0, 1, 1, 1e-4},
		{"600 m, across", 600, math.Pi / 2, 1, 1, 1e-4},
		{"as long as the hull, across", length, math.Pi / 2, 0.86, 0.91, 0.01},
	} {
		const a = 0.5
		k := 2 * math.Pi / c.length
		// The greatest height and slope under the hull over a wave's passing.
		var height, slope float64
		for i := range 400 {
			sea := oneWave(c.length, a, c.toward)
			sea.Waves.Phase[0] = float64(i) * 2 * math.Pi / 400
			w := WaveUnder(&sea.Sea, nil, length, 2*b.halfBeam, 0, 0, 0)
			height = max(height, math.Abs(w.Height))
			slope = max(slope, math.Hypot(w.Ahead, w.Across))
		}
		if d := height/a - c.height; math.Abs(d) > c.tolerance {
			t.Errorf("%s: the hull feels %.4f of the wave's height, want %.4f", c.name, height/a, c.height)
		}
		if d := slope/(a*k) - c.slope; math.Abs(d) > c.tolerance {
			t.Errorf("%s: the hull feels %.4f of the wave's slope, want %.4f", c.name, slope/(a*k), c.slope)
		}
	}
	// The slopes are along and across the hull whichever way it points: a
	// wave from astern lifts the stern first.
	sea := oneWave(60, 0.5, 0)
	sea.Waves.Phase[0] = 0 // the surface rises northward at the centre
	north := WaveUnder(&sea.Sea, nil, length, 2*b.halfBeam, 0, 0, 0)
	east := WaveUnder(&sea.Sea, nil, length, 2*b.halfBeam, 0, 0, math.Pi/2)
	south := WaveUnder(&sea.Sea, nil, length, 2*b.halfBeam, 0, 0, math.Pi)
	if !(north.Ahead > 0.04 && math.Abs(north.Across) < 1e-12) {
		t.Errorf("heading north up the slope: ahead %g, across %g", north.Ahead, north.Across)
	}
	if !(east.Across < -0.04 && math.Abs(east.Ahead) < 1e-12) {
		t.Errorf("heading east along the slope, which rises to port: ahead %g, across %g", east.Ahead, east.Across)
	}
	if !(south.Ahead < -0.04) {
		t.Errorf("heading south down the slope: ahead %g", south.Ahead)
	}
}

// BenchmarkStepInSea times one step on a beam reach in the sea a breeze and
// a gale raise over open water, and the sea's time for a tick, which a
// server sets once for every boat and a client once a step.
func BenchmarkStepInSea(bm *testing.B) {
	b := jolly(bm)
	for _, knots := range []float64{12, 34} {
		sea := openSea(bm, knots, 0, 6)
		sea.at(7.4e8)
		bm.Run(fmt.Sprintf("%gknots-%dwaves", knots, sea.Window.Count), func(bm *testing.B) {
			s := State{Heading: math.Pi / 2, Surge: 3, SheetLimit: 0.6}
			c := Control{Sheet: 0.35}
			e := Env{WindSpeed: 7, WindFrom: 0}
			var o Out
			for bm.Loop() {
				Step(&s, &c, &e, &sea.Sea, nil, b, &o)
			}
		})
	}
	bm.Run("SeaAt", func(bm *testing.B) {
		sea := openSea(bm, 34, 0, 6)
		tick := 7.4e8
		for bm.Loop() {
			sea.at(tick)
			tick++
		}
	})
}

func BenchmarkSeaArea(bm *testing.B) {
	w := testWaves(bm)
	win := newWindow(0, 0, 1)
	i := uint32(0)
	for bm.Loop() {
		i++
		SeaArea(w, win, 0, SeaInput{Speed: 1000 + i%500, From: i % 65536, Fetch: 11112})
	}
}
