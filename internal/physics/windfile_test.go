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

// The wind as Go computes it, for the client to check its copies against:
// testdata/wind.json holds, for a few weathers, ticks and places, the wind
// in full at points about the place, the gust field's frame, and the wave
// wind there. The client's tests load the same spells into the WebAssembly
// module, which must give the same bits, and into the GPU's copy of the
// gust field, which must agree within what its 32-bit floats are good for.
// After a deliberate change to the wind, rewrite it with
//
//	go test ./internal/physics -run WindFile -update

const windFile = "testdata/wind.json"

type windFileData struct {
	Comment string     `json:"comment"`
	Cases   []windCase `json:"cases"`
}

type windCase struct {
	Name string `json:"name"`
	// Spells are the spells in play, each field a whole number, and Tick
	// the tick the wind is asked about.
	Spells []map[string]any `json:"spells"`
	Tick   float64          `json:"tick"`
	// Origin is the place the points lie about, metres east and north of
	// the world's centre.
	Origin [2]float64 `json:"origin"`
	// Points are metres east and north of the origin; Values, for each, the
	// wind's speed and direction, the mean wind's speed and direction, the
	// gust field and the gust factor, as bits.
	Points [][2]float64 `json:"points"`
	Values [][6]string  `json:"values"`
	// Frame is the gust field's frame, each field's values as bits.
	Frame map[string][]string `json:"frame"`
	// Wave is the wave wind at the origin: its speed and direction, as bits.
	Wave [2]string `json:"wave"`
	// Keys are the weather systems' keyframes, each its tick and its
	// systems by their slots, each field a whole number; Pressure the
	// pressure at each point, as bits.
	Keys     []windKey `json:"keys,omitempty"`
	Pressure []string  `json:"pressure"`
}

type windKey struct {
	Tick    float64                   `json:"tick"`
	Systems map[string]map[string]any `json:"systems"`
}

// recordMap is a record's fields by the names the client gives them.
func recordMap(r any) map[string]any {
	out := map[string]any{}
	v := reflect.ValueOf(r)
	for i := range v.NumField() {
		f := v.Field(i)
		name := lowerFirst(v.Type().Field(i).Name)
		if f.Kind() == reflect.Array {
			a := make([]any, f.Len())
			for j := range a {
				a[j] = f.Index(j).Float()
			}
			out[name] = a
		} else {
			out[name] = f.Float()
		}
	}
	return out
}

// spellMap is a spell's fields by the names the client gives them.
func spellMap(s Spell) map[string]any { return recordMap(s) }

// windCases are the weathers written: a trade spell at mid-disk, a stormy
// one in the refuge and at the rim late in a world's life, a change of
// spell part of the way through, a steady wind, systems of every kind
// between two keyframes, and a front crossing with a squall at its line.
func windCases(t *testing.T, p *WeatherPrepared) ([]windCase, [][]Spell) {
	const now, late = 740_000_000, 1<<31 + 1
	regime := map[string]float64{"settled": 0, "trade": 1, "unsettled": 2, "stormy": 3}
	spell := func(id string, n uint32, from, begin, length float64) Spell {
		s := spellOfRegime(t, p, id, n, from, begin, length)
		s.Regime = regime[id]
		return s
	}
	trade := spell("trade", 1, 20, now-3*hourOfTicks, 4*hourOfTicks)
	stormy := spell("stormy", 3, 250, now-hourOfTicks, 2*hourOfTicks)
	stormyLate := spell("stormy", 5, 110, late-hourOfTicks, 2*hourOfTicks)
	next := spell("unsettled", 2, 95, now-6000, 3*hourOfTicks)
	next.Change = float64(p.change)
	calm := spell("settled", 9, 300, now+9000, 5*hourOfTicks)
	calm.Change = float64(p.change)
	spells := [][]Spell{{trade}, {stormy}, {stormyLate}, {trade, next}, {trade, next, calm}, {SteadySpell(7.2, 4, now-50)}, {trade, SteadySpell(3, 1, now-10)}}
	cases := []windCase{
		{Name: "trade", Tick: now, Origin: [2]float64{-1200, 3700}},
		{Name: "stormy, in the refuge", Tick: now, Origin: [2]float64{400, -650.5}},
		{Name: "stormy at the rim, late", Tick: late, Origin: [2]float64{5869, 5869}},
		{Name: "a change", Tick: now, Origin: [2]float64{8300, -12.5}},
		{Name: "a change, before the next", Tick: now + 8800.5, Origin: [2]float64{-300, -200}},
		{Name: "steady", Tick: now, Origin: [2]float64{0, 0}},
		{Name: "steady, after a trade spell", Tick: now + 0.25, Origin: [2]float64{2000, 2000}},
		{Name: "systems", Tick: now + 111.5, Origin: [2]float64{-5500, 1200}},
		{Name: "a front", Tick: now, Origin: [2]float64{-200, 300}},
	}
	front := frontSpell(t, p, now)
	spells = append(spells, []Spell{trade}, []Spell{trade, front})
	return cases, spells
}

// windSystems are the keyframes of the windCases' weathers: none, but for
// systems of every kind about the systems case's place, and a squall at
// the front's line.
func windSystems(t *testing.T, kinds map[string]int32, name string, tick float64) []Keyframe {
	var out []Keyframe
	switch name {
	case "systems":
		b := float64(int64(tick) / 300 * 300)
		for k := range 2 {
			key := Keyframe{Tick: b + float64(k)*300}
			d := float64(k) * 60
			key.Systems[0] = systemAt(kinds["squall"], -5500+d, 1000, 75, 0.45*nm, 16, 3)
			key.Systems[1] = systemAt(kinds["storm"], -5000, 2500+d, 160, 2*nm, 22, 15)
			key.Systems[1].Strength = 3500 + float64(k)*200
			key.Systems[5] = systemAt(kinds["shower"], -5300, 1500, 75, 0.25*nm, 6, 1)
			key.Systems[9] = systemAt(kinds["fog"], -5600, 1100, 40, 0.8*nm, 0, 0)
			key.Systems[9].Peak = 900
			key.Systems[16] = systemAt(kinds["light-air"], -5450, 1250, 40, 0.3*nm, 0, 0)
			key.Systems[16].Peak = 400
			if k == 1 {
				// One born between the keyframes.
				key.Systems[3] = systemAt(kinds["squall"], -5800, 1300, 75, 0.35*nm, 14, 2)
			}
			out = append(out, key)
		}
	case "a front":
		key := Keyframe{Tick: tick - 100}
		key.Systems[2] = systemAt(kinds["squall"], -300, 250, 100, 0.4*nm, 15, 3)
		out = append(out, key)
	}
	return out
}

func fillWindCase(c *windCase, w *Weather) {
	c.Spells = nil
	for i := range w.Count {
		c.Spells = append(c.Spells, spellMap(w.Spells[i]))
	}
	c.Keys = nil
	for k := range w.NKeys {
		key := windKey{Tick: w.Keys[k].Tick, Systems: map[string]map[string]any{}}
		for slot, s := range w.Keys[k].Systems {
			if s.On != 0 {
				key.Systems[strconv.Itoa(slot)] = recordMap(s)
			}
		}
		c.Keys = append(c.Keys, key)
	}
	var at WeatherTick
	WeatherAt(w, &at, c.Tick)
	// Points on a quarter-metre grid, so that float32 holds them exactly:
	// most within the tiles' 150 m, some further.
	rng := rand.New(rand.NewPCG(uint64(len(c.Name)), 77))
	c.Points = [][2]float64{{0, 0}}
	for len(c.Points) < 240 {
		reach := 150.0
		if len(c.Points)%8 == 0 {
			reach = 640
		}
		c.Points = append(c.Points, [2]float64{math.Round((2*rng.Float64()-1)*reach*4) / 4, math.Round((2*rng.Float64()-1)*reach*4) / 4})
	}
	c.Values = c.Values[:0]
	c.Pressure = c.Pressure[:0]
	for _, pt := range c.Points {
		var v WindPoint
		WindPointAt(&at, c.Origin[0]+pt[0], c.Origin[1]+pt[1], &v, nil)
		c.Values = append(c.Values, [6]string{toHex(v.Speed), toHex(v.From), toHex(v.MeanSpeed), toHex(v.MeanFrom), toHex(v.Gust), toHex(v.Factor)})
		c.Pressure = append(c.Pressure, toHex(PressureAt(&at, c.Origin[0]+pt[0], c.Origin[1]+pt[1])))
	}
	var f GustFrame
	GustFrameAt(&at, &f)
	c.Frame = map[string][]string{}
	fv := reflect.ValueOf(f)
	for i := range fv.NumField() {
		var bits []string
		if x := fv.Field(i); x.Kind() == reflect.Array {
			for j := range x.Len() {
				bits = append(bits, toHex(x.Index(j).Float()))
			}
		} else {
			bits = append(bits, toHex(x.Float()))
		}
		c.Frame[lowerFirst(fv.Type().Field(i).Name)] = bits
	}
	var scratch WeatherTick
	var ring [MaxWaveSamples]WaveSample
	speed, from := WaveWindAt(w, c.Origin[0], c.Origin[1], c.Tick, &scratch, &ring)
	c.Wave = [2]string{toHex(speed), toHex(from)}
}

func TestWindFile(t *testing.T) {
	p, kinds := testSystems(t)
	cases, spells := windCases(t, p)
	got := windFileData{
		Comment: "Written by go test ./internal/physics -run WindFile -update. Floats marked as bits are their IEEE 754 bits in hexadecimal.",
	}
	gusty := 0
	for i := range cases {
		w := weatherOf(p, spells[i]...)
		w.SetKeys(windSystems(t, kinds, cases[i].Name, cases[i].Tick))
		fillWindCase(&cases[i], w)
		for _, v := range cases[i].Values {
			if g := fromHex(t, v[4]); math.Abs(g) > 0.5 {
				gusty++
			}
		}
	}
	got.Cases = cases
	if gusty < 100 {
		t.Errorf("only %d points lie in a strong gust or a deep lull", gusty)
	}
	if *update {
		data, err := json.Marshal(got)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(windFile, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s", windFile)
		return
	}
	// Compared as JSON read back: the spells' numbers are any, and a file
	// read gives them as float64.
	data, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var round, want windFileData
	if err := json.Unmarshal(data, &round); err != nil {
		t.Fatal(err)
	}
	readJSON(t, windFile, &want)
	if len(round.Cases) != len(want.Cases) {
		t.Fatalf("%d cases, wind.json has %d: rewrite it with -update", len(round.Cases), len(want.Cases))
	}
	for i, c := range round.Cases {
		if !reflect.DeepEqual(c, want.Cases[i]) {
			t.Errorf("%s: differs from wind.json", c.Name)
		}
	}
}
