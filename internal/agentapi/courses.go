// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"cmp"
	"fmt"
	"math"
	"slices"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sight"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// The chart's racing: the racing areas off Port Royal, where a buoy course
// is laid to the wind as each race begins, open from the world's start;
// and the island courses, each open once every place it names is charted,
// with where its start lies, its length, what it rounds and to which side,
// and the boats it suits with their expected times.

// groupCourses is chart's group of the racing areas and the courses.
const groupCourses = "courses"

// courseList is the chart's racing areas and its open courses, nearest
// first, at most limit courses: from the boat at (x, y) if at sea, else by
// position.
func (s *Sea) courseList(x, y float64, atSea bool, limit int) string {
	if s.Chart == nil {
		return ""
	}
	w := s.Chart.World()
	where := func(px, py float64) string {
		if !atSea {
			return chart.Format(px, py)
		}
		dx, dy := px-x, py-y
		return chart.BearingText(physics.Atan2(dx, dy)) + " " + chart.DistanceText(math.Sqrt(dx*dx+dy*dy))
	}
	var b strings.Builder
	if len(w.Areas) > 0 {
		fmt.Fprintf(&b, "Racing areas off Port Royal, where a buoy course is laid to the wind as each race begins (%d):\n", len(w.Areas))
		for _, a := range w.Areas {
			fmt.Fprintf(&b, " Area %d · %s · %s across\n", a.Number+1, where(a.X, a.Y), chart.DistanceText(2*a.Radius))
		}
	}
	open := s.Chart.OpenCourses()
	type line struct {
		c *worldgen.Course
		d float64
	}
	lines := make([]line, 0, len(open))
	for _, k := range open {
		c := &w.Courses[k]
		lines = append(lines, line{c, math.Hypot(c.Start.X-x, c.Start.Y-y)})
	}
	slices.SortStableFunc(lines, func(p, q line) int { return cmp.Compare(p.d, q.d) })
	fmt.Fprintf(&b, "Island courses open for racing (%d of the world's %d):\n", len(open), len(w.Courses))
	if len(open) == 0 {
		b.WriteString(" none yet: an island course opens once every place it names is charted.\n")
	}
	for _, l := range lines[:min(len(lines), limit)] {
		c := l.c
		fmt.Fprintf(&b, " %s · start %s · %s", c.Name, where(c.Start.X, c.Start.Y), chart.DistanceText(c.Length))
		if c.Finish.Town != c.Start.Town {
			fmt.Fprintf(&b, " to a finish %s", where(c.Finish.X, c.Finish.Y))
		}
		if r := s.roundsWords(w, c); r != "" {
			b.WriteString(", leaving " + r)
		}
		b.WriteString(" · " + s.boatsWords(c) + "\n")
	}
	if len(lines) > limit {
		fmt.Fprintf(&b, " and %d more: ask with group courses and a larger limit\n", len(lines)-limit)
	}
	return b.String()
}

// roundsWords are what a course rounds, each to its side: "Gannet Holm to
// starboard, Salmon Reef Beacon to port".
func (s *Sea) roundsWords(w *chart.World, c *worldgen.Course) string {
	var parts []string
	for _, r := range c.Rounds {
		i := int32(-1)
		switch {
		case r.Island >= 0:
			i = w.Index(sight.Island, r.Island)
		case r.Place >= 0:
			i = w.Index(sight.Place, r.Place)
		}
		if i < 0 {
			continue
		}
		side := "port"
		if r.Starboard {
			side = "starboard"
		}
		parts = append(parts, titleOf(&w.Subjects[i])+" to "+side)
	}
	return strings.Join(parts, ", ")
}

// boatsWords are the boats a course suits, each with its expected time in
// the typical wind: "Jolly boat about 37 min, Skiff about 26 min".
func (s *Sea) boatsWords(c *worldgen.Course) string {
	var parts []string
	for _, cb := range c.Boats {
		name := cb.Boat
		if s.Catalog != nil {
			for _, k := range s.Catalog.Boats {
				if string(k.ID) == cb.Boat {
					name = k.Name
				}
			}
		}
		parts = append(parts, fmt.Sprintf("%s about %.0f min", name, math.Round(cb.Expected/60)))
	}
	return strings.Join(parts, ", ")
}
