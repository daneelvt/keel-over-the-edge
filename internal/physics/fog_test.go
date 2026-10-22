// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"math/rand/v2"
	"slices"
	"testing"
)

// fogBank is a fog bank of the catalog's kind at (east, north) m, moving
// toward heading degrees, of a radius size m, at a strength, with a seed.
func fogBank(kinds map[string]int32, east, north, heading, size, strength float64, seed float64) System {
	s := systemAt(kinds["fog"], east, north, heading, size, 0, 0)
	s.Peak = 900
	s.Strength = math.Round(strength * strengthSteps)
	s.Seed = seed
	return s
}

// tickOf is the weather of a still spell with systems in the slots given,
// at a tick, and the weather.
func tickOf(p *WeatherPrepared, tick float64, systems map[int]System, spells ...Spell) (*WeatherTick, *Weather) {
	if len(spells) == 0 {
		spells = []Spell{still(0)}
	}
	w := weatherOf(p, spells...)
	for k := range int32(2) {
		w.SetKeyframe(k, tick+float64(k)*300)
		for slot, s := range systems {
			w.SetSystem(k, int32(slot), &s)
		}
	}
	w.SetKeyCount(2)
	t := new(WeatherTick)
	WeatherAt(w, t, tick)
	return t, w
}

// marched is the optical depth along the line by a midpoint sum of n
// steps of the extinction AirAt gives, the clear air's and the mist's
// left out, in pieces split where the line crosses a height in tops, so
// that no step straddles a cloud's base.
func marched(t *WeatherTick, x0, y0, h0, x1, y1, h1 float64, n int, tops ...float64) float64 {
	dx, dy, dh := x1-x0, y1-y0, h1-h0
	d2 := dx*dx + dy*dy
	l := math.Sqrt(d2 + dh*dh)
	g := d2 * t.p.vis.invTwoR
	cuts := []float64{0, 1}
	for _, top := range tops {
		// g u² + (dh − g) u + h0 − top = 0.
		a, b, c := g, dh-g, h0-top
		var roots []float64
		if math.Abs(a) < 1e-12 {
			if b != 0 {
				roots = append(roots, -c/b)
			}
		} else if disc := b*b - 4*a*c; disc >= 0 {
			roots = append(roots, (-b-math.Sqrt(disc))/(2*a), (-b+math.Sqrt(disc))/(2*a))
		}
		for _, r := range roots {
			if r > 0 && r < 1 {
				cuts = append(cuts, r)
			}
		}
	}
	slices.Sort(cuts)
	sum := 0.0
	for k := 1; k < len(cuts); k++ {
		u0, u1 := cuts[k-1], cuts[k]
		for i := range n {
			u := u0 + (float64(i)+0.5)/float64(n)*(u1-u0)
			a := AirAt(t, x0+u*dx, y0+u*dy, h0+u*dh-g*u*(1-u))
			sum += (a.Fog + a.Rain) * (u1 - u0) / float64(n)
		}
	}
	return sum * l
}

// The closed form is the integral: within 10⁻⁵ of a 20,000-step march
// along lines over the dome through fog banks and a squall's rain, its
// rain cut at its cloud's base. OpticalDepth leaves out what lies beyond
// a source's reach, a ten-millionth of its peak: within 10⁻⁴ of it.
func TestOpticalDepthClosedForm(t *testing.T) {
	p, kinds := testSystems(t)
	rng := rand.New(rand.NewPCG(33, 1))
	worst, worstAbs, worstCut, checked := 0.0, 0.0, 0.0, 0
	var sources [MaxAirSources]AirSource
	for k := range 400 {
		systems := map[int]System{}
		systems[0] = fogBank(kinds, 0, 0, rng.Float64()*360, 740+rng.Float64()*2040, 0.6+rng.Float64()*0.6, float64(rng.Uint32()))
		if k%2 == 0 {
			sq := systemAt(kinds["squall"], (rng.Float64()-0.5)*2000, (rng.Float64()-0.5)*2000, rng.Float64()*360, 0.45*nm, 16, 3)
			sq.Strength = math.Round((0.3 + 0.7*rng.Float64()) * strengthSteps)
			systems[1] = sq
		}
		tk, _ := tickOf(p, worldTick, systems)
		_, n := AirSources(tk, 0, 0, 1e9, sources[:])
		clear := tk.p.vis.clear
		for range 10 {
			x0, y0 := float64((rng.Float64()-0.5)*6000), float64((rng.Float64()-0.5)*6000)
			h0 := float64(2 + float64(rng.Float64()*30))
			d := float64(50 + float64(rng.Float64()*3000))
			a := rng.Float64() * 2 * math.Pi
			x1, y1 := x0+float64(d*math.Sin(a)), y0+float64(d*math.Cos(a))
			h1 := float64(rng.Float64() * 400)
			if k%5 == 0 {
				h1 = float64(rng.Float64() * 120)
			}
			// Only lines above the sea: the chord's lowest point.
			g := d * d / (2 * 2500)
			low := math.Min(h0, h1)
			if us := 0.5 - (h1-h0)/(2*g); us > 0 && us < 1 {
				low = math.Min(low, h0+us*(h1-h0)+g*(us*us-us))
			}
			if low < 0 || math.Hypot(x0, y0) > 7000 || math.Hypot(x1, y1) > 7000 {
				continue
			}
			dx, dy, dh := x1-x0, y1-y0, h1-h0
			d2 := float64(dx*dx) + float64(dy*dy)
			l := math.Sqrt(d2 + float64(dh*dh))
			closed := 0.0
			for i := range n {
				closed += sources[i].Depth(x0, y0, h0, dx, dy, dh, float64(d2*tk.p.vis.invTwoR), l)
			}
			want := marched(tk, x0, y0, h0, x1, y1, h1, 20000, 350)
			worstAbs = math.Max(worstAbs, math.Abs(closed-want))
			if want > 0.01 {
				worst = math.Max(worst, math.Abs(closed-want)/want)
				checked++
			}
			worstCut = math.Max(worstCut, math.Abs(OpticalDepth(tk, x0, y0, h0, x1, y1, h1)-float64(clear*l)-closed))
		}
	}
	t.Logf("%d lines: worst relative error %.2e, worst absolute %.2e; what the reach leaves out at most %.2e", checked, worst, worstAbs, worstCut)
	if checked < 1000 || worst > 1e-5 || worstAbs > 1e-5 || worstCut > 1e-4 {
		t.Errorf("%d lines checked; worst relative error %.2e, absolute %.2e, beyond the reach %.2e", checked, worst, worstAbs, worstCut)
	}
}

// A front's band of rain integrates the same way, cut at its low cloud.
func TestOpticalDepthFrontBand(t *testing.T) {
	p, _ := testSystems(t)
	old := spellOfRegime(t, p, "trade", 1, 225, 0, 8*hourOfTicks)
	front := frontSpell(t, p, worldTick)
	tk, _ := tickOf(p, worldTick+600, nil, old, front)
	if tk.nf == 0 {
		t.Fatal("no front in sight")
	}
	f := &tk.fronts[0]
	c := &tk.p.clouds
	// Across the band, through its middle, and along it.
	mid := f.line - c.rainAt
	mx, my := mid*f.fe, mid*f.fn
	worst := 0.0
	for _, line := range [][6]float64{
		{mx - 800*f.fe, my - 800*f.fn, 2, mx + 800*f.fe, my + 800*f.fn, 2},
		{mx - 300*f.fn, my + 300*f.fe, 2, mx + 1500*f.fn, my - 1500*f.fe, 40},
		{mx - 100*f.fe, my - 100*f.fn, 2, mx + 400*f.fe, my + 400*f.fn, 900},
	} {
		l := math.Sqrt((line[3]-line[0])*(line[3]-line[0]) + (line[4]-line[1])*(line[4]-line[1]) + (line[5]-line[2])*(line[5]-line[2]))
		got := OpticalDepth(tk, line[0], line[1], line[2], line[3], line[4], line[5]) - tk.p.vis.clear*l
		want := marched(tk, line[0], line[1], line[2], line[3], line[4], line[5], 20000, c.heights[LayerLow])
		if want < 0.01 {
			t.Fatalf("%v: %g through a front's band of rain: too little to check", line, want)
		}
		worst = math.Max(worst, math.Abs(got-want)/want)
	}
	if worst > 1e-5 {
		t.Errorf("worst relative error %.2e through a front's band: want 1e-5", worst)
	}
}

// A fog bank's density is its wind's patch: what it takes from the wind,
// over the share it takes at its core, is its fog over its core's.
func TestFogFollowsPatch(t *testing.T) {
	p, kinds := testSystems(t)
	bank := fogBank(kinds, 300, -200, 70, 1500, 0.8, 1234567)
	tk, _ := tickOf(p, worldTick, map[int]System{0: bank})
	st := &tk.sys[0]
	core := FogAt(tk, st.cx, st.cy, 0)
	if core <= 0 {
		t.Fatal("no fog at the bank's core")
	}
	rng := rand.New(rand.NewPCG(2, 3))
	for range 200 {
		x, y := st.cx+(rng.Float64()-0.5)*6000, st.cy+(rng.Float64()-0.5)*6000
		took := (1 - st.factor(x, y)) / st.patch
		fog := FogAt(tk, x, y, 0) / core
		if took > 1e-4 && math.Abs(fog-took) > 1e-7 {
			t.Errorf("at (%.0f, %.0f) the patch takes %.6f of its core's share, the fog is %.6f of its core's", x, y, took, fog)
		}
	}
	// It thins with height as e^(−h / 40 m).
	if r := FogAt(tk, st.cx, st.cy, 40) / core; math.Abs(r-math.Exp(-1)) > 1e-9 {
		t.Errorf("40 m up the fog is %.6f of the sea's, want e^(−1)", r)
	}
}

// The visibility at a bank's core at the sea is its seed's core
// visibility, drawn within the catalog's range; 2 m up, a little more.
func TestFogCore(t *testing.T) {
	p, kinds := testSystems(t)
	seen := map[int]bool{}
	for _, seed := range []float64{1, 99, 123456789, 3141592653, 4000000000} {
		bank := fogBank(kinds, 0, 0, 0, 1700, 1, seed)
		tk, _ := tickOf(p, worldTick, map[int]System{0: bank})
		st := &tk.sys[0]
		core := p.FogCoreOf(bank.Kind, seed)
		if core < 50 || core > 150 {
			t.Errorf("seed %.0f: a core of %.1f m, outside 50–150", seed, core)
		}
		seen[int(core/10)] = true
		if got := FogAt(tk, st.cx, st.cy, 0); got != p.Contrast()/core {
			t.Errorf("seed %.0f: the fog at the core is %g, want %g", seed, got, p.Contrast()/core)
		}
		v := VisibilityAt(tk, st.cx, st.cy)
		if v < core || v > core*1.06 {
			t.Errorf("seed %.0f: the visibility at the core is %.1f m, its core %.1f m", seed, v, core)
		}
		if p.VisibilityWord(v) != VisibilityVeryPoor {
			t.Errorf("seed %.0f: %.0f m is not very poor", seed, v)
		}
	}
	if len(seen) < 3 {
		t.Errorf("five seeds drew cores in %d tens of metres", len(seen))
	}
}

// With no fog, rain or mist near, the optical depth is the clear air's,
// and AirClear says so for every line within its reach.
func TestOpticalDepthClear(t *testing.T) {
	p, kinds := testSystems(t)
	tk, _ := tickOf(p, worldTick, map[int]System{
		0: fogBank(kinds, -7000, 2500, 0, 900, 1, 7),
		1: systemAt(kinds["squall"], 5000, -3000, 30, 0.4*nm, 16, 3),
	})
	clear := tk.p.vis.clear
	if !AirClear(tk, 0, 0, 1500) {
		t.Fatal("not clear about the centre")
	}
	if AirClear(tk, -6500, 2500, 100) || AirClear(tk, 5000, -3000, 100) || AirClear(tk, 0, 7900, 100) {
		t.Error("clear in fog, rain or the mist")
	}
	rng := rand.New(rand.NewPCG(4, 5))
	for range 2000 {
		a, r := rng.Float64()*2*math.Pi, 1500*math.Sqrt(rng.Float64())
		b, s := rng.Float64()*2*math.Pi, 1500*math.Sqrt(rng.Float64())
		x0, y0 := float64(r*math.Sin(a)), float64(r*math.Cos(a))
		x1, y1 := float64(s*math.Sin(b)), float64(s*math.Cos(b))
		h0, h1 := float64(2+float64(rng.Float64()*10)), float64(rng.Float64()*80)
		dx, dy, dh := x1-x0, y1-y0, h1-h0
		want := float64(clear * math.Sqrt(float64(dx*dx)+float64(dy*dy)+float64(dh*dh)))
		if got := OpticalDepth(tk, x0, y0, h0, x1, y1, h1); got != want {
			t.Fatalf("(%v, %v, %v) to (%v, %v, %v): %g, the clear air's %g", x0, y0, h0, x1, y1, h1, got, want)
		}
	}
	if v := VisibilityAt(tk, 0, 0); math.Abs(v-4.5*nm) > 1e-6 {
		t.Errorf("the visibility in clear air is %.3f m, want 4.5 NM", v)
	}
}

// Fog, rain and the mist add: the visibility is the contrast over the sum
// of their extinctions, and the words follow it.
func TestVisibilityWords(t *testing.T) {
	p, _ := testSystems(t)
	for _, c := range []struct {
		v    float64
		want int32
	}{
		{100, VisibilityVeryPoor}, {399, VisibilityVeryPoor}, {400, VisibilityPoor}, {1851, VisibilityPoor},
		{1852, VisibilityModerate}, {3703, VisibilityModerate}, {3704, VisibilityGood}, {math.Inf(1), VisibilityGood},
	} {
		if got := p.VisibilityWord(c.v); got != c.want {
			t.Errorf("%g m: word %d, want %d", c.v, got, c.want)
		}
	}
	// The mist at the lip: its visibility, 300 m, at the sea.
	tk, _ := tickOf(p, worldTick, nil)
	if v := tk.p.vis.contrast / AirAt(tk, 0, 8334, 0).Total(); math.Abs(v-300) > 1e-6 {
		t.Errorf("the visibility at the lip is %.3f m, want 300", v)
	}
}

// The mist joins the optical depth: along a line at the rim it adds what
// its density summed at sixteen points does, near a long march's.
func TestOpticalDepthMist(t *testing.T) {
	p, _ := testSystems(t)
	tk, _ := tickOf(p, worldTick, nil)
	v := &tk.p.vis
	for _, line := range [][6]float64{{0, 7600, 2, 0, 8100, 10}, {-300, 7900, 2, 300, 7950, 5}, {0, 7000, 2, 0, 7400, 1}} {
		dx, dy, dh := line[3]-line[0], line[4]-line[1], line[5]-line[2]
		d2 := dx*dx + dy*dy
		l := math.Sqrt(d2 + dh*dh)
		got := OpticalDepth(tk, line[0], line[1], line[2], line[3], line[4], line[5]) - v.clear*l
		sum := 0.0
		const n = 4000
		for i := range n {
			u := (float64(i) + 0.5) / n
			x, y := line[0]+u*dx, line[1]+u*dy
			sum += v.mistAt(math.Hypot(x, y), line[2]+u*dh-d2*v.invTwoR*u*(1-u))
		}
		want := sum * l / n
		if math.Abs(math.Exp(-got)-math.Exp(-want)) > 0.02 {
			t.Errorf("%v: the mist's depth %.4f, a march's %.4f", line, got, want)
		}
	}
}

// Nothing allocates.
func TestVisibilityAllocates(t *testing.T) {
	p, kinds := testSystems(t)
	tk, _ := tickOf(p, worldTick, map[int]System{
		0: fogBank(kinds, 0, 0, 30, 1500, 1, 11),
		1: systemAt(kinds["squall"], 1000, 500, 30, 0.4*nm, 16, 3),
		2: systemAt(kinds["storm"], -4000, -3000, 60, 2*nm, 22, 15),
	})
	var out [MaxAirSources]AirSource
	var flashes [MaxFlashes]Flash
	if n := testing.AllocsPerRun(100, func() {
		OpticalDepth(tk, -2000, 300, 2, 4000, -600, 40)
		OpticalDepth(tk, 0, 7700, 2, 0, 8200, 5)
		VisibilityAt(tk, 100, 100)
		AirSources(tk, 0, 0, 8000, out[:])
		Flashes(tk, 1234, flashes[:])
		AirClear(tk, 0, 0, 500)
	}); n != 0 {
		t.Errorf("%v allocations", n)
	}
}

// AirSources gives the fog banks and rain OpticalDepth sums, nearest
// first; their depths add up to OpticalDepth's, less the clear air's.
func TestAirSources(t *testing.T) {
	p, kinds := testSystems(t)
	old := spellOfRegime(t, p, "trade", 1, 225, 0, 8*hourOfTicks)
	front := frontSpell(t, p, worldTick)
	systems := map[int]System{}
	for i := range 6 {
		systems[i] = fogBank(kinds, -3000+float64(i)*1200, float64(i%2)*800, 30, 900, 1, float64(i+1))
	}
	systems[7] = systemAt(kinds["squall"], 1000, 500, 30, 0.4*nm, 16, 3)
	tk, _ := tickOf(p, worldTick+300, systems, old, front)
	var out [MaxAirSources]AirSource
	fog, n := AirSources(tk, 0, 0, 8000, out[:])
	if fog != MaxFogSources || n < fog+2 {
		t.Fatalf("%d fog banks and %d sources", fog, n)
	}
	for i := 1; i < fog; i++ {
		if out[i].distance(0, 0) < out[i-1].distance(0, 0) {
			t.Errorf("fog bank %d nearer than the one before", i)
		}
	}
	// With four banks only, the sources are all OpticalDepth sums.
	for i := 4; i < 6; i++ {
		delete(systems, i)
	}
	tk, _ = tickOf(p, worldTick+300, systems, old, front)
	_, n = AirSources(tk, 0, 0, 8000, out[:])
	rng := rand.New(rand.NewPCG(8, 9))
	for range 200 {
		x0, y0 := (rng.Float64()-0.5)*5000, (rng.Float64()-0.5)*5000
		x1, y1 := x0+(rng.Float64()-0.5)*3000, y0+(rng.Float64()-0.5)*3000
		h0, h1 := 2.0, rng.Float64()*200
		dx, dy, dh := x1-x0, y1-y0, h1-h0
		d2 := dx*dx + dy*dy
		l := math.Sqrt(d2 + dh*dh)
		sum := tk.p.vis.clear * l
		for i := range n {
			if out[i].near(x0, y0, dx, dy, d2) {
				sum += out[i].Depth(x0, y0, h0, dx, dy, dh, d2*tk.p.vis.invTwoR, l)
			}
		}
		if got := OpticalDepth(tk, x0, y0, h0, x1, y1, h1); math.Abs(got-sum) > 1e-12*math.Max(1, got) {
			t.Fatalf("the sources sum to %g, OpticalDepth gives %g", sum, got)
		}
	}
}

func benchmarkDepth(b *testing.B, systems map[int]System, spells ...Spell) {
	p, _ := testSystems(b)
	tk, _ := tickOf(p, worldTick+300, systems, spells...)
	b.ResetTimer()
	s := 0.0
	for i := range b.N {
		s += OpticalDepth(tk, -1500+float64(i%1000), 300, 2, 500, 200+float64(i%700), 40)
	}
	if !(s > 0) {
		b.Fatal(s)
	}
}

func BenchmarkOpticalDepthClear(b *testing.B) { benchmarkDepth(b, nil) }

func BenchmarkOpticalDepthOneBank(b *testing.B) {
	_, kinds := testSystems(b)
	benchmarkDepth(b, map[int]System{0: fogBank(kinds, 0, 0, 30, 1700, 1, 5)})
}

func BenchmarkOpticalDepthFourBanks(b *testing.B) {
	_, kinds := testSystems(b)
	systems := map[int]System{}
	for i := range 4 {
		systems[i] = fogBank(kinds, -1500+float64(i)*1000, float64(i%2)*600, 30, 1500, 1, float64(i+1))
	}
	benchmarkDepth(b, systems)
}

func BenchmarkOpticalDepthRain(b *testing.B) {
	_, kinds := testSystems(b)
	p, _ := testSystems(b)
	old := spellOfRegime(b, p, "trade", 1, 225, 0, 8*hourOfTicks)
	front := frontSpell(b, p, worldTick)
	benchmarkDepth(b, map[int]System{
		0: systemAt(kinds["squall"], 0, 0, 30, 0.45*nm, 16, 3),
		1: systemAt(kinds["shower"], -800, 500, 30, 0.25*nm, 6, 1),
	}, old, front)
}

func BenchmarkVisibilityAt(b *testing.B) {
	p, kinds := testSystems(b)
	tk, _ := tickOf(p, worldTick, map[int]System{
		0: fogBank(kinds, 0, 0, 30, 1700, 1, 5),
		1: systemAt(kinds["squall"], 1000, 500, 30, 0.4*nm, 16, 3),
	})
	b.ResetTimer()
	s := 0.0
	for i := range b.N {
		s += VisibilityAt(tk, float64(i%1000), 300)
	}
	if !(s > 0) {
		b.Fatal(s)
	}
}

func BenchmarkFlashes(b *testing.B) {
	p, kinds := testSystems(b)
	tk, _ := tickOf(p, worldTick, map[int]System{
		0: systemAt(kinds["squall"], 1000, 500, 30, 0.4*nm, 16, 3),
		1: systemAt(kinds["storm"], -4000, -3000, 60, 2*nm, 22, 15),
	})
	var out [MaxFlashes]Flash
	b.ResetTimer()
	n := 0
	for i := range b.N {
		n += Flashes(tk, float64(i), out[:])
	}
	_ = n
}
