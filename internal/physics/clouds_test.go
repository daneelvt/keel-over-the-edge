// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"math/rand/v2"
	"testing"
)

// cloudOf is the heaped cloud of the system in slot 0 of w at a tick.
func cloudOf(t *testing.T, w *Weather, tick float64) Cloud {
	t.Helper()
	var at WeatherTick
	WeatherAt(w, &at, tick)
	var out [MaxClouds]Cloud
	n := HeapedClouds(&at, out[:])
	if n != 1 {
		t.Fatalf("%d heaped clouds, want 1", n)
	}
	return out[0]
}

// A squall's cloud is whole when its wind is half grown, and its top
// follows its cloud strength from its base up.
func TestCloudGrowsAheadOfItsWind(t *testing.T) {
	p, kinds := testSystems(t)
	s := systemAt(kinds["squall"], 2*nm, 0, 90, 0.45*nm, 15, 3)
	for _, c := range []struct{ strength, cloud float64 }{{0.1, 0.2}, {0.25, 0.5}, {0.5, 1}, {0.8, 1}, {1, 1}} {
		s.Strength = c.strength * strengthSteps
		got := cloudOf(t, withSystem(p, worldTick, s, still(0)), worldTick)
		if math.Abs(got.Cloud-c.cloud) > 1e-12 {
			t.Errorf("at strength %.2f its cloud strength is %.4f, want %.4f", c.strength, got.Cloud, c.cloud)
		}
		if want := 350 + (2500-350)*c.cloud; math.Abs(got.Top-want) > 1e-9 {
			t.Errorf("at strength %.2f its top is %.1f m, want %.1f", c.strength, got.Top, want)
		}
		if want := 0.45 * nm * c.cloud; math.Abs(got.Ahead-want) > 1e-6 {
			t.Errorf("at strength %.2f its anvil reaches %.1f m ahead, want %.1f", c.strength, got.Ahead, want)
		}
		if math.Abs(got.Rain-75*c.strength) > 1e-9 {
			t.Errorf("at strength %.2f its core rains %.2f mm an hour, want %.2f: rain follows the wind", c.strength, got.Rain, 75*c.strength)
		}
	}
	// Fog and light air have none.
	for _, id := range []string{"fog", "light-air"} {
		var at WeatherTick
		WeatherAt(withSystem(p, worldTick, systemAt(kinds[id], 0, 0, 90, 0.5*nm, 0, 0), still(0)), &at, worldTick)
		var out [MaxClouds]Cloud
		if n := HeapedClouds(&at, out[:]); n != 0 {
			t.Errorf("%s has %d heaped clouds", id, n)
		}
	}
}

// sheetsAhead is the sheets of a front's at a point d m ahead of its line,
// along the way it moves.
func sheetsAhead(t *testing.T, w *Weather, tick, d float64) [Layers]float64 {
	t.Helper()
	var at WeatherTick
	WeatherAt(w, &at, tick)
	if at.nf == 0 {
		t.Fatal("no front's sheets")
	}
	f := at.fronts[0]
	return at.sheetPoint(float64(f.fe*(f.line+d)), float64(f.fn*(f.line+d)))
}

// A front's layers begin and fill where the catalog says: cirrus from 3
// nautical miles ahead, whole at 0.6; the middle sheet from 1.5, whole at
// 0.2; low cloud in a band 0.15 behind the line; clearing behind.
func TestFrontSheets(t *testing.T) {
	p, _ := testSystems(t)
	old := spellOfRegime(t, p, "trade", 1, 225, 0, 8*hourOfTicks)
	w := weatherOf(p, old, frontSpell(t, p, worldTick))
	for _, c := range []struct {
		d    float64 // nautical miles ahead
		want [Layers]float64
	}{
		{3.2, [Layers]float64{0, 0, 0}},
		{0.6, [Layers]float64{1, -1, -1}},
		{1.5, [Layers]float64{-1, 0, -1}},
		{0.2, [Layers]float64{1, 1, -1}},
		{-0.15, [Layers]float64{1, 1, 1}},
		{-1.7, [Layers]float64{0, 0, -1}},
	} {
		got := sheetsAhead(t, w, worldTick, c.d*nm)
		for l, want := range c.want {
			if want >= 0 && math.Abs(got[l]-want) > 1e-3 {
				t.Errorf("%.2f NM ahead, layer %d's cover is %.4f, want %.0f", c.d, l, got[l], want)
			}
		}
	}
	// Between, the cirrus thickens toward the line.
	if a, b := sheetsAhead(t, w, worldTick, 2*nm)[0], sheetsAhead(t, w, worldTick, 1*nm)[0]; !(0 < a && a < b && b < 1) {
		t.Errorf("the cirrus 2 and 1 NM ahead is %.3f and %.3f: it should thicken toward the line", a, b)
	}
}

// Before its spell is in play, the coming front's line is the one its
// spell will give: the sheets are the same either way, so they do not step
// as the spell is announced.
func TestComingFront(t *testing.T) {
	p, _ := testSystems(t)
	old := spellOfRegime(t, p, "trade", 1, 225, 0, 8*hourOfTicks)
	front := frontSpell(t, p, worldTick)
	coming := weatherOf(p, old)
	coming.SetComing(&ComingFront{On: 1, Begin: front.Begin, Change: front.Change, Toward: front.Toward})
	announced := weatherOf(p, old, front)
	both := weatherOf(p, old, front)
	both.SetComing(&ComingFront{On: 1, Begin: front.Begin, Change: front.Change, Toward: front.Toward})
	rng := rand.New(rand.NewPCG(4, 5))
	seen := 0
	for _, tick := range []float64{front.Begin - 40*minuteTicks, front.Begin - 300, front.Begin - 1, front.Begin} {
		var a, b, c WeatherTick
		WeatherAt(coming, &a, tick)
		WeatherAt(announced, &b, tick)
		WeatherAt(both, &c, tick)
		if c.nf != 1 {
			t.Errorf("a front coming and announced at once gives %d lines, want 1", c.nf)
		}
		for range 200 {
			x, y := (2*rng.Float64()-1)*15000, (2*rng.Float64()-1)*15000
			sa, sb := a.sheetPoint(x, y), b.sheetPoint(x, y)
			if sa != sb {
				t.Fatalf("at tick %.0f the coming front's sheets at (%.0f, %.0f) are %v, its spell's %v", tick, x, y, sa, sb)
			}
			if sa[LayerCirrus] > 0 {
				seen++
			}
			if ra, rb := RainAt(&a, x, y), RainAt(&b, x, y); ra != rb {
				t.Fatalf("at tick %.0f the coming front's rain at (%.0f, %.0f) is %v, its spell's %v", tick, x, y, ra, rb)
			}
		}
	}
	if seen == 0 {
		t.Error("no cirrus anywhere")
	}
	// A quarter of an hour before it begins, the cirrus is overhead beyond
	// the lip, where it can be seen from the disk.
	var a WeatherTick
	WeatherAt(coming, &a, front.Begin-15*minuteTicks)
	f := a.fronts[0]
	edge := -p.edge - 5000
	if s := a.sheetPoint(f.fe*edge, f.fn*edge); !(s[LayerCirrus] > 0.2) {
		t.Errorf("15 minutes before the front begins, the cirrus 5 km beyond the lip covers %.3f", s[LayerCirrus])
	}
}

// Between the lattice's points the sheets are bilinear, and at a point
// they are the point's own.
func TestSheetAtIsBilinear(t *testing.T) {
	p, kinds := testSystems(t)
	storm := systemAt(kinds["storm"], -2000, 1500, 70, 2*nm, 22, 15)
	w := withSystem(p, worldTick, storm, spellOfRegime(t, p, "trade", 1, 225, 0, 8*hourOfTicks), frontSpell(t, p, worldTick))
	var at WeatherTick
	WeatherAt(w, &at, worldTick)
	L := p.SheetLattice()
	rng := rand.New(rand.NewPCG(7, 8))
	varied := 0
	for range 500 {
		i, j := math.Floor((2*rng.Float64()-1)*40), math.Floor((2*rng.Float64()-1)*40)
		u, v := rng.Float64(), rng.Float64()
		a, b := at.sheetPoint(i*L, j*L), at.sheetPoint((i+1)*L, j*L)
		c, d := at.sheetPoint(i*L, (j+1)*L), at.sheetPoint((i+1)*L, (j+1)*L)
		got := SheetAt(&at, (i+u)*L, (j+v)*L)
		for l, g := range []float64{got.Cirrus, got.Middle, got.Low} {
			want := (1-v)*((1-u)*a[l]+u*b[l]) + v*((1-u)*c[l]+u*d[l])
			if math.Abs(g-want) > 1e-12 {
				t.Fatalf("layer %d at (%.2f, %.2f) of a cell: %.15f, the bilinear of its corners %.15f", l, u, v, g, want)
			}
			if a[l] != d[l] {
				varied++
			}
		}
		if corner := SheetAt(&at, i*L, j*L); corner.Cirrus != a[0] || corner.Middle != a[1] || corner.Low != a[2] {
			t.Fatalf("at a lattice point the sheets are %v, the point's own %v", corner, a)
		}
	}
	if varied < 100 {
		t.Errorf("only %d of the cells checked vary", varied)
	}
	// SheetGrid gives the points' own.
	var grid [Layers * SheetSide * SheetSide]float64
	SheetGrid(&at, -20, -12, SheetSide, grid[:])
	for _, k := range [][2]int32{{0, 0}, {5, 7}, {47, 47}, {30, 2}} {
		want := at.sheetPoint(float64(-20+k[0])*L, float64(-12+k[1])*L)
		o := Layers * (k[1]*SheetSide + k[0])
		if grid[o] != want[0] || grid[o+1] != want[1] || grid[o+2] != want[2] {
			t.Errorf("SheetGrid's point %v is %v, want %v", k, grid[o:o+3], want)
		}
	}
}

// A storm's sheets about it follow its cloud strength.
func TestStormSheets(t *testing.T) {
	p, kinds := testSystems(t)
	s := systemAt(kinds["storm"], 0, 0, 90, 2*nm, 22, 15)
	for _, strength := range []float64{0.25, 0.5, 1} {
		s.Strength = strength * strengthSteps
		var at WeatherTick
		WeatherAt(withSystem(p, worldTick, s, still(0)), &at, worldTick)
		cs := math.Min(2*strength, 1)
		if got := at.sheetPoint(0.3*nm, 0); math.Abs(got[LayerLow]-cs) > 1e-12 || math.Abs(got[LayerCirrus]-cs) > 1e-12 {
			t.Errorf("at strength %.2f the overcast over its centre is %v, want %.2f", strength, got, cs)
		}
		if got := at.sheetPoint(4.1*nm, 0); got != [Layers]float64{} {
			t.Errorf("at strength %.2f beyond twice its size the sheets are %v", strength, got)
		}
		if got := at.sheetPoint(3*nm, 0); !(got[LayerCirrus] > 0 && got[LayerLow] == 0) {
			t.Errorf("at strength %.2f at 1.5 of its size the sheets are %v: cirrus, no low cloud", strength, got)
		}
	}
}

// A cell's cumulus at a tick is a closed form of the tick: the same
// whatever was asked before.
func TestCumulusIsAClosedForm(t *testing.T) {
	p, _ := testSystems(t)
	w := weatherOf(p, spellOfRegime(t, p, "trade", 1, 225, worldTick-2*hourOfTicks, 8*hourOfTicks))
	w.Spells[0].Regime = 1
	w.SetSpell(0, &w.Spells[0])
	caps := []Cap{{East: 1500, North: -800, Width: 900}}
	at := func(tick float64) []Cumulus {
		var t WeatherTick
		WeatherAt(w, &t, tick)
		out := make([]Cumulus, MaxCumulus)
		return out[:CumulusAt(&t, 300, -200, 3500, 0.6, caps, out)]
	}
	want := at(worldTick)
	if len(want) < 3 {
		t.Fatalf("only %d cumulus in a trade spell within 3.5 km", len(want))
	}
	for _, tick := range []float64{worldTick + 9000, worldTick - 77, worldTick + 1} {
		at(tick)
	}
	got := at(worldTick)
	if len(got) != len(want) {
		t.Fatalf("%d cumulus, then %d", len(want), len(got))
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("cumulus %d is %+v, then %+v", i, want[i], got[i])
		}
	}
	// They drift with the wind, as one body: a cloud's place a second on
	// is its place and its velocity, but for the frame's slow turn with
	// the spell's drift.
	later := at(worldTick + StepsPerSecond)
	moved := 0
	for _, a := range want {
		for _, b := range later {
			if b.Seed == a.Seed && math.Abs(b.East-(a.East+a.VelEast))+math.Abs(b.North-(a.North+a.VelNorth)) < 0.1 {
				moved++
			}
		}
	}
	if moved < len(want)/2 {
		t.Errorf("only %d of %d cumulus drift with their velocity", moved, len(want))
	}
	// By night the cap has gone.
	var night WeatherTick
	WeatherAt(w, &night, worldTick)
	out := make([]Cumulus, MaxCumulus)
	if day, dark := CumulusAt(&night, 300, -200, 3500, 0.6, caps, out), CumulusAt(&night, 300, -200, 3500, -0.1, caps, out); dark >= day {
		t.Errorf("%d cumulus by day and %d by night: the cap should go", day, dark)
	}
}

// The share of the lattice's cells that hold a cloud is the regime's
// cover.
func TestCumulusCover(t *testing.T) {
	p, _ := testSystems(t)
	for regime, cover := range map[string]float64{"settled": 0.25, "trade": 0.35, "unsettled": 0.45} {
		index := map[string]float64{"settled": 0, "trade": 1, "unsettled": 2}[regime]
		s := spellOfRegime(t, p, regime, 1, 225, worldTick-2*hourOfTicks, 8*hourOfTicks)
		s.Regime = index
		w := weatherOf(p, s)
		shown, cells := 0.0, 0.0
		out := make([]Cumulus, MaxCumulus)
		for k := range 40 {
			var at WeatherTick
			WeatherAt(w, &at, worldTick+float64(k)*7*minuteTicks)
			for _, c := range out[:CumulusAt(&at, 0, 0, 6000, 0, nil, out)] {
				// A cloud in mid-life shows in full.
				shown += c.Grow
			}
			cells += math.Pi * 6000 * 6000 / (1300 * 1300)
		}
		// Each slot's cloud lives a quarter growing, a half whole and a
		// quarter shrinking: on average 0.75 of itself.
		if got := shown / cells / 0.75; math.Abs(got-cover) > 0.06 {
			t.Errorf("%s: the cumulus cover %.3f of the sky's cells, want %.2f", regime, got, cover)
		}
	}
}

// Rain's peaks are the catalog's: a squall's core, a shower's, a front's
// band behind its line; and a storm's bands turn.
func TestRainPeaks(t *testing.T) {
	p, kinds := testSystems(t)
	for id, want := range map[string]float64{"squall": 75, "shower": 6} {
		s := systemAt(kinds[id], 1000, 2000, 90, 0.4*nm, 10, 2)
		var at WeatherTick
		WeatherAt(withSystem(p, worldTick, s, still(0)), &at, worldTick)
		if got := RainAt(&at, 1000, 2000); math.Abs(got-want) > 1e-9 {
			t.Errorf("a %s's core rains %.3f mm an hour, want %.0f", id, got, want)
		}
		if got := RainAt(&at, 1000+3*0.4*nm, 2000); got > 0.01*want {
			t.Errorf("a %s rains %.3f mm an hour three of its sizes off", id, got)
		}
	}
	old := spellOfRegime(t, p, "trade", 1, 225, 0, 8*hourOfTicks)
	w := weatherOf(p, old, frontSpell(t, p, worldTick))
	var at WeatherTick
	WeatherAt(w, &at, worldTick)
	f := at.fronts[0]
	most, where := 0.0, 0.0
	for d := -1.0; d <= 1; d += 0.005 {
		x, y := f.fe*(f.line+d*nm), f.fn*(f.line+d*nm)
		if r := RainAt(&at, x, y); r > most {
			most, where = r, d
		}
	}
	if math.Abs(most-10) > 0.01 || math.Abs(where+0.18) > 0.006 {
		t.Errorf("the front's rain peaks at %.3f mm an hour %.3f NM ahead, want 10 at −0.18", most, where)
	}

	// A storm's bands turn with the tick: once in an hour, so in five
	// minutes the pattern has turned a twelfth of a turn over its two arms.
	s := systemAt(kinds["storm"], 0, 0, 90, 2*nm, 22, 15)
	ws := withSystem(p, worldTick, s, still(0))
	var a, b WeatherTick
	WeatherAt(ws, &a, worldTick)
	WeatherAt(ws, &b, worldTick+5*minuteTicks)
	turn := 2 * math.Pi / 12 / 2
	differs, same := 0, 0
	for k := range 60 {
		r := (0.3 + 0.015*float64(k)) * nm
		th := float64(k) * 0.37
		x, y := r*math.Cos(th), r*math.Sin(th)
		x2, y2 := r*math.Cos(th+turn), r*math.Sin(th+turn)
		ra, rb := RainAt(&a, x, y), RainAt(&b, x, y)
		if math.Abs(ra-rb) > 0.5 {
			differs++
		}
		if math.Abs(ra-RainAt(&b, x2, y2)) < 1e-6 {
			same++
		}
	}
	if differs < 20 || same < 55 {
		t.Errorf("five minutes on, the rain changed at %d of 60 points, and the turned pattern matched at %d", differs, same)
	}
}

// Rain's visibility on the stage, in clear air of 4.5 nautical miles.
func TestRainVisibility(t *testing.T) {
	p, _ := testSystems(t)
	clear := 4.5 * nm
	for _, c := range []struct {
		rate, want float64 // mm an hour, m
		word       int32
	}{
		{0, clear, RainNone},
		{6, 1.07 * nm, RainModerate},
		{10, 0.79 * nm, RainHeavy},
		{20, 0.51 * nm, RainHeavy},
		{75, 383, RainViolent},
		{1, 0, RainLight},
	} {
		got := p.RainVisibility(c.rate, clear)
		if c.want > 0 && math.Abs(got-c.want)/c.want > 0.01 {
			t.Errorf("in %.0f mm an hour the visibility is %.0f m, want %.0f", c.rate, got, c.want)
		}
		if w := p.RainWord(c.rate); w != c.word {
			t.Errorf("%.0f mm an hour is word %d, want %d", c.rate, w, c.word)
		}
	}
}

// Nothing the clouds and the rain compute allocates.
func TestCloudsAllocateNothing(t *testing.T) {
	p, kinds := testSystems(t)
	storm := systemAt(kinds["storm"], -2000, 1500, 70, 2*nm, 22, 15)
	trade := spellOfRegime(t, p, "trade", 1, 225, 0, 8*hourOfTicks)
	trade.Regime = 1
	w := withSystem(p, worldTick, storm, trade, frontSpell(t, p, worldTick))
	var at WeatherTick
	WeatherAt(w, &at, worldTick)
	var clouds [MaxClouds]Cloud
	var cumulus [MaxCumulus]Cumulus
	var grid [Layers * SheetSide * SheetSide]float64
	caps := []Cap{{East: 100, North: 100, Width: 800}}
	if n := testing.AllocsPerRun(20, func() {
		HeapedClouds(&at, clouds[:])
		SheetAt(&at, 120, -340)
		SheetGrid(&at, -24, -24, SheetSide, grid[:])
		RainAt(&at, 120, -340)
		CumulusAt(&at, 0, 0, 3500, 0.5, caps, cumulus[:])
		p.RainVisibility(12, 8000)
	}); n != 0 {
		t.Errorf("%.0f allocations", n)
	}
}
