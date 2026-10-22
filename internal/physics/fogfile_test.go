// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"encoding/json"
	"math"
	"math/rand/v2"
	"os"
	"reflect"
	"strconv"
	"testing"
)

// Visibility and lightning as Go computes them, for the client to check
// its module against: testdata/fog.json holds, for a few weathers, the fog
// and the air's extinction at points, the visibility at them, the optical
// depth along lines, the sources of extinction about a place, and the
// flashes over slots of world time. The client loads the same spells,
// keyframes and records into its module, which must give the same bits.
// After a deliberate change, rewrite it with
//
//	go test ./internal/physics -run FogFile -update

const fogFile = "testdata/fog.json"

type fogFileData struct {
	Comment string    `json:"comment"`
	Cases   []fogCase `json:"cases"`
}

type fogCase struct {
	Name    string           `json:"name"`
	Spells  []map[string]any `json:"spells"`
	Keys    []windKey        `json:"keys,omitempty"`
	Records []map[string]any `json:"records,omitempty"`
	Tick    float64          `json:"tick"`
	// Points are m east and north and m above the sea; Fog the fog there,
	// Air the extinction by what makes it (clear, fog, rain, mist), Vis
	// the visibility at the point's place, as bits.
	Points [][3]float64 `json:"points"`
	Fog    []string     `json:"fog"`
	Air    [][4]string  `json:"air"`
	Vis    []string     `json:"vis"`
	// Lines are from (x, y, h) to (x, y, h); Depth the optical depth
	// along each, as bits.
	Lines [][6]float64 `json:"lines"`
	Depth []string     `json:"depth"`
	// Origin is where the sources are asked about and how far: x, y, r.
	// FogSources is how many of them are fog banks, Sources their records.
	Origin     [3]float64       `json:"origin"`
	FogSources int              `json:"fogSources"`
	Sources    []map[string]any `json:"sources"`
	// Slots are slots of world time; Flashes the flashes in each.
	Slots   []float64          `json:"slots"`
	Flashes [][]map[string]any `json:"flashes"`
}

// recordBits is a record's fields as bits, an array's as a list of them,
// by the names the client gives them.
func recordBits(r any) map[string]any {
	out := map[string]any{}
	v := reflect.ValueOf(r)
	for i := range v.NumField() {
		f := v.Field(i)
		name := lowerFirst(v.Type().Field(i).Name)
		if f.Kind() == reflect.Array {
			list := make([]string, f.Len())
			for j := range list {
				list[j] = toHex(f.Index(j).Float())
			}
			out[name] = list
			continue
		}
		out[name] = toHex(f.Float())
	}
	return out
}

func fogCases(t *testing.T, p *WeatherPrepared, kinds map[string]int32) []fogCase {
	const now = 740_000_000
	b := float64(int64(now) / 300 * 300)
	key := func(tick float64, systems map[int]System) windKey {
		k := windKey{Tick: tick, Systems: map[string]map[string]any{}}
		for slot, s := range systems {
			k.Systems[strconv.Itoa(slot)] = recordMap(s)
		}
		return k
	}
	trade := spellOfRegime(t, p, "trade", 1, 225, now-2*hourOfTicks, 8*hourOfTicks)
	trade.Regime = 1
	front := frontSpell(t, p, now+60)
	stormy := spellOfRegime(t, p, "stormy", 3, 250, now-hourOfTicks, 2*hourOfTicks)
	stormy.Regime = 3
	settled := spellOfRegime(t, p, "settled", 4, 200, now-hourOfTicks, 6*hourOfTicks)

	banks := map[int]System{
		0: fogBank(kinds, -400, 300, 70, 1600, 0.9, 123456789),
		2: fogBank(kinds, 1800, -900, 160, 900, 0.5, 2718281828),
		5: fogBank(kinds, -2500, -2000, 20, 2400, 1.1, 42),
	}
	drifted := map[int]System{}
	for slot, s := range banks {
		s.East += 4 * 25
		s.Strength = math.Min(s.Strength+200, strengthSteps*1.2)
		drifted[slot] = s
	}
	squall := systemAt(kinds["squall"], -600, 700, 75, 0.45*nm, 16, 3)
	squall.Strength = 0.8 * strengthSteps
	squall.Seed = 314159
	shower := systemAt(kinds["shower"], 900, -600, 80, 0.25*nm, 6, 1)
	shower.Strength = 0.7 * strengthSteps
	shower.Seed = 2653589
	storm := systemAt(kinds["storm"], -5200, 4200, 160, 2*nm, 22, 15)
	storm.Strength = 0.9 * strengthSteps
	storm.Seed = 979323846

	cases := []fogCase{
		{
			Name: "fog banks", Spells: []map[string]any{spellMap(settled)}, Tick: b + 111.5,
			Keys:   []windKey{key(b, banks), key(b+300, drifted)},
			Origin: [3]float64{0, 0, 6000},
		},
		{
			Name: "rain", Spells: []map[string]any{spellMap(trade), spellMap(front)}, Tick: b + 200.25,
			Keys:   []windKey{key(b, map[int]System{0: squall, 3: shower}), key(b+300, map[int]System{0: squall, 3: shower})},
			Origin: [3]float64{-300, 200, 5000},
		},
		{
			Name: "a storm at the edge", Spells: []map[string]any{spellMap(stormy)}, Tick: b + 17,
			Keys:   []windKey{key(b, map[int]System{7: storm}), key(b+300, map[int]System{7: storm})},
			Origin: [3]float64{-4000, 5000, 4000},
		},
	}
	// Lightning: a squall and a storm from their records, over a minute's
	// slots and more.
	sq := SystemRecord{Kind: float64(kinds["squall"]), Seed: 1618033, Born: b - 20*minuteTicks, Mature: b - 15*minuteTicks,
		Decays: b + 30*minuteTicks, Gone: b + 40*minuteTicks, East: -2000 * 4, North: 600 * 4, Heading: math.Round(80 * degreeSteps),
		Speed: 300, Size: 0.5 * nm, Peak: math.Round(16 * knotSteps), Depth: 300, Throb: 300, ThrobPeriod: 20 * minuteTicks}
	st := SystemRecord{Kind: float64(kinds["storm"]), Seed: 141421356, Born: b - 60*minuteTicks, Mature: b - 30*minuteTicks,
		Decays: b + 60*minuteTicks, Gone: b + 120*minuteTicks, East: 4000 * 4, North: -3000 * 4, Heading: math.Round(300 * degreeSteps),
		Speed: 400, Size: 2 * nm, Peak: math.Round(22 * knotSteps), Depth: 1500}
	lightning := fogCase{
		Name: "lightning", Spells: []map[string]any{spellMap(stormy)}, Tick: b + 33,
		Records: []map[string]any{recordMap(sq), recordMap(st)},
		Origin:  [3]float64{0, 0, 8000},
	}
	first := p.FlashSlot(b)
	for i := range 90 {
		lightning.Slots = append(lightning.Slots, first+float64(i))
	}
	return append(cases, lightning)
}

func fillFogCase(t *testing.T, p *WeatherPrepared, c *fogCase) {
	w := &Weather{Prepared: p}
	for i, s := range c.Spells {
		var sp Spell
		if err := setRecord(&sp, s); err != nil {
			t.Fatal(err)
		}
		w.SetSpell(int32(i), &sp)
	}
	w.SetCount(int32(len(c.Spells)))
	var keys []Keyframe
	for _, k := range c.Keys {
		key := Keyframe{Tick: k.Tick}
		for slot, s := range k.Systems {
			i, _ := strconv.Atoi(slot)
			if err := setRecord(&key.Systems[i], s); err != nil {
				t.Fatal(err)
			}
		}
		keys = append(keys, key)
	}
	w.SetKeys(keys)
	for i, r := range c.Records {
		var rec SystemRecord
		if err := setRecord(&rec, r); err != nil {
			t.Fatal(err)
		}
		w.SetRecord(int32(i), &rec)
	}
	w.SetRecordCount(int32(len(c.Records)))
	var at WeatherTick
	WeatherAt(w, &at, c.Tick)

	rng := rand.New(rand.NewPCG(uint64(len(c.Name)), 33))
	c.Points, c.Fog, c.Air, c.Vis = nil, nil, nil, nil
	for range 80 {
		x := c.Origin[0] + math.Round((2*rng.Float64()-1)*c.Origin[2]*4)/4
		y := c.Origin[1] + math.Round((2*rng.Float64()-1)*c.Origin[2]*4)/4
		h := math.Round(rng.Float64()*rng.Float64()*400*4) / 4
		c.Points = append(c.Points, [3]float64{x, y, h})
		c.Fog = append(c.Fog, toHex(FogAt(&at, x, y, h)))
		a := AirAt(&at, x, y, h)
		c.Air = append(c.Air, [4]string{toHex(a.Clear), toHex(a.Fog), toHex(a.Rain), toHex(a.Mist)})
		c.Vis = append(c.Vis, toHex(VisibilityAt(&at, x, y)))
	}
	c.Lines, c.Depth = nil, nil
	for range 80 {
		x0 := c.Origin[0] + math.Round((2*rng.Float64()-1)*c.Origin[2]*4)/4
		y0 := c.Origin[1] + math.Round((2*rng.Float64()-1)*c.Origin[2]*4)/4
		x1 := x0 + math.Round((2*rng.Float64()-1)*2500*4)/4
		y1 := y0 + math.Round((2*rng.Float64()-1)*2500*4)/4
		h0, h1 := 2+math.Round(rng.Float64()*30*4)/4, math.Round(rng.Float64()*rng.Float64()*600*4)/4
		c.Lines = append(c.Lines, [6]float64{x0, y0, h0, x1, y1, h1})
		c.Depth = append(c.Depth, toHex(OpticalDepth(&at, x0, y0, h0, x1, y1, h1)))
	}
	var sources [MaxAirSources]AirSource
	fog, n := AirSources(&at, c.Origin[0], c.Origin[1], c.Origin[2], sources[:])
	c.FogSources, c.Sources = fog, nil
	for _, s := range sources[:n] {
		c.Sources = append(c.Sources, recordBits(s))
	}
	c.Flashes = nil
	var flashes [MaxFlashes]Flash
	for _, slot := range c.Slots {
		WeatherAt(w, &at, slot*p.SlotTicks())
		list := []map[string]any{}
		for _, f := range flashes[:Flashes(&at, slot, flashes[:])] {
			list = append(list, recordBits(f))
		}
		c.Flashes = append(c.Flashes, list)
	}
}

func TestFogFile(t *testing.T) {
	p, kinds := testSystems(t)
	cases := fogCases(t, p, kinds)
	got := fogFileData{
		Comment: "Written by go test ./internal/physics -run FogFile -update. Floats marked as bits are their IEEE 754 bits in hexadecimal.",
	}
	// Each case is filled from its records as read back, as the client
	// reads them.
	data, err := json.Marshal(cases)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	fogged, rained, misted, flashed := 0, 0, 0, 0
	for i := range cases {
		fillFogCase(t, p, &cases[i])
		for _, a := range cases[i].Air {
			if fromHex(t, a[1]) > 0.002 {
				fogged++
			}
			if fromHex(t, a[2]) > 0.001 {
				rained++
			}
			if fromHex(t, a[3]) > 0.001 {
				misted++
			}
		}
		for _, f := range cases[i].Flashes {
			flashed += len(f)
		}
	}
	if fogged < 10 || rained < 5 || misted < 3 || flashed < 10 {
		t.Errorf("%d points in fog, %d in rain, %d in the mist and %d flashes: too few to check", fogged, rained, misted, flashed)
	}
	got.Cases = cases
	if *update {
		data, err := json.Marshal(got)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fogFile, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s", fogFile)
		return
	}
	data, err = json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var round, want fogFileData
	if err := json.Unmarshal(data, &round); err != nil {
		t.Fatal(err)
	}
	readJSON(t, fogFile, &want)
	if len(round.Cases) != len(want.Cases) {
		t.Fatalf("%d cases, fog.json has %d: rewrite it with -update", len(round.Cases), len(want.Cases))
	}
	for i, c := range round.Cases {
		if !reflect.DeepEqual(c, want.Cases[i]) {
			t.Errorf("%s: differs from fog.json", c.Name)
		}
	}
}
