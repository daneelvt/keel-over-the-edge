// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// The hull's plan at the sheer, where hulls touch: a convex polygon from
// the catalog's half-beams at OutlineStations stations equally spaced from
// the transom to the stem, up the starboard side and back down the port
// side, the stem a single point. Heel is ignored: a dinghy's sheer is a
// few centimetres from the height of its centre of gravity, so a push
// between hulls rolls it very little.

// OutlineStations is how many half-beams the outline has.
const OutlineStations = 11

// outlinePoints is how many corners its polygon has.
const outlinePoints = 2*OutlineStations - 1

// outline is a hull's polygon in the boat's frame, x ahead and y to
// starboard of the centre of gravity, with each edge's outward normal and
// how far along it the edge lies: edge i runs from corner i to corner i+1.
type outline struct {
	x, y   [outlinePoints]float64
	nx, ny [outlinePoints]float64
	offset [outlinePoints]float64
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
	for i := range OutlineStations {
		x := -p.Transom + float64(float64(i)*length)/float64(OutlineStations-1)
		o.x[i], o.y[i] = x, p.Outline[i]
		if i < OutlineStations-1 {
			o.x[outlinePoints-1-i], o.y[outlinePoints-1-i] = x, -p.Outline[i]
		}
	}
	// The centre of the polygon's corners lies inside it: each edge's
	// normal is turned to point away from it.
	var cx, cy float64
	for i := range outlinePoints {
		cx += o.x[i]
		cy += o.y[i]
	}
	cx /= outlinePoints
	cy /= outlinePoints
	o.radius = 0
	for i := range outlinePoints {
		j := (i + 1) % outlinePoints
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

// OutlineConvex reports whether a catalog's outline makes a convex polygon
// whose stem is a point: each half-beam at least the mean of its
// neighbours', none negative, and the last nothing.
func OutlineConvex(p *Params) bool {
	o := &p.Outline
	if o[OutlineStations-1] != 0 {
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
	x, y     [outlinePoints]float64 // corners
	nx, ny   [outlinePoints]float64 // edges' outward normals
	cx, cy   float64                // the centre of gravity
	sin, cos float64                // of the heading
	o        *outline
}

// place puts hull o at (cx, cy) heading the way sin, cos say. A boat-frame
// point (x ahead, y to starboard) is at x (sin, cos) + y (cos, −sin).
func (h *hullFrame) place(o *outline, cx, cy, sin, cos float64) {
	h.o, h.cx, h.cy, h.sin, h.cos = o, cx, cy, sin, cos
	for i := range outlinePoints {
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
	for i := range outlinePoints {
		m = min2(m, float64(nx*h.x[i])+float64(ny*h.y[i]))
	}
	return m
}
