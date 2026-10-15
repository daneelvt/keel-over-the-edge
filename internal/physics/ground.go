// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// The ground under the water: every hexagon of the lattice (hex.go) has an
// elevation, the sea bed's as a depth below the sea, and a surface. A boat
// feels it in its step: where the water is shallower than its daggerboard
// and rudder reach, they are pushed up by the bottom and work with what is
// left of them in the water, as a dinghy's do; where it is shallower than
// the hull, the hull drags on the bottom; and the land stops it, as a body
// that does not move, with the impulses boats meet each other with
// (contact.go). A boat aground and all but still for a few seconds is
// pushed off by its sailor into the nearest water deep enough to float in,
// bow to the wind.
//
// The ground is read through a Ground, a view of the chunks' elevations: the
// server's holds every chunk, a client's those it has been sent. A chunk the
// view lacks is deep water, and a nil Ground is the open sea everywhere.

// DeepWater is the deepest the sea bed is stored, in decimetres below the
// sea: below it nothing differs for a boat.
const DeepWater = -400

// GroundSurfaces is the most kinds of surface the ground has.
const GroundSurfaces = 16

// GroundChunk is one chunk's ground, each hexagon at its index in the chunk
// (ChunkOf): its elevation in decimetres above the sea, negative for the
// sea bed, and its surface, an index into the catalog's surfaces.
type GroundChunk struct {
	Elevation [ChunkHexes]int16
	Surface   [ChunkHexes]uint8
}

// Ground is a view of the chunks' ground; a nil chunk is deep water.
type Ground struct {
	Prepared *GroundPrepared
	Chunks   [ChunkCount]*GroundChunk
}

// GroundPrepared holds the constants grounding is computed with, derived
// from GroundParams by PrepareGround.
type GroundPrepared struct {
	friction     [GroundSurfaces]float64
	stillSpeed   float64 // m/s
	stillSteps   float64
	pushDepth    float64 // m
	pushReach    float64 // m
	pushRings    int32
	restitution  float64
	landFriction float64
}

// PrepareGround derives grounding's constants from its parameters.
func PrepareGround(p *GroundParams, g *GroundPrepared) {
	g.friction = p.Friction
	g.stillSpeed = p.StillSpeed
	g.stillSteps = math.Floor(float64(p.StillTime*StepsPerSecond) + 0.5)
	g.pushDepth = p.PushDepth
	g.pushReach = p.PushReach
	g.pushRings = toInt32(math.Ceil(p.PushReach/hexRing)) + 1
	g.restitution = p.Restitution
	g.landFriction = p.LandFriction
}

// hexRing is the least distance between a hexagon's centre and those of
// its first ring of neighbours, m: √3/2 of the distance across the flats
// on the diagonals, which is the flats themselves.
const hexRing = HexAcross * 0.8660254037844386

// cellAt is the elevation in decimetres and the surface of hexagon (q, r).
func (g *Ground) cellAt(q, r int32) (int16, uint8) {
	n, i, ok := ChunkOf(HexCell(q, r))
	if !ok || g.Chunks[n] == nil {
		return DeepWater, 0
	}
	ch := g.Chunks[n]
	return ch.Elevation[i], ch.Surface[i]
}

// At is the elevation of the ground at (x, y), m above the sea (negative
// under it), and its surface.
func (g *Ground) At(x, y float64) (elevation float64, surface int32) {
	e, s := g.cellAt(HexAt(x, y))
	return float64(float64(e) * 0.1), int32(s)
}

// The axial offsets of a hexagon's six neighbours, counter-clockwise from
// the one to the north-east, as the client lists them.
var hexNeighbours = [6][2]int32{{1, 0}, {0, 1}, {-1, 1}, {-1, 0}, {0, -1}, {1, -1}}

// bed is what a step needs of the ground under a boat, read as the step
// begins: how much of each foil is in the water, and how hard the hull
// presses on the bottom at its bow, middle and stern.
type bed struct {
	active      bool    // the bottom reaches a foil or the hull: the substeps must feel it
	boardCut    float64 // the share of the board's span in the water
	rudderCut   float64
	depth       float64 // the water under the board, m
	pressed     [3]float64
	friction    [3]float64 // the bottom's coefficient under each point
	onBottom    bool
	pressedLoad float64 // N: the weight each point carries when fully pressed
}

// The hull's three points on the bottom, ahead of the centre of gravity as
// shares of half its waterline length.
var bedPoints = [3]float64{1, 0, -1}

// read samples the ground under boat s.
func (bd *bed) read(g *Ground, s *State, b *Prepared, sinH, cosH float64) {
	gp := g.Prepared
	at := pointGround(g, s.X, s.Y, b.board.x, sinH, cosH)
	bd.depth = -at.elevation
	bd.boardCut, bd.rudderCut = 1, 1
	if bd.depth < b.boardDepth {
		bd.active = true
		bd.boardCut = clamp(float64((bd.depth-b.hullDraught)*b.invBoardSpan), 0, 1)
	}
	rudder := pointGround(g, s.X, s.Y, b.rudder.x, sinH, cosH)
	if d := -rudder.elevation; d < b.rudderDepth {
		bd.active = true
		bd.rudderCut = clamp(float64((d-b.hullDraught)*b.invRudderSpan), 0, 1)
	}
	bd.pressedLoad = b.weight / 3
	for i, k := range bedPoints {
		p := pointGround(g, s.X, s.Y, float64(k*b.halfLength), sinH, cosH)
		d := -p.elevation
		if d < b.hullDraught {
			bd.active, bd.onBottom = true, true
			bd.pressed[i] = clamp(float64((b.hullDraught-d)*b.invHullDraught), 0, 1)
			bd.friction[i] = gp.friction[min(max(p.surface, 0), GroundSurfaces-1)]
		}
	}
}

// groundPoint is the ground at a point of a boat.
type groundPoint struct {
	elevation float64 // m
	surface   int32
}

// pointGround is the ground at the point ahead m ahead of the centre of gravity
// of a boat at (x, y) heading the way sin, cos say.
func pointGround(g *Ground, x, y, ahead, sin, cos float64) groundPoint {
	e, s := g.At(x+float64(ahead*sin), y+float64(ahead*cos))
	return groundPoint{elevation: e, surface: s}
}

// bedFrictionSpeed is the speed below which the bottom's friction fades
// in proportion, m/s: Coulomb's law smoothed so that a boat comes to rest
// on the bottom without chattering.
const bedFrictionSpeed = 0.1

// loads adds the bottom's friction at the hull's three points to l: each
// against the point's motion over the ground, its coefficient times the
// weight it carries.
func (bd *bed) loads(m *motion, b *Prepared, l *loads) {
	for i, k := range bedPoints {
		if !(bd.pressed[i] > 0) {
			continue
		}
		x := float64(k * b.halfLength)
		vx, vy := m.u, m.v+float64(m.r*x)
		speed := math.Sqrt((float64(vx*vx) + float64(vy*vy)) + bedFrictionSpeed*bedFrictionSpeed)
		f := float64(float64(bd.friction[i]*bd.pressedLoad)*bd.pressed[i]) / speed
		fx, fy := float64(-f*vx), float64(-f*vy)
		l.X += fx
		l.Y += fy
		l.N += float64(x * fy)
	}
}

// The hexagon's outward normals, east and north, and its corners from its
// centre: a flat-topped hexagon has corners east and west, so its flats
// face north and south, and its edges' normals point 30° off east.
const halfRoot3 = 0.8660254037844386 // √3/2

var (
	hexNormalX = [6]float64{halfRoot3, 0, -halfRoot3, -halfRoot3, 0, halfRoot3}
	hexNormalY = [6]float64{0.5, 1, 0.5, -0.5, -1, -0.5}
	hexCornerX = [6]float64{hexRadius, hexRadius / 2, -hexRadius / 2, -hexRadius, -hexRadius / 2, hexRadius / 2}
	hexCornerY = [6]float64{0, HexAcross / 2, HexAcross / 2, 0, -HexAcross / 2, -HexAcross / 2}
)

// landTouch reports whether the placed hull h touches the hexagon whose
// centre is (cx, cy) from the hull's centre of gravity, and if it does
// returns the normal pointing from the hull into the land, how deep they
// overlap along it, and the point they touch at, from the centre of
// gravity: separating axes, as between two hulls.
func landTouch(h *hullFrame, cx, cy float64) (nx, ny, depth, px, py float64, ok bool) {
	best := math.Inf(-1)
	fromHull, edge := false, 0
	for i := range outlinePoints {
		low := math.Inf(1)
		for k := range 6 {
			low = min2(low, float64(h.nx[i]*(cx+hexCornerX[k]))+float64(h.ny[i]*(cy+hexCornerY[k])))
		}
		sep := low - h.edgeOffset(i)
		if sep > 0 {
			return 0, 0, 0, 0, 0, false
		}
		if sep > best {
			best, fromHull, edge = sep, true, i
		}
	}
	for k := range 6 {
		mx, my := hexNormalX[k], hexNormalY[k]
		sep := (h.lowest(mx, my) - (float64(mx*cx) + float64(my*cy))) - HexAcross/2
		if sep > 0 {
			return 0, 0, 0, 0, 0, false
		}
		if sep > best {
			best, fromHull, edge = sep, false, k
		}
	}
	if fromHull {
		// A corner of the hexagon pokes into the hull: the deepest one.
		nx, ny = h.nx[edge], h.ny[edge]
		low := math.Inf(1)
		for k := range 6 {
			x, y := cx+hexCornerX[k], cy+hexCornerY[k]
			if d := float64(nx*x) + float64(ny*y); d < low {
				low, px, py = d, x, y
			}
		}
		return nx, ny, -best, px, py, true
	}
	// A corner of the hull pokes into the hexagon.
	nx, ny = -hexNormalX[edge], -hexNormalY[edge]
	high := math.Inf(-1)
	for i := range outlinePoints {
		if d := float64(nx*h.x[i]) + float64(ny*h.y[i]); d > high {
			high, px, py = d, h.x[i], h.y[i]
		}
	}
	return nx, ny, -best, px, py, true
}

// landPasses is how many times the contacts with land are gone over in a
// step: a hull pushed out of one hexagon may be pushed into the next.
const landPasses = 2

// land resolves boat s's contacts with the land about it: each pushes the
// hull out along its normal, and an impulse stops it closing, with the
// restitution and friction of land. It reports whether the hull touched.
func (b *Prepared) land(s *State, g *Ground, h *hullFrame, sinH, cosH float64) bool {
	gp := g.Prepared
	q0, r0 := HexAt(s.X, s.Y)
	h.place(&b.outline, 0, 0, sinH, cosH)
	touched := false
	for range landPasses {
		for dq := -b.groundRings; dq <= b.groundRings; dq++ {
			for dr := max(-b.groundRings, -dq-b.groundRings); dr <= min(b.groundRings, -dq+b.groundRings); dr++ {
				e, _ := g.cellAt(q0+dq, r0+dr)
				if e <= 0 {
					continue
				}
				hx, hy := HexCentre(q0+dq, r0+dr)
				nx, ny, depth, px, py, ok := landTouch(h, hx-s.X, hy-s.Y)
				if !ok {
					continue
				}
				touched = true
				b.landImpulse(s, gp, sinH, cosH, nx, ny, px, py)
				s.X -= float64(depth * nx)
				s.Y -= float64(depth * ny)
			}
		}
	}
	return touched
}

// landImpulse stops the hull's point (px, py) closing on land along the
// normal (nx, ny), parting at the restitution's share of its closing speed,
// and checks its sliding along the land within Coulomb's limit.
func (b *Prepared) landImpulse(s *State, gp *GroundPrepared, sinH, cosH, nx, ny, px, py float64) {
	vx, vy := pointVelocity(s, sinH, cosH, px, py)
	closing := float64(vx*nx) + float64(vy*ny)
	if !(closing > 0) {
		return
	}
	bounce := 0.0
	if closing > restitutionFloor {
		bounce = float64(gp.restitution * closing)
	}
	jn := float64((closing + bounce) / b.inverseMass(sinH, cosH, px, py, nx, ny))
	b.apply(s, sinH, cosH, px, py, float64(-jn*nx), float64(-jn*ny))
	vx, vy = pointVelocity(s, sinH, cosH, px, py)
	tx, ty := -ny, nx
	slide := float64(vx*tx) + float64(vy*ty)
	jt := clamp(slide/b.inverseMass(sinH, cosH, px, py, tx, ty), float64(-gp.landFriction*jn), float64(gp.landFriction*jn))
	b.apply(s, sinH, cosH, px, py, float64(-jt*tx), float64(-jt*ty))
}

// Aground's values, in Out.Aground.
const (
	Afloat      = 0 // clear of the bottom
	OnBottom    = 1 // the hull drags on the bottom
	AgainstLand = 2 // the hull touches land
)

// pushOff moves boat s to the nearest hexagon within reach with the push's
// depth of water and no land beside it; or, on a shore so gentle that there
// is none, to the deepest such hexagon within reach, if it is deeper than
// where the boat lies. There it is at rest, pointing a little off
// close-hauled in the wind from from, on the tack that leads away from
// where it lay: a boat left head to wind is in irons, and drifts back
// astern onto the shore. It reports whether it moved the boat.
func (b *Prepared) pushOff(s *State, g *Ground, from float64) bool {
	gp := g.Prepared
	q0, r0 := HexAt(s.X, s.Y)
	deep := toInt32(math.Floor(float64(-gp.pushDepth*10) + 0.5))
	here, _ := g.cellAt(q0, r0)
	best, found := math.Inf(1), false
	shallowest := here // the deepest found short of the push's depth
	var bx, by, sx, sy float64
	for dq := -gp.pushRings; dq <= gp.pushRings; dq++ {
		for dr := max(-gp.pushRings, -dq-gp.pushRings); dr <= min(gp.pushRings, -dq+gp.pushRings); dr++ {
			q, r := q0+dq, r0+dr
			e, _ := g.cellAt(q, r)
			if e >= 0 || int32(e) > deep && e >= shallowest {
				continue
			}
			hx, hy := HexCentre(q, r)
			dx, dy := hx-s.X, hy-s.Y
			d := float64(dx*dx) + float64(dy*dy)
			if d > float64(gp.pushReach*gp.pushReach) || int32(e) <= deep && d >= best {
				continue
			}
			clear := true
			for _, n := range hexNeighbours {
				if ne, _ := g.cellAt(q+n[0], r+n[1]); ne > 0 {
					clear = false
					break
				}
			}
			switch {
			case !clear:
			case int32(e) <= deep:
				best, bx, by, found = d, hx, hy, true
			default:
				shallowest, sx, sy = e, hx, hy
			}
		}
	}
	if !found {
		if shallowest >= here {
			return false
		}
		bx, by = sx, sy
	}
	// Of the two headings, the one that points further from where the
	// boat lay.
	ax, ay := bx-s.X, by-s.Y
	h1, h2 := wrapAngle(from+b.pushOffAngle), wrapAngle(from-b.pushOffAngle)
	s1, c1 := SinCos(h1)
	s2, c2 := SinCos(h2)
	heading := h1
	if float64(ax*s2)+float64(ay*c2) > float64(ax*s1)+float64(ay*c1) {
		heading = h2
	}
	s.X, s.Y, s.Heading = bx, by, heading
	s.Surge, s.Sway, s.YawRate = 0, 0, 0
	s.Heel, s.RollRate, s.BoomRate = 0, 0, 0
	s.Heave, s.HeaveRate, s.Pitch, s.PitchRate = 0, 0, 0, 0
	return true
}

// ground is a step's dealings with the ground after its substeps: the
// land's contacts, the time aground and still, and pushing off.
func (b *Prepared) ground(s *State, e *Env, g *Ground, bd *bed, o *Out) {
	sinH, cosH := SinCos(s.Heading)
	var h hullFrame
	touched := b.land(s, g, &h, sinH, cosH)
	o.Aground = Afloat
	switch {
	case touched:
		o.Aground = AgainstLand
	case bd.onBottom:
		o.Aground = OnBottom
	}
	speed := math.Sqrt(float64(s.Surge*s.Surge) + float64(s.Sway*s.Sway))
	if o.Aground == Afloat || !(speed < g.Prepared.stillSpeed) {
		s.GroundTimer = 0
		return
	}
	s.GroundTimer++
	if s.GroundTimer < g.Prepared.stillSteps {
		return
	}
	s.GroundTimer = 0
	if b.pushOff(s, g, e.WindFrom) {
		o.PushedOff = 1
	}
}
