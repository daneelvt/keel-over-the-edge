// SPDX-License-Identifier: AGPL-3.0-only

package committee

import (
	"cmp"
	"math"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// An island race from Port Royal starts where the wind is kind: no race
// should open with a beat. At its warning signal the committee looks for a
// start whose first leg, the way's first firstLeg from the start (or less,
// to where it first crosses a rounding ray), lies no closer to the wind
// than dashOff: the course as it was made; the same course the other way
// round, if it is a loop; then the line moved to one of the start sites
// found for it as the stage was set (MoveStarts), each near Port Royal
// with a straight, clear first leg to a point of the course's way before
// its first rounding, the way on from there, the nearest the course's
// own length first; and so along its way back, for a loop. The first that
// fits is laid, its length and expected time worked out again. If none
// fits, the race is laid as made and marked upwind (bus.RaceCourse.Upwind),
// for its sign: it starts upwind today. A course that starts off another
// port is laid as made, marked upwind when it is. A trial's run is laid as
// made, unmarked: a trial's course does not move.

// Port is the port island races are started about: Port Royal's centre, m
// east and north of the world's; how far from it a start may be moved,
// m; its harbour, which a start never enters; how far from the harbour's
// mouth a start keeps, m; and the places new boats start from, which a
// start keeps Fan m from.
type Port struct {
	X, Y, Within float64
	Harbour      *physics.Harbour
	Mouth        float64
	Fan          float64
	Starts       [][2]float64
}

// Move is a start an island race may be moved to: its site, and how far
// along the course's way the point lies that its first leg runs straight
// to, m.
type Move struct {
	Site  Site
	Along float64
}

// The starts an island race may be moved to: sites every siteStep across
// the port's reach, joining the way at every joinStep along it, at least
// joinLeast on and joinClear short of its first rounding; a first leg
// looked along every clearStep for water as deep as the way keeps, m.
// firstLeg is how much of the way from the start is its first leg, m: what
// the boats sail away from the line on.
const (
	siteStep  = 150
	joinStep  = 150
	joinLeast = 150
	joinClear = 200
	clearStep = 20
	firstLeg  = 500
)

// MoveStarts finds the starts each of the stage's island courses that
// starts off the port (Home) may be moved to, onto its way and, for a
// loop, onto its way back: sites within the port's reach, out of its
// harbour and clear of its mouth and of where new boats start, with room
// m of water deep(x, y) about them, from which a straight first leg of
// deep water joins the way before its first rounding; the nearest the
// course's own length first.
func (s *Stage) MoveStarts(port Port, room float64, deep func(x, y float64) bool) {
	var sites []Site
	n := int(math.Floor(port.Within / siteStep))
	for j := -n; j <= n; j++ {
		for i := -n; i <= n; i++ {
			x, y := port.X+float64(float64(i)*siteStep), port.Y+float64(float64(j)*siteStep)
			if hypot(x-port.X, y-port.Y) > port.Within || !port.open(x, y) || !roomAbout(x, y, room, deep) {
				continue
			}
			sites = append(sites, Site{X: x, Y: y, Room: room})
		}
	}
	for i := range s.Courses {
		c := &s.Courses[i]
		if !c.Home || len(c.Way) < 2 {
			continue
		}
		c.Moves = movesOnto(c, sites, deep)
		if c.Loop {
			c.BackMoves = movesOnto(reversed(c), sites, deep)
		}
	}
}

// open reports whether (x, y) is water a start may be moved to: out of the
// port's harbour, clear of its mouth and of where new boats start.
func (p *Port) open(x, y float64) bool {
	if h := p.Harbour; h != nil && (physics.InHarbour(h, x, y) || hypot(x-h.MouthX, y-h.MouthY) < p.Mouth) {
		return false
	}
	for _, q := range p.Starts {
		if hypot(x-q[0], y-q[1]) < p.Fan {
			return false
		}
	}
	return true
}

// movesOnto are the moves of course c's start to each of sites joining its
// way where a straight leg of deep water reaches it, the least added to
// the course's length first.
func movesOnto(c *Course, sites []Site, deep func(x, y float64) bool) []Move {
	along := alongs(c.Way)
	last := float64(along[len(along)-1] - joinClear)
	if len(c.Rays) > 0 {
		last = min(last, float64(c.Rays[0].Along-joinClear))
	}
	type move struct {
		Move
		added float64
	}
	var out []move
	for d := float64(joinLeast); d <= last; d += joinStep {
		jx, jy := pointAlong(c.Way, along, d)
		for _, st := range sites {
			leg := hypot(jx-st.X, jy-st.Y)
			if leg < joinLeast || !clearLeg(st.X, st.Y, jx, jy, deep) {
				continue
			}
			out = append(out, move{Move{Site: st, Along: d}, float64(leg - d)})
		}
	}
	slices.SortStableFunc(out, func(a, b move) int { return cmp.Compare(a.added, b.added) })
	moves := make([]Move, len(out))
	for i := range out {
		moves[i] = out[i].Move
	}
	return moves
}

// clearLeg reports whether the straight leg from (ax, ay) to (bx, by) is
// deep water all the way, looked at every clearStep.
func clearLeg(ax, ay, bx, by float64, deep func(x, y float64) bool) bool {
	d := hypot(bx-ax, by-ay)
	n := max(int(math.Ceil(d/clearStep)), 1)
	for k := 0; k <= n; k++ {
		t := float64(k) / float64(n)
		if !deep(ax+float64(t*(bx-ax)), ay+float64(t*(by-ay))) {
			return false
		}
	}
	return true
}

// roomAbout reports whether the water about (x, y) is deep out to room m,
// looked at every roomStep out on roomBearings bearings.
func roomAbout(x, y, room float64, deep func(x, y float64) bool) bool {
	if !deep(x, y) {
		return false
	}
	for r := float64(roomStep); r <= room; r += roomStep {
		for k := range roomBearings {
			s, c := physics.SinCos(float64(float64(k) * (2 * math.Pi / roomBearings)))
			if !deep(x+float64(r*s), y+float64(r*c)) {
				return false
			}
		}
	}
	return true
}

// The room about a start is looked at this far apart, m, on this many
// bearings.
const (
	roomStep     = 20
	roomBearings = 16
)

// alongs are how far along way each of its points lies, m.
func alongs(way [][2]float64) []float64 {
	out := make([]float64, len(way))
	for i := 1; i < len(way); i++ {
		a, b := way[i-1], way[i]
		out[i] = out[i-1] + hypot(b[0]-a[0], b[1]-a[1])
	}
	return out
}

// reversed is island course c sailed the other way round: from its finish
// to its start, each rounding ray crossed the other way, in the other
// order, its marks numbered afresh from the new start.
func reversed(c *Course) *Course {
	n := len(c.Way)
	out := &Course{Number: c.Number, Start: c.Finish, Finish: c.Start, Length: c.Length, Home: c.Home, Loop: c.Loop,
		Way: make([][2]float64, n)}
	for i, p := range c.Way {
		out.Way[n-1-i] = p
	}
	most := int16(0)
	for _, r := range c.Rays {
		most = max(most, r.Mark)
	}
	length := alongs(c.Way)[n-1]
	for i := len(c.Rays) - 1; i >= 0; i-- {
		r := c.Rays[i]
		r.Crossings, r.Along = -r.Crossings, max(float64(length-r.Along), 0)
		if r.Mark > 0 {
			r.Mark = most + 1 - r.Mark
		}
		out.Rays = append(out.Rays, r)
	}
	return out
}

// moved is island course c with its start moved to m: a straight first
// leg from its site to its way's point m.Along on, the way on from there,
// the roundings as they were.
func moved(c *Course, m Move) *Course {
	along := alongs(c.Way)
	jx, jy := pointAlong(c.Way, along, m.Along)
	leg := hypot(jx-m.Site.X, jy-m.Site.Y)
	out := &Course{Number: c.Number, Start: m.Site, Finish: c.Finish, Home: c.Home, Loop: c.Loop,
		Length: max(float64(c.Length-m.Along)+leg, 0), Way: [][2]float64{{m.Site.X, m.Site.Y}, {jx, jy}}}
	for i, p := range c.Way {
		if along[i] > m.Along {
			out.Way = append(out.Way, p)
		}
	}
	for _, r := range c.Rays {
		r.Along = max(float64(r.Along-m.Along)+leg, 0)
		out.Rays = append(out.Rays, r)
	}
	return out
}

// upwindStart reports whether island course c's first leg, its way's
// first firstLeg from its start (to where it first crosses a rounding ray,
// or its finish, if sooner), lies closer than dashOff to a wind from from.
func upwindStart(c *Course, from float64) bool {
	if len(c.Way) < 2 {
		return false
	}
	along := alongs(c.Way)
	first := min(along[len(along)-1], firstLeg)
	if len(c.Rays) > 0 {
		first = min(first, max(c.Rays[0].Along, 1))
	}
	x, y := pointAlong(c.Way, along, first)
	dx, dy := x-c.Way[0][0], y-c.Way[0][1]
	if !(hypot(dx, dy) > 0) {
		return false
	}
	return math.Abs(wrap(bearing(dx, dy)-from)) < dashOff
}

// islandStart is the island course a race on c is laid on in a wind from
// from: as made, the other way round, or its start moved, the first whose
// first leg is no beat; and whether it starts upwind all the same.
func islandStart(c *Course, from float64) (*Course, bool) {
	if !upwindStart(c, from) {
		return c, false
	}
	if !c.Home {
		return c, true
	}
	var back *Course
	if c.Loop {
		back = reversed(c)
		if !upwindStart(back, from) {
			return back, false
		}
	}
	for _, try := range [...]struct {
		c     *Course
		moves []Move
	}{{c, c.Moves}, {back, c.BackMoves}} {
		if try.c == nil || len(try.moves) == 0 {
			continue
		}
		along := alongs(try.c.Way)
		for _, m := range try.moves {
			if !moveUpwind(try.c, along, m, from) {
				return moved(try.c, m), false
			}
		}
	}
	return c, true
}

// moveUpwind reports whether course c, its way's points along[i] along
// it, moved to m would start upwind in a wind from from: upwindStart of
// moved(c, m), worked out without making it.
func moveUpwind(c *Course, along []float64, m Move, from float64) bool {
	jx, jy := pointAlong(c.Way, along, m.Along)
	leg := hypot(jx-m.Site.X, jy-m.Site.Y)
	first := min(float64(along[len(along)-1]-m.Along)+leg, firstLeg)
	if len(c.Rays) > 0 {
		first = min(first, max(float64(c.Rays[0].Along-m.Along)+leg, 1))
	}
	x, y := jx, jy
	if first < leg {
		t := first / leg
		x, y = m.Site.X+float64(t*(jx-m.Site.X)), m.Site.Y+float64(t*(jy-m.Site.Y))
	} else {
		x, y = pointAlong(c.Way, along, float64(m.Along+first)-leg)
	}
	dx, dy := x-m.Site.X, y-m.Site.Y
	if !(hypot(dx, dy) > 0) {
		return false
	}
	return math.Abs(wrap(bearing(dx, dy)-from)) < dashOff
}

// CourseStart is where the island course of a number starts as made, m
// east and north: false for a course the stage does not have.
func (s *Stage) CourseStart(number int32) (x, y float64, ok bool) {
	c := s.course(number)
	if c == nil {
		return 0, 0, false
	}
	return c.Start.X, c.Start.Y, true
}

// StartsUpwind reports whether a race on the island course of a number,
// laid in a wind from from, rad, would start upwind: every start the
// committee tries for it closer to the wind than dashOff. False for a
// course the stage does not have.
func (s *Stage) StartsUpwind(number int32, from float64) bool {
	c := s.course(number)
	if c == nil || len(c.Way) < 2 {
		return false
	}
	_, up := islandStart(c, from)
	return up
}
