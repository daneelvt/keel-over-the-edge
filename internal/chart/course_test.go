// SPDX-License-Identifier: AGPL-3.0-only

package chart

import (
	"encoding/json"
	"math"
	"os"
	"reflect"
	"testing"
)

// coursesFile holds the cases both the server's course and the page's are
// held to: a boat, a course's point and an island's bounds, and where the
// course aims, how far, its bearing and whether it is reached.
const coursesFile = "testdata/courses.json"

type coursesData struct {
	Comment string       `json:"comment"`
	Cases   []courseCase `json:"cases"`
}

type courseCase struct {
	Name     string      `json:"name"`
	East     float64     `json:"east"`
	North    float64     `json:"north"`
	PointE   float64     `json:"pointEast"`
	PointN   float64     `json:"pointNorth"`
	Bounds   *[4]float64 `json:"bounds"`
	AimE     float64     `json:"aimEast"`
	AimN     float64     `json:"aimNorth"`
	Distance float64     `json:"distance"`
	Bearing  string      `json:"bearing"`
	Reached  bool        `json:"reached"`
}

func (c *courseCase) aim() {
	var b float64
	c.AimE, c.AimN, c.Distance, b = CourseAim(c.PointE, c.PointN, c.Bounds, c.East, c.North)
	c.Bearing = BearingText(b)
	c.Reached = Reached(c.Distance)
}

// courseCases are a boat about a point and an island: far off, either
// side of a tenth of a mile, on every side of the island, and within its
// bounds.
func courseCases() []courseCase {
	island := &[4]float64{1000, 2000, 1600, 2400}
	var cases []courseCase
	add := func(name string, east, north, pe, pn float64, bounds *[4]float64) {
		c := courseCase{Name: name, East: east, North: north, PointE: pe, PointN: pn, Bounds: bounds}
		c.aim()
		cases = append(cases, c)
	}
	add("a point far off", -1200, 300, 3400, -2100, nil)
	add("a point just outside a tenth of a mile", 500, 500, 500+185.5, 500, nil)
	add("a point just inside a tenth of a mile", 500, 500, 500, 500-185, nil)
	add("on the point", 77, -77, 77, -77, nil)
	add("an island to the north-east, aimed at its corner", 0, 0, 1300, 2200, island)
	add("an island to the north, aimed at its south shore", 1200, 1000, 1300, 2200, island)
	add("an island to the west, aimed at its east shore", 2500, 2300, 1300, 2200, island)
	add("an island just outside a tenth of a mile", 1300, 2400+185.5, 1300, 2200, island)
	add("an island just inside a tenth of a mile", 1600+185, 2100, 1300, 2200, island)
	add("within an island's bounds", 1100, 2100, 1300, 2200, island)
	return cases
}

// The rule at the cases a sailor meets most.
func TestCourseAim(t *testing.T) {
	for _, c := range courseCases() {
		want := map[string]bool{"a point just inside a tenth of a mile": true, "on the point": true,
			"an island just inside a tenth of a mile": true, "within an island's bounds": true}[c.Name]
		if c.Reached != want {
			t.Errorf("%s: reached %v at %.1f m", c.Name, c.Reached, c.Distance)
		}
	}
	x, y, d, b := CourseAim(1300, 2200, &[4]float64{1000, 2000, 1600, 2400}, 1200, 1000)
	if x != 1200 || y != 2000 || d != 1000 || BearingText(b) != "000°" {
		t.Errorf("the island's south shore: (%v, %v) %v m %s", x, y, d, BearingText(b))
	}
	if Arrive < 185.2 || Arrive > 185.21 {
		t.Errorf("arrival at %v m", Arrive)
	}
	if _, _, d, _ := CourseAim(0, 0, nil, 3, 4); math.Abs(d-5) > 1e-12 {
		t.Errorf("a point 5 m off: %v", d)
	}
}

// The cases written down are this rule's: the page holds its own to them.
func TestCoursesFile(t *testing.T) {
	got := coursesData{
		Comment: "Written by go test ./internal/chart -run CoursesFile -update: a boat m east and north of the centre, a course's point and an island's bounds (west, south, east, north) or null, and where the course aims, how far, m, its bearing as written, and whether it is reached.",
		Cases:   courseCases(),
	}
	if *update {
		data, _ := json.MarshalIndent(got, "", "  ")
		if err := os.WriteFile(coursesFile, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	data, err := os.ReadFile(coursesFile)
	if err != nil {
		t.Fatal(err)
	}
	var want coursesData
	if err := json.Unmarshal(data, &want); err != nil {
		t.Fatal(err)
	}
	for _, c := range want.Cases {
		g := c
		g.aim()
		if !reflect.DeepEqual(g, c) {
			t.Errorf("%s: %+v, courses.json %+v", c.Name, g, c)
		}
	}
	if !reflect.DeepEqual(want, got) {
		t.Errorf("courses.json has other cases: rewrite it with -update")
	}
}
