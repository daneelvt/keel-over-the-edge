// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// Port Royal's harbour is where the refuge holds the wind and the swell,
// and the start's breeze does not reach. Outside it, about the disk's
// centre, the start's breeze softly holds the mean wind up to a light
// breeze, so that a boat starting in the roads off the harbour's mouth
// can sail away in any spell. The harbour is the world's, from its land:
// a basin, a circle at its widest radius, and the narrows, from the basin's
// centre out to the mouth at the coast. A world with no harbour has one
// of no size at the disk's centre.

// Harbour is a world's harbour, m east and north of the disk's centre.
type Harbour struct {
	X, Y           float64 // the basin's centre
	Radius         float64 // its widest radius
	MouthX, MouthY float64 // where the narrows open to the sea
	Narrows        float64 // the narrows' width at the mouth
}

// harbourShore is how far beyond the harbour's basin and narrows the open
// sea's wind takes over from the harbour's, m: its shore, so that the
// wind has no step there.
const harbourShore = 10

// harbourPrepared is the harbour as the wind is computed with it.
type harbourPrepared struct {
	x, y   float64 // the basin's centre, m
	radius float64 // m
	ue, un float64 // the way out along the narrows, a unit vector
	length float64 // from the basin's centre to the mouth, m
	half   float64 // half the narrows' width, m
	mx, my float64 // the mouth, m
}

// SetHarbour sets the world's harbour. PrepareWeather leaves it as it was:
// a world's harbour is its land's, not the catalog's.
func (w *WeatherPrepared) SetHarbour(h *Harbour) {
	p := &w.harbour
	p.x, p.y, p.radius = h.X, h.Y, max2(h.Radius, 0)
	p.mx, p.my, p.half = h.MouthX, h.MouthY, max2(float64(0.5*h.Narrows), 0)
	de, dn := h.MouthX-h.X, h.MouthY-h.Y
	p.length = math.Sqrt(float64(de*de) + float64(dn*dn))
	p.ue, p.un = 0, 0
	if p.length > 0 {
		p.ue, p.un = de/p.length, dn/p.length
	}
}

// harbourAt is how far (x, y) is outside the harbour, m, negative inside
// the basin or the narrows; and how far it is from the mouth, m.
func (w *WeatherPrepared) harbourAt(x, y float64) (outside, mouth float64) {
	h := &w.harbour
	dx, dy := x-h.x, y-h.y
	basin := math.Sqrt(float64(dx*dx)+float64(dy*dy)) - h.radius
	along := min2(max2(float64(dx*h.ue)+float64(dy*h.un), 0), h.length)
	ax, ay := dx-float64(along*h.ue), dy-float64(along*h.un)
	narrows := math.Sqrt(float64(ax*ax)+float64(ay*ay)) - h.half
	mx, my := x-h.mx, y-h.my
	return min2(basin, narrows), math.Sqrt(float64(mx*mx) + float64(my*my))
}

// shares is how much the refuge and the start's breeze hold at (x, y), r
// from the disk's centre, each from 0 to 1. The refuge holds in full in
// the harbour and fades over its blend beyond it. The breeze holds in
// full within its radius about the disk's centre, fading to nothing at
// its edge; and in the harbour it fades from the mouth to nothing over
// its inside reach, so the basin keeps its calm.
func (w *WeatherPrepared) shares(x, y, r float64) (refuge, breeze float64) {
	outside, mouth := w.harbourAt(x, y)
	refuge = smooth(float64((w.refugeOuter - max2(outside, 0)) * w.invRefugeBlend))
	if w.breezeFade > 0 {
		in := 1 - smooth(float64(outside*(1.0/harbourShore)))
		breeze = float64((1 - smooth(float64((r-w.breezeWithin)*w.invBreezeSpan))) *
			(1 - float64(in*smooth(float64(mouth*w.invBreezeInside)))))
	}
	return refuge, breeze
}

// lift passes a speed below knee through knee − soft × tanh((knee − v) /
// soft): unchanged above the knee, with no step in its slope there, and
// never below knee − soft. It is soften's mirror: a soft floor.
func lift(v, knee, soft float64) float64 {
	if !(v < knee) || !(soft > 0) {
		return v
	}
	e := Exp(float64(2*(knee-v)) / soft)
	return knee - float64(soft*(1-2/(e+1)))
}

// RefugeShare is how much the refuge holds at (x, y): 1 in the harbour, 0
// beyond its blend. Over an area of the sea reach across, the share is the
// most anywhere in it.
func (w *WeatherPrepared) RefugeShare(x, y, reach float64) float64 {
	outside, _ := w.harbourAt(x, y)
	return smooth(float64((w.refugeOuter - max2(outside-float64(0.5*reach), 0)) * w.invRefugeBlend))
}

// BreezeShare is how much the start's breeze holds at (x, y), from 0 to 1.
func (w *WeatherPrepared) BreezeShare(x, y float64) float64 {
	_, b := w.shares(x, y, math.Sqrt(float64(x*x)+float64(y*y)))
	return b
}
