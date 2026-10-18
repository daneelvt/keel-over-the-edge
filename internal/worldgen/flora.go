// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The flora's ground. A hexagon's surface names a community of plants, and
// the catalog says what grows in each, how densely and how tall; the phone
// places the plants from the chunk's surfaces by a fixed rule, so nothing
// is stored per tree. The generator lays the communities' ground: each
// biome's beach, low and high ground as before, and over them mangroves on
// a tropical island's low shores where the water is still, red mangroves
// growing "in sheltered, low-energy shorelines" (UF IFAS), and the
// features' own ground: a stream's bed, a fumarole's sulphur, the rock
// awash under a roof. The wind feels the plants: a windbreak shelters some
// ten times its height to leeward, its trees counted (USDA NRCS,
// Conservation Practice Standard 380), so the shelter counts each
// surface's canopy over its ground.

// mangroveShore is how low and how near the water a mangrove shore is, m.
const (
	mangroveHigh  = 0.8
	mangroveInset = 12.0
)

// stillReach is how far, m, the rays that judge whether a shore's water is
// still are cast, and how many of the sixteen may reach open water.
const (
	stillReach = 150.0
	stillOpen  = 5
	// Behind a fringing reef, whose crest breaks the swell, more may.
	stillOpenLagoon = 8
)

// communities lays island m's communities and features' ground over its
// surfaces: mangroves on its still shores, its streams' beds, the sulphur
// about its fumaroles, the rock awash under its roofs.
func (c *config) communities(m *made, b *biome, w *work) {
	g := &m.grid
	if b.mangroves {
		for i := range g.w * g.h {
			if w.own(i) && w.height[i] < mangroveHigh && w.din[i] < mangroveInset && !w.cliff[i] && m.stillShore(w, i) {
				g.surf[i] = c.featureSurface.mangrove
			}
		}
	}
	for _, st := range m.streams {
		for _, i := range st {
			if g.elev[i] > 0 {
				g.surf[i] = c.featureSurface.stream
			}
		}
	}
	for _, i := range m.sulphur {
		if g.elev[i] > 0 {
			g.surf[i] = c.featureSurface.sulphur
		}
	}
	for _, i := range m.floors {
		g.surf[i] = c.rockSurface
	}
}

// stillShore reports whether the water off hexagon i of island m's grid is
// still: of sixteen rays cast from it, few reach stillReach over water
// without meeting land, as in a bay; more behind a fringing reef.
func (m *made) stillShore(w *work, i int32) bool {
	g := &m.grid
	x0, y0 := g.centre(i)
	open := 0
	most := stillOpen
	if m.reef && m.lagoon >= 40 {
		most = stillOpenLagoon
	}
	for r := range 16 {
		sa, ca := sincos(float64(float64(r) * (2 * math.Pi / 16)))
		clear := true
		wet := false
		for d := float64(physics.HexAcross); d <= stillReach; d += physics.HexAcross {
			q, rr := physics.HexAt(x0+float64(d*sa), y0+float64(d*ca))
			cc, jj := physics.HexCell(q, rr)
			cc, jj = cc-g.c0, jj-g.j0
			if cc < 0 || jj < 0 || cc >= g.w || jj >= g.h {
				break
			}
			if w.land[cc*g.h+jj] {
				if wet {
					clear = false
					break
				}
				continue
			}
			wet = true
		}
		if clear && wet {
			open++
			if open > most {
				return false
			}
		}
	}
	return true
}

// shelterHeights is the highest the wind meets in each cell of the
// shelter's grid, m: the land, its plants' canopy over it, and the roofs'
// tops over their rock awash.
func (c *config) shelterHeights(g *physics.Ground, roofs []Roof) physics.ShelterHeights {
	h := make(physics.ShelterHeights, physics.ShelterFieldSize)
	for n := range int32(physics.ChunkCount) {
		ch := g.Chunks[n]
		if ch == nil {
			continue
		}
		c0, j0 := physics.ChunkCorner(n)
		for i := range int32(physics.ChunkHexes) {
			e := ch.Elevation[i]
			if e <= 0 {
				continue
			}
			cc, j := c0+i/physics.ChunkRows, j0+i%physics.ChunkRows
			s := physics.ShelterIndex(cc/physics.ShelterCell, j/physics.ShelterCell)
			h[s] = max(h[s], float32(float64(float64(e)*0.1)+c.canopy[ch.Surface[i]]))
		}
	}
	for _, r := range roofs {
		s := physics.ShelterIndex(r.C/physics.ShelterCell, r.J/physics.ShelterCell)
		h[s] = max(h[s], float32(float64(r.Top)*0.1))
	}
	return h
}
