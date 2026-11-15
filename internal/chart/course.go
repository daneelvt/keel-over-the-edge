// SPDX-License-Identifier: AGPL-3.0-only

package chart

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// A course is one point a sailor sails for: anything charted, a race
// course's start, or a pin on open water. It is a bearing and a distance
// from the boat, never a steering order. Its point is where the charted
// thing is, or for an island the nearest of its land's bounds, so a large
// island is reached at its shore, not its middle; within a tenth of a mile
// of that point it is reached. The page's twin is
// client/src/chart/course.ts; both are held to testdata/courses.json.

// Arrive is how near its point a course is reached, m: a tenth of a mile
// as the page reckons it, inside the sight of every place and short of a
// reef.
var Arrive = tenthMile

// AimPoint is the point a course aims at from a boat at (east, north): its
// own point, or with bounds (west, south, east, north, m) an island's
// nearest.
func AimPoint(px, py float64, bounds *[4]float64, east, north float64) (x, y float64) {
	if bounds == nil {
		return px, py
	}
	return min(max(east, bounds[0]), bounds[2]), min(max(north, bounds[1]), bounds[3])
}

// CourseAim is a course from a boat at (east, north): the point aimed at,
// how far it is, m, and its bearing, rad clockwise from north.
func CourseAim(px, py float64, bounds *[4]float64, east, north float64) (x, y, distance, bearing float64) {
	x, y = AimPoint(px, py, bounds, east, north)
	dx, dy := x-east, y-north
	return x, y, math.Sqrt(float64(dx*dx) + float64(dy*dy)), physics.Atan2(dx, dy)
}

// Reached reports whether a course this far off, m, is reached.
func Reached(distance float64) bool { return distance <= Arrive }
