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

// The wind in the land's shelter as Go computes it, for the client to check
// its module against: testdata/lee.json holds, for two weathers about the
// golden terrain lee's hill, the wind in full at points in and beside its
// lee, with the shelter and without, and the shelter's factor over a square
// of cells for the mean wind's direction. The client loads the terrain into
// its module's slots and must give the same bits. After a deliberate change,
// rewrite it with
//
//	go test ./internal/physics -run LeeFile -update

const leeFile = "testdata/lee.json"

type leeFileData struct {
	Comment string    `json:"comment"`
	Terrain string    `json:"terrain"`
	Cases   []leeCase `json:"cases"`
}

type leeCase struct {
	windCase
	// Open is the wind at the same points with no shelter.
	Open [][6]string `json:"open"`
	// Grid is the shelter's factor at the centres of 64 by 64 cells from
	// cell (A0, B0), row by row from the south, for a wind from From.
	A0   int32    `json:"a0"`
	B0   int32    `json:"b0"`
	From string   `json:"from"`
	Grid []string `json:"grid"`
}

// leeSide is how many cells a side the grid has: the module's shelterGrid.
const leeSide = 64

func leeCases(t *testing.T, p *WeatherPrepared) ([]leeCase, [][]Spell) {
	const now = 740_000_000
	trade := spellOfRegime(t, p, "trade", 1, 20, now-3*hourOfTicks, 4*hourOfTicks)
	trade.Regime = 1
	cases := []leeCase{
		{windCase: windCase{Name: "steady from the east", Tick: now, Origin: [2]float64{60, 0}}},
		{windCase: windCase{Name: "trade", Tick: now, Origin: [2]float64{150, -150}}},
	}
	return cases, [][]Spell{{SteadySpell(6, math.Pi/2, now-50)}, {trade}}
}

func fillLeeCase(c *leeCase, w *Weather, sh *Shelter) {
	c.Spells = nil
	for i := range w.Count {
		c.Spells = append(c.Spells, spellMap(w.Spells[i]))
	}
	var at WeatherTick
	WeatherAt(w, &at, c.Tick)
	rng := rand.New(rand.NewPCG(uint64(len(c.Name)), 23))
	c.Points = [][2]float64{{0, 0}}
	for len(c.Points) < 240 {
		reach := 150.0
		if len(c.Points)%8 == 0 {
			reach = 640
		}
		c.Points = append(c.Points, [2]float64{math.Round((2*rng.Float64()-1)*reach*4) / 4, math.Round((2*rng.Float64()-1)*reach*4) / 4})
	}
	bits := func(v *WindPoint) [6]string {
		return [6]string{toHex(v.Speed), toHex(v.From), toHex(v.MeanSpeed), toHex(v.MeanFrom), toHex(v.Gust), toHex(v.Factor)}
	}
	c.Values, c.Open = c.Values[:0], c.Open[:0]
	for _, pt := range c.Points {
		var v, o WindPoint
		WindPointAt(&at, c.Origin[0]+pt[0], c.Origin[1]+pt[1], &v, sh)
		WindPointAt(&at, c.Origin[0]+pt[0], c.Origin[1]+pt[1], &o, nil)
		c.Values = append(c.Values, bits(&v))
		c.Open = append(c.Open, bits(&o))
	}
	// The hill's cell at the grid's middle, the mean wind's direction there.
	q, r := HexAt(200, 0)
	col, row := HexCell(q, r)
	c.A0, c.B0 = col/ShelterCell-leeSide/2, row/ShelterCell-leeSide/2
	var mean WindPoint
	WindPointAt(&at, 200, 0, &mean, nil)
	c.From = toHex(mean.MeanFrom)
	c.Grid = c.Grid[:0]
	for j := range int32(leeSide) {
		for i := range int32(leeSide) {
			x, y := ShelterCellCentre(c.A0+i, c.B0+j)
			f, _ := sh.At(x, y, mean.MeanFrom)
			c.Grid = append(c.Grid, toHex(f))
		}
	}
}

func TestLeeFile(t *testing.T) {
	gp := new(GroundPrepared)
	PrepareGround(&testGroundParams, gp)
	_, sh, err := readTerrain("lee", gp)
	if err != nil {
		t.Fatal(err)
	}
	p := testWeather(t)
	cases, spells := leeCases(t, p)
	got := leeFileData{
		Comment: "Written by go test ./internal/physics -run LeeFile -update. Floats marked as bits are their IEEE 754 bits in hexadecimal.",
		Terrain: "lee",
	}
	for i := range cases {
		fillLeeCase(&cases[i], weatherOf(p, spells[i]...), sh)
		sheltered := 0
		for k := range cases[i].Values {
			if cases[i].Values[k] != cases[i].Open[k] {
				sheltered++
			}
		}
		// Enough of the points lie in the lee or beside it to test it.
		if sheltered < 40 {
			t.Errorf("%s: only %d of the points feel the shelter", cases[i].Name, sheltered)
		}
	}
	got.Cases = cases
	if *update {
		data, err := json.Marshal(got)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(leeFile, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s", leeFile)
		return
	}
	data, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var round, want leeFileData
	if err := json.Unmarshal(data, &round); err != nil {
		t.Fatal(err)
	}
	readJSON(t, leeFile, &want)
	if len(round.Cases) != len(want.Cases) {
		t.Fatalf("%d cases, lee.json has %d: rewrite it with -update", len(round.Cases), len(want.Cases))
	}
	for i, c := range round.Cases {
		if !reflect.DeepEqual(c, want.Cases[i]) {
			t.Errorf("%s: differs from lee.json", c.Name)
		}
	}
}
