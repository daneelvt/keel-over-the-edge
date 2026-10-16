// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math"
	"os"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The generator's tests. A whole world takes seconds, and ten times that
// under the race detector, so the tests of a whole world run only at full
// length; their short forms make Port Royal's island and one other alone,
// and raster the chunks about the centre.

var update = flag.Bool("update", false, "write testdata/digests.json again")

func testCatalog(t testing.TB) *catalog.Catalog {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	return cat
}

func testConfig(t testing.TB) *config {
	t.Helper()
	cat := testCatalog(t)
	c, err := newConfig(cat)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

var (
	worldOnce sync.Once
	world1    *Bundle
)

// wholeWorld is seed 1's world, as made by its first attempt, made once
// for every test that needs a whole one; skipped in the short run.
func wholeWorld(t *testing.T) (*config, *Bundle) {
	t.Helper()
	if testing.Short() {
		t.Skip("makes a whole world")
	}
	c := testConfig(t)
	worldOnce.Do(func() { world1 = c.generate(1) })
	return c, world1
}

func TestMainPortHoldsTheCentre(t *testing.T) {
	c := testConfig(t)
	for seed := range uint64(200) {
		spots, _ := layout(c, seed)
		p := spots[0]
		if p.kind != kindMain || hypot(p.x, p.y) > c.port.offset || 2*p.radius < c.port.across[0] || 2*p.radius > c.port.across[1] {
			t.Fatalf("seed %d: the main port's island is %+v", seed, p)
		}
	}
}

func TestLayout(t *testing.T) {
	c := testConfig(t)
	for seed := range uint64(50) {
		spots, groups := layout(c, seed)
		var landmarks []spot
		for _, s := range spots {
			d := hypot(s.x, s.y)
			if s.kind != kindMain && d-float64(reachOf*s.radius)-stackReach < c.calm {
				t.Errorf("seed %d: an island %.0f m from the centre, in the calm water", seed, d)
			}
			if d+float64(reachOf*s.radius) > c.disk {
				t.Errorf("seed %d: an island reaches past the edge", seed)
			}
			if s.kind == kindLandmark {
				landmarks = append(landmarks, s)
				if 2*s.radius < c.layout.landmarkAcross[0] || 2*s.radius > c.layout.landmarkAcross[1] {
					t.Errorf("seed %d: a landmark %.0f m across", seed, 2*s.radius)
				}
			}
		}
		if len(landmarks) != c.layout.landmarks {
			t.Errorf("seed %d: %d landmarks, not %d", seed, len(landmarks), c.layout.landmarks)
		}
		for i, a := range landmarks {
			for _, b := range landmarks[i+1:] {
				if hypot(a.x-b.x, a.y-b.y) < c.layout.landmarkApart {
					t.Errorf("seed %d: landmarks %.0f m apart", seed, hypot(a.x-b.x, a.y-b.y))
				}
			}
		}
		for i, a := range spots {
			for _, b := range spots[i+1:] {
				gap := c.layout.gap
				if a.group >= 0 && a.group == b.group {
					gap = 8
				}
				if hypot(a.x-b.x, a.y-b.y) < float64(reachOf*(a.radius+b.radius))+gap-1e-9 {
					t.Errorf("seed %d: two islands' reaches %.0f m apart", seed, hypot(a.x-b.x, a.y-b.y)-float64(reachOf*(a.radius+b.radius)))
				}
			}
		}
		if len(groups) < c.layout.groups[0]-2 || len(groups) > c.layout.groups[1] {
			t.Errorf("seed %d: %d groups", seed, len(groups))
		}
	}
}

// korcak fits Korčák's exponent to areas from a0 to a1 by maximum
// likelihood: for the truncated law, the density of an area a is
// b a^−(b+1) / (a0^−b − a1^−b).
func korcak(areas []float64, a0, a1 float64) float64 {
	var sumLog float64
	for _, a := range areas {
		sumLog += math.Log(a)
	}
	n := float64(len(areas))
	ll := func(b float64) float64 {
		return n*math.Log(b) - (b+1)*sumLog - n*math.Log(math.Pow(a0, -b)-math.Pow(a1, -b))
	}
	lo, hi := 0.05, 3.0
	for range 200 {
		m1, m2 := lo+(hi-lo)/3, hi-(hi-lo)/3
		if ll(m1) < ll(m2) {
			lo = m1
		} else {
			hi = m2
		}
	}
	return (lo + hi) / 2
}

func TestKorcak(t *testing.T) {
	c := testConfig(t)
	a0 := math.Pi / 4 * c.layout.islandAcross[0] * c.layout.islandAcross[0]
	a1 := math.Pi / 4 * c.layout.islandAcross[1] * c.layout.islandAcross[1]
	var areas []float64
	for seed := range uint64(100) {
		spots, _ := layout(c, seed)
		for _, s := range spots {
			if s.kind == kindIsland && !s.filler {
				areas = append(areas, math.Pi*s.radius*s.radius)
			}
		}
	}
	b := korcak(areas, a0*0.999, a1*1.001)
	if math.Abs(b-c.layout.korcak) > 0.1 {
		t.Errorf("the islands' areas fit Korčák's law with b = %.3f, not %.2f", b, c.layout.korcak)
	}
	t.Logf("%d islands over 100 seeds fit b = %.3f", len(areas), b)
}

// alone makes one island of a biome alone, as a landmark of the radius
// given, at a place in the middle waters, from seed 9's stream for it.
func alone(t *testing.T, c *config, biome int, radius float64) (*made, *work) {
	t.Helper()
	w := new(work)
	sp := spot{kind: kindLandmark, x: 3000, y: -2500, radius: radius, biome: int32(biome), group: -1}
	return c.makeIsland(9, 77, sp, w), w
}

// coastHexes are an island's land hexagons beside water, by their index.
func coastHexes(m *made) []int32 {
	g := &m.grid
	var out []int32
	var nb [6]int32
	for i := range g.w * g.h {
		if g.elev[i] <= 0 {
			continue
		}
		k := g.neighbours(i, &nb)
		for _, j := range nb[:k] {
			if g.elev[j] <= 0 {
				out = append(out, i)
				break
			}
		}
	}
	return out
}

func TestEachBiomeAlone(t *testing.T) {
	c := testConfig(t)
	for bi, id := range c.biomeIDs {
		b := &c.biomes[bi]
		t.Run(id, func(t *testing.T) {
			m, w := alone(t, c, bi, 220)
			g := &m.grid
			if m.highest < c.land[0] || m.highest > b.height[1]+0.05 || m.highest > c.land[1] {
				t.Errorf("its highest point is %.1f m, outside %v", m.highest, b.height)
			}
			coast := coastHexes(m)
			if len(coast) == 0 {
				t.Fatal("no coast")
			}
			// Cliffs: the land rises over 5 m within two hexagons of the
			// coast.
			var nb, nb2 [6]int32
			cliffs, beaches := 0, 0
			for _, i := range coast {
				high := false
				k := g.neighbours(i, &nb)
				for _, j := range append([]int32{i}, nb[:k]...) {
					if g.elev[j] > 50 {
						high = true
					}
					k2 := g.neighbours(j, &nb2)
					for _, j2 := range nb2[:k2] {
						if g.elev[j2] > 50 {
							high = true
						}
					}
				}
				if high {
					cliffs++
				}
				if g.surf[i] == b.surfaces.beach && g.elev[i] < 25 {
					beaches++
				}
			}
			cliffShare := float64(cliffs) / float64(len(coast))
			beachShare := float64(beaches) / float64(len(coast))
			if b.cliffs[0] >= 0.5 && cliffShare < b.cliffs[0]-0.1 {
				t.Errorf("cliffs on %.2f of its coast, wants %v", cliffShare, b.cliffs)
			}
			if b.beach >= 20 && beachShare < 0.7 {
				t.Errorf("beaches on %.2f of its coast", beachShare)
			}
			if b.reef {
				checkReef(t, c, m)
			}
			// Off the cliffs, the ground stands at its angle of repose.
			var slopes []float64
			for i := range g.w * g.h {
				if !w.land[i] || w.cliff[i] || w.din[i] < 2*physics.HexAcross {
					continue
				}
				k := g.neighbours(i, &nb)
				for _, j := range nb[:k] {
					if w.land[j] && !w.cliff[j] {
						slopes = append(slopes, math.Abs(w.height[i]-w.height[j]))
					}
				}
			}
			sort.Float64s(slopes)
			if p := slopes[len(slopes)*95/100]; p > 1.2*c.talus {
				t.Errorf("the 95th percentile of its slopes is %.2f m a hexagon, steeper than the talus's %.2f", p, c.talus)
			}
			t.Logf("highest %.1f m, cliffs %.2f, beaches %.2f of the coast, reef %v", m.highest, cliffShare, beachShare, m.reef)
		})
	}
}

// checkReef checks a reefed island's sea bed: a crest within half a metre
// of the surface, a flat behind it, and deep water outside.
func checkReef(t *testing.T, c *config, m *made) {
	t.Helper()
	g := &m.grid
	var crest, flat, deep int
	for i := range g.w * g.h {
		e := float64(g.elev[i]) / 10
		if e > 0 {
			continue
		}
		x, y := g.centre(i)
		d := hypot(x-m.x, y-m.y) - m.radius
		switch {
		case e >= -0.5:
			crest++
		case e <= -1 && e >= -3.5 && d < m.lagoon:
			flat++
		case e <= -float64(c.reef.Fore)*0.8:
			deep++
		}
	}
	if crest == 0 || flat == 0 || deep == 0 {
		t.Errorf("the reef has %d hexagons of crest, %d of flat and %d of deep water outside", crest, flat, deep)
	}
}

func TestIslandsAreTheirOwn(t *testing.T) {
	c := testConfig(t)
	spots, _ := layout(c, 3)
	// Island 5 made after others, on the same room, and alone.
	shared := new(work)
	for i := range 5 {
		c.makeIsland(3, int32(i), spots[i], shared)
	}
	after := c.makeIsland(3, 5, spots[5], shared)
	first := c.makeIsland(3, 5, spots[5], new(work))
	if !slices.Equal(after.grid.elev, first.grid.elev) || !slices.Equal(after.grid.surf, first.grid.surf) {
		t.Error("an island differs made after others from made alone")
	}
	// Another stream for island 4 leaves island 5 as it was.
	c.makeIsland(4, 4, spots[4], shared)
	again := c.makeIsland(3, 5, spots[5], shared)
	if !slices.Equal(again.grid.elev, first.grid.elev) {
		t.Error("an island changed when another's stream did")
	}
}

func TestChunkRoundTrip(t *testing.T) {
	c := testConfig(t)
	spots, _ := layout(c, 1)
	port := c.makeIsland(1, 0, spots[0], new(work))
	n := int32(8*physics.ChunkSide + 8)
	g := c.raster(n, []*made{port})
	sh := newShelterChunk()
	sh.Values[10], sh.Values[11] = 150, 7
	world := [16]byte{1, 2, 3}
	payload, err := EncodeChunk(n, world, g, sh)
	if err != nil {
		t.Fatal(err)
	}
	g2, sh2, err := DecodeChunk(payload, n, world)
	if err != nil {
		t.Fatal(err)
	}
	if *g2 != *g || *sh2 != *sh {
		t.Error("a chunk decodes to something else")
	}
	for _, bad := range []struct {
		name  string
		n     int32
		world [16]byte
	}{{"another chunk", n + 1, world}, {"another world", n, [16]byte{9}}} {
		if _, _, err := DecodeChunk(payload, bad.n, bad.world); !errors.Is(err, ErrChunk) {
			t.Errorf("%s: %v", bad.name, err)
		}
	}
	empty, err := EncodeChunk(0, world, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if g0, s0, err := DecodeChunk(empty, 0, world); err != nil || g0 != nil || s0 != nil || len(empty) > 64 {
		t.Errorf("an empty chunk is %d bytes and reads %v %v %v", len(empty), g0, s0, err)
	}
	t.Logf("Port Royal's chunk: %d bytes gzip, an empty one %d", len(payload), len(empty))
}

func TestChunksOutsideTheDisk(t *testing.T) {
	c := testConfig(t)
	var outside []int32
	for n := range int32(physics.ChunkCount) {
		if chunkOutside(n, c.disk) {
			outside = append(outside, n)
		}
	}
	if len(outside) != 32 {
		t.Errorf("%d chunks lie wholly outside the disk, not 32: %v", len(outside), outside)
	}
	// None holds a hexagon of the disk.
	for _, n := range outside {
		c0, j0 := physics.ChunkCorner(n)
		for i := range int32(physics.ChunkHexes) {
			x, y := physics.CellCentre(c0+i/physics.ChunkRows, j0+i%physics.ChunkRows)
			if hypot(x, y) < c.disk {
				t.Fatalf("chunk %d holds (%.0f, %.0f), inside the disk", n, x, y)
			}
		}
	}
}

// wall is ground with land east of x, from y0 to y1, and deep water
// elsewhere.
func wall(x, y0, y1 float64) *physics.Ground {
	g := new(physics.Ground)
	for n := range int32(physics.ChunkCount) {
		ch := new(physics.GroundChunk)
		c0, j0 := physics.ChunkCorner(n)
		for i := range int32(physics.ChunkHexes) {
			cx, cy := physics.CellCentre(c0+i/physics.ChunkRows, j0+i%physics.ChunkRows)
			ch.Elevation[i] = physics.DeepWater
			if cx > x && cy > y0 && cy < y1 {
				ch.Elevation[i] = 50
			}
		}
		g.Chunks[n] = ch
	}
	return g
}

func TestFetch(t *testing.T) {
	c := testConfig(t)
	open := new(physics.Ground)
	fetch := c.fetchOf(open, newCoarse(open))
	for i, f := range fetch {
		for k, v := range f {
			if v != c.fetch.cap {
				t.Fatalf("area %d, direction %d: open water's fetch is %v, not the cap %v", i, k, v, c.fetch.cap)
			}
		}
	}
	// An area 1 km downwind of a wall of land: one radial gives 1 km, to
	// within a step; nine give their mean, each 1 km over the cosine of its
	// angle off the wind.
	ax, ay := physics.SeaAreaCentre(20, 18)
	g := wall(ax+1000, ay-3000, ay+3000)
	k := newCoarse(g)
	east := 4 // from the east
	for _, radials := range []int{1, 9} {
		c.fetch.radials = radials
		f := c.fetchOf(g, k)[18*physics.SeaAreas+20][east]
		want := 0.0
		for i := range radials {
			a := float64(i-(radials-1)/2) * c.fetch.spread
			want += 1000 / math.Cos(a)
		}
		want /= float64(radials)
		if math.Abs(f-want) > c.fetch.step+physics.HexAcross {
			t.Errorf("%d radials: the fetch is %v m, wants %.1f", radials, f, want)
		}
	}
}

func TestStartArea(t *testing.T) {
	c := testConfig(t)
	spots, _ := layout(c, 1)
	port := c.makeIsland(1, 0, spots[0], new(work))
	g := new(physics.Ground)
	for _, n := range []int32{7*physics.ChunkSide + 7, 7*physics.ChunkSide + 8, 8*physics.ChunkSide + 7, 8*physics.ChunkSide + 8} {
		g.Chunks[n] = c.raster(n, []*made{port})
	}
	st := c.startOf(g, port)
	if len(st.Places) != c.start.Places {
		t.Fatalf("%d places, not %d", len(st.Places), c.start.Places)
	}
	for _, p := range st.Places {
		if e, _ := g.At(p[0], p[1]); e > -c.start.Depth {
			t.Fatalf("a place in %.1f m of water", -e)
		}
		if c.landNear(g, p[0], p[1], c.start.Clear) {
			t.Fatalf("a place within %v m of land", c.start.Clear)
		}
	}
	if st.Heading < -math.Pi || st.Heading >= math.Pi {
		t.Errorf("the heading %v is not in [−π, π)", st.Heading)
	}
}

// madeFrom is islands as the namer sees them, from a seed's layout
// without making them: each with the area of its spot and features drawn.
func madeFrom(c *config, seed uint64) []*made {
	spots, _ := layout(c, seed)
	s := newStream(seed, 99)
	out := make([]*made, len(spots))
	for i, sp := range spots {
		m := &made{spot: sp, number: int32(i), area: math.Pi * sp.radius * sp.radius}
		b := &c.biomes[sp.biome]
		m.highest = s.in(b.height[0], b.height[1])
		m.cliffs = s.in(b.cliffs[0], b.cliffs[1])
		m.reef = b.reef
		m.lagoon = s.in(20, 90)
		m.stacks = int32(s.pick(b.stacks[0], b.stacks[1]))
		m.twin = s.chance(0.2)
		out[i] = m
	}
	return out
}

func TestNames(t *testing.T) {
	c := testConfig(t)
	seeds := 1000
	if testing.Short() {
		seeds = 100
	}
	byName := map[string]*wholeName{}
	for i := range c.lists.wholes {
		byName[c.lists.wholes[i].name] = &c.lists.wholes[i]
	}
	tone := map[string]*catalog.NameTone{}
	for i := range c.names.Tones {
		tone[c.names.Tones[i].Word] = &c.names.Tones[i]
	}
	darkCentre, darkRim, centre, rim := 0, 0, 0, 0
	pairsBoth, pairsOne := 0, 0
	for seed := range uint64(seeds) {
		islands := madeFrom(c, seed)
		got := c.nameIslands(seed, islands)
		seen := map[string]bool{}
		grim := 0
		for i, n := range got {
			if n == "" {
				t.Fatalf("seed %d: island %d has no name", seed, i)
			}
			if seen[n] {
				t.Fatalf("seed %d: %q twice", seed, n)
			}
			seen[n] = true
			if i == 0 {
				if n != c.port.name {
					t.Fatalf("seed %d: the main port is %q", seed, n)
				}
				continue
			}
			if n == c.port.name {
				t.Fatalf("seed %d: island %d is named %s", seed, i, n)
			}
			m := islands[i]
			d := hypot(m.x, m.y)
			w, whole := byName[n]
			if !whole {
				continue
			}
			size := c.sizeOf(m.area)
			if !slices.Contains(w.sizes, size) || !tagged(w.biomes, c.biomeIDs[m.biome]) {
				t.Fatalf("seed %d: %q for a %s %s island", seed, n, size, c.biomeIDs[m.biome])
			}
			shows := c.shows(m)
			for _, need := range w.needs {
				if !slices.Contains(shows, need) {
					t.Fatalf("seed %d: %q needs %s, which the island does not show", seed, n, need)
				}
			}
			if tone[w.tone].Phantom && len(w.zones) == 1 && w.zones[0] == "rim" && d < c.mist {
				t.Fatalf("seed %d: the phantom %q %.0f m out, short of the mist band", seed, n, d)
			}
			if tone[w.tone].Most > 0 {
				grim++
			}
			dark := tone[w.tone].Phantom || w.tone == "warning"
			switch c.zoneOf(d) {
			case zoneCentre:
				centre++
				if dark {
					darkCentre++
				}
			case zoneRim:
				rim++
				if dark {
					darkRim++
				}
			}
		}
		if grim > 1 {
			t.Fatalf("seed %d: %d grim names", seed, grim)
		}
		for _, p := range namePartners {
			if !drawable(c, byName[p[0]]) || !drawable(c, byName[p[1]]) {
				continue // a name needing a feature no terrain shows yet
			}
			switch {
			case seen[p[0]] && seen[p[1]]:
				pairsBoth++
			case seen[p[0]] || seen[p[1]]:
				pairsOne++
			}
		}
	}
	fc, fr := float64(darkCentre)/float64(centre), float64(darkRim)/float64(rim)
	if !(fr > 2*fc) {
		t.Errorf("eerie and warning names are %.3f of the centre's and %.3f of the rim's", fc, fr)
	}
	if pairsBoth == 0 || pairsOne > pairsBoth {
		t.Errorf("of the paired names, both were given %d times and one alone %d", pairsBoth, pairsOne)
	}
	t.Logf("eerie and warning: %.3f at the centre, %.3f at the rim; pairs both %d, one %d", fc, fr, pairsBoth, pairsOne)
}

// drawable reports whether every feature a name needs is one the terrain
// shows.
func drawable(c *config, w *wholeName) bool {
	for _, need := range w.needs {
		f := c.feature(func(f *nameFeature) bool { return f.word == need })
		if f == nil || f.cliffs == 0 && f.peak == 0 && f.twin == 0 && f.stacks == 0 && !f.reef && f.lagoon == 0 {
			return false
		}
	}
	return true
}

// TestNameLists holds the names to the catalog's words: every tag one the
// world has, no name twice, none the main port's, a form with one place to
// fill, a class a specific takes that some generic has, partners that are
// names.
func TestNameLists(t *testing.T) {
	c := testConfig(t)
	var sizes, features, tones []string
	for _, s := range c.sizes {
		sizes = append(sizes, s.class)
	}
	for _, f := range c.names.Features {
		features = append(features, f.Word)
	}
	for _, tn := range c.names.Tones {
		tones = append(tones, tn.Word)
	}
	check := func(where, field string, got, allowed []string, any bool) {
		if len(got) == 0 && field != "needs" {
			t.Errorf("%s: no %s", where, field)
		}
		for _, tag := range got {
			if !slices.Contains(allowed, tag) && !(any && tag == anyTag && len(got) == 1) {
				t.Errorf("%s: %s %q is not one of %s", where, field, tag, strings.Join(allowed, ", "))
			}
		}
	}
	tone := func(where, tn string) {
		if !slices.Contains(tones, tn) {
			t.Errorf("%s: tone %q is not one of %s", where, tn, strings.Join(tones, ", "))
		}
	}
	seen := map[string]bool{strings.ToLower(c.port.name): true}
	once := func(where, name string) {
		if seen[strings.ToLower(name)] {
			t.Errorf("%s: %q is given twice, or is the main port's", where, name)
		}
		seen[strings.ToLower(name)] = true
	}
	for _, w := range c.lists.wholes {
		where := "whole name " + w.name
		once(where, w.name)
		check(where, "sizes", w.sizes, sizes, false)
		check(where, "biomes", w.biomes, c.biomeIDs, true)
		check(where, "needs", w.needs, features, false)
		check(where, "zones", w.zones, zoneNames[:], true)
		tone(where, w.tone)
	}
	for _, g := range c.lists.groups {
		where := "group name " + g.name
		once(where, g.name)
		check(where, "biomes", g.biomes, c.biomeIDs, true)
		check(where, "zones", g.zones, zoneNames[:], true)
		tone(where, g.tone)
	}
	var classes []string
	for _, g := range c.lists.generics {
		where := "generic " + g.word
		check(where, "sizes", g.sizes, sizes, false)
		check(where, "biomes", g.biomes, c.biomeIDs, true)
		if strings.Count(g.form, specificSlot)+strings.Count(g.form, islandSlot) != 1 {
			t.Errorf("%s: form %q must hold %s or %s once", where, g.form, specificSlot, islandSlot)
		}
		classes = append(classes, g.class)
	}
	specifics := map[string]bool{}
	for _, s := range c.lists.specifics {
		where := "specific " + s.word
		if specifics[strings.ToLower(s.word)] {
			t.Errorf("%s: twice", where)
		}
		specifics[strings.ToLower(s.word)] = true
		check(where, "takes", s.takes, classes, false)
		check(where, "biomes", s.biomes, c.biomeIDs, true)
		check(where, "zones", s.zones, zoneNames[:], true)
		tone(where, s.tone)
	}
	for _, p := range namePartners {
		for _, name := range p {
			if _, ok := byName(c.lists, name); !ok {
				t.Errorf("partner %q is not a whole name", name)
			}
		}
	}
}

// TestNamesStayOutOfTheClient: players learn a place's name only when they
// come upon it, so no name is in the catalog the page is built with.
func TestNamesStayOutOfTheClient(t *testing.T) {
	client, err := os.ReadFile("../../client/src/catalog/catalog.gen.json")
	if err != nil {
		t.Fatal(err)
	}
	c := testConfig(t)
	for _, w := range c.lists.wholes {
		if bytes.Contains(client, []byte(`"`+w.name+`"`)) {
			t.Errorf("the client's catalog holds %q", w.name)
		}
	}
	for _, g := range c.lists.groups {
		if bytes.Contains(client, []byte(`"`+g.name+`"`)) {
			t.Errorf("the client's catalog holds %q", g.name)
		}
	}
}

func TestCombinationsOnlyWhenNoWholeNameFits(t *testing.T) {
	c := testConfig(t)
	n := newNamer(c, 1)
	f := fits{size: "islet", biome: c.biomeIDs[0], zone: zoneMiddle}
	whole := 0
	for {
		name := n.whole(&f)
		if name == "" {
			break
		}
		whole++
		if _, ok := byName(c.lists, name); !ok {
			t.Fatalf("%q came from the whole names", name)
		}
	}
	combined := n.combined(&f, false)
	if combined == "" {
		t.Fatal("no combination once the whole names ran out")
	}
	if _, ok := byName(c.lists, combined); ok {
		t.Errorf("%q is a whole name", combined)
	}
	t.Logf("%d whole names for a sandy islet, then %q", whole, combined)
}

func byName(l *nameLists, name string) (*wholeName, bool) {
	for i := range l.wholes {
		if l.wholes[i].name == name {
			return &l.wholes[i], true
		}
	}
	return nil, false
}

// failedRules lists the rules a world fails.
func failedRules(rules []Rule) []string {
	var out []string
	for _, r := range rules {
		if !r.Pass {
			out = append(out, r.Name)
		}
	}
	return out
}

func TestEachRuleFails(t *testing.T) {
	c, b := wholeWorld(t)
	if f := failedRules(c.validate(b.made)); len(f) > 0 {
		t.Fatalf("seed 1 fails %v", f)
	}
	clone := func() *world {
		w := *b.made
		w.islands = make([]*made, len(b.made.islands))
		for i, m := range b.made.islands {
			mm := *m
			w.islands[i] = &mm
		}
		w.names = slices.Clone(b.made.names)
		return &w
	}
	landmark := func(w *world) *made {
		for _, m := range w.islands {
			if m.kind == kindLandmark {
				return m
			}
		}
		t.Fatal("no landmark")
		return nil
	}
	cases := []struct {
		rule   string
		break_ func(w *world)
	}{
		{"main port's width", func(w *world) { w.islands[0].area /= 4 }},
		{"main port's height", func(w *world) { w.islands[0].highest = 10 }},
		{"main port's cliffs", func(w *world) { w.islands[0].cliffs = 0.1 }},
		{"main port at the centre", func(w *world) { w.islands[0].x += 500 }},
		{"calm water", func(w *world) {
			m := landmark(w)
			m.grid.c0, m.grid.j0 = physics.HexColumns/2-m.grid.w/2, physics.HexRows/2-m.grid.h/2
		}},
		{"start area", func(w *world) { w.start.Places = w.start.Places[:10] }},
		{"landmarks reachable", func(w *world) {
			w.start.Places = append([][2]float64{{w.islands[0].hx, w.islands[0].hy}}, w.start.Places...)
		}},
		{"open water", func(w *world) {
			k := *w.coarse
			k.dist = slices.Clone(k.dist)
			for i := range k.dist {
				k.dist[i] = 5000
			}
			w.coarse = &k
		}},
		{"land share", func(w *world) { w.ground = new(physics.Ground) }},
		{"counts by size", func(w *world) { w.islands = w.islands[:20] }},
		{"landmarks' shores", func(w *world) { landmark(w).shoreline = 1.05 }},
		{"names", func(w *world) { w.names[3] = w.names[2] }},
		{"land's height", func(w *world) { landmark(w).highest = 95 }},
	}
	for _, cs := range cases {
		w := clone()
		cs.break_(w)
		if f := failedRules(c.validate(w)); !slices.Contains(f, cs.rule) {
			t.Errorf("a world built to break %q fails %v", cs.rule, f)
		}
	}
}

func TestFailedAttempts(t *testing.T) {
	if testing.Short() {
		t.Skip("makes whole worlds")
	}
	cat := testCatalog(t)
	cat.World.Validator.Attempts = 2
	cat.World.Validator.OpenWater = 10
	b, err := Generate(5, cat)
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("an impossible rule: %v", err)
	}
	if len(b.Report.Attempts) != 2 || b.Attempts != 2 {
		t.Fatalf("%d attempts reported, %d made", len(b.Report.Attempts), b.Attempts)
	}
	for a, at := range b.Report.Attempts {
		if at.Seed != attemptSeed(5, a) || !slices.Contains(at.Failed, "open water") {
			t.Errorf("attempt %d: %+v", a, at)
		}
	}
	if b.Report.Attempts[0].Seed == b.Report.Attempts[1].Seed {
		t.Error("the second attempt had the first's seed")
	}
}

func TestWholeWorld(t *testing.T) {
	c, b := wholeWorld(t)
	if f := failedRules(b.Report.Rules); len(f) > 0 {
		t.Errorf("seed 1 fails %v", f)
	}
	// Every chunk rastered alone is the world's.
	for _, n := range []int32{0, 119, 136, 200} {
		ch := c.raster(n, b.made.islands)
		switch {
		case ch == nil && b.Ground.Chunks[n] == nil:
		case ch == nil || b.Ground.Chunks[n] == nil || *ch != *b.Ground.Chunks[n]:
			t.Errorf("chunk %d rastered alone differs from the world's", n)
		}
	}
	// The bundle round-trips through its file and its database parts.
	b.Digest = b.digest()
	var file bytes.Buffer
	if err := b.WriteFile(&file); err != nil {
		t.Fatal(err)
	}
	read, err := ReadFile(file.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if read.Digest != b.Digest || len(read.Islands) != len(b.Islands) {
		t.Error("the bundle's file reads back as another")
	}
	var size, largest int
	chunks, _ := b.Chunks([16]byte{})
	sizes := make([]int, 0, len(chunks))
	for _, p := range chunks {
		size += len(p)
		largest = max(largest, len(p))
		sizes = append(sizes, len(p))
	}
	sort.Ints(sizes)
	t.Logf("the chunks: %d bytes, median %d, largest %d; the file %d bytes", size, sizes[len(sizes)/2], largest, file.Len())
	// Every island is named once.
	seen := map[string]bool{}
	for _, is := range b.Islands {
		if is.Name == "" || seen[is.Name] {
			t.Errorf("island %d named %q", is.Number, is.Name)
		}
		seen[is.Name] = true
	}
}

// digestSeeds are the seeds whose worlds' digests testdata/digests.json
// holds.
var digestSeeds = []uint64{1, 2, 3, 4, 5, 6, 7, 8}

type digestFile struct {
	Comment string            `json:"comment"`
	Version int               `json:"version"`
	Digests map[string]string `json:"digests"`
}

const digestsPath = "testdata/digests.json"

func TestDigests(t *testing.T) {
	if testing.Short() {
		t.Skip("makes eight whole worlds")
	}
	cat := testCatalog(t)
	got := make([]string, len(digestSeeds))
	var wg sync.WaitGroup
	for i, seed := range digestSeeds {
		wg.Go(func() {
			b, err := Generate(seed, cat)
			if err != nil && !errors.Is(err, ErrInvalid) {
				t.Error(err)
				return
			}
			got[i] = b.DigestHex()
		})
	}
	wg.Wait()
	if *update {
		f := digestFile{
			Comment: "Written by go test ./internal/worldgen -run Digests -update: each seed's world's digest under the generator's version.",
			Version: Version, Digests: map[string]string{},
		}
		for i, s := range digestSeeds {
			f.Digests[strconv.FormatUint(s, 10)] = got[i]
		}
		data, _ := json.MarshalIndent(f, "", "  ")
		if err := os.WriteFile(digestsPath, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	var want digestFile
	data, err := os.ReadFile(digestsPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &want); err != nil {
		t.Fatal(err)
	}
	if want.Version != Version {
		t.Fatalf("%s is for generator %d, this is generator %d: write it again with -update", digestsPath, want.Version, Version)
	}
	for i, s := range digestSeeds {
		if w := want.Digests[strconv.FormatUint(s, 10)]; got[i] != w {
			t.Errorf("seed %d's world has changed under generator %d (digest %s, was %s): a change to any seed's world must raise worldgen.Version, then write %s again with -update",
				s, Version, got[i], w, digestsPath)
		}
	}
}

func TestEmpty(t *testing.T) {
	b := Empty(3)
	var file bytes.Buffer
	if err := b.WriteFile(&file); err != nil {
		t.Fatal(err)
	}
	read, err := ReadFile(file.Bytes())
	if err != nil || read.Digest != b.Digest {
		t.Fatalf("an empty world reads back as %v, %v", read, err)
	}
	if fmt.Sprint(b.Terrain(nil).Start) != "[]" {
		t.Error("an empty world has a start area")
	}
}

var seeds = flag.Int("seeds", 0, "TestSeeds makes the worlds of seeds 1 to this, and reports on them")

// TestSeeds makes many seeds' worlds, as pr.worldgen does with a hundred:
// each must pass the rules within its attempts. It reports how long each
// took, how many attempts, the land's share, the islands by class and
// biome and the widest open water. Run it with -parallel 1 to time worlds
// one at a time.
func TestSeeds(t *testing.T) {
	if *seeds == 0 {
		t.Skip("-seeds N runs it")
	}
	cat := testCatalog(t)
	type result struct {
		seed     uint64
		ms       float64
		attempts int
		share    float64
		open     float64
		classes  map[string]int
		biomes   map[string]int
		failed   []string
	}
	results := make([]result, *seeds)
	t.Run("seeds", func(t *testing.T) {
		for i := range *seeds {
			t.Run(strconv.Itoa(i+1), func(t *testing.T) {
				t.Parallel()
				seed := uint64(i + 1)
				start := time.Now()
				b, err := Generate(seed, cat)
				r := result{seed: seed, ms: float64(time.Since(start).Microseconds()) / 1000}
				if b != nil {
					r.attempts, r.share, r.open, r.classes, r.biomes = b.Attempts, b.Report.LandShare, b.Report.Open, b.Report.ByClass, b.Report.ByBiome
					r.failed = failedRules(b.Report.Rules)
				}
				results[i] = r
				if err != nil {
					t.Errorf("seed %d: %v: failing %v", seed, err, r.failed)
				}
			})
		}
	})
	ms := make([]float64, 0, len(results))
	attempts := map[int]int{}
	var share, open []float64
	classes, biomes := map[string]int{}, map[string]int{}
	for _, r := range results {
		ms = append(ms, r.ms)
		attempts[r.attempts]++
		share = append(share, r.share)
		open = append(open, r.open)
		for k, v := range r.classes {
			classes[k] += v
		}
		for k, v := range r.biomes {
			biomes[k] += v
		}
	}
	sort.Float64s(ms)
	sort.Float64s(share)
	sort.Float64s(open)
	n := float64(len(results))
	t.Logf("%d seeds: made in median %.0f ms, worst %.0f ms; attempts %v", len(results), ms[len(ms)/2], ms[len(ms)-1], attempts)
	t.Logf("land share: least %.2f%%, median %.2f%%, most %.2f%%; widest open water: median %.0f m, most %.0f m",
		share[0], share[len(share)/2], share[len(share)-1], open[len(open)/2], open[len(open)-1])
	for _, m := range []map[string]int{classes, biomes} {
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		line := ""
		for _, k := range keys {
			line += fmt.Sprintf(" %s %.1f", k, float64(m[k])/n)
		}
		t.Logf("a world's mean:%s", line)
	}
}
