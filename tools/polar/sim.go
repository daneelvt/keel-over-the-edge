// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"math"
	"runtime"
	"sync"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

const (
	knot = 1852.0 / 3600 // m/s
	deg  = math.Pi / 180
)

// sailHeight is the height at which the reference data's wind is taken: the
// sail's, about 3 m. The game's wind, and the physics', is 10 m up.
const sailHeight = 3.0

// seaRoughness must match the physics package's.
const seaRoughness = 0.0002

// wind10 returns the wind 10 m up that blows at knots at sail height, in m/s,
// by the logarithmic profile over the open sea.
func wind10(knotsAtSail float64) float64 {
	return knotsAtSail * knot * math.Log(10/seaRoughness) / math.Log(sailHeight/seaRoughness)
}

// helmsman steers by a heading: a proportional-derivative heading-hold of the
// tool's own, not the game's autopilot.
type helmsman struct {
	target float64 // heading, rad
}

const (
	steerGain = 1.6 // helm per radian off course
	steerRate = 0.8 // helm per rad/s of turn
)

func (h helmsman) helm(s *physics.State) float64 {
	off := math.Remainder(h.target-s.Heading, 2*math.Pi)
	return max(-1, min(1, steerGain*off-steerRate*s.YawRate))
}

// boat is one boat sailing in the tool, from rest or a given state.
type boat struct {
	s    physics.State
	c    physics.Control
	e    physics.Env
	b    *physics.Prepared
	o    physics.Out
	time float64
	// capsized is set once the sailor has fallen in.
	capsized bool
}

func newBoat(b *physics.Prepared, wind, heading, sheet float64) *boat {
	bt := &boat{b: b}
	bt.e.WindSpeed = wind
	bt.s.Heading = heading
	bt.s.Surge = 1.5
	bt.c.Sheet = sheet
	bt.s.SheetLimit = math.Pi / 2 * sheet
	return bt
}

func (bt *boat) step() {
	physics.Step(&bt.s, &bt.c, &bt.e, bt.b, &bt.o)
	bt.time += physics.Dt
	if bt.s.SailorMode != physics.Sailing {
		bt.capsized = true
	}
}

// point is the boat's steady sailing at one true wind angle and sheet.
type point struct {
	TWA    float64 `json:"twa"`    // degrees, off the heading
	Sheet  float64 `json:"sheet"`  // 0 … 1
	Speed  float64 `json:"speed"`  // knots through the water
	VMG    float64 `json:"vmg"`    // knots toward the wind, negative away from it
	Heel   float64 `json:"heel"`   // degrees, positive to leeward
	Rudder float64 `json:"rudder"` // degrees, positive to windward (weather helm)
	Leeway float64 `json:"leeway"` // degrees, positive to leeward
	Boom   float64 `json:"boom"`   // degrees off the centreline
	Attack float64 `json:"attack"` // the lower strip's angle of attack, degrees
	Sailor float64 `json:"sailor"` // m out to windward
	Flat   float64 `json:"flat"`   // the sailor's flattening
	OK     bool    `json:"ok"`     // false if the boat capsized or never settled
}

const (
	settle  = 60.0 // s sailed before measuring
	measure = 20.0 // s measured
)

// sail sails a boat at true wind angle twa (degrees) on port tack with the
// sheet fixed, and returns its mean over the measured time.
func sail(b *physics.Prepared, windKnots, twa, sheet float64) point {
	// The wind comes from the north; on port tack it comes over the port side,
	// so the heading is the true wind angle.
	h := helmsman{target: twa * deg}
	bt := newBoat(b, wind10(windKnots), h.target, sheet)
	n := int((settle + measure) * physics.StepsPerSecond)
	start := int(settle * physics.StepsPerSecond)
	var sum point
	y0 := 0.0
	for i := range n {
		bt.c.Helm = h.helm(&bt.s)
		bt.step()
		if i == start {
			y0 = bt.s.Y
		}
		if i >= start {
			sum.Speed += math.Hypot(bt.s.Surge, bt.s.Sway)
			sum.Heel += bt.s.Heel
			sum.Rudder += bt.s.Rudder
			sum.Leeway += bt.o.Leeway
			sum.Boom += bt.s.Boom
			sum.Attack += bt.o.FootAttack
			sum.Sailor += bt.s.Sailor
			sum.Flat += bt.o.Flattening
		}
	}
	k := 1 / float64(n-start)
	p := point{
		TWA:   twa,
		Sheet: sheet,
		Speed: sum.Speed * k / knot,
		VMG:   (bt.s.Y - y0) / measure / knot,
		// On port tack leeward is starboard, positive; the sailor hikes to
		// port, negative; weather helm, the tiller to windward, turns the
		// blade to leeward: positive.
		Heel:   sum.Heel * k / deg,
		Rudder: sum.Rudder * k / deg,
		Leeway: sum.Leeway * k / deg,
		Boom:   sum.Boom * k / deg,
		Attack: sum.Attack * k / deg,
		Sailor: -sum.Sailor * k,
		Flat:   sum.Flat * k,
		OK:     !bt.capsized,
	}
	return p
}

// best finds the sheet that sails fastest at a true wind angle: a coarse
// search, then a fine one around the best.
func best(b *physics.Prepared, windKnots, twa float64) point {
	var top point
	try := func(sheet float64) {
		p := sail(b, windKnots, twa, sheet)
		if p.OK && (!top.OK || p.Speed > top.Speed) {
			top = p
		}
	}
	for sheet := 0.0; sheet <= 1.0001; sheet += 0.05 {
		try(sheet)
	}
	if !top.OK {
		return point{TWA: twa}
	}
	centre := top.Sheet
	for d := -0.04; d <= 0.0401; d += 0.01 {
		if s := centre + d; s >= 0 && s <= 1 && math.Abs(d) > 1e-9 {
			try(s)
		}
	}
	return top
}

// polar is the boat's speed at each true wind angle in one wind.
type polar struct {
	Wind   float64 `json:"wind"` // knots at sail height
	Points []point `json:"points"`
}

// sailPolars computes polars for every wind and angle, in parallel.
func sailPolars(b *physics.Prepared, winds, angles []float64) []polar {
	out := make([]polar, len(winds))
	type job struct{ i, j int }
	jobs := make(chan job)
	var wg sync.WaitGroup
	for i, w := range winds {
		out[i] = polar{Wind: w, Points: make([]point, len(angles))}
	}
	for range runtime.NumCPU() {
		wg.Go(func() {
			for jb := range jobs {
				out[jb.i].Points[jb.j] = best(b, winds[jb.i], angles[jb.j])
			}
		})
	}
	for i := range winds {
		for j := range angles {
			jobs <- job{i, j}
		}
	}
	close(jobs)
	wg.Wait()
	return out
}

// vmg returns the best upwind and downwind VMG of a polar, in knots, with the
// angles they are sailed at.
func vmg(p polar) (up, upAngle, down, downAngle float64) {
	for _, pt := range p.Points {
		if !pt.OK {
			continue
		}
		v := pt.Speed * math.Cos(pt.TWA*deg)
		if v > up {
			up, upAngle = v, pt.TWA
		}
		if -v > down {
			down, downAngle = -v, pt.TWA
		}
	}
	return up, upAngle, down, downAngle
}

func at(p polar, twa float64) point {
	for _, pt := range p.Points {
		if pt.TWA == twa {
			return pt
		}
	}
	return point{TWA: twa}
}
