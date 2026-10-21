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

// Clouds and rain as Go computes them, for the client to check its module
// against: testdata/clouds.json holds, for a few weathers, the heaped
// clouds, the sheets' cover over a window of their lattice and at points
// between, the rain at points, and the cumulus and caps about a place. The
// client loads the same spells, keyframes, coming front and caps into its
// module, which must give the same bits. After a deliberate change, rewrite
// it with
//
//	go test ./internal/physics -run CloudsFile -update

const cloudsFile = "testdata/clouds.json"

type cloudsFileData struct {
	Comment string      `json:"comment"`
	Cases   []cloudCase `json:"cases"`
}

type cloudCase struct {
	Name   string           `json:"name"`
	Spells []map[string]any `json:"spells"`
	Keys   []windKey        `json:"keys,omitempty"`
	// Coming is the coming front's record; Caps the islands' caps, each its
	// centre and width.
	Coming map[string]any `json:"coming"`
	Caps   [][3]float64   `json:"caps,omitempty"`
	Tick   float64        `json:"tick"`
	// Origin is where the cumulus are asked about, Reach how far, and Sun
	// the sun's height, rad.
	Origin [2]float64 `json:"origin"`
	Reach  float64    `json:"reach"`
	Sun    float64    `json:"sun"`
	// Clouds are the heaped clouds' records, and Cumulus the cumulus's,
	// each field's value as bits.
	Clouds  []map[string]string `json:"clouds"`
	Cumulus []map[string]string `json:"cumulus"`
	// Grid is the sheets' cover at the lattice's points from (I0, J0),
	// N a side, as SheetGrid writes them, as bits.
	I0   int32    `json:"i0"`
	J0   int32    `json:"j0"`
	N    int32    `json:"n"`
	Grid []string `json:"grid"`
	// Points are metres east and north of the world's centre; Sheets the
	// cover there, and Rain the rain, as bits.
	Points [][2]float64 `json:"points"`
	Sheets [][3]string  `json:"sheets"`
	Rain   []string     `json:"rain"`
}

// bitsMap is a record's fields as bits, by the names the client gives them.
func bitsMap(r any) map[string]string {
	out := map[string]string{}
	v := reflect.ValueOf(r)
	for i := range v.NumField() {
		out[lowerFirst(v.Type().Field(i).Name)] = toHex(v.Field(i).Float())
	}
	return out
}

func cloudCases(t *testing.T, p *WeatherPrepared, kinds map[string]int32) []cloudCase {
	const now = 740_000_000
	trade := spellOfRegime(t, p, "trade", 1, 225, now-2*hourOfTicks, 8*hourOfTicks)
	trade.Regime = 1
	front := frontSpell(t, p, now+100*minuteTicks)
	coming := ComingFront{On: 1, Begin: front.Begin, Change: front.Change, Toward: front.Toward}
	stormy := spellOfRegime(t, p, "stormy", 3, 250, now-hourOfTicks, 2*hourOfTicks)
	stormy.Regime = 3
	key := func(tick float64, systems map[int]System) Keyframe {
		k := Keyframe{Tick: tick}
		for slot, s := range systems {
			k.Systems[slot] = s
		}
		return k
	}
	squall := systemAt(kinds["squall"], -1500, 900, 75, 0.45*nm, 16, 3)
	squall.Strength = 0.4 * strengthSteps
	squall.Seed = 123456789
	shower := systemAt(kinds["shower"], 1200, -700, 80, 0.25*nm, 6, 1)
	shower.Strength = 0.7 * strengthSteps
	shower.Seed = 3141592653
	storm := systemAt(kinds["storm"], -3000, -2500, 160, 2*nm, 22, 15)
	storm.Strength = 0.35 * strengthSteps
	storm.Seed = 2718281828
	moved := squall
	moved.East += 4 * 60
	moved.Strength = 0.5 * strengthSteps
	cases := []cloudCase{
		{Name: "trade, with caps", Tick: now + 0.5, Origin: [2]float64{300, -200}, Reach: 3500, Sun: 0.5,
			Caps: [][3]float64{{1500, -800, 900}, {-2200, 1900, 2600}}},
		{Name: "a front coming", Tick: now, Origin: [2]float64{-11000, 1800}, Reach: 3500, Sun: 0.2},
		{Name: "a front passing", Tick: now + 100*minuteTicks, Origin: [2]float64{-500, 0}, Reach: 3500, Sun: 0.2},
		{Name: "systems", Tick: now + 111.5, Origin: [2]float64{-1000, 0}, Reach: 3000, Sun: -0.3},
	}
	set := func(c *cloudCase, w *Weather) {
		c.Spells = nil
		for i := range w.Count {
			c.Spells = append(c.Spells, spellMap(w.Spells[i]))
		}
		c.Coming = recordMap(w.Coming)
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
	}
	w := weatherOf(p, trade)
	set(&cases[0], w)
	w = weatherOf(p, trade)
	w.SetComing(&coming)
	set(&cases[1], w)
	w = weatherOf(p, trade, front)
	set(&cases[2], w)
	w = weatherOf(p, stormy)
	b := float64(int64(now) / 300 * 300)
	w.SetKeys([]Keyframe{key(b, map[int]System{0: squall, 3: shower, 7: storm}), key(b+300, map[int]System{0: moved, 7: storm, 9: shower})})
	set(&cases[3], w)
	return cases
}

func fillCloudCase(t *testing.T, p *WeatherPrepared, c *cloudCase) {
	w := &Weather{Prepared: p}
	for i, s := range c.Spells {
		var sp Spell
		if err := setRecord(&sp, s); err != nil {
			t.Fatal(err)
		}
		w.SetSpell(int32(i), &sp)
	}
	w.SetCount(int32(len(c.Spells)))
	var coming ComingFront
	if err := setRecord(&coming, c.Coming); err != nil {
		t.Fatal(err)
	}
	w.SetComing(&coming)
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
	var at WeatherTick
	WeatherAt(w, &at, c.Tick)

	var clouds [MaxClouds]Cloud
	c.Clouds = nil
	for _, cl := range clouds[:HeapedClouds(&at, clouds[:])] {
		c.Clouds = append(c.Clouds, bitsMap(cl))
	}
	caps := make([]Cap, len(c.Caps))
	for i, k := range c.Caps {
		caps[i] = Cap{East: k[0], North: k[1], Width: k[2]}
	}
	var cumulus [MaxCumulus]Cumulus
	c.Cumulus = nil
	for _, cu := range cumulus[:CumulusAt(&at, c.Origin[0], c.Origin[1], c.Reach, c.Sun, caps, cumulus[:])] {
		c.Cumulus = append(c.Cumulus, bitsMap(cu))
	}
	L := p.SheetLattice()
	c.N = 16
	c.I0 = int32(math.Floor(c.Origin[0]/L)) - 8
	c.J0 = int32(math.Floor(c.Origin[1]/L)) - 8
	grid := make([]float64, Layers*c.N*c.N)
	SheetGrid(&at, c.I0, c.J0, c.N, grid)
	c.Grid = c.Grid[:0]
	for _, v := range grid {
		c.Grid = append(c.Grid, toHex(v))
	}
	rng := rand.New(rand.NewPCG(uint64(len(c.Name)), 32))
	c.Points = c.Points[:0]
	c.Sheets = c.Sheets[:0]
	c.Rain = c.Rain[:0]
	for range 120 {
		x := c.Origin[0] + math.Round((2*rng.Float64()-1)*6000*4)/4
		y := c.Origin[1] + math.Round((2*rng.Float64()-1)*6000*4)/4
		c.Points = append(c.Points, [2]float64{x, y})
		s := SheetAt(&at, x, y)
		c.Sheets = append(c.Sheets, [3]string{toHex(s.Cirrus), toHex(s.Middle), toHex(s.Low)})
		c.Rain = append(c.Rain, toHex(RainAt(&at, x, y)))
	}
}

func TestCloudsFile(t *testing.T) {
	p, kinds := testSystems(t)
	cases := cloudCases(t, p, kinds)
	got := cloudsFileData{
		Comment: "Written by go test ./internal/physics -run CloudsFile -update. Floats marked as bits are their IEEE 754 bits in hexadecimal.",
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
	clouded, raining, cumulus := 0, 0, 0
	for i := range cases {
		fillCloudCase(t, p, &cases[i])
		clouded += len(cases[i].Clouds)
		cumulus += len(cases[i].Cumulus)
		for _, r := range cases[i].Rain {
			if fromHex(t, r) > 1 {
				raining++
			}
		}
	}
	if clouded < 3 || raining < 5 || cumulus < 5 {
		t.Errorf("%d heaped clouds, %d points in rain and %d cumulus: too few to check", clouded, raining, cumulus)
	}
	got.Cases = cases
	if *update {
		data, err := json.Marshal(got)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(cloudsFile, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s", cloudsFile)
		return
	}
	data, err = json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var round, want cloudsFileData
	if err := json.Unmarshal(data, &round); err != nil {
		t.Fatal(err)
	}
	readJSON(t, cloudsFile, &want)
	if len(round.Cases) != len(want.Cases) {
		t.Fatalf("%d cases, clouds.json has %d: rewrite it with -update", len(round.Cases), len(want.Cases))
	}
	for i, c := range round.Cases {
		if !reflect.DeepEqual(c, want.Cases[i]) {
			t.Errorf("%s: differs from clouds.json", c.Name)
		}
	}
}
