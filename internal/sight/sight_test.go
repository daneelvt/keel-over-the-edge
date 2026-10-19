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

// clear is visibility with no mist anywhere near the test's ground.
var clear = physics.Visibility{Band: 7778, Lip: 8334, Clear: 8334, Range: 300}

func input(g *physics.Ground, subjects []Subject, cells []Cell, lights []Light) *Input {
	return &Input{Ground: g, Subjects: subjects, Cells: cells, Lights: lights, Eyes: []float64{2},
		Dome: 2500, Rays: 48, Grid: 500, Visibility: clear, Threshold: 2e-7}
}

// sees reports whether a lookout at (x, y), its eye 2 m up, sees subject s.
func sees(t *Table, x, y float64, s int32, lit []bool) bool {
	l := Lookout{X: x, Y: y, Eye: t.Eye(2), Reach: t.EyeReach(2)}
	for _, got := range t.Look(&l, make([]uint64, Words(len(t.subjects))), lit, nil) {
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

// TestIslandInTheMist: a 40 m island in the mist band is seen as far as the
// mist lets the eye see, not out to its horizon.
func TestIslandInTheMist(t *testing.T) {
	g := ground(func(x, y float64) float64 { return -10 })
	// The band over the test's ground: the lip 900 m off, its inner edge
	// 500 m, 300 m at the lip.
	in := input(g, []Subject{{Kind: Island, Island: -1, X: 820, Top: 40, Seen: ByLand}},
		[]Cell{{X: 820, Y: 0, Top: 40, Subject: 0}}, nil)
	in.Visibility = physics.Visibility{Band: 500, Lip: 900, Clear: 8334, Range: 300}
	tb := Build(in)
	horizon := 100 + math.Sqrt(2*2500*40) // 547 m in clear air
	vis := physics.VisualRangeAt(&in.Visibility, 820)
	if vis >= horizon-50 {
		t.Fatalf("the visibility %v is not under the horizon %v", vis, horizon)
	}
	if !sees(tb, 820-vis+5, 0, 0, nil) {
		t.Errorf("not seen at %v m, inside the visibility", vis-5)
	}
	if sees(tb, 820-vis-20, 0, 0, nil) {
		t.Errorf("seen at %v m, beyond the visibility %v", vis+20, vis)
	}
}

// TestLightSeenAtNight: a light is seen out to its nominal range while it
// is lit, not beyond, and not while it is dark.
func TestLightSeenAtNight(t *testing.T) {
	g := ground(func(x, y float64) float64 { return -10 })
	subjects := []Subject{{Kind: Place, Number: 4, Island: -1, Seen: ByLight}}
	tb := Build(input(g, subjects, nil, []Light{{X: 0, Y: 0, Range: 2.5 * 1852, Subject: 0}}))
	lit := []bool{true}
	if !sees(tb, 0, -4500, 0, lit) {
		t.Error("not seen within its range, lit")
	}
	if sees(tb, 0, -4700, 0, lit) {
		t.Error("seen beyond its range")
	}
	if sees(tb, 0, -1000, 0, []bool{false}) {
		t.Error("seen dark")
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
	l := Lookout{X: 280, Eye: 0, Reach: tb.EyeReach(2)}
	charted := make([]uint64, 1)
	lit := []bool{true}
	out := make([]Seen, 0, 8)
	if n := testing.AllocsPerRun(100, func() { out = tb.Look(&l, charted, lit, out[:0]) }); n != 0 {
		t.Errorf("%v allocations a look", n)
	}
	if len(out) != 2 {
		t.Errorf("saw %v", out)
	}
}
