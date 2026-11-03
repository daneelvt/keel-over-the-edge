// SPDX-License-Identifier: AGPL-3.0-only

package lookout

import (
	"encoding/json"
	"os"
	"testing"
)

// boatSoundsFile holds the cases the boat's voices and the page's are held
// to.
const boatSoundsFile = "testdata/boatsounds.json"

type boatSoundsData struct {
	Comment string          `json:"comment"`
	Cases   []boatSoundCase `json:"cases"`
}

// boatSoundCase is a boat as its voices hear it, their levels and the
// words for them.
type boatSoundCase struct {
	Name   string     `json:"name"`
	Input  BoatHeard  `json:"input"`
	Levels BoatLevels `json:"levels"`
	Words  string     `json:"words"`
}

// knots is a speed in knots, m/s.
func knots(k float64) float64 { return float64(k*1852) / 3600 }

// boatScene is a scene of the file and the words it must have.
type boatScene struct {
	name  string
	in    BoatHeard
	words string
}

// boatScenes are the boat as a sailor most often hears it, and between.
func boatScenes() []boatScene {
	return []boatScene{
		{"at rest in a calm", BoatHeard{}, "quiet"},
		{"at rest in a light air", BoatHeard{ApparentWind: knots(4), SeaHeight: 0.05}, "quiet"},
		{"drifting at a knot in 4 kn of wind", BoatHeard{ApparentWind: knots(4.5), Speed: knots(1), ThroughWater: knots(1), SeaHeight: 0.05}, "quiet"},
		{"ghosting at 2 kn in 5 kn of wind", BoatHeard{ApparentWind: knots(6), Speed: knots(2), ThroughWater: knots(2), SeaHeight: 0.1}, "water along the hull"},
		{"a reach at 4 kn in 6 kn of wind", BoatHeard{ApparentWind: knots(7.2), Speed: knots(4), ThroughWater: knots(4), SeaHeight: 0.15, Seconds: 1234.5}, "water along the hull"},
		{"a reach at 6 kn in 12 kn of wind", BoatHeard{ApparentWind: knots(15), Speed: knots(6), ThroughWater: knots(6), SeaHeight: 0.4, Whitecaps: 0.2}, "water along the hull, wind in the rigging"},
		{"a reach at 7 kn in 14 kn of wind", BoatHeard{ApparentWind: knots(17), Speed: knots(7), ThroughWater: knots(7), SeaHeight: 0.6, Whitecaps: 0.35}, "surging, water along the hull"},
		{"planing at 9 kn in 18 kn of wind", BoatHeard{ApparentWind: knots(20), Speed: knots(9), ThroughWater: knots(9), SeaHeight: 0.8, Whitecaps: 0.6}, "surging"},
		{"head to wind in 10 kn, the sail luffing", BoatHeard{ApparentWind: knots(10), SeaHeight: 0.3, Whitecaps: 0.05, Luffing: 2}, "the sail flogging"},
		{"a reach at 4 kn in 10 kn, the head luffing", BoatHeard{ApparentWind: knots(12), Speed: knots(4), ThroughWater: knots(4), SeaHeight: 0.3, Whitecaps: 0.1, Luffing: 1}, "the sail flogging"},
		{"beating at 5 kn in 20 kn apparent", BoatHeard{ApparentWind: knots(20), Speed: knots(5), ThroughWater: knots(5), SeaHeight: 0.5, Whitecaps: 0.3}, "wind in the rigging, water along the hull"},
		{"hove to in 25 kn", BoatHeard{ApparentWind: knots(25), Speed: knots(0.5), ThroughWater: knots(1), SeaHeight: 0.9, Whitecaps: 0.85}, "wind in the rigging, the hull slapping"},
		{"light rain at a knot", BoatHeard{ApparentWind: knots(4), Speed: knots(1), ThroughWater: knots(1), Rain: 1}, "rain on the deck"},
		{"heavy rain at 3 kn", BoatHeard{ApparentWind: knots(8), Speed: knots(3), ThroughWater: knots(3), SeaHeight: 0.2, Rain: 30}, "rain on the deck"},
		{"rain on a reach at 5 kn", BoatHeard{ApparentWind: knots(12), Speed: knots(5), ThroughWater: knots(5), SeaHeight: 0.3, Whitecaps: 0.1, Rain: 6}, "water along the hull, rain on the deck"},
		{"running at 5 kn in a 1 m sea with whitecaps", BoatHeard{ApparentWind: knots(14), Speed: knots(5), ThroughWater: knots(5), SeaHeight: 1, Whitecaps: 0.7}, "the hull slapping, water along the hull"},
		{"running at 8 kn in a 2 m sea", BoatHeard{ApparentWind: knots(18), Speed: knots(8), ThroughWater: knots(7), SeaHeight: 2, Whitecaps: 0.95}, "the hull slapping, surging"},
		{"sternway in a short sea", BoatHeard{ApparentWind: knots(9), Speed: knots(1.5), ThroughWater: -knots(2), SeaHeight: 0.6, Whitecaps: 0.1}, "the hull slapping, wind in the rigging"},
	}
}

func boatSoundCases() []boatSoundCase {
	var out []boatSoundCase
	for _, s := range boatScenes() {
		c := boatSoundCase{Name: s.name, Input: s.in}
		c.run()
		out = append(out, c)
	}
	return out
}

func (c *boatSoundCase) run() {
	c.Levels = BoatSounds(&c.Input)
	c.Words = c.Levels.Words()
}

// The words at the scenes a sailor knows.
func TestBoatSoundsWords(t *testing.T) {
	for _, s := range boatScenes() {
		l := BoatSounds(&s.in)
		if got := l.Words(); got != s.words {
			t.Errorf("%s: %q, want %q (%+v)", s.name, got, s.words, l)
		}
	}
	// The second sound is named from half the first's weighed gain, and a
	// tie goes to the one listed first.
	if w := (&BoatLevels{Water: 0.2, Hiss: 0.025}).Words(); w != "water along the hull, surging" {
		t.Errorf("half as loud: %q", w)
	}
	if w := (&BoatLevels{Water: 0.2, Hiss: 0.0249}).Words(); w != "water along the hull" {
		t.Errorf("under half as loud: %q", w)
	}
	if w := (&BoatLevels{Water: 0.2, Hiss: 0.05}).Words(); w != "water along the hull, surging" {
		t.Errorf("a tie: %q", w)
	}
	if w := (&BoatLevels{Water: 0.039, Hiss: 0.0099, Sea: 0.0099}).Words(); w != "quiet" {
		t.Errorf("under the floor: %q", w)
	}
}

// The boat's voices' recipes are art/sound's.
func TestBoatSoundRecipes(t *testing.T) {
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
	levels := func(m map[string]any, key, from, full string) levelRecipe {
		return levelRecipe{from: num(m, key, from), full: num(m, key, full), most: num(m, key, "most")}
	}
	wind, rigging, flogging, water, sea, rain := read("wind"), read("rigging"), read("flogging"), read("water"), read("sea"), read("rain")
	for _, c := range []struct {
		name      string
		got, want levelRecipe
	}{
		{"wind", levels(wind, "level", "from", "full"), windRecipe.level},
		{"rigging", levels(rigging, "level", "from", "full"), riggingRecipe},
		{"flogging", levels(flogging, "level", "from", "full"), floggingRecipe},
		{"water", levels(water, "level", "from", "full"), waterRecipe},
		{"hiss", levels(water, "hiss", "hullSpeed", "full"), hissRecipe},
		{"sea", levels(sea, "level", "from", "full"), seaRecipe.level},
		{"rain", levels(rain, "level", "from", "full"), rainRecipe},
		{"drum", levels(rain, "drumLevel", "from", "full"), drumRecipe},
	} {
		if c.got != c.want {
			t.Errorf("%s: art/sound %+v, here %+v", c.name, c.got, c.want)
		}
	}
	for _, c := range []struct {
		name      string
		got, want float64
	}{
		{"breath rate", num(wind, "breath", "rate"), windRecipe.breathRate},
		{"breath depth", num(wind, "breath", "depth"), windRecipe.depth},
		{"sea share", num(sea, "share", "sea"), seaRecipe.sea},
		{"whitecaps share", num(sea, "share", "whitecaps"), seaRecipe.whitecaps},
		{"speed share", num(sea, "share", "speed"), seaRecipe.speed},
		{"way from", num(sea, "speed", "from"), seaRecipe.way[0]},
		{"way full", num(sea, "speed", "full"), seaRecipe.way[1]},
	} {
		if c.got != c.want {
			t.Errorf("%s: art/sound %v, here %v", c.name, c.got, c.want)
		}
	}
}

func TestBoatSoundsFile(t *testing.T) {
	got := boatSoundsData{
		Comment: "Written by go test ./internal/lookout -run BoatSoundsFile -update: boats as their own voices hear them, the apparent wind, m/s, the speed over the ground and through the water, m/s, the sea's significant height, m, and whitecaps, 0 to 1, the sail's strips luffing, world time, s, and the rain, mm an hour; the voices' levels, gains, as the phone sets them, and the words for what the boat sounds like.",
		Cases:   boatSoundCases(),
	}
	caseFile(t, boatSoundsFile, got, func(t *testing.T, want boatSoundsData) {
		for _, c := range want.Cases {
			g := c
			g.run()
			if g.Levels != c.Levels || g.Words != c.Words {
				t.Errorf("%s: %+v %q, boatsounds.json %+v %q", c.Name, g.Levels, g.Words, c.Levels, c.Words)
			}
		}
	})
}
