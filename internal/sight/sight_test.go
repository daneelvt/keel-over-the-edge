// SPDX-License-Identifier: AGPL-3.0-only

package sight

import (
	"math"
	"reflect"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// ground is ground whose elevation at each hexagon's centre is
// elevation(x, y), m, over the four chunks about the centre.
func ground(elevation func(x, y float64) float64) *physics.Ground {
	g := &physics.Ground{Prepared: new(physics.GroundPrepared)}
	for _, n := range []int32{7*physics.ChunkSide + 7, 7*physics.ChunkSide + 8, 8*physics.ChunkSide + 7, 8*physics.ChunkSide + 8} {
		ch := new(physics.GroundChunk)
		c0, j0 := physics.ChunkCorner(n)
		for i := range int32(physics.ChunkHexes) {
			x, y := physics.CellCentre(c0+i/physics.ChunkRows, j0+i%physics.ChunkRows)
			ch.Elevation[i] = int16(max(min(math.Round(elevation(x, y)*10), 800), physics.DeepWater))
		}
		g.Chunks[n] = ch
	}
	return g
}

// calm is the weather of nothing but the clear air, 4.5 nautical miles,
// and a mist band from band to lip m from the centre, 300 m at the lip,
// with fog banks: each at (x, y), of a core's visibility, m (0 for 100),
// and a radius, m (0 for 1,700), its long axis north and south.
func calm(band, lip float64, banks ...[4]float64) *physics.WeatherTick {
	p := new(physics.WeatherPrepared)
	p.PrepareVisibility(&physics.VisibilityParams{
		Contrast: 3.912, Clear: 4.5 * 1852, Dome: 2500, MistBand: band, MistLip: lip, MistRange: 300, MistHeight: 40, Slot: 10,
	})
	p.SetKind(0, &physics.SystemKind{Shape: physics.ShapeNone, Width: 0.5, Stretch: 2, FogCore: [2]float64{100, 100}, FogHeight: 40})
	w := &physics.Weather{Prepared: p}
	w.Set([]physics.Spell{{Gust: 1000, Pressure: 101300}})
	for k := range int32(2) {
		w.SetKeyframe(k, float64(k)*300)
		for i, b := range banks {
			s := physics.System{On: 1, Kind: 0, Seed: 1, East: math.Round(b[0] * 4), North: math.Round(b[1] * 4),
				Strength: 4096, Size: 1700, Peak: 900}
			if b[3] > 0 {
				s.Size = b[3]
			}
			if b[2] > 0 {
				p.SetKind(int32(i)+1, &physics.SystemKind{Shape: physics.ShapeNone, Width: 0.5, Stretch: 2, FogCore: [2]float64{b[2], b[2]}, FogHeight: 40})
				s.Kind = float64(i + 1)
			}
			w.SetSystem(k, int32(i), &s)
		}
	}
	w.SetKeyCount(2)
	t := new(physics.WeatherTick)
	physics.WeatherAt(w, t, 0)
	return t
}

// clear is the weather with no mist anywhere near the test's ground.
var clear = calm(7778, 8334)

func input(g *physics.Ground, subjects []Subject, cells []Cell, lights []Light) *Input {
	return &Input{Ground: g, Subjects: subjects, Cells: cells, Lights: lights, Eyes: []float64{2},
		Dome: 2500, Rays: 48, Grid: 500, Lip: 8334, Clear: 4.5 * 1852, Contrast: 3.912, Threshold: 2e-7}
}

// sees reports whether a lookout at (x, y), its eye 2 m up, sees subject s.
func sees(t *Table, x, y float64, s int32, lit []bool) bool {
	return seesIn(t, clear, x, y, s, lit, nil)
}

// seesIn reports whether a lookout at (x, y), its eye 2 m up, sees subject
// s in the weather w, the lights lit and seen against the thresholds
// given.
func seesIn(t *Table, w *physics.WeatherTick, x, y float64, s int32, lit []bool, thr []float64) bool {
	l := Lookout{X: x, Y: y, Eye: t.Eye(2), Reach: t.EyeReach(2), Height: 2}
	for _, got := range t.Look(&l, make([]uint64, Words(len(t.subjects))), &Conditions{Weather: w, Lit: lit, Threshold: thr}, nil) {
		if got.Subject == s {
			return true
		}
	}
	return false
}

// TestIslandSeenByItsWood: a low island with a wood 20 m high on its near
// side and a 10 m summit on its far side shows first by the wood, at the
// wood's horizon and not the summit's.
func TestIslandSeenByItsWood(t *testing.T) {
	g := ground(func(x, y float64) float64 { return -10 })
	subjects := []Subject{{Kind: Island, Number: 0, Island: -1, X: 0, Y: 0, Top: 10, Seen: ByLand}}
	cells := []Cell{{X: -50, Y: 0, Top: 20, Subject: 0}, {X: 50, Y: 0, Top: 10, Subject: 0}}
	tb := Build(input(g, subjects, cells, nil))
	wood := 100 + math.Sqrt(2*2500*20) // from the wood, m
	if !sees(tb, -50-wood+2, 0, 0, nil) {
		t.Errorf("not seen %v m from the wood", wood-2)
	}
	if sees(tb, -50-wood-2, 0, 0, nil) {
		t.Errorf("seen %v m from the wood", wood+2)
	}
	// The summit alone, the wood cut: seen only within the summit's horizon.
	tb = Build(input(g, subjects, cells[1:], nil))
	if sees(tb, -50-wood+2, 0, 0, nil) {
		t.Errorf("the summit seen from the wood's horizon")
	}
}

// coveGround is an island 40 m high, a ring of land 150 m to 260 m from
// the centre open to the east between bearings 60° and 120°: a cove whose
// water lies inside it.
func coveGround(x, y float64) float64 {
	r := math.Hypot(x, y)
	a := math.Atan2(x, y) * 180 / math.Pi
	if r >= 150 && r <= 260 && !(a > 60 && a < 120) {
		return 40
	}
	return -5
}

// TestCoveSeenFromItsMouth: a cove is seen into from off its mouth, and not
// from behind the land round it.
func TestCoveSeenFromItsMouth(t *testing.T) {
	g := ground(coveGround)
	subjects := []Subject{{Kind: Place, Number: 1, Island: -1, X: 0, Y: 0, Seen: ByWater, Reach: 300}}
	tb := Build(input(g, subjects, nil, nil))
	if !sees(tb, 280, 0, 0, nil) {
		t.Error("not seen from off its mouth")
	}
	if sees(tb, -280, 0, 0, nil) {
		t.Error("seen from behind the island")
	}
	if sees(tb, 400, 0, 0, nil) {
		t.Error("seen from beyond its reach")
	}
}

// TestLighthouseBehindItsHeadland: a tower whose own headland stands
// between it and the boat is seen only once the boat is round the
// headland.
func TestLighthouseBehindItsHeadland(t *testing.T) {
	// The tower on low ground at the centre; a headland 60 m high from
	// 40 m to 120 m west of it, 40 m wide.
	g := ground(func(x, y float64) float64 {
		switch {
		case math.Hypot(x, y) < 20:
			return 3
		case x < -40 && x > -120 && math.Abs(y) < 20:
			return 60
		}
		return -8
	})
	subjects := []Subject{{Kind: Place, Number: 2, Island: -1, X: 0, Y: 0, Top: 30, Seen: ByView}}
	tb := Build(input(g, subjects, nil, nil))
	if sees(tb, -300, 0, 0, nil) {
		t.Error("seen through its headland")
	}
	if !sees(tb, -300, 200, 0, nil) {
		t.Error("not seen round its headland")
	}
	if !sees(tb, 300, 0, 0, nil) {
		t.Error("not seen from the open side")
	}
}

// TestReefSeenWithinItsReach: a reef awash is seen at 140 m and not at
// 160 m.
func TestReefSeenWithinItsReach(t *testing.T) {
	g := ground(func(x, y float64) float64 { return -10 })
	subjects := []Subject{{Kind: Place, Number: 3, Island: -1, X: 100, Y: 100, Seen: Awash, Reach: 150}}
	tb := Build(input(g, subjects, nil, nil))
	if !sees(tb, 240, 100, 0, nil) {
		t.Error("not seen at 140 m")
	}
	if sees(tb, 260, 100, 0, nil) {
		t.Error("seen at 160 m")
	}
}

// TestIslandInTheMist: a 40 m island in the mist is seen as far as the
// mist along the line lets the eye see, not out to its horizon.
func TestIslandInTheMist(t *testing.T) {
	g := ground(func(x, y float64) float64 { return -10 })
	in := input(g, []Subject{{Kind: Island, Island: -1, X: 820, Top: 40, Seen: ByLand}},
		[]Cell{{X: 820, Y: 0, Top: 40, Subject: 0}}, nil)
	tb := Build(in)
	// The whole test's ground beyond the lip: 300 m at the sea.
	misty := calm(0, 100)
	horizon := 100 + math.Sqrt(2*2500*40) // 547 m in clear air
	// Where the optical depth along the line from the eye reaches 3.912.
	at := 0.0
	for d := 5.0; d < horizon; d += 5 {
		if physics.OpticalDepth(misty, 820-d, 0, 2, 820, 0, 40) > 3.912 {
			at = d
			break
		}
	}
	if at == 0 || at > horizon-50 {
		t.Fatalf("the mist hides it from %v m, not well inside the horizon %v", at, horizon)
	}
	if !seesIn(tb, misty, 820-at+10, 0, 0, nil, nil) {
		t.Errorf("not seen at %v m, inside the mist's reach", at-10)
	}
	if seesIn(tb, misty, 820-at-10, 0, 0, nil, nil) {
		t.Errorf("seen at %v m, beyond the mist's reach %v", at+10, at)
	}
}

// TestIslandInFog: an island inside a held fog bank is seen only from
// within the bank, close; with the bank gone, from its old range.
func TestIslandInFog(t *testing.T) {
	g := ground(func(x, y float64) float64 { return -10 })
	tb := Build(input(g, []Subject{{Kind: Island, Island: -1, X: 0, Y: 0, Top: 10, Seen: ByLand}},
		[]Cell{{X: 0, Y: 0, Top: 10, Subject: 0}}, nil))
	foggy := calm(7778, 8334, [4]float64{0, 0, 100, 0})
	horizon := 100 + math.Sqrt(2*2500*10) // 324 m
	if !sees(tb, horizon-5, 0, 0, nil) || sees(tb, horizon+5, 0, 0, nil) {
		t.Fatalf("in clear air not seen from %v m, its horizon", horizon)
	}
	if seesIn(tb, foggy, 200, 0, 0, nil, nil) || seesIn(tb, foggy, horizon-5, 0, 0, nil, nil) {
		t.Error("seen through 200 m of the bank's core")
	}
	if !seesIn(tb, foggy, 80, 0, 0, nil, nil) {
		t.Error("not seen from 80 m in the bank's 100 m core")
	}
}

// TestFogBankBetween: a bank between a boat and an island hides it, though
// the boat and the island lie in clear air; a tall island's summit near a
// bank's edge is seen over it.
func TestFogBankBetween(t *testing.T) {
	g := ground(func(x, y float64) float64 { return -10 })
	low := Build(input(g, []Subject{{Kind: Island, Island: -1, X: 300, Y: 0, Top: 30, Seen: ByLand}},
		[]Cell{{X: 300, Y: 0, Top: 30, Subject: 0}}, nil))
	// A thin bank, its long axis north and south through x = 0.
	between := calm(7778, 8334, [4]float64{0, 0, 60, 100})
	if !sees(low, -150, 0, 0, nil) {
		t.Fatal("not seen in clear air")
	}
	for _, x := range []float64{-150, 300} {
		if v := physics.VisibilityAt(between, x, 0); v < 1852 {
			t.Fatalf("(%v, 0) is in fog: %v m", x, v)
		}
	}
	if seesIn(low, between, -150, 0, 0, nil, nil) {
		t.Error("seen through the bank")
	}
	// An island 1,300 m off a broad bank's axis, near its edge: its shore
	// 30 m up and its summit 70 m, seen from 400 m beyond it.
	bank := calm(7778, 8334, [4]float64{0, 0, 80, 0})
	shore := []Cell{{X: 1250, Y: 0, Top: 30, Subject: 0}}
	island := []Subject{{Kind: Island, Island: -1, X: 1300, Y: 0, Top: 70, Seen: ByLand}}
	if seesIn(Build(input(g, island, shore, nil)), bank, 1700, 0, 0, nil, nil) {
		t.Error("its shore seen through the bank's edge")
	}
	tall := Build(input(g, island, append(shore, Cell{X: 1300, Y: 0, Top: 70, Subject: 0}), nil))
	if !seesIn(tall, bank, 1700, 0, 0, nil, nil) {
		t.Error("the summit not seen over the bank's edge")
	}
}

// TestLightSeenAtNight: a light is seen out to its nominal range in clear
// air while it is lit, not beyond, and not while it is dark.
func TestLightSeenAtNight(t *testing.T) {
	g := ground(func(x, y float64) float64 { return -10 })
	subjects := []Subject{{Kind: Place, Number: 4, Island: -1, Seen: ByLight}}
	// From the light at 4,100 m south of the centre, northward, clear of
	// the mist band.
	for _, r := range []float64{1.5, 2.5, 4.5} {
		tb := Build(input(g, subjects, nil, []Light{{X: 0, Y: -4100, Focal: 30, Range: r * 1852, Subject: 0}}))
		lit := []bool{true}
		if !sees(tb, 0, -4100+r*1852-10, 0, lit) {
			t.Errorf("a light of %v NM not seen within its range, lit", r)
		}
		if sees(tb, 0, -4100+r*1852+10, 0, lit) {
			t.Errorf("a light of %v NM seen beyond its range", r)
		}
		if sees(tb, 0, -3100, 0, []bool{false}) {
			t.Errorf("a light of %v NM seen dark", r)
		}
	}
}

// TestLightInFog: a light in a fog bank is seen by night from a few times
// the visibility, by day against the day's threshold barely beyond it.
func TestLightInFog(t *testing.T) {
	g := ground(func(x, y float64) float64 { return -10 })
	subjects := []Subject{{Kind: Place, Number: 4, Island: -1, Seen: ByLight}}
	tb := Build(input(g, subjects, nil, []Light{{X: 0, Y: 0, Focal: 30, Range: 4.5 * 1852, Subject: 0}}))
	foggy := calm(7778, 8334, [4]float64{0, 0, 100, 0})
	lit := []bool{true}
	day := []float64{physics.Log(1e-3)}
	reach := func(thr []float64) float64 {
		d := 0.0
		for seesIn(tb, foggy, 0, -d-5, 0, lit, thr) {
			d += 5
		}
		return d
	}
	night, byDay := reach(nil), reach(day)
	if night < 200 || night > 400 {
		t.Errorf("by night seen from %v m in 100 m fog", night)
	}
	if byDay < 60 || byDay > 150 || byDay > night/2 {
		t.Errorf("by day seen from %v m in 100 m fog, by night %v", byDay, night)
	}
	// By day in clear air, not out to its night's range.
	if seesIn(tb, clear, 0, -2000, 0, lit, day) || !seesIn(tb, clear, 0, -500, 0, lit, day) {
		t.Error("by day in clear air seen from 2 km, or not from 500 m")
	}
}

// TestHiddenChartedWithItsIsland: a spring seen from no water is charted
// with its island, and never looked for.
func TestHiddenChartedWithItsIsland(t *testing.T) {
	g := ground(func(x, y float64) float64 { return -10 })
	subjects := []Subject{
		{Kind: Island, Island: -1, Top: 10, Seen: ByLand},
		{Kind: Feature, Number: 7, Island: 0, Seen: Hidden},
	}
	tb := Build(input(g, subjects, []Cell{{Top: 10}}, nil))
	if got := tb.With(0); !reflect.DeepEqual(got, []int32{1}) {
		t.Errorf("charted with the island: %v", got)
	}
	if sees(tb, 50, 0, 1, nil) {
		t.Error("the hidden spring is looked for")
	}
}

// TestBuiltTwiceTheSame: the table is the same however its views are
// shared among cores.
func TestBuiltTwiceTheSame(t *testing.T) {
	g := ground(coveGround)
	var subjects []Subject
	for i := range 12 {
		a := float64(i) * math.Pi / 6
		subjects = append(subjects, Subject{Kind: Feature, Number: int32(i), Island: -1,
			X: 205 * math.Sin(a), Y: 205 * math.Cos(a), Top: 45, Seen: ByView, Reach: 300})
	}
	a, b := Build(input(g, subjects, nil, nil)), Build(input(g, subjects, nil, nil))
	if !reflect.DeepEqual(a, b) {
		t.Error("two builds differ")
	}
}

// TestLookAllocatesNothing: a look with room for what it sees allocates
// nothing.
func TestLookAllocatesNothing(t *testing.T) {
	g := ground(coveGround)
	subjects := []Subject{{Kind: Place, Island: -1, Seen: ByWater, Reach: 300}, {Kind: Island, Island: -1, Seen: ByLand, Top: 40}}
	tb := Build(input(g, subjects, []Cell{{X: 200, Top: 40, Subject: 1}}, []Light{{Range: 1000, Subject: 0}}))
	l := Lookout{X: 280, Eye: 0, Reach: tb.EyeReach(2), Height: 2}
	charted := make([]uint64, 1)
	c := &Conditions{Weather: clear, Lit: []bool{true}}
	out := make([]Seen, 0, 8)
	if n := testing.AllocsPerRun(100, func() { out = tb.Look(&l, charted, c, out[:0]) }); n != 0 {
		t.Errorf("%v allocations a look", n)
	}
	foggy := &Conditions{Weather: calm(7778, 8334, [4]float64{100, 0, 100, 0}), Lit: []bool{true}}
	if n := testing.AllocsPerRun(100, func() { out = tb.Look(&l, charted, foggy, out[:0]) }); n != 0 {
		t.Errorf("%v allocations a look in fog", n)
	}
	out = tb.Look(&l, charted, c, out[:0])
	if len(out) != 2 {
		t.Errorf("saw %v", out)
	}
}
