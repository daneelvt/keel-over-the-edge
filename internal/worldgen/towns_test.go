// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"math"
	"slices"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The harbour's and the towns' tests.

// TestHarbours makes Port Royal's island alone for seeds 1 to 100 and holds
// each harbour to the catalog: a basin of its width with land round it,
// room to turn, a narrows of its width with its channel, and cliffs on a
// third of its outer coast.
func TestHarbours(t *testing.T) {
	c := testConfig(t)
	hc := &c.port.harbour
	seeds := uint64(100)
	if testing.Short() {
		seeds = 10
	}
	var widths, cliffs []float64
	for seed := uint64(1); seed <= seeds; seed++ {
		spots, _ := layout(c, seed)
		m := c.makeIsland(seed, 0, spots[0], new(work), spots)
		h := m.harbour
		if h == nil {
			t.Errorf("seed %d: no harbour", seed)
			continue
		}
		g := &m.grid
		if w := 2 * h.radius; w < hc.Across[0] || w > hc.Across[1] {
			t.Errorf("seed %d: a basin %.0f m across", seed, w)
		}
		// The turning circle: water a quay's depth and more throughout.
		for i := range g.w * g.h {
			x, y := g.centre(i)
			if hypot(x-h.x, y-h.y) <= h.turning && float64(-g.elev[i]) < float64(hc.Depth[0]*10) {
				t.Errorf("seed %d: the turning circle has %.1f m of water at (%.0f, %.0f)", seed, float64(-g.elev[i])/10, x, y)
				break
			}
		}
		// The narrows' middle third at least the channel's depth.
		for d := h.edge; d <= h.mouth; d += physics.HexAcross {
			x, y := h.x+d*h.sin, h.y+d*h.cos
			if i, ok := g.index(x, y); ok && float64(-g.elev[i]) < float64(hc.Channel*10) {
				t.Errorf("seed %d: the narrows %.1f m deep %.0f m out", seed, float64(-g.elev[i])/10, d)
				break
			}
		}
		if h.inner < hc.Narrows[0] || h.inner > hc.Narrows[1] {
			t.Errorf("seed %d: the narrows %.0f m wide", seed, h.inner)
		}
		if m.cliffs < 1.0/3 {
			t.Errorf("seed %d: cliffs on %.2f of the outer coast", seed, m.cliffs)
		}
		widths = append(widths, 2*h.radius)
		cliffs = append(cliffs, m.cliffs)
	}
	slices.Sort(widths)
	slices.Sort(cliffs)
	t.Logf("basins %.0f–%.0f m across, median %.0f; outer cliffs %.2f–%.2f", widths[0], widths[len(widths)-1],
		widths[len(widths)/2], cliffs[0], cliffs[len(cliffs)-1])
}

// TestHarbourStreamIsItsOwn makes another island with the harbour's draws
// changed: it comes out the same.
func TestHarbourStreamIsItsOwn(t *testing.T) {
	c := testConfig(t)
	spots, _ := layout(c, 1)
	a := c.makeIsland(1, 3, spots[3], new(work), spots)
	c.port.harbour.Tries = 3
	b := c.makeIsland(1, 3, spots[3], new(work), spots)
	if !slices.Equal(a.grid.elev, b.grid.elev) {
		t.Error("a change to the harbour's draws changed another island")
	}
}

// TestRoom counts a town's room over land only: a spit's, not the land
// across its bay.
func TestRoom(t *testing.T) {
	g := new(physics.Ground)
	for _, n := range []int32{7*physics.ChunkSide + 7, 7*physics.ChunkSide + 8, 8*physics.ChunkSide + 7, 8*physics.ChunkSide + 8} {
		ch := new(physics.GroundChunk)
		c0, j0 := physics.ChunkCorner(n)
		for i := range int32(physics.ChunkHexes) {
			x, y := physics.CellCentre(c0+i/physics.ChunkRows, j0+i%physics.ChunkRows)
			// A flat spit 12 m wide along y = 0 from x = 0 to 100, and flat
			// land across a bay from y = 60.
			switch {
			case math.Abs(y) <= 6 && x >= 0 && x <= 100, y >= 60:
				ch.Elevation[i] = 20
			default:
				ch.Elevation[i] = -40
			}
		}
		g.Chunks[n] = ch
	}
	spit := roomOf(g, 50, -8, 150, 4)
	across := roomOf(g, 50, 56, 150, 4)
	if spit > 120 || across < 600 {
		t.Errorf("the spit's room %d hexagons, the land's across the bay %d", spit, across)
	}
}

// TestTowns holds seed 1's towns to their rules and looks at their plans:
// every kind of Port Royal's, counts in their ranges, houses facing their
// ways and not in rows, the start's moorings first.
func TestTowns(t *testing.T) {
	c, b := wholeWorld(t)
	w := b.made
	if bad := c.unsound(w); len(bad) > 0 {
		t.Errorf("seed 1's towns are unsound: %v", bad[:min(len(bad), 5)])
	}
	main := &b.Towns[0]
	if main.Kind != townMain || main.Square == nil || len(main.Piers) < 4 {
		t.Fatalf("Port Royal's town: %+v", main)
	}
	for i, k := range c.buildings {
		if r, ok := k.counts[townMain]; ok && r[0] > 0 && main.Counts[i] == 0 {
			t.Errorf("Port Royal has no %s", c.towns.Buildings[i].ID)
		}
	}
	size := c.towns.Size
	for _, tn := range b.Towns {
		r := map[string][]int{townMain: size.Main, townPort: size.Port, townVillage: size.Village}[tn.Kind]
		if tn.Buildings < r[0] || tn.Buildings > r[1] {
			t.Errorf("%s, a %s, has %d buildings, not %d–%d", tn.Name, tn.Kind, tn.Buildings, r[0], r[1])
		}
	}
	// Not in rows: the houses along Port Royal's streets turn this way and
	// that, each its own.
	var turns []float64
	for _, bd := range b.Buildings {
		if bd.Town == 0 && c.buildings[bd.Kind].stands == catalog.StandsStreet {
			turns = append(turns, bd.Heading)
		}
	}
	distinct := map[float64]bool{}
	for _, h := range turns {
		distinct[h] = true
	}
	if len(turns) < 100 || float64(len(distinct)) < float64(0.5*float64(len(turns))) {
		t.Errorf("%d houses on the streets, facing %d ways", len(turns), len(distinct))
	}
	// The start: its moorings first, in the basin, clear of land, facing
	// the narrows.
	h := w.islands[0].harbour
	st := b.Start
	if st.Moorings < c.moorings.Least || len(st.Places) != c.start.Places {
		t.Fatalf("%d moorings of %d places", st.Moorings, len(st.Places))
	}
	ex, ey := h.x+h.edge*h.sin, h.y+h.edge*h.cos
	for i, p := range st.Places[:st.Moorings] {
		if !h.inBasin(p[0], p[1]) || c.landNear(b.Ground, p[0], p[1], c.moorings.Clear) || hypot(p[0]-h.x, p[1]-h.y) < h.turning {
			t.Errorf("mooring %d at (%.0f, %.0f) is not clear in the basin", i, p[0], p[1])
		}
		want := physics.Atan2(ex-p[0], ey-p[1])
		if math.Abs(angleBetween(st.HeadingOf(i), want)) > 1e-9 {
			t.Errorf("mooring %d faces %.2f, not the narrows' %.2f", i, st.HeadingOf(i), want)
		}
	}
	// In port: the moorings are, the open sea and the land are not.
	for _, p := range st.Places[:st.Moorings] {
		if b.InPort(p[0], p[1]) != 0 {
			t.Errorf("a mooring at (%.0f, %.0f) is not in Port Royal's harbour", p[0], p[1])
		}
	}
	if b.InPort(0, -3000) != -1 || b.InPort(w.islands[0].hx, w.islands[0].hy) != -1 {
		t.Error("the open sea or the land is in port")
	}
	t.Logf("Port Royal: %d buildings, %d hexagons of street, %d piers, %d moorings; %d towns, %d buildings and props in all",
		main.Buildings, main.Streets, len(main.Piers), st.Moorings, len(b.Towns), len(b.Buildings))
}

// TestTownsTime holds the harbour and the towns to their budget: under a
// second added to a world's making.
func TestTownsTime(t *testing.T) {
	_, b := wholeWorld(t)
	ms := b.Report.Millis["towns"] + b.Report.Millis["moorings"]
	t.Logf("towns %.0f ms, moorings %.0f ms, the world %.0f ms", b.Report.Millis["towns"], b.Report.Millis["moorings"], float64(b.Generated().Milliseconds()))
	if ms > 1000 {
		t.Errorf("the towns took %.0f ms", ms)
	}
}
