// SPDX-License-Identifier: AGPL-3.0-only

package lookout

import (
	"encoding/json"
	"math"
	"os"
	"reflect"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
)

// soundsFile holds the cases what is heard and the page's are held to.
const soundsFile = "testdata/sounds.json"

type soundsData struct {
	Comment        string      `json:"comment"`
	SecondsPerHour float64     `json:"secondsPerHour"`
	Cases          []soundCase `json:"cases"`
}

// soundCase is a listener and the world about it, the interval of world
// time heard, and what the phone plays.
type soundCase struct {
	Name      string         `json:"name"`
	From      float64        `json:"from"`
	To        float64        `json:"to"`
	Seconds   float64        `json:"seconds"`
	East      float64        `json:"east"`
	North     float64        `json:"north"`
	Day       bool           `json:"day"`
	SeaHeight float64        `json:"seaHeight"`
	Lip       float64        `json:"lip"`
	Falling   bool           `json:"falling"`
	EndNear   float64        `json:"endNear"`
	Features  []FeatureHeard `json:"features"`
	Harbour   HarbourHeard   `json:"harbour"`
	// Weather is whether the world has weather: without it no fog signal
	// sounds. Each light's visibility is the visibility at it, m.
	Weather bool         `json:"weather"`
	Lights  []soundLight `json:"lights"`
	Flashes []Flash      `json:"flashes"`
	Sounds  []soundOut   `json:"sounds"`
}

type soundLight struct {
	FogLight
	Visibility float64 `json:"visibility"`
}

// soundOut is a sound as the case file writes it, its kind by name.
type soundOut struct {
	Kind string `json:"kind"`
	Sound
}

// kindNames are the kinds of sound as the case file names them.
var kindNames = map[SoundKind]string{
	SoundFalls: "falls", SoundWaterfall: "roar", SoundLapping: "lapping", SoundBoom: "boom", SoundCall: "call",
	SoundBell: "bell", SoundGull: "gull", SoundMallet: "mallet", SoundFogSignal: "fog", SoundThunder: "thunder",
}

func (c *soundCase) heard() *Heard {
	in := &Heard{
		Seconds: c.Seconds, East: c.East, North: c.North, Day: c.Day, SeaHeight: c.SeaHeight,
		Lip: c.Lip, Falling: c.Falling, EndNear: c.EndNear, Features: c.Features, Harbour: c.Harbour, Flashes: c.Flashes,
	}
	for _, l := range c.Lights {
		in.Lights = append(in.Lights, l.FogLight)
	}
	if c.Weather {
		in.Visibility = func(east, north, tick float64) float64 {
			for _, l := range c.Lights {
				if l.East == east && l.North == north {
					return l.Visibility
				}
			}
			return math.Inf(1)
		}
	}
	return in
}

func (c *soundCase) run(h *Hearing) {
	c.Sounds = []soundOut{}
	for _, s := range h.Sounds(c.heard(), c.From, c.To) {
		// The kind by its name alone, as the file reads back.
		name := kindNames[s.Kind]
		s.Kind = 0
		c.Sounds = append(c.Sounds, soundOut{Kind: name, Sound: s})
	}
}

func soundCases(cat *catalog.Catalog, h *Hearing) []soundCase {
	signal := func(d catalog.FogSignalDevice) int {
		for i, s := range cat.World.Lights.FogSignals {
			if s.Device == d {
				return i
			}
		}
		panic("no fog signal of a device")
	}
	at := func(e, n float64) *Point { return &Point{East: e, North: n} }
	const e0, n0 = 2300.5, -1700.25
	island := []FeatureHeard{
		{Site: catalog.FeatureSiteWaterfall, East: e0 + 120, North: n0, Drop: 20},
		{Site: catalog.FeatureSiteWaterfall, East: e0, North: n0 + 50, Drop: 5},
		{Site: catalog.FeatureSiteWaterfall, East: e0 - 400, North: n0, Drop: 40},
		{Site: catalog.FeatureSiteBlowhole, East: e0 - 60, North: n0 - 55, Seed: 3},
		{Site: catalog.FeatureSiteBlowhole, East: e0 + 250, North: n0 + 250, Seed: 200},
		{Site: catalog.FeatureSiteColony, East: e0 - 100, North: n0 + 110, Seed: 7, Call: catalog.CallHarsh},
		{Site: catalog.FeatureSiteColony, East: e0 + 200, North: n0 - 150, Seed: 41, Call: catalog.CallWhistle},
		{Site: catalog.FeatureSiteColony, East: e0, North: n0 - 310, Seed: 9, Call: catalog.CallRattle},
		{Site: catalog.FeatureSiteArch, East: e0 + 10, North: n0 + 10},
	}
	sph := h.secondsPerHour
	lights := []soundLight{
		{FogLight: FogLight{Number: 4, East: 900, North: 300, Phase: 1_234_567, Signal: signal(catalog.FogSignalDeviceTwotone)}, Visibility: 500},
		{FogLight: FogLight{Number: 9, East: -1000, North: -1000, Phase: 98_765_432, Signal: signal(catalog.FogSignalDeviceDiaphone)}, Visibility: 1851},
		{FogLight: FogLight{Number: 12, East: 0, North: -1500, Phase: 0, Signal: signal(catalog.FogSignalDeviceSiren)}, Visibility: 1852},
		{FogLight: FogLight{Number: 15, East: 1900, North: 0, Phase: 5, Signal: signal(catalog.FogSignalDeviceReedhorn)}, Visibility: 100},
		{FogLight: FogLight{Number: 20, East: 30, North: 40, Phase: 77, Signal: -1}, Visibility: 100},
	}
	cases := []soundCase{
		{Name: "the open sea", From: 1000, To: 1060, Seconds: 1060, Lip: 5000, SeaHeight: 1, Day: true},
		{Name: "near the lip", From: 1000, To: 1001, Seconds: 1001, East: 1000, North: -7000, Lip: 400, SeaHeight: 2},
		{Name: "within the falls' last tenth", From: 1000, To: 1001, Seconds: 1001, East: -7000, North: 1000, Lip: 950},
		{Name: "on the lip", From: 1000, To: 1001, Seconds: 1001, East: 0, North: 7100, Lip: -2},
		{Name: "going over", From: 1000, To: 1001, Seconds: 1001, East: 7100, North: 10, Lip: -30, Falling: true},
		{Name: "the world's end near", From: 1000, To: 1001, Seconds: 1001, East: 100, North: 100, Lip: 5000, EndNear: EndRoar(20, &cat.World.Edge.End)},
		{Name: "an island by day", From: 123496.5, To: 123516.5, Seconds: 123516.5, East: e0, North: n0, Day: true, SeaHeight: 1.2, Lip: 5000, Features: island},
		{Name: "the island by night, the sea high", From: 50040, To: 50060, Seconds: 50060, East: e0, North: n0, SeaHeight: 3.5, Lip: 5000, Features: island},
		{Name: "the island in a calm", From: 822, To: 837, Seconds: 837, East: e0 + 20, North: n0 - 20, Day: true, SeaHeight: 0, Lip: 5000, Features: island},
		{Name: "in port at a half hour by day", From: 90000, To: 90010, Seconds: 90010, East: 50, North: 60, Day: true, SeaHeight: 0.8, Lip: 5000,
			Harbour: HarbourHeard{InPort: true, Town: true, NearTown: 120, Bell: at(140, 60), Yard: at(-150, 60), Quay: at(50, 80), Hour: 14.5 + 2/sph}},
		{Name: "near a town at a watch's end by night", From: 4000, To: 4005, Seconds: 4005, East: 0, North: 0, Lip: 5000,
			Harbour: HarbourHeard{Town: true, NearTown: 250, Bell: at(0, 280), Quay: at(40, 0), Hour: 20 + 1/sph}},
		{Name: "near a town between the bells", From: 4000, To: 4030, Seconds: 4030, East: 0, North: 0, Day: true, SeaHeight: 2, Lip: 5000,
			Harbour: HarbourHeard{Town: true, NearTown: 290, Bell: at(0, 280), Yard: at(310, 0), Quay: at(20, 30), Hour: 9.2}},
		{Name: "past a town", From: 4000, To: 4030, Seconds: 4030, East: 0, North: 0, Day: true, Lip: 5000,
			Harbour: HarbourHeard{Town: true, NearTown: 301, Bell: at(0, 280), Yard: at(30, 0), Quay: at(20, 30), Hour: 12 + 1/sph}},
		{Name: "fog signals in fog", From: 600000, To: 600060, Seconds: 600060, Lip: 5000, Weather: true, Lights: lights},
		{Name: "fog signals in a world with no weather", From: 600000, To: 600060, Seconds: 600060, Lip: 5000, Lights: lights},
		{Name: "thunder", From: 200, To: 260, Seconds: 260, East: 100, North: -200, Lip: 5000, Flashes: []Flash{
			{Tick: 6000, East: 100, North: 1800, Sea: true, Base: 600, Seed: 7},
			{Tick: 6300, East: 4100, North: -200, Base: 900, Seed: 3141592653},
			{Tick: 6600, East: 7100, North: -200, Base: 800, Seed: 12},
			{Tick: 7500, East: 400, North: 300, Sea: true, Base: 500, Seed: 99},
			{Tick: 7650, East: -800, North: -600, Base: 700, Seed: 2718281828},
			{Tick: 3000, East: 100, North: 300, Sea: true, Base: 600, Seed: 1},
			{Tick: 7790, East: 5000, North: 2000, Sea: true, Base: 600, Seed: 5},
		}},
	}
	for i := range cases {
		cases[i].run(h)
	}
	return cases
}

// The sounds' own rules at the cases a sailor hears most.
func TestSoundsWords(t *testing.T) {
	r := readied()
	h := NewHearing(r.cat)
	// Eight bells at a watch's end, one at the half hour after.
	if BellStrokes(4) != 8 || BellStrokes(4.5) != 1 || BellStrokes(7.9) != 7 || BellStrokes(-0.25) != 7 {
		t.Error("the bell's strokes")
	}
	if HourAt(0, 1000) != 12 || HourAt(250, 1000) != 18 || HourAt(-250, 1000) != 6 {
		t.Error("the hour")
	}
	// Thunder 2,000 m off is heard after 2,000 m over the speed of sound.
	got := h.Sounds(&Heard{Lip: 5000, Flashes: []Flash{{Tick: 300, North: 2000, Sea: true, Base: 600, Seed: 7}}}, 0, 70)
	if len(got) != 1 || got[0].Kind != SoundThunder || math.Abs(got[0].At-(10+2000/343.0)) > 1e-9 || got[0].Bearing != 0 || got[0].Crack {
		t.Errorf("thunder: %+v", got)
	}
	// A fog signal a mile off and more is not heard; nor one in clear air.
	for _, v := range []float64{100, 5000} {
		in := &Heard{Lip: 5000, Lights: []FogLight{{East: 1000, Signal: 0}}, Visibility: func(_, _, _ float64) float64 { return v }}
		n := 0
		for _, s := range h.Sounds(in, 0, 120) {
			if s.Kind == SoundFogSignal {
				n++
				if s.Bearing != 90 || math.Abs(s.Delay-1000/343.0) > 1e-9 {
					t.Errorf("a blast: %+v", s)
				}
			}
		}
		if (n > 0) != (v < 1852) {
			t.Errorf("%d blasts in a visibility of %v m", n, v)
		}
	}
	if s := h.Sounds(&Heard{Lip: 5000}, 0, 1); len(s) != 0 {
		t.Errorf("the open sea: %+v", s)
	}
	if s := h.Sounds(&Heard{Lip: 50}, 0, 1); len(s) != 1 || s[0].Kind != SoundFalls || s[0].Kind.String() != "the roar of the falls" {
		t.Errorf("the lip: %+v", s)
	}
}

// The recipes' numbers are art/sound's.
func TestSoundRecipes(t *testing.T) {
	read := func(name string) map[string]any {
		data, err := os.ReadFile("../../art/sound/" + name + ".json")
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		if err := json.Unmarshal(data, &m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	num := func(m map[string]any, path ...string) float64 {
		var v any = m
		for _, p := range path {
			v = v.(map[string]any)[p]
		}
		return v.(float64)
	}
	pair := func(m map[string]any, key string) [2]float64 {
		a := m[key].([]any)
		return [2]float64{a[0].(float64), a[1].(float64)}
	}
	point := func(name string) pointRecipe {
		m := read(name)
		return pointRecipe{near: num(m, "near"), reach: num(m, "reach"), level: num(m, "level")}
	}
	for name, want := range map[string]pointRecipe{
		"waterfall": waterfallRecipe, "blowhole": blowholeRecipe, "colony": colonyRecipe, "bell": bellRecipe,
		"gulls": gullsRecipe, "mallets": malletsRecipe,
	} {
		if got := point(name); got != want {
			t.Errorf("%s: art/sound %+v, here %+v", name, got, want)
		}
	}
	waterfall, blowhole, colony, gulls, bell, mallets := read("waterfall"), read("blowhole"), read("colony"), read("gulls"), read("bell"), read("mallets")
	lapping, falls, thunder := read("lapping"), read("falls"), read("thunder")
	for _, c := range []struct {
		name      string
		got, want float64
	}{
		{"waterfall height", num(waterfall, "height"), waterfallHeight},
		{"blowhole sea", num(blowhole, "seaHeight"), blowholeSea},
		{"colony per minute", num(colony, "perMinute"), colonyPerMinute},
		{"gulls per minute", num(gulls, "perMinute"), gullsPerMinute},
		{"bell stroke", num(bell, "stroke"), bellStroke},
		{"bell pair", num(bell, "pair"), bellPair},
		{"mallet beat", num(mallets, "beat"), malletBeat},
		{"lapping near", num(lapping, "near"), lappingRecipe.near},
		{"lapping reach", num(lapping, "reach"), lappingRecipe.reach},
		{"lapping calm", num(lapping, "level", "calm"), lappingLevel.calm},
		{"lapping most", num(lapping, "level", "most"), lappingLevel.most},
		{"lapping sea", num(lapping, "level", "seaHeight"), lappingLevel.seaHeight},
		{"falls near", num(falls, "near"), fallsRecipe.near},
		{"falls reach", num(falls, "reach"), fallsRecipe.reach},
		{"falls most", num(falls, "level", "most"), fallsRecipe.most},
		{"falls falling", num(falls, "level", "falling"), fallsRecipe.falling},
		{"thunder stretch", num(thunder, "stretch"), thunderRecipe.stretch},
		{"thunder near", num(thunder, "near"), thunderRecipe.near},
		{"thunder level", num(thunder, "level"), thunderRecipe.level},
	} {
		if c.got != c.want {
			t.Errorf("%s: art/sound %v, here %v", c.name, c.got, c.want)
		}
	}
	if pair(mallets, "run") != malletRun || pair(lapping, "period") != lappingPeriod {
		t.Error("the mallets' runs or the lapping's periods are not art/sound's")
	}
	for d, want := range fogDeviceRecipes {
		m := read(string(d))
		if got := (pointRecipe{near: num(m, "near"), level: num(m, "level")}); got != want {
			t.Errorf("%s: art/sound %+v, here %+v", d, got, want)
		}
	}
}

func TestSoundsFile(t *testing.T) {
	r := readied()
	h := NewHearing(r.cat)
	got := soundsData{
		Comment:        "Written by go test ./internal/lookout -run SoundsFile -update: an hour of the world's day, s; listeners and the world about them, m, s, rad and µs, the interval of world time heard, s, and the sounds the phone plays: the held ones now, then those heard in the interval in the order the phone finds them, each with its true bearing in degrees and to 5°, its distance, m, when it is heard, s, its delay and length, s, and its level.",
		SecondsPerHour: h.secondsPerHour,
		Cases:          soundCases(r.cat, h),
	}
	caseFile(t, soundsFile, got, func(t *testing.T, want soundsData) {
		for _, c := range want.Cases {
			g := c
			g.run(h)
			if !reflect.DeepEqual(g.Sounds, c.Sounds) {
				t.Errorf("%s: %+v, sounds.json %+v", c.Name, g.Sounds, c.Sounds)
			}
		}
	})
}
