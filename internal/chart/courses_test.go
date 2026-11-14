// SPDX-License-Identifier: AGPL-3.0-only

package chart

import (
	"slices"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/sight"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// A course opens when the last of its places is charted: that charting
// makes its story, naming the course, and once written the course goes on
// the chart, with its way; never before. A charting by no boat opens a
// course on the chart but makes no story.
func TestCourseOpensOnCharting(t *testing.T) {
	b, cat := world1(t)
	w := Build(b, cat)
	k := -1
	for i, need := range w.CourseSubjects {
		if len(need) >= 2 && !slices.ContainsFunc(need, func(s int32) bool { return slices.Contains(w.Known, s) }) {
			k = i
			break
		}
	}
	if k < 0 {
		t.Fatal("no course of two places or more, none known from the start")
	}
	course := &w.Courses[k]
	for _, credited := range []bool{true, false} {
		m := NewModel(w, cat, nil)
		need := w.CourseSubjects[k]
		for n, s := range need {
			c := &bus.Charted{Subject: s, With: -1, Slot: -1}
			if credited {
				c.Slot, c.Boat, c.Owner = 0, 7, bus.Account{1}
			}
			row := m.Charting(c)
			last := n == len(need)-1
			opened := slices.ContainsFunc(row.Opens, func(o store.CourseOpen) bool { return o.Number == course.Number })
			if opened != (last && credited) {
				t.Errorf("credited %v: charting %d of %d opens %v", credited, n+1, len(need), row.Opens)
			}
			if opened {
				o := row.Opens[0]
				if o.Title != course.Name || o.What == "" || o.Score <= 0 {
					t.Errorf("the story: %+v", o)
				}
			}
			on := len(m.Courses())
			m.Add([]store.Charting{row})
			if !last && len(m.Courses()) != on {
				t.Errorf("credited %v: a course on the chart with %d of its %d places charted", credited, n+1, len(need))
			}
		}
		i := slices.IndexFunc(m.Courses(), func(c *pb.Course) bool { return c.Number == uint32(course.Number) })
		if i < 0 {
			t.Fatalf("credited %v: %s is not on the chart", credited, course.Name)
		}
		c := m.Courses()[i]
		if c.Name != course.Name || len(c.Way) != 2*len(course.Way) || len(c.Boats) != len(course.Boats) || c.Kind == pb.CourseKind_COURSE_KIND_UNSPECIFIED {
			t.Errorf("credited %v: on the wire %+v", credited, c)
		}
		if !slices.Contains(m.OpenCourses(), int32(k)) {
			t.Errorf("credited %v: open %v", credited, m.OpenCourses())
		}
	}
}

// A beacon is charted with the reef or bar it marks, never sighted alone.
func TestBeaconChartedWithItsHazard(t *testing.T) {
	b, cat := world1(t)
	w := Build(b, cat)
	found := 0
	for i, s := range w.Subjects {
		if s.Kind != sight.Place || cat.World.Places.Kinds[s.Sort].Site != catalog.SiteBeacon {
			continue
		}
		found++
		if s.Seen != sight.Hidden || s.With <= 0 {
			t.Errorf("beacon %s: seen %d, with %d", s.Name, s.Seen, s.With)
			continue
		}
		if !slices.Contains(w.Table.With(s.With-1), int32(i)) {
			t.Errorf("beacon %s is not charted with %s", s.Name, w.Subjects[s.With-1].Name)
		}
	}
	if found == 0 {
		t.Skip("seed 1 has no beacon")
	}
}
