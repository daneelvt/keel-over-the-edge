// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"fmt"
	"math"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sight"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// A machine sailor's course: one point it sails for, set with the course
// tool as a person sets one on the chart: a charted place by its name, an
// open race course's start by the course's name, or a position for a pin;
// never a boat. Setting one replaces the last, and clear clears it. It is
// a bearing and a distance, never a steering order: observe tells it at
// every look, "Course: Gull Rock 045° 1.2 NM", and within a tenth of a
// mile of its point (an island's nearest bounds, as on the phone) it is
// reached: an event says so, ends a wait on course, and the course clears.
// It is kept in memory with the machine sailor's account for the world it
// was set in, so a helm forgotten while idle keeps it; keel's restart or a
// new world loses it, and observe then tells no course. While its boat
// races, the race's own lines point to the next mark, and the course is
// neither told nor reached, as on the phone.

// course is a course set: the world it was set in, its names, its point,
// m, and an island's bounds, nil for a point; a pin's position is told
// with it.
type course struct {
	sea *Sea
	// name is how observe names it, reached how its arrival does: "Start
	// of Round Gull Rock", "the start of Round Gull Rock".
	name, reached string
	x, y          float64
	bounds        *[4]float64
	pin           bool
}

// courseArgs are course's.
type courseArgs struct {
	Place    string `json:"place,omitempty"`
	Position string `json:"position,omitempty"`
	Clear    bool   `json:"clear,omitempty"`
}

// courseFacts are the course in a report: its name, its bearing from the
// boat and its distance to a tenth of a mile; a pin's position.
type courseFacts struct {
	Name     string  `json:"name"`
	Bearing  int     `json:"bearing"`
	NM       float64 `json:"nm"`
	Position string  `json:"position,omitempty"`
}

// courseOf is the machine sailor's course in world s, nil for none: one
// set in another world is let go.
func (c *Core) courseOf(id store.AccountID, s *Sea) *course {
	c.coursesMu.Lock()
	defer c.coursesMu.Unlock()
	k := c.courses[id]
	if k != nil && k.sea != s {
		delete(c.courses, id)
		return nil
	}
	return k
}

// setCourse sets the machine sailor's course, nil clearing it.
func (c *Core) setCourse(id store.AccountID, k *course) {
	c.coursesMu.Lock()
	defer c.coursesMu.Unlock()
	if k == nil {
		delete(c.courses, id)
		return
	}
	if c.courses == nil {
		c.courses = map[store.AccountID]*course{}
	}
	c.courses[id] = k
}

// reachedCourse clears the machine sailor's course k, reached, unless
// another has been set since; whether it cleared it.
func (c *Core) reachedCourse(id store.AccountID, k *course) bool {
	c.coursesMu.Lock()
	defer c.coursesMu.Unlock()
	if c.courses[id] != k {
		return false
	}
	delete(c.courses, id)
	return true
}

// forgetCourses lets every course go: a new world opens.
func (c *Core) forgetCourses() {
	c.coursesMu.Lock()
	clear(c.courses)
	c.coursesMu.Unlock()
}

// aim is the course from a boat at (x, y): the point aimed at's distance,
// m, and bearing, rad.
func (k *course) aim(x, y float64) (distance, bearing float64) {
	_, _, distance, bearing = chart.CourseAim(k.x, k.y, k.bounds, x, y)
	return distance, bearing
}

// facts are the course from a boat at (x, y), as a report tells it.
func (k *course) facts(x, y float64) *courseFacts {
	d, b := k.aim(x, y)
	out := &courseFacts{Name: k.name, Bearing: degrees(b), NM: math.Floor(d/nm*10+0.5) / 10}
	if k.pin {
		out.Position = chart.Format(k.x, k.y)
	}
	return out
}

// text is the report's line: "Gull Rock 045° 1.2 NM".
func (f *courseFacts) text() string {
	line := fmt.Sprintf("%s %s %.1f NM", f.Name, three(f.Bearing), f.NM)
	if f.Position != "" {
		line += " · at " + f.Position
	}
	return line
}

// where is the course as set, for a boat not at sea: "Gull Rock, at
// 67°24′N 045°12′".
func (k *course) where() string {
	return k.name + ", at " + chart.Format(k.x, k.y)
}

// same reports whether two courses name the one point.
func (k *course) same(o *course) bool {
	return o != nil && k.name == o.name && k.x == o.x && k.y == o.y
}

// racing reports whether the boat in slot sl of f races, on the line or
// under way, for account: the race's lines point to its next mark then.
func racing(f *bus.Frame, sl int32, account bus.Account) bool {
	ri, j := racerAt(f, sl, account)
	if ri < 0 || f.Races[ri].Phase == bus.RaceEnded {
		return false
	}
	switch f.Racers[j].State {
	case bus.RacerDNS, bus.RacerRetired, bus.RacerFinished:
		return false
	}
	return true
}

// courseFor is the course a report of the helm's boat in slot sl tells,
// nil for none or while it races. With mu held.
func (h *helm) courseFor(s *Sea, f *bus.Frame, sl int32) *courseFacts {
	k := h.core.courseOf(h.account, s)
	if k == nil || racing(f, sl, bus.Account(h.account)) {
		return nil
	}
	st := &f.State[sl]
	return k.facts(st.X, st.Y)
}

// arrival is the event of the helm's boat in slot sl reaching its course,
// which it clears; nil if it has not. With mu held.
func (h *helm) arrival(s *Sea, f *bus.Frame, sl int32) *event {
	k := h.core.courseOf(h.account, s)
	if k == nil {
		return nil
	}
	st := &f.State[sl]
	if d, _ := k.aim(st.X, st.Y); !chart.Reached(d) || racing(f, sl, bus.Account(h.account)) {
		return nil
	}
	if !h.core.reachedCourse(h.account, k) {
		return nil
	}
	return &event{Tick: f.Tick, Kind: evCourse, Words: "you've reached " + k.reached + ": the course is cleared"}
}

// courseUsage says what course takes.
const courseUsage = "course takes place, a charted place or an open course's name for its start; or position, as 67°24′N 045°12′, for a pin; or clear."

// setCourseOf answers course: the course set, cleared, or with nothing
// given, told.
func (c *Core) setCourseOf(h *helm, o *courseArgs) (string, *refusal) {
	given := 0
	for _, g := range []bool{o.Place != "", o.Position != "", o.Clear} {
		if g {
			given++
		}
	}
	if given > 1 {
		return "", refuse(refusedArgs, "Give one of place, position or clear: "+courseUsage)
	}
	s, x, y, atSea := c.where(h)
	if s == nil {
		return "", refuse(refusedNoWorld, wordsNoWorld)
	}
	old := c.courseOf(h.account, s)
	told := func(k *course) string {
		if !atSea {
			return k.where()
		}
		return k.facts(x, y).text()
	}
	switch {
	case o.Clear:
		if old == nil {
			return "No course was set: nothing to clear.", nil
		}
		c.setCourse(h.account, nil)
		return "Course cleared: it was " + old.name + ".", nil
	case given == 0:
		if old == nil {
			return "No course set. " + courseUsage, nil
		}
		return "Your course: " + told(old) + ".", nil
	}
	k, r := courseTo(s, o, x, y, atSea)
	if r != nil {
		return "", r
	}
	if k.same(old) {
		return "Your course is " + told(k) + " already.", nil
	}
	if atSea {
		if d, _ := k.aim(x, y); chart.Reached(d) {
			words := "You are at " + k.name + " already, within 0.1 NM: no course set."
			if old != nil {
				words += " Your course is still " + told(old) + "."
			}
			return words, nil
		}
	}
	c.setCourse(h.account, k)
	words := "Course set: " + told(k)
	if old != nil {
		words += " (it replaces " + old.name + ")"
	}
	if !atSea {
		return words + ". Once you are at sea, observe tells its bearing and distance at every look, and wakes you on arrival, within 0.1 NM.", nil
	}
	return words + ". A bearing, never a steering order: steer for it, tacking if it is upwind. observe tells it at every look, and wakes you on arrival, within 0.1 NM.", nil
}

// courseTo is the course o names in world s, from a boat at (x, y) if at
// sea, or a refusal that says what to send.
func courseTo(s *Sea, o *courseArgs, x, y float64, atSea bool) (*course, *refusal) {
	if o.Position != "" {
		east, north, err := chart.ParsePosition(o.Position)
		if err != nil {
			return nil, refuse(refusedArgs, fmt.Sprintf("Not a position, %q: %s. %s", o.Position, err, courseUsage))
		}
		if p := s.Timeline.Prepared(); p != nil && physics.EdgeDistance(p, east, north) < 0 {
			return nil, refuse(refusedArgs, fmt.Sprintf("%s is beyond the edge, past the lip of the falls, %.1f NM from the pole: give a position on the disk.",
				chart.Format(east, north), p.Edge()/nm))
		}
		return &course{sea: s, name: "your pin", reached: "your pin", x: east, y: north, pin: true}, nil
	}
	entries := charted(s)
	if e, ok := placeNamed(entries, o.Place); ok {
		k := &course{sea: s, name: titleOf(e.sub), reached: titleOf(e.sub), x: e.sub.X, y: e.sub.Y}
		if e.sub.Kind == sight.Island {
			b := e.sub.Bounds
			k.bounds = &b
		}
		return k, nil
	}
	if s.Chart != nil {
		w := s.Chart.World()
		want := strings.TrimPrefix(fold(o.Place), "startof")
		for _, i := range s.Chart.OpenCourses() {
			if rc := &w.Courses[i]; fold(rc.Name) == want {
				return &course{sea: s, name: "Start of " + rc.Name, reached: "the start of " + rc.Name, x: rc.Start.X, y: rc.Start.Y}, nil
			}
		}
	}
	words := fmt.Sprintf("No charted place or open course called %q.", o.Place)
	if near := nearestNames(entries, o.Place, x, y, atSea); near != "" {
		words += " Did you mean " + near + "?"
	}
	return nil, refuse(refusedPlace, words+" Uncharted places have no names yet: chart lists the charted ones, and with group courses the open courses.")
}
