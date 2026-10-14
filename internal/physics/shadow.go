// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// Wind shadow. A sail turns and slows the air it works: behind it lies a
// wake of weaker wind, turned away from the true wind, which a boat
// sailing in it feels as less wind and a header. Wind-tunnel studies of two
// yachts find the wake along the source's apparent wind, not the true
// wind, its centre turned a few degrees toward the source's windward side
// by the sail's lift (Richards, Le Pelley, Jowett, Little and Detlefsen
// 2012): the air shed a time τ ago left the boat's place then and has moved
// with the true wind U since, so it lies at x + τ (U − v), along the
// apparent wind U − v. Far behind a body a turbulent wake's loss of speed
// falls as s^(−2/3) and its width grows as s^(1/3) (Pope 2000, chapter 5);
// distances are in the source's rig height h, its masthead's height as it
// stands, so a heeled rig casts a shorter wake and a capsized one none.

// WakeOf is the wake boat s, of kind b, leaves in the true wind e at its
// place.
func WakeOf(s *State, e *Env, b *Prepared, ep *EncounterPrepared) Wake {
	sin, cos := SinCos(s.Heading)
	vx := float64(s.Surge*sin) + float64(s.Sway*cos)
	vy := float64(s.Surge*cos) - float64(s.Sway*sin)
	return WakeAt(s.X, s.Y, s.Heading, s.Heel, s.Boom, vx, vy, e.WindSpeed, e.WindFrom, b, ep)
}

// WakeAt is the wake of a boat of kind b at (x, y) heading heading, heeled
// heel with its boom at boom, moving at (vx, vy) east and north, in a true
// wind of speed from from: what WakeOf computes from a state, and a client
// from what it draws of another boat.
func WakeAt(x, y, heading, heel, boom, vx, vy, speed, from float64, b *Prepared, ep *EncounterPrepared) Wake {
	h := float64(b.mastHeight * Cos(heel))
	if !(h > 0) {
		return Wake{}
	}
	sinW, cosW := SinCos(from)
	// Where the air moves, less where the boat does: the apparent wind.
	ax := float64(-speed*sinW) - vx
	ay := float64(-speed*cosW) - vy
	a := math.Sqrt(float64(ax*ax) + float64(ay*ay))
	if !(a > minApparent) {
		return Wake{}
	}
	ax, ay = ax/a, ay/a
	sin, cos := SinCos(heading)
	// The side the apparent wind comes over: where −a points across the
	// boat, to starboard (cos, −sin) or to port.
	across := -(float64(ax*cos) - float64(ay*sin))
	side := 1.0
	if across < 0 {
		side = -1
	}
	angle := Atan2(math.Abs(across), -(float64(ax*sin) + float64(ay*cos)))
	t := clamp(float64((angle-ep.deflectionAt[0])*ep.invDeflectionAt), 0, 1)
	d := ep.deflection[0] + float64(t*(ep.deflection[1]-ep.deflection[0]))
	sd, cd := SinCos(d)
	// The wake's axis turns from the apparent wind toward the windward
	// side by d: the unit vector across the axis that points there.
	px, py := ay, -ax
	if float64(px*cos)-float64(py*sin) < 0 == (side > 0) {
		px, py = -px, -py
	}
	ex := float64(ax*cd) + float64(px*sd)
	ey := float64(ay*cd) + float64(py*sd)

	// The sail's centre of effort: aft of the mast along the boom, and to
	// the side the rig leans.
	sb, cb := SinCos(boom)
	cx := b.mastX - float64(b.pressureAttached*cb)
	cy := float64(b.pressureAttached*sb) + float64(b.effortHeight*Sin(heel))
	return Wake{
		X:      x + (float64(cx*sin) + float64(cy*cos)),
		Y:      y + (float64(cx*cos) - float64(cy*sin)),
		East:   ex,
		North:  ey,
		Height: h,
		Side:   side,
	}
}

// minApparent is the least apparent wind that leaves a wake, m/s.
const minApparent = 0.01

// Sources are the wakes a boat feels in a step: up to MaxSources, the
// nearest of those that reach it, ties going to the lower slot.
type Sources struct {
	n    int32
	d2   [MaxSources]float64 // the squared distance to each one's start
	slot [MaxSources]int32
	wake [MaxSources]Wake
}

// Reset empties the sources.
func (src *Sources) Reset() { src.n = 0 }

// Len is how many sources there are.
func (src *Sources) Len() int32 { return src.n }

// Consider keeps wake w, cast by the boat in slot, among the sources of a
// boat at (x, y) if it reaches it and is among the nearest.
func (src *Sources) Consider(w *Wake, slot int32, x, y float64, ep *EncounterPrepared) {
	limit := ep.sources
	if limit == 0 {
		return
	}
	if _, ok := wakeReach(w, x, y, ep); !ok {
		return
	}
	dx, dy := x-w.X, y-w.Y
	d2 := float64(dx*dx) + float64(dy*dy)
	i := src.n
	for i > 0 && (d2 < src.d2[i-1] || d2 == src.d2[i-1] && slot < src.slot[i-1]) {
		i--
	}
	if i >= limit {
		return
	}
	last := min(src.n, limit-1)
	for j := last; j > i; j-- {
		src.d2[j], src.slot[j], src.wake[j] = src.d2[j-1], src.slot[j-1], src.wake[j-1]
	}
	src.d2[i], src.slot[i], src.wake[i] = d2, slot, *w
	src.n = min(src.n+1, limit)
}

// wakeAt is where (x, y) lies in wake w: how far along its axis and
// across it, in the source's rig heights.
func wakeAt(w *Wake, x, y float64) (s, c float64) {
	dx, dy := x-w.X, y-w.Y
	s = (float64(dx*w.East) + float64(dy*w.North)) / w.Height
	c = (float64(dx*w.North) - float64(dy*w.East)) / w.Height
	return s, c
}

// wakeReach is the share of the wake's strength on its axis that reaches
// (x, y), with whether any does: nothing ahead of the source, beyond its
// reach, or wide of it.
func wakeReach(w *Wake, x, y float64, ep *EncounterPrepared) (f float64, ok bool) {
	if !(w.Height > 0) {
		return 0, false
	}
	s, c := wakeAt(w, x, y)
	if !(s > 0 && s < ep.reach) {
		return 0, false
	}
	sb := max2(s, ep.near)
	// s^(−2/3): the loss along the axis, and 1/width² across it.
	g := Exp(float64(-(2.0 / 3) * Log(sb)))
	q := float64(float64(float64(c*c)*g) * ep.invWidth2)
	if !(q < shadowAcross) {
		return 0, false
	}
	f = float64(g * Exp(-q))
	// It fades in over the first stretch behind the sail, out toward its
	// reach, and away at its sides, so that a boat moving through it never
	// feels a step.
	f = float64(f * smooth(float64(s*ep.invNear)))
	f = float64(f * (1 - smooth(float64((s-ep.taper)*ep.invTaper))))
	f = float64(f * (1 - smooth(float64((q-shadowAcrossFade)*(1.0/(shadowAcross-shadowAcrossFade))))))
	return f, f > 0
}

// ShadowAt changes e, the true wind at (x, y), by the wakes of src: the
// speed times Π(1 − A fᵢ), the direction turned by Σ H fᵢ away from each
// source's windward side, which is a header for a boat behind a source on
// the same tack. With no wake reaching, e is left as it was.
func ShadowAt(e *Env, x, y float64, src *Sources, ep *EncounterPrepared) {
	speed, from := e.WindSpeed, e.WindFrom
	touched := false
	for i := range src.n {
		w := &src.wake[i]
		f, ok := wakeReach(w, x, y, ep)
		if !ok {
			continue
		}
		touched = true
		speed = float64(speed * (1 - float64(ep.deficit*f)))
		from -= float64(float64(ep.header*f) * w.Side)
	}
	if touched {
		e.WindSpeed, e.WindFrom = speed, wrapAngle(from)
	}
}
