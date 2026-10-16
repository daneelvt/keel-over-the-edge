// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"encoding/json"
	"math"
	"math/rand/v2"
	"os"
	"reflect"
	"testing"
)

// The sea as Go computes it, for the client to check its copies against:
// testdata/sea.json holds the sea's waves, and for a few seas, ticks and
// places the height and slope of the surface at points about the place, and
// the sea under a hull there. The client's tests load the same seas into the
// WebAssembly module, which must give the same bits, and into the GPU's sum,
// which must agree within what its sine is good for. After a deliberate
// change to the sea, rewrite it with
//
//	go test ./internal/physics -run SeaFile -update

const seaFile = "testdata/sea.json"

type seaFileData struct {
	Comment string `json:"comment"`
	// Components are the sea's waves, each field's values as bits.
	Components map[string][]string `json:"components"`
	Cases      []seaCase           `json:"cases"`
}

type seaCase struct {
	Name string      `json:"name"`
	Sea  scenarioSea `json:"sea"`
	// Origin is the place the points lie about, metres east and north of
	// the world's centre.
	Origin [2]float64 `json:"origin"`
	// Points are metres east and north of the origin; Values, for each, the
	// surface's height, its slope eastward and northward, and the sea's
	// significant height, as bits.
	Points [][2]float64 `json:"points"`
	Values [][4]string  `json:"values"`
	// Hulls are hulls at the origin, each a heading and a waterplane's
	// length and beam; Waves the sea under each: height, slope ahead, slope
	// across, as bits.
	Hulls [][3]float64 `json:"hulls"`
	Waves [][3]string  `json:"waves"`
}

// seaCases are the seas written: a breeze and a gale, and a calm sea that
// meets a gale along a line of area centres; near a world's present tick and
// past 2³¹; at the world's centre and near its rim.
func seaCases() []seaCase {
	const fetch = 11112
	uniform := func(knots float64) [][3]uint32 {
		in := SeaInputOf(knots*knot, 0.4, fetch)
		areas := make([][3]uint32, SeaClientWindow*SeaClientWindow)
		for i := range areas {
			areas[i] = [3]uint32{in.Speed, in.From, in.Fetch}
		}
		return areas
	}
	border := uniform(6)
	for i, a := range uniform(34) {
		if i%SeaClientWindow >= 3 {
			border[i] = a
		}
	}
	const now, late = 740_000_000, 1<<31 + 1
	return []seaCase{
		{Name: "breeze", Sea: scenarioSea{Tick: now, Col: 16, Row: 16, Size: 5, Areas: uniform(12)}},
		{Name: "gale", Sea: scenarioSea{Tick: now, Col: 16, Row: 16, Size: 5, Areas: uniform(34)}},
		{Name: "gale at the rim, late", Sea: scenarioSea{Tick: late, Col: 29, Row: 29, Size: 5, Areas: uniform(34)}, Origin: [2]float64{5869, 5869}},
		{Name: "breeze at the rim", Sea: scenarioSea{Tick: now, Col: 34, Row: 16, Size: 5, Areas: uniform(12)}, Origin: [2]float64{8300, -12.5}},
		// The areas from the world's middle column eastward have the gale:
		// the origin is between the last calm centre, 463 m west of the
		// world's, and the first of the gale's.
		{Name: "border", Sea: scenarioSea{Tick: now, Col: 15, Row: 16, Size: 5, Areas: border}, Origin: [2]float64{-231.5, 40}},
		{Name: "border, late", Sea: scenarioSea{Tick: late, Col: 15, Row: 16, Size: 5, Areas: border}, Origin: [2]float64{-300, -200}},
	}
}

// fillSeaCase computes a case's values.
func fillSeaCase(t *testing.T, w *Waves, c *seaCase) {
	t.Helper()
	sea, err := scenarioOcean(w, &c.Sea)
	if err != nil {
		t.Fatal(err)
	}
	sea.at(c.Sea.Tick)
	// Points on a quarter-metre grid, so that float32 holds them exactly:
	// most within the tiles' 150 m, some out where only the far sea reaches.
	rng := rand.New(rand.NewPCG(uint64(len(c.Name)), 99))
	c.Points = [][2]float64{{0, 0}}
	for len(c.Points) < 240 {
		reach := 150.0
		if len(c.Points)%8 == 0 {
			reach = 640
		}
		x := math.Round((2*rng.Float64()-1)*reach*4) / 4
		y := math.Round((2*rng.Float64()-1)*reach*4) / 4
		c.Points = append(c.Points, [2]float64{x, y})
	}
	c.Values = c.Values[:0]
	for _, p := range c.Points {
		v := SeaSample(&sea.Sea, nil, c.Origin[0]+p[0], c.Origin[1]+p[1])
		c.Values = append(c.Values, [4]string{toHex(v.Height), toHex(v.East), toHex(v.North), toHex(v.Hs)})
	}
	c.Hulls = [][3]float64{{0, 3.791, 1.103}, {1.3, 3.791, 1.103}, {-2.5, 30, 7}, {4, 0.5, 0.5}}
	c.Waves = c.Waves[:0]
	for _, h := range c.Hulls {
		v := WaveUnder(&sea.Sea, nil, h[1], h[2], c.Origin[0], c.Origin[1], h[0])
		c.Waves = append(c.Waves, [3]string{toHex(v.Height), toHex(v.Ahead), toHex(v.Across)})
	}
}

func TestSeaFile(t *testing.T) {
	w := testWaves(t)
	got := seaFileData{
		Comment:    "Written by go test ./internal/physics -run SeaFile -update. Floats marked as bits are their IEEE 754 bits in hexadecimal.",
		Components: map[string][]string{},
		Cases:      seaCases(),
	}
	cv := reflect.ValueOf(w.Components)
	for i := range cv.NumField() {
		f := cv.Field(i)
		bits := make([]string, f.Len())
		for j := range bits {
			bits[j] = toHex(f.Index(j).Float())
		}
		got.Components[lowerFirst(cv.Type().Field(i).Name)] = bits
	}
	for i := range got.Cases {
		fillSeaCase(t, w, &got.Cases[i])
	}
	// The cases are not flat, and the border's two seas differ.
	for _, c := range got.Cases {
		highest := 0.0
		for _, v := range c.Values {
			highest = max(highest, math.Abs(fromHex(t, v[0])))
		}
		if highest < 0.1 {
			t.Errorf("%s: the sea is %.3f m at its highest", c.Name, highest)
		}
	}
	if *update {
		data, err := json.Marshal(got)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(seaFile, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s", seaFile)
		return
	}
	var want seaFileData
	readJSON(t, seaFile, &want)
	if !reflect.DeepEqual(got.Components, want.Components) {
		t.Error("the sea's waves differ from sea.json: rewrite it with -update")
	}
	if len(got.Cases) != len(want.Cases) {
		t.Fatalf("%d cases, sea.json has %d: rewrite it with -update", len(got.Cases), len(want.Cases))
	}
	for i, c := range got.Cases {
		if !reflect.DeepEqual(c, want.Cases[i]) {
			t.Errorf("%s: differs from sea.json", c.Name)
		}
	}
}
