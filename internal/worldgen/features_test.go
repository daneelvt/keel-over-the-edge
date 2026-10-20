// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"math"
	"slices"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// handIsland is an island made by hand about (x, y), within e m: land where
// shape says, as high as it says; its distances inland and out worked out,
// its coast cliffed where it stands 5 m or more.
func handIsland(c *config, biome int32, x, y, e float64, shape func(x, y float64) (bool, float64)) (*made, *work) {
	g := gridFor(x, y, e)
	total := g.w * g.h
	w := &work{}
	w.land = grow(w.land, int(total))
	w.height = grow(w.height, int(total))
	w.din = grow(w.din, int(total))
	w.dout = grow(w.dout, int(total))
	w.near = grow(w.near, int(total))
	w.cliff = grow(w.cliff, int(total))
	w.harbour = grow(w.harbour, int(total))
	w.xs = grow(w.xs, int(g.w))
	for cc := range g.w {
		w.xs[cc], _ = physics.CellCentre(g.c0+cc, 0)
	}
	for i := range total {
		hx, hy := g.centre(i)
		land, h := shape(hx, hy)
		w.land[i] = land
		w.height[i] = -5
		if land {
			w.height[i] = h
		}
	}
	sea := make([]bool, total)
	for i := range total {
		sea[i] = !w.land[i]
	}
	g.distances(sea, w.din, w.near, w.xs)
	g.distances(w.land, w.dout, w.near, w.xs)
	for i := range total {
		w.cliff[i] = w.land[i] && w.din[i] < 20 && w.height[i] >= 5
	}
	m := &made{spot: spot{kind: kindIsland, x: x, y: y, radius: e / 2, biome: biome, group: -1}, number: 1, grid: g, reefRock: -1}
	return m, w
}

func biomeIndex(t *testing.T, c *config, ok func(b *biome) bool) int32 {
	t.Helper()
	for i := range c.biomes {
		if ok(&c.biomes[i]) {
			return int32(i)
		}
	}
	t.Fatal("no such biome")
	return -1
}

// rockyBiome is the biome with the most cliffs.
func rockyBiome(t *testing.T, c *config) int32 {
	return biomeIndex(t, c, func(b *biome) bool { return b.cliffs[0] >= 0.5 })
}

func kindOf(t *testing.T, c *config, site catalog.FeatureSite, biome int32) int {
	t.Helper()
	k := c.features.kind(site, biome)
	if k < 0 {
		t.Fatalf("no kind of %s for the biome", site)
	}
	return k
}

// headland is land south of y = 0 and a headland running north from it,
// wide m across, to a head 60 m across beyond its neck, 15 m high.
func headland(wide float64) func(x, y float64) (bool, float64) {
	return func(x, y float64) (bool, float64) {
		switch {
		case y < 0 && y > -200 && math.Abs(x) < 200:
			return true, 15
		case y >= 0 && y < 40 && math.Abs(x) < wide/2:
			return true, 15
		case y >= 40 && y < 90 && math.Abs(x) < 30:
			return true, 15
		}
		return false, 0
	}
}

func TestArchThroughANarrowHeadland(t *testing.T) {
	c := testConfig(t)
	rocky := rockyBiome(t, c)
	m, w := handIsland(c, rocky, 0, 0, 400, headland(12))
	c.archOf(newStream(1, 1), m, w, kindOf(t, c, catalog.FeatureSiteArch, rocky))
	if len(m.features) != 1 || len(m.roofs) == 0 || len(m.roofs) > c.features.headland.Arch.Neck {
		t.Fatalf("a headland 12 m across: %d features, %d roofs", len(m.features), len(m.roofs))
	}
	h := c.features.headland
	for _, r := range m.roofs {
		if !(r.under >= float64(h.Arch.Underside[0]*15)-1e-9 && r.under <= float64(h.Arch.Underside[1]*15)+1e-9) || r.top != 15 {
			t.Errorf("a roof from %.1f to %.1f m", r.under, r.top)
		}
		// Its ground is rock awash: water, a few decimetres deep.
		if w.land[r.i] || w.height[r.i] < -h.Floor[1]-1e-9 || w.height[r.i] > -h.Floor[0]+1e-9 {
			t.Errorf("the ground under a roof is %.2f m", w.height[r.i])
		}
		x, y := m.grid.centre(r.i)
		if y < 0 || y >= 40 {
			t.Errorf("a roof at (%.0f, %.0f), not across the neck", x, y)
		}
	}

	wide, ww := handIsland(c, rocky, 0, 0, 400, headland(40))
	c.archOf(newStream(1, 1), wide, ww, kindOf(t, c, catalog.FeatureSiteArch, rocky))
	if len(wide.features) != 0 {
		t.Fatalf("a headland 40 m across got an arch")
	}
	c.caveOf(newStream(1, 2), wide, ww, kindOf(t, c, catalog.FeatureSiteCave, rocky), nil)
	if len(wide.features) == 0 || c.siteOf(wide.features[0]) != catalog.FeatureSiteCave {
		t.Fatal("a headland 40 m across got no cave")
	}
	f := wide.features[0]
	cells := float64(f.size / physics.HexAcross)
	if cells < float64(h.Cave.Depth[0]) || cells > float64(h.Cave.Depth[1]) {
		t.Errorf("a cave %.0f hexagons deep", cells)
	}
	for _, r := range wide.roofs {
		if r.under < h.Cave.Underside[0]-1e-9 || r.under > h.Cave.Underside[1]+1e-9 || r.top-r.under < h.Cave.Roof-1e-9 {
			t.Errorf("a cave's roof from %.1f to %.1f m", r.under, r.top)
		}
	}
}

func TestDrainageLeavesPits(t *testing.T) {
	c := testConfig(t)
	// A round island 15 m high with a pit 6 m deep in it.
	m, w := handIsland(c, 0, 0, 0, 300, func(x, y float64) (bool, float64) {
		r := hypot(x, y)
		if r >= 120 {
			return false, 0
		}
		h := 15 * (1 - r/120)
		if p := hypot(x-30, y); p < 25 {
			h -= 6 * (1 - p/25)
		}
		return true, max(h, 0.5)
	})
	d := m.drain(w)
	land := 0.0
	g := &m.grid
	for i := range g.w * g.h {
		if !w.land[i] {
			continue
		}
		land += hexArea
		// Every hexagon's water reaches the coast.
		at, steps := i, 0
		for d.to[at] >= 0 && steps < len(d.order) {
			at, steps = d.to[at], steps+1
		}
		if d.to[at] >= 0 || d.sea[at] < 0 {
			x, y := g.centre(i)
			t.Fatalf("the water at (%.0f, %.0f) does not reach the sea", x, y)
		}
	}
	// The catchments where the land drains into the sea add up to it.
	sum := 0.0
	for _, i := range d.order {
		if d.to[i] < 0 {
			sum += d.area[i]
		}
	}
	if math.Abs(sum-land) > 1e-6 {
		t.Errorf("the coast drains %.0f m² of %.0f", sum, land)
	}
	for _, st := range d.streams(g, 5000, 1000) {
		if !m.adjacentAll(st.cells) || d.to[st.mouth()] >= 0 {
			t.Errorf("a stream of %d hexagons does not run to the sea", len(st.cells))
		}
	}
}

// adjacentAll reports whether each hexagon is the next's neighbour.
func (m *made) adjacentAll(cells []int32) bool {
	for k := 1; k < len(cells); k++ {
		if !m.adjacent(cells[k-1], cells[k]) {
			return false
		}
	}
	return true
}

func TestHangingValley(t *testing.T) {
	c := testConfig(t)
	wooded := biomeIndex(t, c, func(b *biome) bool { return b.cliffs[0] > 0 && b.cliffs[1] < 0.5 })
	b := &c.biomes[wooded]
	// A valley running down to a beach in the south: land rising from the
	// shore, lower along x = 0.
	m, w := handIsland(c, wooded, 0, 0, 500, func(x, y float64) (bool, float64) {
		if y < -150 || math.Abs(x) > 220 || y > 250 {
			return false, 0
		}
		h := 0.5 + float64(0.12*(y+150)) - 4*math.Exp(-x*x/800)
		return true, max(h, 0.4)
	})
	d := m.drain(w)
	sts := d.streams(&m.grid, b.stream, c.features.streams.Spring)
	if len(sts) == 0 {
		t.Fatal("no stream down the valley")
	}
	if !c.hangingValley(newStream(1, 3), m, b, w, &sts[0]) {
		t.Fatal("no hanging valley raised")
	}
	d = m.drain(w)
	sts = d.streams(&m.grid, b.stream, c.features.streams.Spring)
	lip := w.height[sts[0].mouth()]
	if lip < c.features.streams.Fall {
		t.Fatalf("the stream leaves over a coast %.1f m high", lip)
	}
	if !m.adjacentAll(sts[0].cells) {
		t.Error("the stream is broken")
	}
}

func TestCones(t *testing.T) {
	c := testConfig(t)
	vol := biomeIndex(t, c, func(b *biome) bool { return b.cone > 0 })
	seen := map[int]bool{}
	for n := int32(1); n < 60 && len(seen) < 3; n++ {
		sp := spot{kind: kindLandmark, x: 3000, y: 0, radius: 200, biome: vol, group: -1}
		var w work
		m := c.makeIsland(11, n, sp, &w, nil)
		if m.cone == nil {
			t.Fatal("a volcanic island with no cone")
		}
		age := m.cone.age
		if seen[age] {
			continue
		}
		seen[age] = true
		height, crater, _ := c.coneShape(age)
		width := float64(2 * sqrtArea(m.area))
		wantH := c.coneTop(width/2, height, crater) / width
		gotH := m.highest / width
		if math.Abs(gotH-wantH) > 0.1*wantH {
			t.Errorf("%s: height %.3f of its base, wants %.3f", ageNames[age], gotH, wantH)
		}
		// The crater: its rim's crest along rays from the cone's centre, its
		// width twice the median distance, over the base's.
		g := &m.grid
		var rims []float64
		for r := range 72 {
			sa, ca := sincos(float64(float64(r) * (2 * math.Pi / 72)))
			rim, best := 0.0, 0.0
			for d := 0.0; d < 400; d += 2 {
				q, rr := physics.HexAt(m.cone.x+float64(d*sa), m.cone.y+float64(d*ca))
				cc, jj := physics.HexCell(q, rr)
				cc, jj = cc-g.c0, jj-g.j0
				if cc < 0 || jj < 0 || cc >= g.w || jj >= g.h || g.elev[cc*g.h+jj] <= 0 {
					break
				}
				if e := float64(g.elev[cc*g.h+jj]); e > best {
					rim, best = d, e
				}
			}
			rims = append(rims, rim)
		}
		slices.Sort(rims)
		got := 2 * rims[len(rims)/2] / width
		if math.Abs(got-crater) > 0.1*crater {
			t.Errorf("%s: crater %.2f of its base, wants %.2f", ageNames[age], got, crater)
		}
		smokes := slices.Contains(c.shows(m), "smoke")
		if smokes != (age == ageYoung) {
			t.Errorf("%s: shows smoke %v", ageNames[age], smokes)
		}
		if m.highest > c.land[1] {
			t.Errorf("%s: %.1f m high", ageNames[age], m.highest)
		}
		t.Logf("%s: height %.3f (wants %.3f), crater %.2f (wants %.2f)", ageNames[age], gotH, wantH, got, crater)
	}
	if len(seen) < 3 {
		t.Errorf("only %d ages among the islands made", len(seen))
	}
}

func TestMangrovesOnStillShores(t *testing.T) {
	c := testConfig(t)
	for bi := range c.biomes {
		b := &c.biomes[bi]
		m, _ := alone(t, c, bi, 220)
		g := &m.grid
		n := 0
		for i := range g.w * g.h {
			if g.elev[i] <= 0 || g.surf[i] != c.featureSurface.mangrove {
				continue
			}
			n++
			if !b.mangroves {
				t.Fatalf("mangroves on a %s island", c.biomeIDs[bi])
			}
			if float64(g.elev[i])/10 > mangroveHigh+0.05 {
				t.Errorf("mangroves %.1f m up", float64(g.elev[i])/10)
			}
		}
		t.Logf("%s: %d hexagons of mangroves", c.biomeIDs[bi], n)
	}
}

func TestCanopyLengthensTheLee(t *testing.T) {
	c := testConfig(t)
	forest := uint8(255)
	for i, h := range c.canopy {
		if h >= 10 {
			forest = uint8(i)
			break
		}
	}
	// A round island 10 m high, wooded all over, at the world's centre.
	g := new(physics.Ground)
	for n := range int32(physics.ChunkCount) {
		g.Chunks[n] = c.raster(n, nil)
	}
	set := func(s uint8) {
		for n := range int32(physics.ChunkCount) {
			ch := g.Chunks[n]
			if ch == nil {
				continue
			}
			c0, j0 := physics.ChunkCorner(n)
			for i := range int32(physics.ChunkHexes) {
				x, y := physics.CellCentre(c0+i/physics.ChunkRows, j0+i%physics.ChunkRows)
				if hypot(x-2000, y-2000) < 60 {
					ch.Elevation[i], ch.Surface[i] = 100, s
				}
			}
		}
	}
	lee := func() int {
		sh := c.shelterOf(g, nil)
		n := 0
		for _, ch := range sh.Chunks {
			if ch == nil {
				continue
			}
			for k := 0; k < len(ch.Values); k += physics.ShelterStride {
				if ch.Values[k] < physics.ShelterFactorOne*9/10 {
					n++
				}
			}
		}
		return n
	}
	set(0)
	bare := lee()
	set(forest)
	wooded := lee()
	if wooded <= bare {
		t.Fatalf("the wooded island's lee covers %d cells' directions, the bare one's %d", wooded, bare)
	}
	t.Logf("lee: bare %d, wooded %d", bare, wooded)
}

func TestShelterAndHandoutCountRoofs(t *testing.T) {
	c := testConfig(t)
	g := new(physics.Ground)
	cc, jj := physics.HexCell(physics.HexAt(1000, 1000))
	roofs := []Roof{{C: cc, J: jj, Top: 180, Under: 60}}
	h := c.shelterHeights(g, roofs)
	if got := h[physics.ShelterIndex(cc/physics.ShelterCell, jj/physics.ShelterCell)]; math.Abs(float64(got)-18) > 1e-4 {
		t.Errorf("the shelter sees %.1f m over a roof 18 m high", got)
	}
	b := &Bundle{Ground: g, Roofs: roofs}
	tops := b.Tops(testCatalog(t))
	if len(tops) != 1 || tops[0][2] != 18 {
		t.Errorf("the tops: %v", tops)
	}
}

// featureIsland is a made island of the scores' test: its measures and
// its features, each in view.
func featureIsland(c *config, t *testing.T, biome int32, highest, cliffs float64, sites ...catalog.FeatureSite) *made {
	m, _ := handIsland(c, biome, 0, 0, 300, func(x, y float64) (bool, float64) { return hypot(x, y) < 100, highest })
	g := &m.grid
	g.elev = make([]int16, g.w*g.h)
	g.surf = make([]uint8, g.w*g.h)
	m.own = make([]bool, g.w*g.h)
	b := &c.biomes[biome]
	for i := range g.w * g.h {
		x, y := g.centre(i)
		if hypot(x, y) < 100 {
			g.elev[i], m.own[i] = int16(highest*10), true
			g.surf[i] = b.surfaces.low
			if hypot(x, y) < 50 {
				g.surf[i] = b.surfaces.high
			}
			m.area += hexArea
		} else {
			g.elev[i] = -20
		}
	}
	m.highest, m.cliffs = highest, cliffs
	for _, site := range sites {
		f := m.addFeature(kindOf(t, c, site, biome), 0, 0, 10, highest)
		f.sighted = true
	}
	return m
}

func TestScores(t *testing.T) {
	c := testConfig(t)
	rocky := rockyBiome(t, c)
	sandy := biomeIndex(t, c, func(b *biome) bool { return b.bars })
	bare := featureIsland(c, t, sandy, 2, 0)
	if sc := c.scenery(bare, []*made{bare}, false, false); c.classOf(sc) != "C" {
		t.Errorf("a bare islet: %+v, class %s", sc, c.classOf(sc))
	}
	grand := featureIsland(c, t, rocky, 45, 0.7, catalog.FeatureSiteArch, catalog.FeatureSiteWaterfall)
	colony := c.features.kinds[slices.IndexFunc(c.features.kinds, func(k featureKind) bool {
		return k.site == catalog.FeatureSiteColony && k.biomes[rocky]
	})]
	_ = colony
	for k := range c.features.kinds {
		if c.features.kinds[k].site == catalog.FeatureSiteColony && c.features.kinds[k].biomes[rocky] {
			f := grand.addFeature(k, 0, 0, 40, 45)
			f.sighted = true
			break
		}
	}
	grand.streams = [][]int32{{0}}
	sc := c.scenery(grand, []*made{grand}, false, false)
	if c.classOf(sc) != "A" {
		t.Errorf("a rocky island with an arch, a colony and a fall: %+v, %.1f, class %s", sc, sc.sum(), c.classOf(sc))
	}
	if sc.Landform < 4 || sc.Water != 5 || sc.Scarcity != 5 {
		t.Errorf("its factors: %+v", sc)
	}
	// What is not in view is not counted.
	for _, f := range grand.features {
		f.sighted = false
	}
	if hidden := c.scenery(grand, []*made{grand}, false, false); hidden.sum() >= sc.sum() {
		t.Errorf("hidden, it scores %.1f; seen, %.1f", hidden.sum(), sc.sum())
	}
}

func TestFeaturesOfSeedOne(t *testing.T) {
	c, b := wholeWorld(t)
	w := b.made
	if bad := c.unsoundFeatures(w); len(bad) > 0 {
		t.Fatalf("unsound: %v", bad)
	}
	if len(w.islands[0].features) > 0 {
		t.Errorf("Port Royal's island has %d features", len(w.islands[0].features))
	}
	// Every part in exactly one chunk.
	parts := 0
	for _, ct := range b.ChunkTowns() {
		if ct != nil {
			parts += len(ct.Parts)
		}
	}
	if parts != len(b.Parts) || len(b.Parts) == 0 {
		t.Errorf("%d parts in the chunks, %d in the bundle", parts, len(b.Parts))
	}
	for _, f := range b.Features {
		fk := &c.features.kinds[slices.IndexFunc(c.features.kinds, func(k featureKind) bool { return k.id == f.Kind })]
		m := w.islands[f.Island]
		switch fk.site {
		case catalog.FeatureSiteRuin:
			if fk.ruin == catalog.RuinBeacon {
				// On its island's high ground near the coast.
				i, _ := m.grid.index(f.X, f.Y)
				if m.inland(i) > c.features.ruins.Beacon || f.Height < 0.5*m.highest {
					t.Errorf("a beacon %.0f m inland, %.1f m up on an island %.1f m high", m.inland(i), f.Height, m.highest)
				}
			}
		case catalog.FeatureSiteColony:
			// On a stack, a cliff, a cay or in mangroves, as its birds nest.
			i, _ := m.grid.index(f.X, f.Y)
			g := &m.grid
			on := map[catalog.Nest]bool{
				catalog.NestStack: g.elev[i] > 0 && !m.ownLand(i),
				catalog.NestCliff: m.ownLand(i) && m.coastal(i) && g.elev[i] >= 60,
				catalog.NestCay:   m.kind == kindRock || m.area <= 8000,
				catalog.NestTrees: g.surf[i] == c.featureSurface.mangrove,
			}
			if !slices.ContainsFunc(fk.birds.Nests, func(n catalog.Nest) bool { return on[n] }) {
				t.Errorf("a %s at (%.0f, %.0f) not where its birds nest", fk.id, f.X, f.Y)
			}
		case catalog.FeatureSiteWaterfall:
			if f.Height < c.features.streams.Fall {
				t.Errorf("a fall from %.1f m", f.Height)
			}
		}
	}
	// A deserted hamlet's houses face a path before their doors.
	for _, bd := range b.Buildings {
		k := &c.buildings[bd.Kind]
		if bd.Town != ruinTown || k.prop || k.stands != catalog.StandsHamlet {
			continue
		}
		sh, ch := sincos(bd.Heading)
		found := false
		for d := float64(bd.Depth/2) + 0.5; d < float64(bd.Depth/2)+8 && !found; d++ {
			if _, s := b.Ground.At(bd.X+float64(d*sh), bd.Y+float64(d*ch)); uint8(s) == c.townSurface.yard {
				found = true
			}
		}
		if !found {
			t.Errorf("a roofless house at (%.0f, %.0f) faces no path", bd.X, bd.Y)
		}
	}
}

func TestEachFeatureRuleFails(t *testing.T) {
	c, b := wholeWorld(t)
	if f := failedRules(c.validate(b.made)); len(f) > 0 {
		t.Fatalf("seed 1 fails %v", f)
	}
	clone := func() *world {
		w := *b.made
		w.islands = make([]*made, len(b.made.islands))
		for i, m := range b.made.islands {
			mm := *m
			mm.features = slices.Clone(m.features)
			mm.roofs = slices.Clone(m.roofs)
			w.islands[i] = &mm
		}
		rb := *b
		rb.Islands = slices.Clone(b.Islands)
		rb.Features = slices.Clone(b.Features)
		w.records = &rb
		return &w
	}
	site := func(m *made, s catalog.FeatureSite) bool {
		return slices.ContainsFunc(m.features, func(f *featureWork) bool { return c.siteOf(f) == s })
	}
	cases := []struct {
		rule   string
		break_ func(w *world)
	}{
		{"features of every site", func(w *world) {
			for _, m := range w.islands {
				m.features = slices.DeleteFunc(m.features, func(f *featureWork) bool { return c.siteOf(f) == catalog.FeatureSiteArch })
			}
		}},
		{"islands worth seeing", func(w *world) {
			for i := range w.records.Islands {
				w.records.Islands[i].Class = "C"
			}
		}},
		{"none hidden", func(w *world) {
			for i := range w.records.Features {
				w.records.Features[i].Seen = false
			}
		}},
		{"biomes' qualities", func(w *world) {
			for _, m := range w.islands {
				if c.biomes[m.biome].reef && m.kind != kindRock {
					m.reef = false
				}
			}
		}},
		{"features sound", func(w *world) {
			for _, m := range w.islands {
				if len(m.roofs) > 0 {
					m.roofs[0].under = m.roofs[0].top + 1
					return
				}
			}
		}},
		{"ruins and colonies", func(w *world) {
			for _, m := range w.islands {
				if site(m, catalog.FeatureSiteRuin) {
					m.features = slices.DeleteFunc(m.features, func(f *featureWork) bool { return c.siteOf(f) == catalog.FeatureSiteRuin })
				}
			}
		}},
	}
	for _, cs := range cases {
		w := clone()
		cs.break_(w)
		if f := failedRules(c.validate(w)); !slices.Contains(f, cs.rule) {
			t.Errorf("a world built to break %q fails %v", cs.rule, f)
		}
	}
}

func TestSeedsPassFirstTime(t *testing.T) {
	if testing.Short() {
		t.Skip("makes eight worlds")
	}
	cat := testCatalog(t)
	for seed := uint64(1); seed <= 8; seed++ {
		t.Run("", func(t *testing.T) {
			t.Parallel()
			b, err := Generate(seed, cat)
			if err != nil || b.Attempts != 1 {
				t.Errorf("seed %d: %d attempts, %v: %v", seed, b.Attempts, err, b.Report.Attempts)
			}
		})
	}
}
