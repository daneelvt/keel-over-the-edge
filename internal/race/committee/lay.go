// SPDX-License-Identifier: AGPL-3.0-only

package committee

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Laying a course, at the warning signal, to the mean wind at its place.
//
// A buoy course's line is square to the wind, one and a half of the boat's
// lengths for each boat entered (six at least), the committee boat at its
// starboard end and the pin at its port end, downwind of the area's centre
// by half the windward leg; the windward mark is as far upwind of the
// centre, so the course lies across the area's middle in any wind. The leg
// is sized by the boat's polar for the race's time, ten minutes short and
// twenty long; where the area cannot hold it, it is cut to what it holds
// and the course sails more laps instead. A triangle's wing mark lies out
// to port of the middle by half the leg; between laps the boats round a
// leeward gate a little above the line. Every mark is left to port; the
// finish is the start line, crossed coming down the wind.
//
// A reach is a beginner's course: its line lies along the wind, the
// committee boat at its downwind end, its length for the boats entered as
// a buoy course's is, and its one mark straight across the wind from the
// line's middle, as far to one side of the
// area's centre as the line is to the other. The way is out to the mark,
// round it and back over the same line, so both legs are beam reaches
// and nobody has to tack up a beat. It is sized by the boat's polar for
// five minutes, or to what the area holds if that is less: it is never
// sailed twice round. The mark is left to port, and lies to the side
// that makes the turn round it a tack, through the wind, not a gybe.
//
// A Dash is the race's course with no beat in it: laid as a reach is, its
// line along the wind and its one mark straight across the wind from the
// line's middle, but home to a finish line of its own, two buoys along the
// wind as the start line is, up the wind of it by DashApart of the boat's
// lengths beyond its end, so that the boats coming home are clear of the
// boats going out. No leg lies closer to the wind than dashOff: where the
// legs are too short for the finish to lie so far up the wind, it lies
// less far. It is sized by the boat's polar for six minutes, a long Dash
// for twelve, twice as far to its mark, or to what the area holds, and laid across the area's middle with room behind the
// line for the boats placed there; the committee boat stays at the start,
// and fires each finisher's gun from there.
//
// An island course lays only its lines: the start across the wind at its
// start's site, or across the way out if the way leaves across the wind,
// within the site's room; the finish across the way in at its finish's
// site. Its rounding rays are the world's.

// The sizes of a laid course, in the boat's lengths.
const (
	lineEach   = 1.5 // the line's length for each boat
	lineLeast  = 6   // the shortest line
	areaBehind = 6   // the room behind the line that stays in the area
	legLeast   = 15  // the shortest windward leg
	gateAbove  = 3   // the leeward gate above the line, at least
	gateLeast  = 5   // the gate's width, at least
	rowBack    = 3   // each row of boats placed behind the line
	rows       = 6   // rows offered
)

// startOffWind is how far off the wind a placed boat faces, on starboard
// tack: 110°.
const startOffWind = 110 * math.Pi / 180

// Lay lays the course of the race of call in a mean wind of speed m/s from
// from, rad, at its place (Where), for n boats: nil if the stage has no
// such course.
func (s *Stage) Lay(f *bus.Frame, call *bus.RaceCall, speed, from float64, n int) *bus.RaceCourse {
	k := s.kind(call.Kind)
	if call.Island {
		c := s.course(call.Course)
		if c == nil || len(c.Way) < 2 {
			return nil
		}
		if call.Trial {
			return layIsland(c, k, speed, from, n)
		}
		at, upwind := islandStart(c, from)
		laid := layIsland(at, k, speed, from, n)
		laid.Upwind = upwind
		return laid
	}
	a := s.areaFor(f, call)
	if a == nil {
		return nil
	}
	switch {
	case call.Across && call.Dash:
		target := float64(DashSeconds)
		if call.Long {
			target = LongDashSeconds
		}
		return layDash(a, k, target, speed, from, n)
	case call.Across:
		return layReach(a, k, speed, from, n)
	}
	target := float64(ShortSeconds)
	if call.Long {
		target = LongSeconds
	}
	return layBuoy(a, k, call.Triangle, target, speed, from, n)
}

// lineLength is a line's length for n boats of length l.
func lineLength(l float64, n int) float64 {
	return max(float64(lineEach*l)*float64(n), float64(lineLeast*l))
}

// layBuoy lays a buoy course in area a for boats k, n of them, sized to
// target s in a wind of speed from from.
func layBuoy(a *Area, k Kind, triangle bool, target, speed, from float64, n int) *bus.RaceCourse {
	us, uc := physics.SinCos(from)
	// u is up the wind, r to starboard looking up it.
	ux, uy, rx, ry := us, uc, uc, -us
	at := func(along, across float64) [2]float64 {
		return [2]float64{a.X + float64(along*ux) + float64(across*rx), a.Y + float64(along*uy) + float64(across*ry)}
	}
	l := k.Length
	lineLen := lineLength(l, n)
	// The time a lap takes for each metre of the leg, by the polar.
	perMetre := lapTime(k.Polar, triangle, speed, from)
	leg := float64(legLeast * l)
	laps := int32(1)
	most := max(2*(a.Radius-float64(areaBehind*l)), leg)
	if perMetre > 0 && !math.IsInf(perMetre, 0) {
		leg = max(target/perMetre, leg)
		if leg > most {
			laps = max(toInt32(math.Ceil(target/float64(most*perMetre))), 1)
			leg = max(target/float64(float64(laps)*perMetre), float64(legLeast*l))
		}
	}
	half := float64(leg * 0.5)
	mid := at(-half, 0)
	c := &bus.RaceCourse{
		Number: a.Number, Triangle: triangle, Laps: laps, Wind: speed, From: from,
		X: a.X, Y: a.Y, Reach: a.Radius,
		Committee: at(-half, float64(lineLen*0.5)), Pin: at(-half, -float64(lineLen*0.5)),
	}
	c.FinishA, c.FinishB = c.Pin, c.Committee
	windward := at(half, 0)
	wing := at(0, -half)
	gateUp := max(float64(gateAbove*l), float64(0.1*leg))
	gateWidth := max(float64(lineLen*0.5), float64(gateLeast*l))
	gate := at(-half+gateUp, 0)
	gateL, gateR := at(-half+gateUp, -float64(gateWidth*0.5)), at(-half+gateUp, float64(gateWidth*0.5))
	c.Marks = append(c.Marks, bus.RaceMark{X: windward[0], Y: windward[1], Number: 1, Side: bus.MarkPort})
	gateNumber := int16(2)
	if triangle {
		c.Marks = append(c.Marks, bus.RaceMark{X: wing[0], Y: wing[1], Number: 2, Side: bus.MarkPort})
		gateNumber = 3
	}
	if laps > 1 {
		c.Marks = append(c.Marks,
			bus.RaceMark{X: gateL[0], Y: gateL[1], Number: gateNumber, Side: bus.MarkGate},
			bus.RaceMark{X: gateR[0], Y: gateR[1], Number: gateNumber, Side: bus.MarkGate})
	}
	// The start: the line from the pin to the committee boat, crossed up
	// the wind, from its right to its left.
	c.Way = append(c.Way, mid)
	c.Checks = append(c.Checks, lineCheck(c.Pin, c.Committee, -1, 0))
	for lap := int32(1); lap <= laps; lap++ {
		c.Way = append(c.Way, windward)
		c.Checks = append(c.Checks, rayCheck(windward, us, uc, -1, 1))
		if triangle {
			c.Way = append(c.Way, wing)
			c.Checks = append(c.Checks, rayCheck(wing, -rx, -ry, -1, 2))
		}
		if lap < laps {
			c.Way = append(c.Way, gate)
			c.Checks = append(c.Checks, lineCheck(gateL, gateR, 1, gateNumber))
		}
	}
	c.Way = append(c.Way, mid)
	c.Checks = append(c.Checks, lineCheck(c.FinishA, c.FinishB, 1, 0))
	finishCourse(c, k.Polar)
	return c
}

// layReach lays a reach in area a for boats k, n of them, in a wind of
// speed from from: a reach sailed alone has the shortest line.
func layReach(a *Area, k Kind, speed, from float64, n int) *bus.RaceCourse {
	us, uc := physics.SinCos(from)
	// u is up the wind, r to starboard looking up it: out to the mark. A
	// boat sailing out has the wind over her port side, and leaves the
	// mark to port by turning up through the wind.
	ux, uy, rx, ry := us, uc, uc, -us
	at := func(along, across float64) [2]float64 {
		return [2]float64{a.X + float64(along*ux) + float64(across*rx), a.Y + float64(along*uy) + float64(across*ry)}
	}
	l := k.Length
	halfLine := float64(lineLength(l, n) * 0.5)
	// The leg the area holds: the line's ends inside it, with room behind
	// the line for the boats placed there, a fleet's rows behind its ends
	// too.
	behind := float64(areaBehind * l)
	room := a.Radius - behind
	if ends := float64(a.Radius*a.Radius) - float64(halfLine*halfLine); ends > 0 {
		e := math.Sqrt(ends)
		if n > 1 {
			e -= behind
		}
		room = min(room, e)
	}
	most := max(float64(2*room), float64(legLeast*l))
	leg := float64(legLeast * l)
	if k.Polar != nil {
		// Out and back, each across the wind.
		if perMetre := float64(2 * k.Polar.LegTime(speed, math.Pi/2, 1)); perMetre > 0 && !math.IsInf(perMetre, 0) {
			leg = max(ReachSeconds/perMetre, leg)
		}
	}
	leg = min(leg, most)
	half := float64(leg * 0.5)
	mid, mark := at(0, -half), at(0, half)
	c := &bus.RaceCourse{
		Number: a.Number, Across: true, Laps: 1, Wind: speed, From: from,
		X: a.X, Y: a.Y, Reach: a.Radius,
		Committee: at(-halfLine, -half), Pin: at(halfLine, -half),
	}
	c.FinishA, c.FinishB = c.Pin, c.Committee
	c.Marks = append(c.Marks, bus.RaceMark{X: mark[0], Y: mark[1], Number: 1, Side: bus.MarkPort})
	c.Way = append(c.Way, mid, mark, mid)
	// Out over the line from its right to its left, round the mark by a
	// ray on from it, and home over the line the other way.
	c.Checks = append(c.Checks, lineCheck(c.Pin, c.Committee, -1, 0), rayCheck(mark, rx, ry, -1, 1), lineCheck(c.FinishA, c.FinishB, 1, 0))
	finishCourse(c, k.Polar)
	return c
}

// DashApart is how far up the wind of a Dash's start line's end its
// finish line's begins, in the boat's lengths: a variable only so that a
// test may measure how far is enough.
var DashApart = 8.0

// dashOff is how near the wind a Dash's way home may lie, rad, and an
// island race's first leg.
const dashOff = 70 * math.Pi / 180

// layDash lays a Dash in area a for boats k, n of them, sized to target s
// in a wind of speed from from.
func layDash(a *Area, k Kind, target, speed, from float64, n int) *bus.RaceCourse {
	us, uc := physics.SinCos(from)
	// u is up the wind, r to starboard looking up it: out to the mark, the
	// wind over the boats' port side, the mark left to port by a tack.
	ux, uy, rx, ry := us, uc, uc, -us
	l := k.Length
	halfLine := float64(lineLength(l, n) * 0.5)
	halfFinish := float64(lineLength(l, 1) * 0.5)
	// How far up the wind of the start line's middle the finish line's
	// middle lies, for a leg of leg: as far as it should, no further than
	// the way home keeps dashOff off the wind.
	ts, tc := physics.SinCos(math.Pi/2 - dashOff)
	upOf := func(leg float64) float64 {
		return min(float64(halfLine+float64(DashApart*l))+halfFinish, float64(leg*ts)/tc)
	}
	// The course's points, for a leg of leg, along and across the wind from
	// the start line's middle; and the middle of what they span, so the
	// course lies across the area's.
	behind := float64(areaBehind * l)
	fits := func(leg float64) (bool, float64, float64) {
		up := upOf(leg)
		lo, hi := -halfLine, float64(up+halfFinish)
		midAlong := float64((lo + hi) * 0.5)
		midAcross := float64((float64(-behind) + leg) * 0.5)
		for _, p := range [...][2]float64{{lo, -behind}, {hi, -behind}, {lo, 0}, {hi, 0}, {0, leg}} {
			da, dc := p[0]-midAlong, p[1]-midAcross
			if hypot(da, dc) > a.Radius {
				return false, midAlong, midAcross
			}
		}
		return true, midAlong, midAcross
	}
	leg := float64(legLeast * l)
	if k.Polar != nil {
		// Out and home, each across the wind, near enough.
		if perMetre := float64(2 * k.Polar.LegTime(speed, math.Pi/2, 1)); perMetre > 0 && !math.IsInf(perMetre, 0) {
			leg = max(target/perMetre, leg)
		}
	}
	// Cut to what the area holds, a twentieth at a time.
	for range 64 {
		if ok, _, _ := fits(leg); ok || leg <= float64(legLeast*l) {
			break
		}
		leg = max(float64(leg*0.95), float64(legLeast*l))
	}
	_, midAlong, midAcross := fits(leg)
	at := func(along, across float64) [2]float64 {
		along, across = along-midAlong, across-midAcross
		return [2]float64{a.X + float64(along*ux) + float64(across*rx), a.Y + float64(along*uy) + float64(across*ry)}
	}
	up := upOf(leg)
	start, mark, home := at(0, 0), at(0, leg), at(up, 0)
	c := &bus.RaceCourse{
		Number: a.Number, Across: true, Dash: true, Laps: 1, Wind: speed, From: from,
		X: a.X, Y: a.Y, Reach: a.Radius,
		Committee: at(-halfLine, 0), Pin: at(halfLine, 0),
		FinishA: at(float64(up+halfFinish), 0), FinishB: at(float64(up-halfFinish), 0),
	}
	c.Marks = append(c.Marks, bus.RaceMark{X: mark[0], Y: mark[1], Number: 1, Side: bus.MarkPort})
	c.Way = append(c.Way, start, mark, home)
	// Out over the start line from its right to its left, round the mark
	// by a ray on from it, and home over the finish line the other way.
	c.Checks = append(c.Checks, lineCheck(c.Pin, c.Committee, -1, 0), rayCheck(mark, rx, ry, -1, 1), lineCheck(c.FinishA, c.FinishB, 1, 0))
	finishCourse(c, k.Polar)
	return c
}

// lapTime is how long a lap of a buoy course takes a boat of polar p for
// each metre of its windward leg, s, in a wind of speed from from: up to
// the windward mark, then down, or across to the wing and down.
func lapTime(p *physics.Polar, triangle bool, speed, from float64) float64 {
	if p == nil {
		return 0
	}
	up := p.LegTime(speed, 0, 1)
	if !triangle {
		return up + p.LegTime(speed, math.Pi, 1)
	}
	// The windward mark is half a leg up of the middle, the wing half a
	// leg to port of it, the gate half a leg down: the reach out to the
	// wing and the broad reach back are each half a leg's square's
	// diagonal.
	us, uc := physics.SinCos(from)
	d := float64(0.5 * math.Sqrt2)
	out := p.LegTime(speed, from-bearing(-us-uc, -uc+us), d)
	back := p.LegTime(speed, from-bearing(-us+uc, -uc-us), d)
	return up + out + back
}

// wrap is an angle in [−π, π).
func wrap(a float64) float64 {
	for range 64 {
		switch {
		case a < -math.Pi:
			a += 2 * math.Pi
		case a >= math.Pi:
			a -= 2 * math.Pi
		default:
			return a
		}
	}
	return 0
}

// layIsland lays island course c's lines for boats k, n of them, in a wind
// of speed from from.
func layIsland(ic *Course, k Kind, speed, from float64, n int) *bus.RaceCourse {
	l := k.Length
	c := &bus.RaceCourse{Island: true, Number: ic.Number, Laps: 1, Wind: speed, From: from, X: ic.Start.X, Y: ic.Start.Y}
	way := ic.Way
	// The start: across the wind if the way leaves within 60° of up or
	// down it, else across the way out.
	ox, oy := unit(way[1][0]-way[0][0], way[1][1]-way[0][1])
	us, uc := physics.SinCos(from)
	if dot := float64(ox*us) + float64(oy*uc); math.Abs(dot) >= 0.5 {
		if dot > 0 {
			ox, oy = us, uc
		} else {
			ox, oy = -us, -uc
		}
	}
	h := min(float64(lineLength(l, n)*0.5), max(ic.Start.Room-float64(2*l), l))
	c.Pin, c.Committee = across(ic.Start.X, ic.Start.Y, ox, oy, h)
	last := len(way) - 1
	ix, iy := unit(way[last][0]-way[last-1][0], way[last][1]-way[last-1][1])
	hf := min(float64(lineLength(l, n)*0.5), max(ic.Finish.Room-float64(2*l), l))
	c.FinishA, c.FinishB = across(ic.Finish.X, ic.Finish.Y, ix, iy, hf)
	c.Way = append(c.Way, way...)
	c.Checks = append(c.Checks, lineCheck(c.Pin, c.Committee, -1, 0))
	for _, r := range ic.Rays {
		s, co := physics.SinCos(r.Bearing)
		ch := rayCheck([2]float64{r.X, r.Y}, s, co, r.Crossings, r.Mark)
		ch.Along = r.Along
		c.Checks = append(c.Checks, ch)
	}
	c.Checks = append(c.Checks, lineCheck(c.FinishA, c.FinishB, -1, 0))
	finishCourse(c, k.Polar)
	// Its reach: as far as its way goes from its start.
	for _, p := range way {
		c.Reach = max(c.Reach, hypot(p[0]-c.X, p[1]-c.Y))
	}
	return c
}

// across is a line through (x, y) square to the way (dx, dy), a unit,
// half h long each side: its port end, then its starboard end, looking
// along the way.
func across(x, y, dx, dy, h float64) ([2]float64, [2]float64) {
	// To starboard of (dx, dy) is (dy, −dx).
	return [2]float64{x - float64(h*dy), y + float64(h*dx)}, [2]float64{x + float64(h*dy), y - float64(h*dx)}
}

// unit is (x, y) made a unit, or north for none.
func unit(x, y float64) (float64, float64) {
	d := hypot(x, y)
	if !(d > 0) {
		return 0, 1
	}
	return x / d, y / d
}

// lineCheck is a line from a to b crossed want's way, the mark's.
func lineCheck(a, b [2]float64, want int8, mark int16) bus.RaceCheck {
	return bus.RaceCheck{Line: true, X: a[0], Y: a[1], X2: b[0], Y2: b[1], Want: want, Mark: mark}
}

// rayCheck is a ray from p toward (s, c) crossed want times, the mark's.
func rayCheck(p [2]float64, s, c float64, want int8, mark int16) bus.RaceCheck {
	return bus.RaceCheck{X: p[0], Y: p[1], S: s, C: c, Want: want, Mark: mark}
}

// finishCourse works out a course's way's length, where along it each
// check lies (a buoy course's at its way's points, in order; an island
// course's rays already know) and the way's point there, and how long the
// boat takes to sail it in the wind it was laid to.
func finishCourse(c *bus.RaceCourse, p *physics.Polar) {
	along := make([]float64, len(c.Way))
	for i := 1; i < len(c.Way); i++ {
		a, b := c.Way[i-1], c.Way[i]
		seg := hypot(b[0]-a[0], b[1]-a[1])
		along[i] = along[i-1] + seg
		if p != nil && seg > 0 {
			c.Expected += p.LegTime(c.Wind, c.From-bearing(b[0]-a[0], b[1]-a[1]), seg)
		}
	}
	c.Length = along[len(along)-1]
	last := len(c.Checks) - 1
	for i := range c.Checks {
		ch := &c.Checks[i]
		switch {
		case i == 0:
			ch.Along = 0
		case i == last:
			ch.Along = c.Length
		case !c.Island:
			ch.Along = along[min(i, len(along)-1)]
		}
		ch.AtX, ch.AtY = pointAlong(c.Way, along, ch.Along)
	}
	if math.IsInf(c.Expected, 0) || !(c.Expected > 0) {
		// No wind to sail it in: the time limit is the course's time at a
		// knot.
		c.Expected = c.Length / physics.Knot
	}
}

// pointAlong is the point d along a way whose points lie along[i] along it.
func pointAlong(way [][2]float64, along []float64, d float64) (float64, float64) {
	for i := 1; i < len(way); i++ {
		if d <= along[i] || i == len(way)-1 {
			seg := along[i] - along[i-1]
			t := 0.0
			if seg > 0 {
				t = min(max((d-along[i-1])/seg, 0), 1)
			}
			a, b := way[i-1], way[i]
			return a[0] + float64(t*(b[0]-a[0])), a[1] + float64(t*(b[1]-a[1]))
		}
	}
	return way[0][0], way[0][1]
}

// Spots are where a course's boats are placed, the best first: in rows
// behind its start line, three of the boat's lengths apart, as many to a
// row as fit two lengths clear across the line, each facing startOffWind
// off the wind on starboard tack, at rest; on a reach, each facing the
// mark. The simulation takes the first clear of land, shoal water and
// every other boat.
func Spots(c *bus.RaceCourse, length float64) []physics.State {
	px, py := c.Pin[0], c.Pin[1]
	cx, cy := c.Committee[0], c.Committee[1]
	mx, my := float64((px+cx)*0.5), float64((py+cy)*0.5)
	// Behind the line: to the right of pin → committee, the line's own
	// direction turned to starboard.
	lx, ly := unit(cx-px, cy-py)
	bx, by := ly, -lx
	lineLen := hypot(cx-px, cy-py)
	across := max(int(toInt32(lineLen/float64(rowBack*length)+0.01)), 1)
	heading := wrap(c.From - startOffWind)
	if c.Across && len(c.Way) > 1 {
		heading = bearing(c.Way[1][0]-c.Way[0][0], c.Way[1][1]-c.Way[0][1])
	}
	out := make([]physics.State, 0, rows*across)
	for row := 1; row <= rows; row++ {
		back := float64(float64(row*rowBack) * length)
		for j := range across {
			t := float64((float64(j)+0.5)/float64(across)) - 0.5
			off := float64(t * lineLen)
			out = append(out, physics.State{
				X: mx + float64(off*lx) + float64(back*bx), Y: my + float64(off*ly) + float64(back*by), Heading: heading,
			})
		}
	}
	return out
}

// Lot is the order in which call's entrants are placed: drawn by lot, a
// new draw for each race, the same for a race every time it is drawn.
func Lot(call *bus.RaceCall) []int {
	order := make([]int, len(call.Entrants))
	for i := range order {
		order[i] = i
	}
	// A seed from the race's own ID and run: splitmix64's steps.
	var seed uint64 = 0x9e3779b97f4a7c15
	for _, b := range call.ID {
		seed = mix(seed ^ uint64(b))
	}
	seed = mix(seed ^ uint64(uint32(call.Run)))
	for i := len(order) - 1; i > 0; i-- {
		seed = mix(seed)
		j := int(seed % uint64(i+1))
		order[i], order[j] = order[j], order[i]
	}
	return order
}

// mix is splitmix64's finaliser.
func mix(z uint64) uint64 {
	z += 0x9e3779b97f4a7c15
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	return z ^ (z >> 31)
}
