// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Port Royal's harbour, carved into its island in every world after the
// island's shape is drawn and before its heights are raised, so that its
// slopes rise from the harbour's shore as from any coast. A basin, in
// Smyth's words "those sheltered spaces of water which are nearly
// surrounded with slopes … these receptacles have a circular shape and
// narrow entrance" (The Sailor's Word-Book, 1867): a circle whose radius
// wanders by a few harmonics, its centre off the island's toward the
// bearing that leaves the most land round it; a narrows, "the most
// confined part of a channel between two lands", from the basin out to the
// open sea, widening outward; and a mole, "a long pier of massy masonry,
// covering the entrance of a harbour", along the narrows' inner side. The
// basin is deep enough for a tall ship, deepest in its middle, with a
// circle of clear water inside it to turn in: three of her lengths, as
// PIANC's guidance has it for a turning basin without tugs.

// harbour is Port Royal's harbour as carved.
type harbour struct {
	x, y   float64 // the basin's centre
	radius float64 // its mean radius
	amp    []float64
	phase  []float64
	// bearing is the way out through the narrows from the basin's centre,
	// rad clockwise from north; sin and cos are its sine and cosine.
	bearing  float64
	sin, cos float64
	// inner and outer are the narrows' widths at its inner end and its
	// mouth; edge is how far from the basin's centre its inner end is, and
	// mouth how far the coast is along it, m.
	inner, outer float64
	edge, mouth  float64
	// The mole: its root, at the narrows' inner end, the lattice's axis it
	// runs along, and its length and width, m.
	moleX, moleY   float64
	moleAxis       int
	moleLength     float64
	moleWidth      float64
	turning        float64 // the turning circle's radius, m
	town           float64 // half the arc of the shore the town stands on, rad
	quayDepth, mid float64 // m
	channel        float64 // m
}

// The lattice's three axes, as the directions a straight strip of
// hexagons runs: north, and 60° either side of it, rad clockwise from
// north, and their opposites.
var latticeAxes = [6]float64{0, math.Pi / 3, 2 * math.Pi / 3, math.Pi, 4 * math.Pi / 3, 5 * math.Pi / 3}

// radiusAt is the basin's radius toward a, rad clockwise from north.
func (h *harbour) radiusAt(a float64) float64 {
	f := 1.0
	for k := range h.amp {
		f += float64(h.amp[k] * physics.Sin(float64(float64(k+2)*a)+h.phase[k]))
	}
	return float64(h.radius * f)
}

// inBasin reports whether (x, y) is in the basin.
func (h *harbour) inBasin(x, y float64) bool {
	dx, dy := x-h.x, y-h.y
	return hypot(dx, dy) < h.radiusAt(physics.Atan2(dx, dy))
}

// narrowsAt is how far along the narrows (x, y) is, from the basin's
// centre, and how far across from its middle, m.
func (h *harbour) narrowsAt(x, y float64) (along, across float64) {
	dx, dy := x-h.x, y-h.y
	return dot(dx, dy, h.sin, h.cos), float64(dx*h.cos) - float64(dy*h.sin)
}

// narrowsWidth is the narrows' width along m from the basin's centre.
func (h *harbour) narrowsWidth(along float64) float64 {
	return lerp(smoothstep(h.edge, h.mouth+30, along), h.inner, h.outer)
}

// inNarrows reports whether (x, y) is in the narrows: from inside the
// basin out past the coast.
func (h *harbour) inNarrows(x, y float64) bool {
	along, across := h.narrowsAt(x, y)
	return along > 0 && along < h.mouth+80 && math.Abs(across) < h.narrowsWidth(along)/2
}

// inHarbour reports whether (x, y) is the harbour's water.
func (h *harbour) inHarbour(x, y float64) bool { return h.inBasin(x, y) || h.inNarrows(x, y) }

// inTown reports whether the bearing a from the basin's centre is on the
// shore the town stands on, opposite the narrows.
func (h *harbour) inTown(a float64) bool {
	return math.Abs(angleBetween(a, h.bearing+math.Pi)) <= h.town
}

// drawHarbour draws the harbour for the island m, whose land is given:
// tries basins from the harbour's own stream, each at every one of 16
// bearings, and keeps the one with the most land round it among those
// with the land the catalog asks for and room to turn, the widest on a
// tie. nil if none fits.
func (c *config) drawHarbour(seed uint64, m *made, land []bool) *harbour {
	hc := &c.port.harbour
	s := newStream(seed, streamHarbour)
	g := &m.grid
	landAt := func(x, y float64) bool {
		q, r := physics.HexAt(x, y)
		cc, jj := physics.HexCell(q, r)
		cc, jj = cc-g.c0, jj-g.j0
		return cc >= 0 && jj >= 0 && cc < g.w && jj < g.h && land[cc*g.h+jj]
	}
	// coastFrom is how far from (x, y) toward a the land first gives way to
	// water, at most most m; 0 if (x, y) is water.
	coastFrom := func(x, y, a, most float64) float64 {
		sa, ca := sincos(a)
		for d := 0.0; d < most; d += physics.HexAcross / 2 {
			if !landAt(x+float64(d*sa), y+float64(d*ca)) {
				return d
			}
		}
		return most
	}
	var best *harbour
	bestScore := math.Inf(-1)
	for range max(hc.Tries, 1) {
		h := &harbour{
			radius:    s.in(hc.Across[0], hc.Across[1]) / 2,
			inner:     s.in(hc.Narrows[0], hc.Narrows[1]),
			turning:   hc.Turning / 2,
			town:      float64(hc.Town*degree) / 2,
			quayDepth: hc.Depth[0],
			mid:       hc.Depth[1],
			channel:   hc.Channel,
		}
		h.outer = float64(h.inner * hc.Widen)
		offset := s.in(hc.Offset[0], hc.Offset[1])
		for range hc.Harmonics {
			h.amp = append(h.amp, 0)
			h.phase = append(h.phase, s.angle())
		}
		for k, a := range hc.Harmonics {
			h.amp[k] = float64(a * s.in(0.6, 1))
		}
		moleLength := s.in(hc.Mole[0], hc.Mole[1])
		moleSide := s.chance(0.5)
		// Room to turn: the basin's least radius.
		least := math.Inf(1)
		for k := range 64 {
			least = min(least, h.radiusAt(float64(float64(k)*(2*math.Pi/64))))
		}
		if least < h.turning+10 {
			continue
		}
		for d := range 16 {
			b := float64(float64(d) * (2 * math.Pi / 16))
			sb, cb := sincos(b)
			cand := *h
			cand.bearing, cand.sin, cand.cos = b, sb, cb
			cand.x, cand.y = m.x+float64(offset*sb), m.y+float64(offset*cb)
			// The land round the basin, but where the narrows leave it.
			margin := math.Inf(1)
			ok := true
			for k := range 48 {
				a := float64(float64(k) * (2 * math.Pi / 48))
				if math.Abs(angleBetween(a, b)) < 0.6 {
					continue
				}
				sa, ca := sincos(a)
				r := cand.radiusAt(a)
				px, py := cand.x+float64(r*sa), cand.y+float64(r*ca)
				if !landAt(px, py) {
					ok = false
					break
				}
				margin = min(margin, coastFrom(px, py, a, 400))
			}
			if !ok || margin < hc.Land {
				continue
			}
			// The narrows: from the basin's edge out to the coast.
			cand.edge = cand.radiusAt(b)
			ex, ey := cand.x+float64(cand.edge*sb), cand.y+float64(cand.edge*cb)
			cand.mouth = cand.edge + coastFrom(ex, ey, b, 600)
			// It opens to the open sea, not into a bay of the island's
			// own: clear water ahead and either side of its mouth.
			mx, my := cand.x+float64(cand.mouth*sb), cand.y+float64(cand.mouth*cb)
			open := true
			for _, turn := range []float64{0, -0.3, 0.3} {
				sa, ca := sincos(b + turn)
				for t := float64(physics.HexAcross); t <= 250 && open; t += physics.HexAcross / 2 {
					if landAt(mx+float64(t*sa), my+float64(t*ca)) {
						open = false
					}
				}
			}
			if !open {
				continue
			}
			// Sheltered: the island within 300 m of its middle in all but
			// two of the 16 directions.
			lee := 0
			for k := range 16 {
				a := float64(float64(k) * (2 * math.Pi / 16))
				sa, ca := sincos(a)
				for t := 0.0; t < 300; t += physics.HexAcross / 2 {
					if px, py := cand.x+float64(t*sa), cand.y+float64(t*ca); landAt(px, py) && !cand.inHarbour(px, py) {
						lee++
						break
					}
				}
			}
			if lee < 14 {
				continue
			}
			// The mole, along the narrows' inner side, from its inner
			// corner into the basin, along the lattice's axis nearest the
			// way in.
			side := float64(cand.inner/2) + physics.HexAcross
			if moleSide {
				side = -side
			}
			cand.moleX = ex + float64(side*cb)
			cand.moleY = ey - float64(side*sb)
			cand.moleAxis = nearestAxis(b + math.Pi)
			cand.moleWidth = 2 * physics.HexAcross
			// It stops short of the turning circle.
			cand.moleLength = moleLength
			for cand.moleLength > 10 {
				sa, ca := sincos(latticeAxes[cand.moleAxis])
				hx := cand.moleX + float64(cand.moleLength*sa)
				hy := cand.moleY + float64(cand.moleLength*ca)
				if hypot(hx-cand.x, hy-cand.y) >= cand.turning+10 {
					break
				}
				cand.moleLength -= physics.HexAcross
			}
			score := min(margin, hc.Land+40) + float64(0.1*cand.radius)
			if score > bestScore {
				c := cand
				best, bestScore = &c, score
			}
		}
	}
	return best
}

// nearestAxis is the lattice's axis nearest the bearing a.
func nearestAxis(a float64) int {
	best, far := 0, math.Inf(1)
	for k, b := range latticeAxes {
		if d := math.Abs(angleBetween(a, b)); d < far {
			best, far = k, d
		}
	}
	return best
}

// carve takes the harbour's water out of the island's land, and marks it.
func (h *harbour) carve(g *islandGrid, land, water []bool) {
	for i := range g.w * g.h {
		x, y := g.centre(i)
		if h.inHarbour(x, y) {
			water[i] = true
			land[i] = false
		}
	}
}

// finish gives the harbour its sea bed and its mole, once the island's
// heights and surfaces are written: the basin quayDepth deep at its shore
// on the town's side, shoaling to a beach elsewhere, mid deep in its
// middle; the narrows channel deep across its middle third, out to where
// the bed is as deep; the mole a quay's height, of the quay's surface.
func (c *config) finishHarbour(m *made, w *work) {
	h := m.harbour
	g := &m.grid
	tw := &c.towns.Waterfront
	for i := range g.w * g.h {
		if !w.harbour[i] || g.elev[i] > 0 {
			continue
		}
		x, y := g.centre(i)
		natural := -float64(g.elev[i]) / 10
		d := w.dout[i] // to the land
		var depth float64
		if h.inBasin(x, y) {
			dx, dy := x-h.x, y-h.y
			shore := 1.5
			if h.inTown(physics.Atan2(dx, dy)) {
				shore = h.quayDepth
			}
			depth = lerp(smoothstep(0, 30, d), shore, h.mid)
			// The turning circle is deep enough for a tall ship
			// throughout.
			if hypot(dx, dy) <= h.turning+physics.HexAcross {
				depth = max(depth, h.quayDepth+0.5)
			}
		} else {
			along, across := h.narrowsAt(x, y)
			half := h.narrowsWidth(along) / 2
			t := clamp(math.Abs(across)/max(half, 1), 0, 1)
			depth = lerp(smoothstep(1.0/3, 1, t), h.channel+1, 2)
			// Beyond the coast the bed falls away as it would.
			depth = max(depth, natural)
			if along > h.mouth {
				depth = max(natural, lerp(smoothstep(h.mouth, h.mouth+80, along), depth, natural))
			}
		}
		g.elev[i] = -int16(round(float64(clamp(depth, 0.5, c.seabed.Deep) * 10)))
		g.surf[i] = c.biomes[m.biome].surfaces.bed
	}
	// The mole.
	sa, ca := sincos(latticeAxes[h.moleAxis])
	quay := int16(round(float64(tw.Quay * 10)))
	for t := 0.0; t <= h.moleLength; t += physics.HexAcross / 2 {
		for o := -h.moleWidth / 2; o <= h.moleWidth/2; o += physics.HexAcross / 2 {
			x := h.moleX + float64(t*sa) + float64(o*ca)
			y := h.moleY + float64(t*ca) - float64(o*sa)
			if i, ok := g.index(x, y); ok && g.elev[i] <= 0 {
				g.elev[i] = quay
				g.surf[i] = c.townSurface.quay
			}
		}
	}
}

// index is the grid's hexagon that holds (x, y).
func (g *islandGrid) index(x, y float64) (int32, bool) {
	q, r := physics.HexAt(x, y)
	cc, jj := physics.HexCell(q, r)
	cc, jj = cc-g.c0, jj-g.j0
	if cc < 0 || jj < 0 || cc >= g.w || jj >= g.h {
		return 0, false
	}
	return cc*g.h + jj, true
}
