// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"fmt"
	"math"
	"runtime"
	"sync"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

const (
	knot = 1852.0 / 3600 // m/s
	deg  = math.Pi / 180
)

// seaRoughness must match the physics package's.
const seaRoughness = 0.0002

// kind is a boat of the catalog as the tool sails it: its constants, its
// raw values, and the height its reference data's wind is taken at.
type kind struct {
	id, name string
	b        *physics.Prepared
	p        *physics.Params
	// height is the reference data's wind height, m: a dinghy's wind is
	// measured near its sail, about 3 m up; a keelboat's polar is rated in
	// the wind 10 m up, the game's own height. The tool's winds are given
	// at this height.
	height     float64
	startSheet [][]float64
	// steerRate is the tool's helmsman's helm per rad/s of turn, and
	// settle and measure how long it sails a point before measuring and
	// how long it measures, s: a dinghy's or a keelboat's, or longer for a
	// boat slow to answer her helm and her sails (newKind).
	steerRate       float64
	settle, measure float64
	// slow is set for such a boat: her helmsman learns a standing helm,
	// steerTrim, helm per radian off course per second, and her sails
	// begin and settle by the wind (startAt, settleAt), no faster than
	// startSurge, m/s.
	slow       bool
	steerTrim  float64
	startSurge float64
	// mass is her mass with the water she carries ahead, kg.
	mass float64
	// square is set for a boat with square sails: her sheet is the braces,
	// the tool's boom the yards' angle off the centreline, and its angle of
	// attack the after yards' lower sails'; in is the least of it, hauled
	// in hard or braced up sharp, degrees.
	square bool
	in     float64
}

// newKind is a boat of the catalog as the tool sails it. Its helmsman
// meets a turn as far ahead as its rudder takes to go from hard over to
// hard over, and no less than steerRate: a ship's wheel is slow. It sails
// a point for settle, or for half the time her hull's drag takes to change
// her speed at sailFrom, M / (ρ C_D A V), if that is longer: a boat so
// slow to answer her sails is sailed by settleAt. It measures a third as
// long.
//
// A slow boat carries a helm too large for a heading-hold alone to keep
// her on course: its helmsman learns a standing helm in the time it
// measures, as a ship's helmsman holds the spokes she needs.
func newKind(id, name string, b *physics.Prepared, p *physics.Params, height float64, startSheet [][]float64) *kind {
	k := &kind{id: id, name: name, b: b, p: p, height: height, startSheet: startSheet,
		steerRate: max(steerRate, steerGain*p.RudderTime), settle: settle, startSurge: sailFrom,
		square: p.SquareForeArea > 0 || p.SquareAfterArea > 0, in: p.BoomIn,
		mass: p.Displacement + p.AddedMassSurge}
	if k.square {
		k.in = p.BraceSharp
	}
	k.settle = max(settle, k.answer(sailFrom)/2)
	k.measure = k.settle * measure / settle
	if k.settle > settle {
		k.slow = true
		k.steerTrim = steerGain / k.measure
		k.startSurge = max(sailFrom, startFroude*math.Sqrt(gravity*p.WaterlineLength))
	}
	return k
}

// answer is the time her hull's drag takes to change her speed near v
// m/s, M / (ρ C_D A V), s.
func (k *kind) answer(v float64) float64 {
	i := v / k.p.DragAreaStep
	j := min(int(i), len(k.p.DragArea)-2)
	area := k.p.DragArea[j] + (i-float64(j))*(k.p.DragArea[j+1]-k.p.DragArea[j])
	return k.mass / (waterDensity * area * v)
}

// startAt is the speed a sail begins at in a wind of m/s 10 m up: a
// dinghy's sailFrom; a slow boat's startShare of the wind, or startFroude
// of her waterline's wave speed, √(g L), whichever is less, and no less
// than sailFrom. From a dinghy's speed a ship gathers way so slowly that
// her sails swing her head round before her rudder can hold it, and from
// her own in a fresh breeze she is so slow to lose way in light air that
// a sail never settles.
func (k *kind) startAt(wind float64) float64 {
	if !k.slow {
		return sailFrom
	}
	return max(sailFrom, min(k.startSurge, startShare*wind))
}

// settleAt is how long a sail is sailed before it is measured in a wind
// of m/s 10 m up: a dinghy's settle; a slow boat's the time her hull's
// drag takes to change her speed at the speed she begins at, which in
// light air is many minutes.
func (k *kind) settleAt(wind float64) float64 {
	if !k.slow {
		return k.settle
	}
	return max(k.settle, k.answer(k.startAt(wind)))
}

// The physics package's water density, kg/m³, and gravity, m/s²; and the
// Froude number and the share of the wind a slow boat's sails begin at.
const (
	waterDensity = 1025
	gravity      = 9.81
	startFroude  = 0.19
	startShare   = 0.3
)

// wind10 returns the wind 10 m up that blows at knots at the kind's
// reference height, in m/s, by the logarithmic profile over the open sea.
func (k *kind) wind10(knots float64) float64 {
	if k.height == 10 {
		return knots * knot
	}
	return knots * knot * math.Log(10/seaRoughness) / math.Log(k.height/seaRoughness)
}

// heightWords names the height the tool's winds are given at.
func (k *kind) heightWords() string {
	if k.height == 10 {
		return "10 m up"
	}
	return fmt.Sprintf("at sail height, %g m", k.height)
}

// helmsman steers by a heading: a proportional-derivative heading-hold of the
// tool's own, not the game's autopilot, with a standing helm it learns
// near its course, kept toward the wind so that it carries over a tack.
type helmsman struct {
	target float64 // heading, rad
	rate   float64 // helm per rad/s of turn
	learn  float64 // standing helm per radian off course per second
	trim   float64 // the standing helm, toward the wind
}

// The helmsman's gain and least rate: a dinghy's.
const (
	steerGain = 1.6 // helm per radian off course
	steerRate = 0.8 // helm per rad/s of turn
)

// helmsmanOf is the kind's helmsman, steering for twa degrees.
func (k *kind) helmsmanOf(twa float64) helmsman {
	return helmsman{target: twa * deg, rate: k.steerRate, learn: k.steerTrim}
}

// trimBand is how near its course the helmsman learns its standing helm,
// rad, so that it never winds up in a turn.
const trimBand = 10 * deg

func (h *helmsman) helm(s *physics.State) float64 {
	off := math.Remainder(h.target-s.Heading, 2*math.Pi)
	if h.learn == 0 {
		return max(-1, min(1, steerGain*off-h.rate*s.YawRate))
	}
	// The wind is from the north: a heading east of it has the wind over
	// port, where weather helm turns her to starboard.
	side := math.Copysign(1, math.Sin(h.target))
	if math.Abs(off) < trimBand {
		h.trim = max(-1, min(1, h.trim+side*h.learn*off/physics.StepsPerSecond))
	}
	return max(-1, min(1, steerGain*off-h.rate*s.YawRate+side*h.trim))
}

// boat is one boat sailing in the tool, from rest or a given state.
type boat struct {
	s    physics.State
	c    physics.Control
	e    physics.Env
	b    *physics.Prepared
	o    physics.Out
	sea  *physics.Sea // nil in flat water
	time float64
	// capsized is set once the sailor has fallen in, or a boat whose sailor
	// stays aboard is knocked down past knockedDown.
	capsized bool
}

// knockedDown is the heel past which a boat counts as capsized though its
// sailor stays aboard, rad: a dinghy's sailor falls in before it.
const knockedDown = 75 * deg

// newBoat is a boat under way at heading in a wind of m/s 10 m up from the
// north, its sheet at sheet and its sail reefed to reef, from 0 to 2.
func newBoat(k *kind, wind, heading, sheet, reef float64) *boat {
	bt := &boat{b: k.b}
	bt.s.Reef, bt.c.Reef = reef, reef
	bt.e.WindSpeed = wind
	bt.s.Heading = heading
	bt.s.Surge = k.startAt(wind)
	bt.c.Sheet = sheet
	bt.s.SheetLimit = math.Pi / 2 * sheet
	return bt
}

func (bt *boat) step() {
	physics.Step(&bt.s, &bt.c, &bt.e, bt.sea, nil, bt.b, &bt.o)
	bt.time += physics.Dt
	if bt.s.SailorMode != physics.Sailing || math.Abs(bt.s.Heel) > knockedDown {
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
	// Apparent is the apparent wind's angle off the bow at the masthead,
	// degrees; Word the sail's word for its sheet (Out.Sail) most often
	// in the measured time.
	Apparent float64 `json:"apparent"`
	Word     int     `json:"word"`
	OK       bool    `json:"ok"` // false if the boat capsized or never settled
	// Aback is set for a ship whose square sails are aback or lifting, or
	// who is out of hand, at every brace: she cannot sail so close to the
	// wind.
	Aback bool `json:"aback,omitempty"`
}

// The least times a point is sailed before measuring and measured, s,
// and the speed each sail begins at, m/s.
const (
	settle   = 60.0
	measure  = 20.0
	sailFrom = 1.5
)

// sail sails a boat at true wind angle twa (degrees) on port tack with the
// sheet fixed and the sail reefed to reef, and returns its mean over the
// measured time.
func sail(k *kind, windKnots, twa, sheet, reef float64) point {
	// The wind comes from the north; on port tack it comes over the port side,
	// so the heading is the true wind angle.
	h := k.helmsmanOf(twa)
	bt := newBoat(k, k.wind10(windKnots), h.target, sheet, reef)
	settled := k.settleAt(k.wind10(windKnots))
	n := int((settled + k.measure) * physics.StepsPerSecond)
	start := int(settled * physics.StepsPerSecond)
	var sum point
	var words [4]int
	y0, off, helm := 0.0, 0.0, 0.0
	for i := range n {
		bt.c.Helm = h.helm(&bt.s)
		bt.step()
		if i == start {
			y0 = bt.s.Y
		}
		if i >= start {
			off = max(off, math.Abs(math.Remainder(h.target-bt.s.Heading, 2*math.Pi)))
			helm += math.Abs(bt.s.Rudder)
			sum.Speed += math.Hypot(bt.s.Surge, bt.s.Sway)
			sum.Heel += bt.s.Heel
			sum.Rudder += bt.s.Rudder
			sum.Leeway += bt.o.Leeway
			if k.square {
				sum.Boom += math.Abs(bt.s.Yards)
				sum.Attack += bt.o.AfterFootAttack
			} else {
				sum.Boom += bt.s.Boom
				sum.Attack += bt.o.FootAttack
			}
			sum.Sailor += bt.s.Sailor
			sum.Flat += bt.o.Flattening
			sum.Apparent += math.Abs(bt.o.ApparentWindAngle)
			words[int(bt.o.Sail)]++
		}
	}
	per := 1 / float64(n-start)
	p := point{
		TWA:   twa,
		Sheet: sheet,
		Speed: sum.Speed * per / knot,
		VMG:   (bt.s.Y - y0) / k.measure / knot,
		// On port tack leeward is starboard, positive; the sailor hikes to
		// port, negative; weather helm, the tiller to windward, turns the
		// blade to leeward: positive.
		Heel:   sum.Heel * per / deg,
		Rudder: sum.Rudder * per / deg,
		Leeway: sum.Leeway * per / deg,
		Boom:   sum.Boom * per / deg,
		Attack: sum.Attack * per / deg,
		Sailor: -sum.Sailor * per,
		Flat:   sum.Flat * per,
		// The mean apparent angle and the commonest word.
		Apparent: sum.Apparent * per / deg,
		OK:       !bt.capsized && off < heldWithin,
	}
	for w, n := range words {
		if n > words[p.Word] {
			p.Word = w
		}
	}
	if k.square && (p.Word == physics.SailAback || p.Word == physics.SailLuffing ||
		helm*per > hardOver*k.p.RudderAngle*deg || math.Abs(p.Leeway) > 45) {
		// A ship whose square sails are aback or lifting is not sailing:
		// they drive her astern, or barely ahead, and only her
		// fore-and-aft sails hold her way; nor is one whose helm is held
		// over past half its travel, which her sails turn as they will,
		// nor one going more sideways or astern than ahead.
		p.OK, p.Aback = false, true
	}
	return p
}

// hardOver is the share of its greatest angle a ship's rudder is held at,
// on the mean, when she is out of hand.
const hardOver = 0.5

// heldWithin is how far off its course a boat may go while it is measured,
// rad: one that goes further is not sailing the point but turning.
const heldWithin = 30 * deg

// best finds the sheet that sails fastest at a true wind angle, the sail
// reefed to reef: a coarse search, then a fine one around the best. A
// ship's braces, slow to sail and smooth in what they give, are searched
// every fifth of their travel, then every twentieth about the best.
func best(k *kind, windKnots, twa, reef float64) point {
	if k.square {
		return search(k, windKnots, twa, reef, 0.2, []float64{-0.1, -0.05, 0.05, 0.1})
	}
	var top point
	aback := false
	try := func(sheet float64) {
		p := sail(k, windKnots, twa, sheet, reef)
		aback = aback || p.Aback
		if p.OK && (!top.OK || p.Speed > top.Speed) {
			top = p
		}
	}
	for sheet := 0.0; sheet <= 1.0001; sheet += 0.05 {
		try(sheet)
	}
	if !top.OK {
		return point{TWA: twa, Aback: aback}
	}
	centre := top.Sheet
	for d := -0.04; d <= 0.0401; d += 0.01 {
		if s := centre + d; s >= 0 && s <= 1 && math.Abs(d) > 1e-9 {
			try(s)
		}
	}
	return top
}

// search is best with a coarse step and the fine offsets about the
// coarse best.
func search(k *kind, windKnots, twa, reef, step float64, fine []float64) point {
	var top point
	aback := false
	try := func(sheet float64) {
		p := sail(k, windKnots, twa, sheet, reef)
		aback = aback || p.Aback
		if p.OK && (!top.OK || p.Speed > top.Speed) {
			top = p
		}
	}
	for i := 0.0; i*step <= 1.0001; i++ {
		try(i * step)
	}
	if !top.OK {
		return point{TWA: twa, Aback: aback}
	}
	centre := top.Sheet
	for _, d := range fine {
		if s := centre + d; s >= 0 && s <= 1 {
			try(s)
		}
	}
	return top
}

// polar is the boat's speed at each true wind angle in one wind.
type polar struct {
	Wind   float64 `json:"wind"` // knots at the kind's reference height
	Points []point `json:"points"`
	// Track is set for a ship: her VMGs are those she makes good over the
	// ground, her leeway in them, not her speed along her heading.
	Track bool `json:"-"`
}

// sailPolars computes polars at full sail for every wind and angle, in
// parallel.
func sailPolars(k *kind, winds, angles []float64) []polar {
	return reefedPolars(k, winds, angles, 0)
}

// reefedPolars computes polars with the sail reefed to reef.
func reefedPolars(k *kind, winds, angles []float64, reef float64) []polar {
	out := make([]polar, len(winds))
	type job struct{ i, j int }
	jobs := make(chan job)
	var wg sync.WaitGroup
	for i, w := range winds {
		out[i] = polar{Wind: w, Points: make([]point, len(angles)), Track: k.square}
	}
	for range runtime.NumCPU() {
		wg.Go(func() {
			for jb := range jobs {
				out[jb.i].Points[jb.j] = best(k, winds[jb.i], angles[jb.j], reef)
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
		if p.Track {
			v = pt.VMG
		}
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

// cannot says why a boat sails no point at an angle: it capsizes, or, a
// ship, she is taken aback, at every sheet.
func (p point) cannot() string {
	if p.Aback {
		return "aback, lifting or out of hand at every brace"
	}
	return "capsizes at every sheet"
}
