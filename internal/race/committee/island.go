// SPDX-License-Identifier: AGPL-3.0-only

package committee

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// An island race from Port Royal starts where the wind is kind: no race
// should open with a beat. At its warning signal the committee looks for a
// start whose first leg, from the start to where the way first crosses a
// rounding ray, lies no closer to the wind than dashOff: the course as it
// was made; the same course the other way round, if it is a loop; then the
// line moved along the course's way, and along its way back for a loop, to
// each of the starts found for it as the stage was set (MoveStarts): every
// startStep along the way before its first rounding, within the port's
// reach, out of its harbour and clear of its mouth, with room for the
// line. The first that fits is laid, its length and expected time worked
// out again. If none fits, the race is laid as made and marked upwind
// (bus.RaceCourse.Upwind), for its sign: it starts upwind today. A course
// that starts off another port is laid as made, marked upwind when it is.
// A trial's run is laid as made, unmarked: a trial's course does not move.

// Port is the port island races are started about: Port Royal's centre, m
// east and north of the world's; how far from it a start may be moved,
// m; its harbour, which a start never enters; and how far from the
// harbour's mouth a start keeps, m.
type Port struct {
	X, Y, Within float64
	Harbour      *physics.Harbour
	Mouth        float64
}

// startStep is how far apart along an island course's way the starts it
// may be moved to lie, m; startClear how far short of its first rounding
// the last of them lies, m.
const (
	startStep  = 50
	startClear = 200
)

// MoveStarts finds the starts each of the stage's island courses that
// starts off the port (Home) may be moved to, along its way and, for a
// loop, along its way back: every startStep, before its first rounding,
// within the port's reach, out of its harbour and its mouth's water, with
// room m of water deep(x, y) about it.
func (s *Stage) MoveStarts(port Port, room float64, deep func(x, y float64) bool) {
	for i := range s.Courses {
		c := &s.Courses[i]
		if !c.Home || len(c.Way) < 2 {
			continue
		}
		c.Starts = startsAlong(c, port, room, deep)
		if c.Loop {
			c.BackStarts = startsAlong(reversed(c), port, room, deep)
		}
	}
}

// startsAlong are the starts course c may be moved to, in order along its
// way.
func startsAlong(c *Course, port Port, room float64, deep func(x, y float64) bool) []Site {
	along := alongs(c.Way)
	last := float64(along[len(along)-1] - startClear)
	if len(c.Rays) > 0 {
		last = min(last, float64(c.Rays[0].Along-startClear))
	}
	var out []Site
	for d := float64(startStep); d <= last; d += startStep {
		x, y := pointAlong(c.Way, along, d)
		if hypot(x-port.X, y-port.Y) > port.Within {
			break
		}
		if port.Harbour != nil && physics.InHarbour(port.Harbour, x, y) ||
			port.Harbour != nil && hypot(x-port.Harbour.MouthX, y-port.Harbour.MouthY) < port.Mouth {
			continue
		}
		if !roomAbout(x, y, room, deep) {
			continue
		}
		out = append(out, Site{X: x, Y: y, Room: room, Along: d})
	}
	return out
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

// moved is island course c with its start moved along its way to st: the
// way from there on, the roundings as they were.
func moved(c *Course, st Site) *Course {
	along := alongs(c.Way)
	out := &Course{Number: c.Number, Start: st, Finish: c.Finish, Home: c.Home, Loop: c.Loop,
		Length: max(float64(c.Length-st.Along), 0), Way: [][2]float64{{st.X, st.Y}}}
	for i, p := range c.Way {
		if along[i] > st.Along {
			out.Way = append(out.Way, p)
		}
	}
	for _, r := range c.Rays {
		r.Along = max(float64(r.Along-st.Along), 0)
		out.Rays = append(out.Rays, r)
	}
	return out
}

// upwindStart reports whether island course c's first leg, from its start
// to where its way first crosses a rounding ray (or to its finish, with
// none), lies closer than dashOff to a wind from from.
func upwindStart(c *Course, from float64) bool {
	if len(c.Way) < 2 {
		return false
	}
	along := alongs(c.Way)
	first := along[len(along)-1]
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
	tries := []*Course{}
	var back *Course
	if c.Loop {
		back = reversed(c)
		tries = append(tries, back)
	}
	for _, st := range c.Starts {
		tries = append(tries, moved(c, st))
	}
	if back != nil {
		for _, st := range c.BackStarts {
			tries = append(tries, moved(back, st))
		}
	}
	for _, t := range tries {
		if !upwindStart(t, from) {
			return t, false
		}
	}
	return c, true
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
