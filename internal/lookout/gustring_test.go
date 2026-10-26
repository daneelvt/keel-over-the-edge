// SPDX-License-Identifier: AGPL-3.0-only

package lookout

import (
	"encoding/json"
	"math"
	"os"
	"reflect"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// gustFile holds the cases the ring and the page's are held to.
const gustFile = "testdata/gustring.json"

type gustData struct {
	Comment string              `json:"comment"`
	Ring    catalog.WeatherRing `json:"ring"`
	Cases   []gustCase          `json:"cases"`
}

// gustCase is a boat at (East, North) in a mean wind From, moving at
// (BoatEast, BoatNorth), in a field carried at (DriftEast, DriftNorth) of
// a spell whose gust factor is 1 + Excess: on the ring's grid the factor is
// 1 but in Blocks; and the patches found, the rings chosen and the gusts the
// ring shows.
type gustCase struct {
	Name       string        `json:"name"`
	East       float64       `json:"east"`
	North      float64       `json:"north"`
	From       float64       `json:"from"`
	BoatEast   float64       `json:"boatEast"`
	BoatNorth  float64       `json:"boatNorth"`
	DriftEast  float64       `json:"driftEast"`
	DriftNorth float64       `json:"driftNorth"`
	Excess     float64       `json:"excess"`
	Blocks     []gustBlock   `json:"blocks"`
	Patches    []GustPatch   `json:"patches"`
	Rings      []RingedPatch `json:"rings"`
	Gusts      []Gust        `json:"gusts"`
}

// gustBlock is a block of the grid, rows From[0] to To[0] and columns
// From[1] to To[1], the ends left out, whose gust factor is Factor in its
// first row and Slope more each row upwind; where blocks overlap, the
// strongest.
type gustBlock struct {
	From   [2]int  `json:"from"`
	To     [2]int  `json:"to"`
	Factor float64 `json:"factor"`
	Slope  float64 `json:"slope"`
}

// field is the gust factor at each point of the grid, as the blocks give it.
func (c *gustCase) field(o *catalog.WeatherRing) []float64 {
	rows, cols := RingGridSize(o)
	f := make([]float64, rows*cols)
	for i := range rows {
		for j := range cols {
			f[i*cols+j] = 1
			for _, b := range c.Blocks {
				if i >= b.From[0] && i < b.To[0] && j >= b.From[1] && j < b.To[1] {
					f[i*cols+j] = math.Max(f[i*cols+j], b.Factor+float64(b.Slope*float64(i-b.From[0])))
				}
			}
		}
	}
	return f
}

func (c *gustCase) run(o *catalog.WeatherRing) {
	rows, cols := RingGridSize(o)
	points := make([]float64, rows*cols*2)
	RingGrid(c.East, c.North, c.From, o, points)
	c.Patches = FindPatches(c.field(o), points, c.Excess, o)
	c.Rings = ChooseRings(c.Patches, c.East, c.North, c.BoatEast, c.BoatNorth, c.DriftEast, c.DriftNorth, o)
	c.Gusts = GustsOf(c.Rings, c.East, c.North)
}

func gustCases(o *catalog.WeatherRing) []gustCase {
	block := func(i0, j0, i1, j1 int, f, slope float64) gustBlock {
		return gustBlock{From: [2]int{i0, j0}, To: [2]int{i1, j1}, Factor: f, Slope: slope}
	}
	cases := []gustCase{
		{Name: "two gusts and a weak one, from the north", East: 0, North: 0, From: 0, DriftNorth: -5, Excess: 0.3,
			Blocks: []gustBlock{block(4, 2, 8, 6, 1.25, 0), block(20, 14, 22, 20, 1.3, 0), block(12, 0, 13, 20, 1.1, 0)}},
		{Name: "a weak spell's gusts", East: 0, North: 0, From: 0, DriftNorth: -5, Excess: 0.2,
			Blocks: []gustBlock{block(4, 2, 8, 6, 1.25, 0), block(20, 14, 22, 20, 1.3, 0), block(12, 0, 13, 20, 1.1, 0)}},
		{Name: "no gusts in the spell", East: 0, North: 0, From: 0, DriftNorth: -5, Excess: 0,
			Blocks: []gustBlock{block(4, 2, 8, 6, 1.25, 0)}},
		{Name: "from the east, a boat sailing north", East: 1200.5, North: -340.25, From: math.Pi / 2, BoatNorth: 4, DriftEast: -6, Excess: 0.35,
			Blocks: []gustBlock{block(2, 8, 9, 13, 1.2, 0.02), block(8, 0, 14, 4, 1.3, -0.01), block(15, 9, 25, 11, 1.4, 0)}},
		{Name: "a curl joined at a corner", East: -50, North: 75, From: 2.3, DriftEast: -3.2, DriftNorth: 4.1, Excess: 0.3,
			Blocks: []gustBlock{block(3, 3, 6, 10, 1.22, 0.01), block(6, 8, 12, 10, 1.25, 0), block(12, 2, 14, 10, 1.18, 0.005)}},
		{Name: "more than three heading for the boat", East: 300, North: 300, From: 5.9, BoatEast: 1, BoatNorth: 2, DriftEast: 1.4, DriftNorth: -6.3, Excess: 0.4,
			Blocks: []gustBlock{
				block(1, 8, 3, 12, 1.3, 0), block(5, 9, 7, 11, 1.35, 0), block(10, 7, 12, 13, 1.25, 0),
				block(15, 9, 18, 11, 1.3, 0), block(22, 8, 25, 12, 1.32, 0), block(27, 9, 30, 11, 1.4, 0),
			}},
		{Name: "a boat sailing out from under", East: 0, North: 0, From: 0, BoatEast: 5, DriftNorth: -5, Excess: 0.3,
			Blocks: []gustBlock{block(10, 15, 14, 20, 1.3, 0), block(10, 0, 14, 4, 1.3, 0)}},
		{Name: "a still field", East: 10, North: 10, From: 1, Excess: 0.3,
			Blocks: []gustBlock{block(0, 8, 3, 12, 1.3, 0), block(10, 8, 12, 12, 1.3, 0)}},
	}
	for i := range cases {
		cases[i].run(o)
	}
	return cases
}

// The ring on its own cases, as the page's own tests have them.
func TestGustRing(t *testing.T) {
	o := &readied().cat.Weather.Ring
	if r, c := RingGridSize(o); r != 30 || c != 20 {
		t.Fatalf("the grid is %d by %d", r, c)
	}
	p := func(e, n float64) GustPatch { return GustPatch{East: e, North: n, Radius: 20, Peak: 1.3} }
	got := ChooseRings([]GustPatch{p(0, 150), p(45, 100), p(60, 100), p(0, 400)}, 0, 0, 0, 0, 0, -5, o)
	if len(got) != 2 || got[0].East != 45 || math.Abs(got[0].Arrives-20) > 1e-9 || math.Abs(got[0].Miss-25) > 1e-9 || got[1].Arrives != 30 || got[1].Miss != 0 {
		t.Errorf("rings: %+v", got)
	}
	g := GustsOf(got, 0, 0)
	if math.Abs(g[1].Bearing) > 1e-9 || g[1].Distance != 130 || g[1].Stronger != 30 {
		t.Errorf("gusts: %+v", g)
	}
}

// The ring on the physics' own field: the trade wind of the physics'
// cases, about a few boats.
func TestGustRingsField(t *testing.T) {
	r := readied()
	data, err := os.ReadFile("../physics/testdata/wind.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []struct {
			Name   string          `json:"name"`
			Spells json.RawMessage `json:"spells"`
			Tick   float64         `json:"tick"`
			Origin [2]float64      `json:"origin"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	o := &r.cat.Weather.Ring
	for _, c := range file.Cases {
		if c.Name != "trade" {
			continue
		}
		var spells []physics.Spell
		if err := json.Unmarshal(c.Spells, &spells); err != nil {
			t.Fatal(err)
		}
		w := physics.Weather{Prepared: r.cat.PrepareWeather()}
		w.Set(spells)
		var tick physics.WeatherTick
		physics.WeatherAt(&w, &tick, c.Tick)
		ringed := 0
		for n := range 40 {
			east := c.Origin[0] + float64(n*53%400) - 200
			north := c.Origin[1] + float64(n*97%400) - 200
			var here physics.WindPoint
			physics.WindPointAt(&tick, east, north, &here, nil)
			gusts := GustRings(&tick, nil, GustBoat{East: east, North: north, MeanFrom: here.MeanFrom}, o)
			if len(gusts) > o.Rings {
				t.Errorf("%d rings", len(gusts))
			}
			for _, g := range gusts {
				if !(g.Peak > 1) || g.Stronger < 1 || g.Arrives < 0 || g.Arrives > o.Horizon {
					t.Errorf("a ring: %+v", g)
				}
			}
			ringed += len(gusts)
		}
		// A trade spell has gusts about any boat, and some head for it.
		if ringed < 10 {
			t.Errorf("%d rings about 40 boats", ringed)
		}
		return
	}
	t.Fatal("the physics' wind cases have no trade wind")
}

func TestGustFile(t *testing.T) {
	o := readied().cat.Weather.Ring
	got := gustData{
		Comment: "Written by go test ./internal/lookout -run GustFile -update: the catalog's ring; boats, m and m/s, in a mean wind from a direction, rad, in a field carried by its drift, m/s, its gust factor 1 but in blocks of the ring's grid (rows from the boat upwind, columns across the wind, the ends left out); the patches found, the rings chosen, and the gusts the ring shows, their true bearings in degrees.",
		Ring:    o, Cases: gustCases(&o),
	}
	caseFile(t, gustFile, got, func(t *testing.T, want gustData) {
		if !reflect.DeepEqual(want.Ring, o) {
			t.Errorf("gustring.json's ring is %+v, the catalog's %+v", want.Ring, o)
		}
		for _, c := range want.Cases {
			r := c
			r.run(&o)
			if !reflect.DeepEqual(r.Patches, c.Patches) || !reflect.DeepEqual(r.Rings, c.Rings) || !reflect.DeepEqual(r.Gusts, c.Gusts) {
				t.Errorf("%s: %+v %+v, gustring.json %+v %+v", c.Name, r.Patches, r.Rings, c.Patches, c.Rings)
			}
		}
	})
}
