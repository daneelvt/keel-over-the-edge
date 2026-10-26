// SPDX-License-Identifier: AGPL-3.0-only

package lookout

import (
	"math"
	"reflect"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// rightOfWayFile holds the cases the overlay and the page's are held to.
const rightOfWayFile = "testdata/rightofway.json"

type rowData struct {
	Comment string    `json:"comment"`
	Range   float64   `json:"range"`
	Ahead   float64   `json:"ahead"`
	Close   float64   `json:"close"`
	Marks   int       `json:"marks"`
	Cases   []rowCase `json:"cases"`
}

// rowCase is the sailor's boat and the others about it, each as the page
// draws it, with the true wind at it; and what the overlay shows: the
// boats that will come close, the marks over them and the sailor's tack.
type rowCase struct {
	Name       string     `json:"name"`
	Own        rowBoat    `json:"own"`
	Others     []rowBoat  `json:"others"`
	Approaches []Approach `json:"approaches"`
	Marks      []Mark     `json:"marks"`
	Tack       string     `json:"tack"`
}

// rowBoat is a boat as the page draws it: where, its pose, its sailor's
// mode, its speed along its heading, m/s, and the true wind's direction at
// it, rad. Its course is the Articles', followed as the page follows it,
// once a judgement, from its first sight: its headings and booms Before,
// at the judgements before this one, then its own.
type rowBoat struct {
	East     float64   `json:"east"`
	North    float64   `json:"north"`
	Heading  float64   `json:"heading"`
	Heel     float64   `json:"heel"`
	Boom     float64   `json:"boom"`
	Mode     float64   `json:"mode"`
	Speed    float64   `json:"speed"`
	WindFrom float64   `json:"windFrom"`
	Before   []rowPose `json:"before"`
}

type rowPose struct {
	Heading float64 `json:"heading"`
	Boom    float64 `json:"boom"`
}

func (b *rowBoat) judged(r *RightOfWay) Judged {
	s, c := physics.SinCos(b.Heading)
	j := Judged{
		Seen:     Seen{East: b.East, North: b.North, Heading: b.Heading, Heel: b.Heel, Boom: b.Boom, Mode: b.Mode, VEast: b.Speed * s, VNorth: b.Speed * c},
		WindFrom: b.WindFrom,
	}
	for _, p := range append(b.Before, rowPose{Heading: b.Heading, Boom: b.Boom}) {
		physics.TrackCourse(&j.Course, &physics.State{Heading: p.Heading, Boom: p.Boom}, b.WindFrom, r.Kind, r.Encounters)
	}
	return j
}

func (c *rowCase) run(r *RightOfWay) {
	own := c.Own.judged(r)
	others := make([]Judged, len(c.Others))
	seen := make([]Seen, len(c.Others))
	for i := range c.Others {
		others[i] = c.Others[i].judged(r)
		seen[i] = others[i].Seen
	}
	c.Approaches = Approaching(own.Seen, seen, r.Range, r.Ahead, r.Close, r.Marks)
	c.Marks = r.Show(own, others)
	c.Tack = TackText(own.Course)
}

func rowCases(r *RightOfWay) []rowCase {
	deg := math.Pi / 180
	// boat is a boat at (east, north) heading h degrees at speed m/s in a
	// wind from the north, its boom to leeward.
	boom := func(h float64) float64 {
		twa := math.Remainder(-h, 360)
		return -math.Copysign(math.Min(math.Abs(twa)/2, 80), twa) * deg
	}
	boat := func(east, north, h, speed float64) rowBoat {
		return rowBoat{East: east, North: north, Heading: h * deg, Boom: boom(h), Speed: speed, Before: []rowPose{}}
	}
	// turned is a boat that headed each of before at the judgements before.
	turned := func(b rowBoat, before ...float64) rowBoat {
		for _, h := range before {
			b.Before = append(b.Before, rowPose{Heading: h * deg, Boom: boom(h)})
		}
		return b
	}
	capsized := func(b rowBoat) rowBoat { b.Heel = 100 * deg; b.Mode = 1; return b }
	cases := []rowCase{
		{Name: "port and starboard crossing", Own: boat(0, 0, 45, 2), Others: []rowBoat{boat(20, -2, -45, 2)}},
		{Name: "starboard and port crossing", Own: boat(0, 0, -45, 2), Others: []rowBoat{boat(-20, -2, 45, 2)}},
		{Name: "windward and leeward on one tack", Own: boat(0, 0, 45, 2), Others: []rowBoat{boat(3, -3, 45, 2.2)}},
		{Name: "leeward of one on the same tack", Own: boat(3, -3, 45, 2.2), Others: []rowBoat{boat(0, 0, 45, 2)}},
		{Name: "clear astern", Own: boat(0, 0, 120, 3), Others: []rowBoat{boat(5.2, -3, 120, 1)}},
		{Name: "clear ahead", Own: boat(5.2, -3, 120, 1), Others: []rowBoat{boat(0, 0, 120, 3)}},
		{Name: "a boat tacking", Own: boat(0, 0, -45, 2), Others: []rowBoat{turned(boat(-6, 8, -20, 1.2), 45, 30, 10)}},
		{Name: "tacking", Own: turned(boat(-6, 8, -20, 1.2), 45, 30, 10), Others: []rowBoat{boat(0, 0, -45, 2)}},
		{Name: "tacked and close-hauled", Own: turned(boat(8, 6, -45, 2), 45, 30, 10, -20), Others: []rowBoat{boat(0, 0, 45, 2)}},
		{Name: "beside a capsized boat", Own: boat(0, 0, 90, 2), Others: []rowBoat{capsized(boat(12, 1, 30, 0))}},
		{Name: "capsized beside a boat", Own: capsized(boat(12, 1, 30, 0)), Others: []rowBoat{boat(0, 0, 90, 2)}},
		{Name: "both capsized", Own: capsized(boat(0, 0, 0, 0)), Others: []rowBoat{capsized(boat(3, 0, 0, 0))}},
		{Name: "near head to wind", Own: boat(0, 0, 2, 0.5), Others: []rowBoat{boat(6, 6, -50, 2)}},
		{Name: "running", Own: boat(0, 0, 170, 3), Others: []rowBoat{boat(2, -6, 185, 2.5)}},
		{Name: "the nearest three of many", Own: boat(0, 0, 0, 2), Others: []rowBoat{
			boat(30, 20, 270, 2), boat(10, 10, 270, 1), boat(-6, 6, 90, 1), boat(5, 3, 270, 1),
			boat(0, -10, 0, 2), boat(8, 8, 284, 0.82), boat(0, 39, 180, 2),
		}},
		{Name: "all passing wide", Own: boat(0, 0, 0, 2), Others: []rowBoat{boat(20, 0, 0, 2), boat(-15, 5, 0, 1), boat(0, -30, 180, 0.5)}},
		{Name: "out of range", Own: boat(0, 0, 0, 2), Others: []rowBoat{boat(0, 41, 180, 5)}},
		{Name: "a wind that differs between them", Own: boat(100, 100, 30, 2), Others: []rowBoat{boat(106, 108, 300, 2)}},
	}
	cases[len(cases)-1].Others[0].WindFrom = 0.3
	for i := range cases {
		cases[i].run(r)
	}
	return cases
}

// The overlay's own words for the Articles and the tack.
func TestRightOfWayWords(t *testing.T) {
	for code, want := range map[float64]string{10: "10", 11: "11", 12: "12", 13: "13", 15: "15", 16: "16.1", 22: "22", 0: ""} {
		if got := ArticleName(code); got != want {
			t.Errorf("%v: %q, want %q", code, got, want)
		}
	}
	if TackText(physics.Course{Tack: 1}) != "Starboard tack" || TackText(physics.Course{Tack: -1}) != "Port tack" || TackText(physics.Course{Tack: 1, Tacking: 1}) != "Tacking" {
		t.Error("the tacks' words")
	}
}

// Port keeps clear of starboard: the overlay says so over the other boat.
func TestRightOfWayCrossing(t *testing.T) {
	r := readied()
	row := NewRightOfWay(r.cat, r.kinds, 0, r.ep)
	c := rowCase{Own: rowBoat{Heading: math.Pi / 4, Speed: 2, Boom: 0.4}, Others: []rowBoat{{East: 20, North: -2, Heading: -math.Pi / 4, Speed: 2, Boom: -0.4}}}
	c.run(row)
	if len(c.Marks) != 1 || !c.Marks[0].KeepClear || c.Marks[0].Label != "Keep clear · Article 10" || c.Tack != "Port tack" {
		t.Errorf("%+v %q", c.Marks, c.Tack)
	}
	if a := c.Approaches; len(a) != 1 || a[0].Time <= 0 || a[0].Time > row.Ahead {
		t.Errorf("%+v", a)
	}
}

func TestRightOfWayFile(t *testing.T) {
	r := readied()
	row := NewRightOfWay(r.cat, r.kinds, 0, r.ep)
	got := rowData{
		Comment: "Written by go test ./internal/lookout -run RightOfWayFile -update: the overlay's range, m, seconds ahead, closeness, m, and most marks; the sailor's boat and others as the page draws them, m, rad and m/s, the true wind's direction at each, rad, their courses the Articles' first; the boats that will come close, by index, how close, m, and when, s; the marks over them; the sailor's tack.",
		Range:   row.Range, Ahead: row.Ahead, Close: row.Close, Marks: row.Marks,
		Cases: rowCases(row),
	}
	caseFile(t, rightOfWayFile, got, func(t *testing.T, want rowData) {
		for _, c := range want.Cases {
			g := c
			g.run(row)
			if !reflect.DeepEqual(g, c) {
				t.Errorf("%s: %+v, rightofway.json %+v", c.Name, g, c)
			}
		}
	})
}
