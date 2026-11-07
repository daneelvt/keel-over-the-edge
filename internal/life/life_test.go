// SPDX-License-Identifier: AGPL-3.0-only

package life

import (
	"encoding/json"
	"flag"
	"math"
	"os"
	"slices"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

var update = flag.Bool("update", false, "rewrite the golden files")

// testDisk is the world's disk, m.
const testDisk = 8334

// island is the test world's one island: a disc of land, a shelf about it
// and the deep beyond.
var island = struct{ x, y, land, shelf float64 }{x: 2000, y: 1000, land: 500, shelf: 1500}

// testGround is the island's ground: land within land m of its centre,
// sloping from 2 m down at its shore to 60 m at shelf m, the deep's 400 m
// beyond. Only the chunks about it are made: the rest is deep water.
func testGround() *physics.Ground {
	g := &physics.Ground{}
	for n := range int32(physics.ChunkCount) {
		c0, j0 := physics.ChunkCorner(n)
		x0, y0 := physics.CellCentre(c0, j0)
		x1, y1 := physics.CellCentre(c0+physics.ChunkColumns-1, j0+physics.ChunkRows-1)
		nx := math.Max(x0, math.Min(island.x, x1))
		ny := math.Max(y0, math.Min(island.y, y1))
		if math.Hypot(nx-island.x, ny-island.y) > island.shelf+200 {
			continue
		}
		ch := &physics.GroundChunk{}
		for ci := range int32(physics.ChunkColumns) {
			for cj := range int32(physics.ChunkRows) {
				x, y := physics.CellCentre(c0+ci, j0+cj)
				d := math.Hypot(x-island.x, y-island.y)
				e := 10.0
				switch {
				case d > island.shelf+150:
					e = -400
				case d > island.land:
					e = -2 - 58*(d-island.land)/(island.shelf-island.land)
				}
				ch.Elevation[ci*physics.ChunkRows+cj] = int16(math.Round(e * 10))
			}
		}
		g.Chunks[n] = ch
	}
	return g
}

// testPlaces are a town on the island's shore, a reef off it, and a colony.
var testPlaces = Places{
	Towns:    [][2]float64{{island.x + 520, island.y}},
	Reefs:    []Reach{{X: island.x, Y: island.y - 900, Half: 100}},
	Colonies: [][2]float64{{island.x - 400, island.y + 300}},
	Islands:  [][2]float64{{island.x, island.y}},
}

func testCatalog(t testing.TB) *catalog.Catalog {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	return cat
}

// steady is weather the same everywhere.
type steady struct{ wind, rain float64 }

func (s steady) Weather(x, y float64) (float64, float64) { return s.wind, s.rain }

func testSchedule(t testing.TB, seed uint64) *Schedule {
	t.Helper()
	p, kinds := Prepare(testCatalog(t))
	h := NewHabitat(p, testGround(), testPlaces, testDisk)
	return NewSchedule(&Config{Params: p, Kinds: kinds, Habitat: h, Seed: seed})
}

// slots draws the slots from first for n slots in the weather c.
func slots(s *Schedule, first, n int64, c Conditions) []bus.LifeEncounter {
	var out []bus.LifeEncounter
	for sl := first; sl < first+n; sl++ {
		out = s.Slot(sl, c, out)
	}
	return out
}

// TestSlotIsPure: a slot gives the same encounters whether it is drawn
// alone, after others or again.
func TestSlotIsPure(t *testing.T) {
	s := testSchedule(t, 7)
	c := steady{wind: 6}
	alone := s.Slot(5000, c, nil)
	_ = slots(s, 4000, 200, c)
	again := s.Slot(5000, c, nil)
	if !slices.Equal(alone, again) {
		t.Fatalf("drawn alone %v, after others %v", alone, again)
	}
	other := testSchedule(t, 7)
	if got := other.Slot(5000, c, nil); !slices.Equal(alone, got) {
		t.Fatalf("another schedule of the same seed drew %v, not %v", got, alone)
	}
	if n := len(slots(s, 1000, 2000, c)); n == 0 {
		t.Fatal("two thousand slots drew nothing")
	}
}

// TestNothingOnLand: no encounter begins on land, and each begins where
// its kind lives.
func TestNothingOnLand(t *testing.T) {
	s := testSchedule(t, 3)
	enc := slots(s, 10000, 6000, steady{wind: 6})
	if len(enc) < 100 {
		t.Fatalf("only %d encounters in 6,000 slots", len(enc))
	}
	byKind := map[uint16]int{}
	for _, e := range enc {
		k := &s.kinds[e.Kind]
		at, _ := s.hab.At(e.East, e.North)
		if at == Land {
			t.Fatalf("%s began on land at (%.0f, %.0f)", k.Name, e.East, e.North)
		}
		// One that comes with another is where the other lives.
		if !(k.Habitat[at] > 0) && e.Over == 0 {
			t.Errorf("%s began in habitat %d, where it weighs nothing", k.Name, at)
		}
		byKind[e.Kind]++
	}
	brought := map[int]bool{}
	for i := range s.kinds {
		for _, b := range s.kinds[i].Brings {
			brought[b.Kind] = true
		}
	}
	for i := range s.kinds {
		// A kind of no rate comes only with another's groups.
		if byKind[uint16(i)] == 0 && (s.kinds[i].Rate > 0 || brought[i]) {
			t.Errorf("no %s in 6,000 slots", s.kinds[i].Name)
		}
	}
}

// TestHabitats: the test world's points are in the habitats they should
// be, and kinds that weigh nothing somewhere are never met there.
func TestHabitats(t *testing.T) {
	s := testSchedule(t, 1)
	h := s.hab
	for _, c := range []struct {
		x, y float64
		want int
	}{
		{island.x, island.y, Land},
		{island.x + 600, island.y, Harbour},
		{island.x, island.y - 950, Reef},
		{island.x - 800, island.y - 300, Shelf},
		{-3000, -3000, Deep},
		{0, -7000, Outer},
		{9000, 0, Land},
	} {
		if got, _ := h.At(c.x, c.y); got != c.want {
			t.Errorf("(%.0f, %.0f) is habitat %d, want %d", c.x, c.y, got, c.want)
		}
	}
	// No pelican in outer water, nor any gull in the deep.
	for i := range s.kinds {
		k := &s.kinds[i]
		if k.Habitat[Outer] > 0 && k.Habitat[Harbour] > 0 && k.Habitat[Deep] == 0 {
			t.Errorf("%s lives in harbours and in the outer water but not the deep", k.Name)
		}
	}
}

// TestHeavySeaStartsNoWaterLife: a kind seen less as the sea rises is
// never met at force 6 and over.
func TestHeavySeaStartsNoWaterLife(t *testing.T) {
	p, kinds := Prepare(testCatalog(t))
	k := kinds[0]
	k.BySea, k.Index, k.Name = true, len(kinds), "water"
	kinds = append(kinds, k)
	h := NewHabitat(p, testGround(), testPlaces, testDisk)
	s := NewSchedule(&Config{Params: p, Kinds: kinds, Habitat: h, Seed: 11})
	calm := slots(s, 20000, 3000, steady{wind: 3})
	gale := slots(s, 20000, 3000, steady{wind: 12})
	count := func(es []bus.LifeEncounter) int {
		n := 0
		for _, e := range es {
			if int(e.Kind) == k.Index {
				n++
			}
		}
		return n
	}
	if count(calm) == 0 {
		t.Fatal("none met in a light air either")
	}
	if n := count(gale); n != 0 {
		t.Errorf("%d met in a near gale", n)
	}
}

// TestLulls: no two encounters of a family begin in neighbouring cells
// within the family's lull of each other; those that come with another
// keep no lull of their own.
func TestLulls(t *testing.T) {
	s := testSchedule(t, 5)
	enc := slices.DeleteFunc(slots(s, 30000, 4000, steady{wind: 6}), func(e bus.LifeEncounter) bool { return e.Over != 0 })
	cellOf := func(e bus.LifeEncounter) (int64, int64) {
		c := int64(e.ID>>8) & 0xfff
		return c % int64(s.n), c / int64(s.n)
	}
	pairs := 0
	for i, a := range enc {
		ai, aj := cellOf(a)
		for _, b := range enc[i+1:] {
			if s.kinds[a.Kind].Family != s.kinds[b.Kind].Family {
				continue
			}
			bi, bj := cellOf(b)
			if max(abs(ai-bi), abs(aj-bj)) > 1 {
				continue
			}
			pairs++
			if abs(a.Start-b.Start) < s.p.Lulls[s.kinds[a.Kind].Family] {
				t.Fatalf("%s at %d and %s at %d in neighbouring cells", s.kinds[a.Kind].Name, a.Start, s.kinds[b.Kind].Name, b.Start)
			}
		}
	}
	if pairs == 0 {
		t.Fatal("no two encounters met in neighbouring cells to judge")
	}
}

func abs(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}

// TestNightStartsNoBirds: the sun down, no bird the catalog keeps by day
// begins.
func TestDuskSendsBoobiesHome(t *testing.T) {
	s := testSchedule(t, 2)
	k := -1
	for i := range s.kinds {
		if s.kinds[i].Homeward {
			k = i
		}
	}
	if k < 0 {
		t.Skip("no kind flies home at dusk")
	}
	for x := -6000.0; x <= 6000; x += 1500 {
		h, ok := s.hab.Home(x, -4000)
		if !ok {
			t.Fatal("no way home")
		}
		want := math.Atan2(testPlaces.Colonies[0][0]-x, testPlaces.Colonies[0][1]+4000)
		if math.Abs(wrap(h-want)) > 1e-9 {
			t.Errorf("home from (%.0f, -4000) is %.3f, want %.3f", x, h, want)
		}
	}
}

// golden is a seed's slots as the golden file holds them.
type golden struct {
	Seed  uint64              `json:"seed"`
	First int64               `json:"first"`
	Slots int64               `json:"slots"`
	Wind  float64             `json:"wind"`
	Life  []bus.LifeEncounter `json:"life"`
}

// TestGolden holds a seed's slots to testdata/slots.json, on every
// machine.
func TestGolden(t *testing.T) {
	g := golden{Seed: 42, First: 60000, Slots: 400, Wind: 6}
	// Under the sky, its days and nights from an epoch.
	cat := testCatalog(t)
	p, kinds := Prepare(cat)
	s := NewSchedule(&Config{Params: p, Kinds: kinds, Habitat: NewHabitat(p, testGround(), testPlaces, testDisk), Seed: g.Seed,
		Sky: cat.PrepareSky(), Epoch: 1_793_577_600_000_000})
	g.Life = slots(s, g.First, g.Slots, steady{wind: g.Wind})
	const path = "testdata/slots.json"
	if *update {
		b, err := json.MarshalIndent(g, "", " ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var want golden
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if len(want.Life) == 0 {
		t.Fatal("the golden file holds no encounters")
	}
	if !slices.Equal(g.Life, want.Life) {
		for i := range min(len(g.Life), len(want.Life)) {
			if g.Life[i] != want.Life[i] {
				t.Fatalf("encounter %d is %+v, the golden file's %+v", i, g.Life[i], want.Life[i])
			}
		}
		t.Fatalf("%d encounters, the golden file %d", len(g.Life), len(want.Life))
	}
}
