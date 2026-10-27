// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"encoding/json"
	"math"
	"os"
	"reflect"
	"testing"
)

// The forecast as Go makes it, for the client to check its module against:
// testdata/forecast.json holds, for a few weathers, the spells in play and
// the systems' records an issue is made from, the forecast and the gale
// scan made, and at ticks between the steps the wind, its typical gust and
// the pressure the forecast gives. The sandbox makes its forecast in the
// module from the same records as the server, so the two must give the
// same bits. After a deliberate change, rewrite it with
//
//	go test ./internal/physics -run ForecastFile -update

const forecastFile = "testdata/forecast.json"

type forecastFileData struct {
	Comment string         `json:"comment"`
	Cases   []forecastCase `json:"cases"`
}

type forecastCase struct {
	Name    string           `json:"name"`
	Issue   float64          `json:"issue"`
	End     float64          `json:"end"`
	Every   float64          `json:"every"`
	Spells  []map[string]any `json:"spells"`
	Records []map[string]any `json:"records"`
	// Head is the forecast's head, Spells its spells and Systems its
	// systems, as bits; Gales its gale at each step.
	Head     map[string]any   `json:"head"`
	FSpells  []map[string]any `json:"forecastSpells"`
	Systems  []map[string]any `json:"systems"`
	Gales    []map[string]any `json:"gales"`
	GalesOn  []int            `json:"galesOn"`
	Ticks    []float64        `json:"ticks"`
	Points   [][2]float64     `json:"points"`
	Wind     [][]string       `json:"wind"`
	Typical  [][]string       `json:"typical"`
	Pressure [][]string       `json:"pressure"`
}

// testForecast is the catalog's wind, its kinds and its forecast,
// prepared.
func testForecast(t testing.TB) (*WeatherPrepared, map[string]int32) {
	t.Helper()
	p, kinds := testSystems(t)
	c, err := readCatalogWeather()
	if err != nil {
		t.Fatal(err)
	}
	f := c.Weather.Forecast
	p.PrepareForecast(&ForecastParams{
		Every: f.Every, Horizon: f.Horizon, Step: f.Step,
		GaleMean: f.Gale.Mean, GaleGust: f.Gale.Gust, Quantile: f.Gale.Quantile, Grid: f.Gale.Grid, Within: f.Gale.Within,
	})
	return p, kinds
}

// catalogForecast is the catalog's forecast as the tests read it.
type catalogForecast struct {
	Every, Horizon, Step float64
	Gale                 struct{ Mean, Gust, Quantile, Grid, Within float64 }
}

// forecastRecords are a squall beyond the windward lip, a shower, a fog
// bank, a storm on its arc, a storm born within the horizon and a shower
// born after the issue, about an issue.
func forecastRecords(kinds map[string]int32, issue float64) []SystemRecord {
	m := float64(minuteTicks)
	squall := SystemRecord{Kind: float64(kinds["squall"]), Seed: 1618033, Born: issue - 4*m, Mature: issue + 6*m,
		Decays: issue + 26*m, Gone: issue + 36*m, East: -9800 * 4, North: 1200 * 4, Heading: math.Round(85 * degreeSteps),
		Speed: 620, Size: 0.45 * nm, Peak: math.Round(16 * knotSteps), Depth: 300,
		Wobble: 0.4 * nm * 4, WobblePeriod: [2]float64{400 * m, 600 * m}, WobblePhase: [2]float64{1000, 30000},
		Throb: 400, ThrobPeriod: 500 * m, ThrobPhase: 12000}
	shower := SystemRecord{Kind: float64(kinds["shower"]), Seed: 2653589, Born: issue - 8*m, Mature: issue - 3*m,
		Decays: issue + 7*m, Gone: issue + 12*m, East: 900 * 4, North: -600 * 4, Heading: math.Round(80 * degreeSteps),
		Speed: 600, Size: 0.25 * nm, Peak: math.Round(6 * knotSteps), Depth: 100,
		Wobble: 0.3 * nm * 4, WobblePeriod: [2]float64{380 * m, 700 * m}, WobblePhase: [2]float64{5000, 9000}}
	fog := SystemRecord{Kind: float64(kinds["fog"]), Seed: 141421356, Born: issue - 30*m, Mature: issue - 10*m,
		Decays: issue + 20*m, Gone: issue + 40*m, East: -2000 * 4, North: -2500 * 4, Heading: math.Round(60 * degreeSteps),
		Speed: 200, Size: 0.9 * nm, Peak: 900,
		Wobble: 0.45 * nm * 4, WobblePeriod: [2]float64{420 * m, 500 * m}, WobblePhase: [2]float64{30000, 61000}}
	storm := SystemRecord{Kind: float64(kinds["storm"]), Seed: 979323846, Born: issue - 50*m, Mature: issue - 20*m,
		Decays: issue + 40*m, Gone: issue + 110*m, Track: TrackArc, Radius: 3.6 * nm * 4, Angle: math.Round(210 * degreeSteps),
		Sense: -1, Speed: 280, Size: 2 * nm, Peak: math.Round(24 * knotSteps), Depth: 1800,
		Wobble: 0.5 * nm * 4, WobblePeriod: [2]float64{450 * m, 650 * m}, WobblePhase: [2]float64{7000, 45000},
		Throb: 500, ThrobPeriod: 520 * m, ThrobPhase: 33000}
	forming := SystemRecord{Kind: float64(kinds["storm"]), Seed: 31415926, Born: issue + 25*m, Mature: issue + 60*m,
		Decays: issue + 100*m, Gone: issue + 150*m, Track: TrackArc, Radius: 3.2 * nm * 4, Angle: math.Round(20 * degreeSteps),
		Sense: 1, Inward: 30, Speed: 300, Size: 1.8 * nm, Peak: math.Round(22 * knotSteps), Depth: 1500,
		Wobble: 0.4 * nm * 4, WobblePeriod: [2]float64{500 * m, 700 * m}}
	// A shower born after the issue.
	later := shower
	later.Seed, later.Born, later.Mature, later.Decays, later.Gone = 7777, issue+15*m, issue+20*m, issue+30*m, issue+35*m
	return []SystemRecord{squall, shower, fog, storm, forming, later}
}

func forecastCases(t *testing.T, p *WeatherPrepared, kinds map[string]int32) []forecastCase {
	const issue = 740_016_000 // a boundary of ten minutes
	m := float64(minuteTicks)
	stormy := spellOfRegime(t, p, "stormy", 3, 250, issue-hourOfTicks, 3*hourOfTicks)
	stormy.Regime, stormy.Pressure = 3, 99800
	// A front coming 40 minutes after the issue, and a plain change after
	// it.
	front := frontSpell(t, p, issue+40*m)
	front.Regime = 2
	trade := spellOfRegime(t, p, "trade", 9, 300, issue+70*m, 6*hourOfTicks)
	trade.Regime, trade.Change, trade.Pressure = 1, 10*m, 101700
	settled := spellOfRegime(t, p, "settled", 4, 200, issue-2*hourOfTicks, 6*hourOfTicks)
	settled.Regime, settled.Pressure = 0, 102400
	records := func(rs []SystemRecord) []map[string]any {
		var out []map[string]any
		for _, r := range rs {
			out = append(out, recordMap(r))
		}
		return out
	}
	all := forecastRecords(kinds, issue)
	return []forecastCase{
		{Name: "a stormy spell, a front and a change", Issue: issue, Every: 300, Spells: []map[string]any{spellMap(stormy), spellMap(front), spellMap(trade)}, Records: records(all)},
		{Name: "at the world's end", Issue: issue, End: issue + 45*m, Every: 300, Spells: []map[string]any{spellMap(stormy), spellMap(front)}, Records: records(all[:4])},
		{Name: "a settled spell", Issue: issue + 3*hourOfTicks, Every: 300, Spells: []map[string]any{spellMap(settled)}, Records: nil},
	}
}

func fillForecastCase(t *testing.T, p *WeatherPrepared, c *forecastCase) {
	in := ForecastInput{Issue: c.Issue, End: c.End, Every: c.Every}
	for _, s := range c.Spells {
		var sp Spell
		if err := setRecord(&sp, s); err != nil {
			t.Fatal(err)
		}
		in.Spells = append(in.Spells, sp)
	}
	for _, r := range c.Records {
		var rec SystemRecord
		if err := setRecord(&rec, r); err != nil {
			t.Fatal(err)
		}
		in.Records = append(in.Records, rec)
	}
	var f Forecast
	MakeForecast(p, &in, &f)
	c.Head = recordBits(f.Head)
	c.FSpells, c.Systems, c.Gales = nil, nil, nil
	for i := range int(f.Head.NSpells) {
		c.FSpells = append(c.FSpells, recordBits(f.Spells[i]))
	}
	for i := range int(f.Head.NSystems) {
		c.Systems = append(c.Systems, recordBits(f.Systems[i]))
	}
	water := make([]uint8, MaxGaleSide*MaxGaleSide)
	for i := range water {
		water[i] = 1
	}
	on := make([]uint8, len(water))
	var w Weather
	var at WeatherTick
	var g Gales
	GaleScan(p, &f, &w, &at, water, on, &g)
	for k := range int(f.Head.Steps) {
		c.Gales = append(c.Gales, recordBits(g.Steps[k]))
	}
	c.GalesOn = nil
	for i, v := range on {
		if v != 0 {
			c.GalesOn = append(c.GalesOn, i)
		}
	}
	c.Ticks = []float64{c.Issue, c.Issue + 300, c.Issue + 7*minuteTicks + 15, c.Issue + 33*minuteTicks, c.Issue + 61*minuteTicks + 0.5, c.Issue + 89*minuteTicks}
	c.Points = [][2]float64{{0, 0}, {-3000, 1000}, {2500, -2500}, {-1500, -6500}, {-7000, 1500}, {600, 5200}, {4100, 3300}}
	c.Wind, c.Typical, c.Pressure = nil, nil, nil
	fw := Weather{Prepared: p}
	for _, tick := range c.Ticks {
		ForecastAt(&fw, &f, tick)
		WeatherAt(&fw, &at, tick)
		var wind, typical, pressure []string
		for _, pt := range c.Points {
			var wp WindPoint
			WindPointAt(&at, pt[0], pt[1], &wp, nil)
			wind = append(wind, toHex(wp.Speed), toHex(wp.From), toHex(wp.MeanSpeed), toHex(wp.MeanFrom))
			mean, from, gust, _ := TypicalAt(&at, pt[0], pt[1])
			typical = append(typical, toHex(mean), toHex(from), toHex(gust))
			pressure = append(pressure, toHex(PressureAt(&at, pt[0], pt[1])))
		}
		c.Wind = append(c.Wind, wind)
		c.Typical = append(c.Typical, typical)
		c.Pressure = append(c.Pressure, pressure)
	}
}

func TestForecastFile(t *testing.T) {
	p, kinds := testForecast(t)
	cases := forecastCases(t, p, kinds)
	got := forecastFileData{
		Comment: "Written by go test ./internal/physics -run ForecastFile -update. Floats marked as bits are their IEEE 754 bits in hexadecimal.",
	}
	data, err := json.Marshal(cases)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for i := range cases {
		fillForecastCase(t, p, &cases[i])
	}
	got.Cases = cases
	if *update {
		data, err := json.Marshal(got)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(forecastFile, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s", forecastFile)
		return
	}
	data, err = json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var round, want forecastFileData
	if err := json.Unmarshal(data, &round); err != nil {
		t.Fatal(err)
	}
	readJSON(t, forecastFile, &want)
	if len(round.Cases) != len(want.Cases) {
		t.Fatalf("%d cases, forecast.json has %d: rewrite it with -update", len(round.Cases), len(want.Cases))
	}
	for i, c := range round.Cases {
		if !reflect.DeepEqual(c, want.Cases[i]) {
			t.Errorf("%s: differs from forecast.json", c.Name)
		}
	}
}
