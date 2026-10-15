// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"testing"
)

// testShelterParams are the catalog's starting values for the shelter.
var testShelterParams = ShelterParams{
	Reach: 800, Step: 16, Near: 3, Far: 10, Least: 0.3, Most: 1.3, SpeedUp: 0.3, Flank: 2, Turn: 20,
	Offsets: [4]float64{24, 48, 96, 192},
}

func newShelterField() ShelterField {
	f := ShelterField{
		Lee:   make([]float32, ShelterFieldSize),
		Right: make([]float32, ShelterFieldSize),
		Left:  make([]float32, ShelterFieldSize),
	}
	for i := range f.Lee {
		f.Lee[i] = 1
	}
	return f
}

// hill is a grid of heights with land of height h in the one cell that
// holds the point (x, y).
func hill(x, y, h float64) ShelterHeights {
	heights := make(ShelterHeights, ShelterFieldSize)
	i, _ := shelterCellAt(x, y)
	heights[i] = float32(h)
	return heights
}

// fieldAt is the factor and turn of the cell that holds (x, y).
func fieldAt(f *ShelterField, x, y float64, s *ShelterPrepared) (float64, float64) {
	i, _ := shelterCellAt(x, y)
	return ShelterAt(f, i, s)
}

func TestShelterOfOpenWater(t *testing.T) {
	var s ShelterPrepared
	PrepareShelter(&testShelterParams, &s)
	f := newShelterField()
	for k := range int32(ShelterDirections) {
		ShelterDirection(make(ShelterHeights, ShelterFieldSize), k, &s, &f)
	}
	for i := range f.Lee {
		if f.Lee[i] != 1 || f.Right[i] != 0 || f.Left[i] != 0 {
			t.Fatalf("cell %d is sheltered by no land", i)
		}
	}
}

func TestShelterOfAHill(t *testing.T) {
	var s ShelterPrepared
	PrepareShelter(&testShelterParams, &s)
	const h = 40.0
	ax, ay := ShelterCellCentre(300, 270)
	heights := hill(ax, ay, h)
	f := newShelterField()
	// A wind from the north: the lee lies south of the hill.
	ShelterDirection(heights, 0, &s, &f)
	near, _ := fieldAt(&f, ax, ay-2.5*h, &s)
	if math.Abs(near-0.3) > 1e-6 {
		t.Errorf("2.5 heights downwind the factor is %v, not the least, 0.3", near)
	}
	mid, _ := fieldAt(&f, ax, ay-6.5*h, &s)
	if !(mid > 0.4 && mid < 0.9) {
		t.Errorf("6.5 heights downwind the factor is %v, between the least and 1", mid)
	}
	far, _ := fieldAt(&f, ax, ay-11*h, &s)
	if far != 1 {
		t.Errorf("11 heights downwind the factor is %v, not 1", far)
	}
	up, _ := fieldAt(&f, ax, ay+3*h, &s)
	if up != 1 {
		t.Errorf("upwind the factor is %v, not 1", up)
	}
	// Beside the lee, within two heights of the hill's line, the wind is
	// faster and turned away from the hill.
	for _, side := range []float64{1, -1} {
		factor, turn := fieldAt(&f, ax+side*48, ay-3*h, &s)
		if !(factor > 1) {
			t.Errorf("48 m to the %v of the lee the factor is %v, not above 1", side, factor)
		}
		// East of the line, the hill lies to the right looking downwind
		// (south): the wind backs, turning anticlockwise, away from it.
		if side > 0 && !(turn < 0) || side < 0 && !(turn > 0) {
			t.Errorf("48 m to the %v of the lee the turn is %v", side, turn)
		}
	}
}

func TestShelterLookup(t *testing.T) {
	var s ShelterPrepared
	PrepareShelter(&testShelterParams, &s)
	ax, ay := ShelterCellCentre(300, 270)
	heights := hill(ax, ay, 30)
	sh := new(Shelter)
	for k := range int32(ShelterDirections) {
		f := newShelterField()
		ShelterDirection(heights, k, &s, &f)
		cols, rows := ShelterGrid()
		for a := range cols {
			for b := range rows {
				factor, turn := ShelterAt(&f, ShelterIndex(a, b), &s)
				fb, tb := ShelterBytes(factor, turn)
				if fb == ShelterFactorOne && tb == 0 {
					continue
				}
				n, i, _ := ShelterCellOf(a, b)
				if sh.Chunks[n] == nil {
					sh.Chunks[n] = new(ShelterChunk)
					for v := 0; v < len(sh.Chunks[n].Values); v += 2 {
						sh.Chunks[n].Values[v] = ShelterFactorOne
					}
				}
				v := sh.Chunks[n].Values[(i*ShelterDirections+k)*2:]
				v[0], v[1] = fb, tb
			}
		}
	}
	// At a cell's centre and a direction of the table, the lookup is the
	// table's value.
	cx, cy := ShelterCellCentre(300, 268)
	factor, _ := sh.At(cx, cy, 0)
	n, i, _ := ShelterCellOf(300, 268)
	if want := float64(sh.Chunks[n].Values[i*ShelterDirections*2]) / ShelterFactorOne; factor != want {
		t.Errorf("at a cell's centre the factor is %v, the table's %v", factor, want)
	}
	// Continuous: small moves in space and direction make small changes,
	// across the cells' and the chunks' edges too.
	worst := 0.0
	for k := range 4000 {
		x := ax - 300 + float64(k)*0.15
		y := ay - 70
		a, _ := sh.At(x, y, 0.1)
		b, _ := sh.At(x+0.05, y, 0.1)
		c, _ := sh.At(x, y, 0.1+0.0005)
		worst = max(worst, math.Abs(a-b), math.Abs(a-c))
	}
	if worst > 0.01 {
		t.Errorf("the factor jumps by %v between neighbouring points", worst)
	}
	// Far from any land, and off the grid, the wind is whole.
	if f, turn := sh.At(-5000, -5000, 1); f != 1 || turn != 0 {
		t.Errorf("open water's shelter is %v, %v", f, turn)
	}
	if f, turn := sh.At(1e6, 1e6, 1); f != 1 || turn != 0 {
		t.Errorf("off the grid the shelter is %v, %v", f, turn)
	}
}

func TestWindInShelter(t *testing.T) {
	var p WeatherParams
	weatherParamsForTest(t, &p)
	var w Weather
	w.Prepared = new(WeatherPrepared)
	PrepareWeather(&p, w.Prepared)
	s := SteadySpell(6, 0, 0)
	w.Set([]Spell{s})
	var at WeatherTick
	WeatherAt(&w, &at, 100)
	// An empty shelter is open water: bit for bit the wind with none.
	empty := new(Shelter)
	for _, pt := range [][2]float64{{0, 0}, {1234.5, -678.9}, {-4000, 3000}} {
		if a, b := WindAt(&at, pt[0], pt[1], nil), WindAt(&at, pt[0], pt[1], empty); a != b {
			t.Errorf("at %v an empty shelter changes the wind: %+v, %+v", pt, a, b)
		}
	}
}

// weatherParamsForTest fills p with the scenarios' wind values.
func weatherParamsForTest(t *testing.T, p *WeatherParams) {
	t.Helper()
	var sf scenarioFile
	readJSON(t, scenariosFile, &sf)
	if err := setRecord(p, sf.Wind); err != nil {
		t.Fatal(err)
	}
}
