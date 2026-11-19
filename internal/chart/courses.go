// SPDX-License-Identifier: AGPL-3.0-only

package chart

import (
	"fmt"
	"math"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/sight"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// The island courses open by charting: a course opens once every island
// and place it names is charted, by anyone. Its opening is a candidate
// story of the day's news, written with the charting that opened it (the
// simulation's, as it is made, so that a course whose last two places are
// charted in one batch opens with the second); and it goes on the chart,
// to every connection, once what opened it is written. A course known
// from the world's start (all of it on Port Royal) is on the chart from
// the start, with no story.

// see marks subject i seen, and its courses one nearer opening; m.mu must
// be held.
func (m *Model) see(i int32) []int32 {
	if int(i) >= len(m.seen) || m.seen[i] {
		return nil
	}
	m.seen[i] = true
	var done []int32
	for _, k := range m.courseOf[i] {
		m.left[k]--
		if m.left[k] == 0 {
			done = append(done, k)
		}
	}
	return done
}

// opens are the courses the simulation's charting of subject i opens, as
// stories of the news.
func (m *Model) opens(i int32) []store.CourseOpen {
	m.mu.Lock()
	done := m.see(i)
	m.mu.Unlock()
	var out []store.CourseOpen
	for _, k := range done {
		c := &m.world.Courses[k]
		out = append(out, store.CourseOpen{Number: c.Number, Title: c.Name, What: courseWhat(c), X: c.Start.X, Y: c.Start.Y,
			Score: m.courseScore})
	}
	return out
}

// openCourses puts on the chart next every course subject i, just
// charted, completes; m.mu must be held.
func (m *Model) openCourses(i int32, next *Chart) {
	for _, k := range m.courseOf[i] {
		if m.opened[k] || !m.allCharted(k) {
			continue
		}
		m.opened[k] = true
		next.Courses = append(next.Courses, m.course(k))
		next.Open = append(next.Open, k)
	}
}

// allCharted reports whether every subject of course k is charted; m.mu
// must be held.
func (m *Model) allCharted(k int32) bool {
	for _, i := range m.world.CourseSubjects[k] {
		if !m.charted[i] {
			return false
		}
	}
	return true
}

// OpenCourses are the courses open as the chart stands, by their index in
// the world's.
func (m *Model) OpenCourses() []int32 { return m.cur.Load().Open }

// courseWhat is what a course is, as its story says: "a new course of
// 2.4 NM".
func courseWhat(c *worldgen.Course) string {
	return fmt.Sprintf("a new course of %.1f NM", c.Length/1852)
}

// courseKinds are the courses' kinds on the wire.
var courseKinds = map[string]pb.CourseKind{
	worldgen.CourseRound:   pb.CourseKind_COURSE_KIND_ROUND,
	worldgen.CourseTour:    pb.CourseKind_COURSE_KIND_TOUR,
	worldgen.CoursePassage: pb.CourseKind_COURSE_KIND_PASSAGE,
	worldgen.CourseLight:   pb.CourseKind_COURSE_KIND_LIGHT,
}

// course is course k as the wire carries it.
func (m *Model) course(k int32) *pb.Course {
	c := &m.world.Courses[k]
	out := &pb.Course{Number: uint32(c.Number), Kind: courseKinds[c.Kind], Name: c.Name, Length: uint32(math.Round(c.Length))}
	for _, p := range c.Way {
		out.Way = append(out.Way, int32(math.Round(p[0])), int32(math.Round(p[1])))
	}
	for _, r := range c.Rounds {
		round := &pb.CourseRound{Starboard: r.Starboard}
		switch {
		case r.Island >= 0:
			round.Subject, round.Number = pb.ChartSubject_CHART_SUBJECT_ISLAND, uint32(r.Island)
		case r.Place >= 0:
			round.Subject, round.Number = pb.ChartSubject_CHART_SUBJECT_PLACE, uint32(r.Place)
		}
		out.Rounds = append(out.Rounds, round)
	}
	for _, b := range c.Boats {
		if i := slices.Index(m.world.Boats, b.Boat); i >= 0 {
			out.Boats = append(out.Boats, &pb.CourseBoat{Kind: uint32(i), Seconds: uint32(math.Round(b.Expected))})
		}
	}
	return out
}

// subjectKind is a subject kind of the wire's, as the sight table's.
func subjectKind(s pb.ChartSubject) uint8 {
	switch s {
	case pb.ChartSubject_CHART_SUBJECT_PLACE:
		return sight.Place
	case pb.ChartSubject_CHART_SUBJECT_FEATURE:
		return sight.Feature
	}
	return sight.Island
}
