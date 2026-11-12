// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// The hull's plan at the sheer, where hulls touch: a convex polygon from
// the catalog's half-beams at OutlineStations stations equally spaced from
// the transom to the stem, up the starboard side and back down the port
// side, the stem a single point; or, for a boat of two hulls, the bows'
// two points, the platform's flat front. Heel is ignored: a dinghy's
// sheer is a few centimetres from the height of its centre of gravity, so
// a push between hulls rolls it very little.

// OutlineStations is how many half-beams the outline has.
const OutlineStations = 11

// outlinePoints is how many corners a polygon with its stem a point has;
// outlineCorners the most it may have, with a flat bow.
const (
	outlinePoints  = 2*OutlineStations - 1
	outlineCorners = 2 * OutlineStations
)

// outline is a hull's polygon in the boat's frame, x ahead and y to
// starboard of the centre of gravity, with each edge's outward normal and
// how far along it the edge lies: edge i runs from corner i to corner i+1.
// It has n corners: outlinePoints, or outlineCorners with a flat bow.
type outline struct {
	n      int32
	x, y   [outlineCorners]float64
	nx, ny [outlineCorners]float64
	offset [outlineCorners]float64
	// radius is the furthest corner from the centre of gravity: the
	// bounding circle tried before the polygons.
	radius float64
	// bow and aft are how far the hull reaches ahead of and behind the
	// centre of gravity: the stem and the transom. The rudder, which
	// reaches further aft, is left out of overlaps as it is of contacts:
	// with it, a bow that touched a transom would always have been
	// overlapped first.
	bow, aft float64
}

func (b *Prepared) prepareOutline(p *Params) {
	o := &b.outline
	length := p.Transom + p.Stem
	// A flat bow's last station is a corner each side; a pointed one's is
	// the stem, once.
	o.n = outlinePoints
	if p.Outline[OutlineStations-1] != 0 {
		o.n = outlineCorners
	}
	n := int(o.n)
	for i := range OutlineStations {
		x := -p.Transom + float64(float64(i)*length)/float64(OutlineStations-1)
		o.x[i], o.y[i] = x, p.Outline[i]
		if i < OutlineStations-1 || o.n == outlineCorners {
			o.x[n-1-i], o.y[n-1-i] = x, -p.Outline[i]
		}
	}
	// The centre of the polygon's corners lies inside it: each edge's
	// normal is turned to point away from it.
	var cx, cy float64
	for i := range n {
		cx += o.x[i]
		cy += o.y[i]
	}
	cx /= float64(n)
	cy /= float64(n)
	o.radius = 0
	for i := range n {
		j := (i + 1) % n
		ex, ey := o.x[j]-o.x[i], o.y[j]-o.y[i]
		l := math.Sqrt(float64(ex*ex) + float64(ey*ey))
		nx, ny := ey/l, -ex/l
		if float64(nx*(o.x[i]-cx))+float64(ny*(o.y[i]-cy)) < 0 {
			nx, ny = -nx, -ny
		}
		o.nx[i], o.ny[i] = nx, ny
		o.offset[i] = float64(nx*o.x[i]) + float64(ny*o.y[i])
		o.radius = max2(o.radius, math.Sqrt(float64(o.x[i]*o.x[i])+float64(o.y[i]*o.y[i])))
	}
	o.bow = p.Stem
	o.aft = p.Transom
}

// Bow is how far the boat's stem is ahead of its centre of gravity, m.
func (b *Prepared) Bow() float64 { return b.outline.bow }

// OutlineConvex reports whether a catalog's outline makes a convex
// polygon: each half-beam at least the mean of its neighbours', none
// negative, the transom's above nothing, and the last nothing, the stem a
// point, unless flat is set, for a boat of two hulls, whose last is the
// bows' half-spread, a flat front no wider than the station behind it.
func OutlineConvex(p *Params, flat bool) bool {
	o := &p.Outline
	last := o[OutlineStations-1]
	if flat && !(last > 0 && last <= o[OutlineStations-2]) || !flat && last != 0 {
		return false
	}
	for i := range OutlineStations {
		if !(o[i] >= 0) {
			return false
		}
		if i > 0 && i < OutlineStations-1 && float64(2*o[i]) < o[i-1]+o[i+1] {
			return false
		}
	}
	return o[0] > 0
}

// hullFrame is a boat's hull placed in the world, relative to a point: its
// corners and normals east and north, its centre, and its frame's axes.
type hullFrame struct {
	x, y     [outlineCorners]float64 // corners
	nx, ny   [outlineCorners]float64 // edges' outward normals
	cx, cy   float64                 // the centre of gravity
	sin, cos float64                 // of the heading
	o        *outline
}

// place puts hull o at (cx, cy) heading the way sin, cos say. A boat-frame
// point (x ahead, y to starboard) is at x (sin, cos) + y (cos, −sin).
func (h *hullFrame) place(o *outline, cx, cy, sin, cos float64) {
	h.o, h.cx, h.cy, h.sin, h.cos = o, cx, cy, sin, cos
	for i := range o.n {
		h.x[i] = cx + (float64(o.x[i]*sin) + float64(o.y[i]*cos))
		h.y[i] = cy + (float64(o.x[i]*cos) - float64(o.y[i]*sin))
		h.nx[i] = float64(o.nx[i]*sin) + float64(o.ny[i]*cos)
		h.ny[i] = float64(o.nx[i]*cos) - float64(o.ny[i]*sin)
	}
}

// edgeOffset is how far along its own normal edge i of h lies.
func (h *hullFrame) edgeOffset(i int) float64 {
	return (float64(h.nx[i]*h.cx) + float64(h.ny[i]*h.cy)) + h.o.offset[i]
}

// lowest is the least projection of h's corners on (nx, ny).
func (h *hullFrame) lowest(nx, ny float64) float64 {
	m := math.Inf(1)
	for i := range h.o.n {
		m = min2(m, float64(nx*h.x[i])+float64(ny*h.y[i]))
	}
	return m
}

// Radius is how far boat b's outline reaches from its centre of gravity,
// m: the circle about its hull, for the simulation's start places.
func Radius(b *Prepared) float64 { return b.outline.radius }
