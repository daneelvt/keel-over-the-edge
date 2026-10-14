// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// Boats are solid. Two hulls that touch exchange an impulse with no damage,
// as rigid bodies in surge, sway and yaw, each with its added masses and
// added inertia: the method of ship-collision mechanics, which treats the
// water as constant added masses and the impact as two bodies colliding on
// a frictionless surface (Zhang 1999, as Ståhlberg, Goerlandt, Montewka and
// Kujala 2012 describe it). A tick's contacts are resolved together by
// sequential impulses, a fixed number of passes over them in a fixed order,
// then what penetration is left is pushed apart (Catto 2006): in a fixed
// order over fixed passes, it is the same on every machine.
//
// Contacts are found between the hulls' outlines by separating axes
// (Ericson 2005, 5.2.1): two convex polygons are apart if and only if one
// of their edges' normals separates them; touching, the normal along which
// they overlap least is the contact's, and the centre of their overlap,
// clipped one by the other (Sutherland and Hodgman), the contact's point.

// clipCapacity holds the overlap of two outlines: each clip by a half-plane
// adds at most one corner.
const clipCapacity = 2*outlinePoints + 2

// Hulls is the room contacts are found in: two hulls placed in the world
// and their overlap clipped. A goroutine keeps one and uses it for every
// pair it tries; it is too large for the WebAssembly build's stack.
type Hulls struct {
	a, b         hullFrame
	clipX, clipY [2][clipCapacity]float64
	one          [1]Touching
}

// Touch reports whether boats a and b, of kinds pa and pb, touch, and if
// they do sets c to their contact, its normal pointing from a to b.
func (h *Hulls) Touch(a, b *State, pa, pb *Prepared, c *Contact) bool {
	dx, dy := b.X-a.X, b.Y-a.Y
	r := pa.outline.radius + pb.outline.radius
	if !(float64(dx*dx)+float64(dy*dy) < float64(r*r)) {
		return false
	}
	ha, hb := &h.a, &h.b
	sa, ca := SinCos(a.Heading)
	sb, cb := SinCos(b.Heading)
	// Placed about a's centre, so that the numbers stay small far from
	// the world's.
	ha.place(&pa.outline, 0, 0, sa, ca)
	hb.place(&pb.outline, dx, dy, sb, cb)

	best := math.Inf(-1)
	var nx, ny float64
	for i := range outlinePoints {
		sep := hb.lowest(ha.nx[i], ha.ny[i]) - ha.edgeOffset(i)
		if sep > 0 {
			return false
		}
		if sep > best {
			best, nx, ny = sep, ha.nx[i], ha.ny[i]
		}
	}
	for i := range outlinePoints {
		sep := ha.lowest(hb.nx[i], hb.ny[i]) - hb.edgeOffset(i)
		if sep > 0 {
			return false
		}
		if sep > best {
			best, nx, ny = sep, -hb.nx[i], -hb.ny[i]
		}
	}
	px, py := h.overlapCentre()
	*c = Contact{NormalEast: nx, NormalNorth: ny, Depth: -best, X: a.X + px, Y: a.Y + py}
	vax, vay := pointVelocity(a, sa, ca, px, py)
	vbx, vby := pointVelocity(b, sb, cb, px-dx, py-dy)
	c.Closing = -(float64((vbx-vax)*nx) + float64((vby-vay)*ny))
	return true
}

// overlapCentre is the centre of the overlap of the two placed hulls: a's
// outline clipped by each of b's edges, and the centroid of what is left.
// Hulls that barely touch leave a sliver: then the mean of its corners.
func (h *Hulls) overlapCentre() (x, y float64) {
	a, b := &h.a, &h.b
	bufX, bufY := &h.clipX, &h.clipY
	n := int32(outlinePoints)
	copy(bufX[0][:], a.x[:])
	copy(bufY[0][:], a.y[:])
	cur := 0
	for e := range outlinePoints {
		nx, ny, off := b.nx[e], b.ny[e], b.edgeOffset(e)
		inX, inY := &bufX[cur], &bufY[cur]
		outX, outY := &bufX[1-cur], &bufY[1-cur]
		m := int32(0)
		for i := range n {
			j := (i + 1) % n
			di := (float64(nx*inX[i]) + float64(ny*inY[i])) - off
			dj := (float64(nx*inX[j]) + float64(ny*inY[j])) - off
			if di <= 0 {
				outX[m], outY[m] = inX[i], inY[i]
				m++
			}
			if (di <= 0) != (dj <= 0) {
				t := di / (di - dj)
				outX[m] = inX[i] + float64(t*(inX[j]-inX[i]))
				outY[m] = inY[i] + float64(t*(inY[j]-inY[i]))
				m++
			}
		}
		n = m
		cur = 1 - cur
		if n == 0 {
			break
		}
	}
	px, py := &bufX[cur], &bufY[cur]
	if n == 0 {
		// Touching at a corner, to rounding: the nearer centres' midpoint.
		return float64(0.5 * (a.cx + b.cx)), float64(0.5 * (a.cy + b.cy))
	}
	var area, sx, sy, mx, my float64
	for i := range n {
		j := (i + 1) % n
		cross := float64(px[i]*py[j]) - float64(px[j]*py[i])
		area += cross
		sx += float64((px[i] + px[j]) * cross)
		sy += float64((py[i] + py[j]) * cross)
		mx += px[i]
		my += py[i]
	}
	if math.Abs(area) > 1e-8 {
		return sx / float64(3*area), sy / float64(3*area)
	}
	return mx / float64(n), my / float64(n)
}

// pointVelocity is the velocity, east and north, of the point (rx, ry)
// from boat s's centre of gravity, the boat heading the way sin, cos say.
// Turning to starboard is clockwise seen from above: a point ahead moves
// east as a boat heading north turns.
func pointVelocity(s *State, sin, cos, rx, ry float64) (vx, vy float64) {
	vx = (float64(s.Surge*sin) + float64(s.Sway*cos)) + float64(s.YawRate*ry)
	vy = (float64(s.Surge*cos) - float64(s.Sway*sin)) - float64(s.YawRate*rx)
	return vx, vy
}

// Touching is a contact being resolved: the two boats, their kinds and the
// contact, with what the solver works out once and what it has applied.
type Touching struct {
	A, B   *State
	PA, PB *Prepared
	C      Contact

	sa, ca, sb, cb     float64 // the boats' headings' sines and cosines
	rax, ray, rbx, rby float64 // the contact's point from each centre of gravity
	kn, kt             float64 // the inverse effective masses along the normal and the tangent
	bias               float64 // the parting speed restitution asks for
	pn, pt             float64 // the impulses applied so far, along the normal and the tangent
}

// restitutionFloor is the least closing speed that rebounds, m/s: hulls
// pressed together slowly come to rest against each other rather than
// chatter.
const restitutionFloor = 0.1

// Resolve resolves a tick's contacts: impulses over them in the order
// given for the encounters' passes, then each pushes its boats apart by
// what penetration is left beyond the slop, at most the cap.
func Resolve(ts []Touching, e *EncounterPrepared) {
	for i := range ts {
		ts[i].prepare(e)
	}
	for range e.passes {
		for i := range ts {
			ts[i].impulse(e)
		}
	}
	for i := range ts {
		ts[i].separate(e)
	}
}

// Collide resolves the contact between two boats alone: Touch, then
// Resolve. It reports whether they touched.
func (h *Hulls) Collide(a, b *State, pa, pb *Prepared, e *EncounterPrepared, c *Contact) bool {
	t := &h.one
	if !h.Touch(a, b, pa, pb, &t[0].C) {
		return false
	}
	t[0].A, t[0].B, t[0].PA, t[0].PB = a, b, pa, pb
	Resolve(t[:], e)
	*c = t[0].C
	return true
}

func (t *Touching) prepare(e *EncounterPrepared) {
	t.sa, t.ca = SinCos(t.A.Heading)
	t.sb, t.cb = SinCos(t.B.Heading)
	t.rax, t.ray = t.C.X-t.A.X, t.C.Y-t.A.Y
	t.rbx, t.rby = t.C.X-t.B.X, t.C.Y-t.B.Y
	nx, ny := t.C.NormalEast, t.C.NormalNorth
	t.kn = 1 / (t.PA.inverseMass(t.sa, t.ca, t.rax, t.ray, nx, ny) + t.PB.inverseMass(t.sb, t.cb, t.rbx, t.rby, nx, ny))
	t.kt = 1 / (t.PA.inverseMass(t.sa, t.ca, t.rax, t.ray, -ny, nx) + t.PB.inverseMass(t.sb, t.cb, t.rbx, t.rby, -ny, nx))
	t.bias = 0
	if t.C.Closing > restitutionFloor {
		t.bias = float64(e.restitution * t.C.Closing)
	}
	t.pn, t.pt = 0, 0
}

// inverseMass is how fast the point (rx, ry) from the centre of gravity of
// a boat heading the way sin, cos say moves along (dx, dy) per unit of
// impulse along it: through the mass and added mass in surge and in sway,
// and the yaw inertia.
func (b *Prepared) inverseMass(sin, cos, rx, ry, dx, dy float64) float64 {
	ahead := float64(dx*sin) + float64(dy*cos)
	across := float64(dx*cos) - float64(dy*sin)
	turn := float64(ry*dx) - float64(rx*dy)
	return (float64(float64(ahead*ahead)*b.invMassX) + float64(float64(across*across)*b.invMassY)) +
		float64(float64(turn*turn)*b.invYawInertia)
}

// apply gives boat s, heading the way sin, cos say, the impulse (jx, jy)
// at the point (rx, ry) from its centre of gravity.
func (b *Prepared) apply(s *State, sin, cos, rx, ry, jx, jy float64) {
	s.Surge += float64((float64(jx*sin) + float64(jy*cos)) * b.invMassX)
	s.Sway += float64((float64(jx*cos) - float64(jy*sin)) * b.invMassY)
	s.YawRate += float64((float64(ry*jx) - float64(rx*jy)) * b.invYawInertia)
}

// relative is the velocity of the contact's point on b less that on a.
func (t *Touching) relative() (vx, vy float64) {
	ax, ay := pointVelocity(t.A, t.sa, t.ca, t.rax, t.ray)
	bx, by := pointVelocity(t.B, t.sb, t.cb, t.rbx, t.rby)
	return bx - ax, by - ay
}

// impulse is one pass's impulse at the contact: along the normal, enough
// that the hulls part at the speed restitution asks for, never pulling;
// along the tangent, enough to stop them sliding, within Coulomb's limit.
func (t *Touching) impulse(e *EncounterPrepared) {
	nx, ny := t.C.NormalEast, t.C.NormalNorth
	vx, vy := t.relative()
	vn := float64(vx*nx) + float64(vy*ny)
	pn := max2(t.pn+float64((t.bias-vn)*t.kn), 0)
	t.push(nx, ny, pn-t.pn)
	t.pn = pn

	vx, vy = t.relative()
	vt := float64(-vx*ny) + float64(vy*nx)
	limit := float64(e.friction * t.pn)
	pt := clamp(t.pt-float64(vt*t.kt), -limit, limit)
	t.push(-ny, nx, pt-t.pt)
	t.pt = pt
}

// push applies an impulse j along (dx, dy) to b, and its opposite to a.
func (t *Touching) push(dx, dy, j float64) {
	jx, jy := float64(j*dx), float64(j*dy)
	t.PA.apply(t.A, t.sa, t.ca, t.rax, t.ray, -jx, -jy)
	t.PB.apply(t.B, t.sb, t.cb, t.rbx, t.rby, jx, jy)
}

// separate pushes the boats apart along the normal by the push's share of
// the penetration beyond the slop, at most the cap, shared between them by
// how readily each moves along it.
func (t *Touching) separate(e *EncounterPrepared) {
	d := min2(float64(e.push*(t.C.Depth-e.slop)), e.cap)
	if !(d > 0) {
		return
	}
	nx, ny := t.C.NormalEast, t.C.NormalNorth
	wa := t.PA.inverseMass(t.sa, t.ca, 0, 0, nx, ny)
	wb := t.PB.inverseMass(t.sb, t.cb, 0, 0, nx, ny)
	da := float64(d*wa) / (wa + wb)
	db := d - da
	t.A.X -= float64(da * nx)
	t.A.Y -= float64(da * ny)
	t.B.X += float64(db * nx)
	t.B.Y += float64(db * ny)
}
