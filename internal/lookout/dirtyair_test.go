// SPDX-License-Identifier: AGPL-3.0-only

package lookout

import (
	"math"
	"reflect"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// dirtyAirFile holds the cases dirty air and the page's are held to.
const dirtyAirFile = "testdata/dirtyair.json"

type airData struct {
	Comment string    `json:"comment"`
	Range   float64   `json:"range"`
	Least   float64   `json:"least"`
	Outline Outline   `json:"outline"`
	Cases   []airCase `json:"cases"`
}

// airCase is the sailor's boat and others, each as the page draws it with
// the true wind at it; the wedges the page draws, its own first, and whose
// wedge the sailor's boat sits in and which others its own covers.
type airCase struct {
	Name     string     `json:"name"`
	Own      airBoat    `json:"own"`
	Others   []airBoat  `json:"others"`
	Wedges   []airWedge `json:"wedges"`
	In       []int      `json:"in"`
	Covering []int      `json:"covering"`
}

// airBoat is a boat as the page draws it: where, its pose, how it moves,
// m/s, and the true wind at it, m/s and rad.
type airBoat struct {
	East      float64 `json:"east"`
	North     float64 `json:"north"`
	Heading   float64 `json:"heading"`
	Heel      float64 `json:"heel"`
	Boom      float64 `json:"boom"`
	VEast     float64 `json:"vEast"`
	VNorth    float64 `json:"vNorth"`
	WindSpeed float64 `json:"windSpeed"`
	WindFrom  float64 `json:"windFrom"`
}

func (b *airBoat) aired() Aired {
	return Aired{Seen: Seen{East: b.East, North: b.North, Heading: b.Heading, Heel: b.Heel, Boom: b.Boom, VEast: b.VEast, VNorth: b.VNorth},
		WindSpeed: b.WindSpeed, WindFrom: b.WindFrom}
}

// airWedge is a wedge: its source, −1 the sailor's, and its wake.
type airWedge struct {
	Source int     `json:"source"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	East   float64 `json:"east"`
	North  float64 `json:"north"`
	Height float64 `json:"height"`
	Side   float64 `json:"side"`
}

func (c *airCase) run(d *DirtyAir) {
	own := c.Own.aired()
	others := make([]Aired, len(c.Others))
	for i := range c.Others {
		others[i] = c.Others[i].aired()
	}
	c.Wedges = []airWedge{}
	for _, w := range d.Wedges(own, others) {
		k := w.Wake
		c.Wedges = append(c.Wedges, airWedge{Source: w.Source, X: k.X, Y: k.Y, East: k.East, North: k.North, Height: k.Height, Side: k.Side})
	}
	f := d.Foul(own, others)
	c.In, c.Covering = append([]int{}, f.In...), append([]int{}, f.Covering...)
}

func airCases(d *DirtyAir) []airCase {
	deg := math.Pi / 180
	// boat is a boat at (east, north) heading h degrees at speed m/s in a
	// wind of 5 m/s from the north, its boom to leeward.
	boat := func(east, north, h, speed float64) airBoat {
		s, c := physics.SinCos(h * deg)
		twa := math.Remainder(-h, 360)
		return airBoat{East: east, North: north, Heading: h * deg, Boom: -math.Copysign(math.Min(math.Abs(twa)/2, 80), twa) * deg,
			VEast: speed * s, VNorth: speed * c, WindSpeed: 5, WindFrom: 0}
	}
	many := []airBoat{}
	for i := range 14 {
		a := float64(i) * 25 * deg
		s, c := physics.SinCos(a)
		many = append(many, boat(float64(50*s), float64(50*c)-5, 45, 1.5))
	}
	gust := boat(-3, 12, -40, 2.5)
	gust.WindSpeed, gust.WindFrom = 8.5, 0.15
	capsized := boat(2, 10, -45, 0)
	capsized.Heel = 100 * deg
	cases := []airCase{
		{Name: "a boat in the sailor's wind", Own: boat(0, 0, -45, 2), Others: []airBoat{boat(8, -14, -45, 2)}},
		{Name: "the sailor in another's wind", Own: boat(8, -14, -45, 2), Others: []airBoat{boat(0, 0, -45, 2)}},
		{Name: "abeam, in neither's", Own: boat(0, 0, -45, 2), Others: []airBoat{boat(-14, -14, -45, 2)}},
		{Name: "beyond the wedges' range", Own: boat(0, 0, -45, 2), Others: []airBoat{boat(10, -65, -45, 2), boat(3, -30, -45, 2)}},
		{Name: "a capsized boat casts none", Own: boat(0, -5, -45, 2), Others: []airBoat{capsized}},
		{Name: "in a gust, reaching", Own: boat(0, 0, 90, 3), Others: []airBoat{gust, boat(-10, -25, 90, 3)}},
		{Name: "running", Own: boat(0, 0, 175, 3), Others: []airBoat{boat(1, 15, 175, 3), boat(-2, -20, 175, 3)}},
		{Name: "a fleet about the sailor", Own: boat(0, 0, 45, 2), Others: many},
	}
	for i := range cases {
		cases[i].run(d)
	}
	return cases
}

// The wedge is widest a little behind the sail and gone at its reach, and
// covers what lies within it.
func TestDirtyAirWedge(t *testing.T) {
	r := readied()
	d := NewDirtyAir(r.cat, r.kinds, 0, r.ep)
	o := d.Outline
	if len(o.S) != stations+1 || o.C[0] != 0 || o.C[stations] != 0 {
		t.Fatalf("the outline: %+v", o)
	}
	widest := 0.0
	for _, c := range o.C {
		widest = math.Max(widest, c)
	}
	if widest < 0.3 || widest > 2 {
		t.Errorf("widest %v rig heights", widest)
	}
	w := physics.Wake{X: 0, Y: 0, East: 0, North: -1, Height: 6}
	if !o.Covers(&w, 0, -20) || o.Covers(&w, 0, 20) || o.Covers(&w, 30, -20) || o.Covers(&w, 0, -61) {
		t.Error("the wedge covers the wrong places")
	}
}

func TestDirtyAirFile(t *testing.T) {
	r := readied()
	d := NewDirtyAir(r.cat, r.kinds, 0, r.ep)
	got := airData{
		Comment: "Written by go test ./internal/lookout -run DirtyAirFile -update: the wedges' range, m, and least loss; the wedge's outline, its stations along the wake and its half-widths, in rig heights; the sailor's boat and others as the page draws them, m, rad and m/s, with the true wind at each, m/s and rad; the wedges the page draws, their sources (-1 the sailor's) and wakes; the others in whose wedges the sailor's boat sits, and those its own wedge covers.",
		Range:   d.Range, Least: r.cat.Encounters.Overlay.WedgeDeficit, Outline: d.Outline,
		Cases: airCases(d),
	}
	caseFile(t, dirtyAirFile, got, func(t *testing.T, want airData) {
		if !reflect.DeepEqual(want.Outline, d.Outline) {
			t.Errorf("the outline %+v, dirtyair.json %+v", d.Outline, want.Outline)
		}
		for _, c := range want.Cases {
			g := c
			g.run(d)
			if !reflect.DeepEqual(g, c) {
				t.Errorf("%s: %+v, dirtyair.json %+v", c.Name, g, c)
			}
		}
	})
}
