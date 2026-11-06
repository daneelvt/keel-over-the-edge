// SPDX-License-Identifier: AGPL-3.0-only

package lookout

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// What the phone plays of the boat's own voices, and the words for them.
// The wind is broadband noise whose level rises with the apparent wind at
// the masthead; the rigging sings its Aeolian tone once the wind is up; the
// cloth flogs while a sail strip luffs, louder as the wind rises; the water
// on the hull rises with the boat's speed, and past the hull speed the bow
// wave hisses; the sea rises with the height of the waves under the boat,
// a part of it the sea's alone, a part its whitecaps' and a part the boat's
// way through it; the rain hisses with the logarithm of its rate, and in
// heavy rain drums. The falls are the world's, in sounds.go.
//
// The page's twin is soundTargets in client/src/audio/voices.ts, held to
// testdata/boatsounds.json. The recipes' numbers are art/sound's, which
// the tests check.

// A voice's level: nothing below from, rising smoothly to most, a gain, at
// full.
type levelRecipe struct{ from, full, most float64 }

// The boat's voices' recipes, as art/sound's files give them. Speeds are
// m/s, heights m, rain mm an hour.
var (
	windRecipe = struct {
		level                        levelRecipe
		breathRate, perGust, deepest float64
	}{level: levelRecipe{from: 0.3, full: 17.5, most: 0.4}, breathRate: 0.11, perGust: 0.6, deepest: 0.3}
	riggingRecipe  = levelRecipe{from: 3, full: 14, most: 0.05}
	floggingRecipe = levelRecipe{from: 0.5, full: 9, most: 0.3}
	waterRecipe    = levelRecipe{from: 0.05, full: 4, most: 0.3}
	// The bow wave's hiss, from the hull speed to full.
	hissRecipe = levelRecipe{from: 2.4, full: 4.6, most: 0.16}
	seaRecipe  = struct {
		level                 levelRecipe
		sea, whitecaps, speed float64
		way                   [2]float64
	}{level: levelRecipe{from: 0.08, full: 2.2, most: 0.24}, sea: 0.45, whitecaps: 0.25, speed: 0.3, way: [2]float64{0.2, 4.5}}
	rainRecipe = levelRecipe{from: 0.1, full: 50, most: 0.22}
	drumRecipe = levelRecipe{from: 8, full: 60, most: 0.14}
)

// BoatHeard is the boat as its own voices hear it: the apparent wind at the
// masthead, m/s; its speed over the ground and through the water, m/s; the
// significant height of the waves under it, m, and their whitecaps, 0 to
// 1; how many of the sail's two strips are luffing, 0 to 2; world time, s;
// the rain at it, mm an hour; and the wind's gust factor, 0 or 1 for a
// steady wind.
type BoatHeard struct {
	ApparentWind float64 `json:"apparentWind"`
	Speed        float64 `json:"speed"`
	ThroughWater float64 `json:"throughWater"`
	SeaHeight    float64 `json:"seaHeight"`
	Whitecaps    float64 `json:"whitecaps"`
	Luffing      int     `json:"luffing"`
	Seconds      float64 `json:"time"`
	Rain         float64 `json:"rain"`
	GustFactor   float64 `json:"gustFactor,omitempty"`
}

// BoatLevels are the boat's voices' levels, gains, as the phone sets them.
type BoatLevels struct {
	Wind     float64 `json:"windLevel"`
	Rigging  float64 `json:"rigLevel"`
	Flogging float64 `json:"flogLevel"`
	Water    float64 `json:"waterLevel"`
	Hiss     float64 `json:"hissLevel"`
	Sea      float64 `json:"seaLevel"`
	Rain     float64 `json:"rainLevel"`
	Drum     float64 `json:"drumLevel"`
}

// BoatSounds is each of the boat's voices' level for in, by the recipes.
func BoatSounds(in *BoatHeard) BoatLevels {
	var l BoatLevels
	v := math.Max(0, in.ApparentWind)
	w := &windRecipe
	// The wind breathes as deep as it gusts: not at all in a steady wind.
	depth := math.Min(w.deepest, float64(w.perGust*math.Max(in.GustFactor-1, 0)))
	rate := float64(2 * math.Pi * w.breathRate)
	breath := 1 + float64(float64(depth*physics.Sin(float64(rate*in.Seconds)))*
		physics.Sin(float64(float64(rate*0.37)*in.Seconds)+1))
	l.Wind = float64(level(&w.level, v) * breath)
	l.Rigging = level(&riggingRecipe, v)
	if in.Luffing > 0 {
		l.Flogging = float64(level(&floggingRecipe, v) * (0.6 + float64(0.2*float64(in.Luffing))))
	}

	s := math.Max(0, in.Speed)
	l.Water = level(&waterRecipe, s)
	l.Hiss = level(&hissRecipe, s)

	e := &seaRecipe
	hs := math.Max(0, in.SeaHeight)
	white := math.Min(1, math.Max(0, in.Whitecaps))
	way := ramp(e.way[0], e.way[1], math.Abs(in.ThroughWater))
	l.Sea = float64(level(&e.level, hs) * (e.sea + float64(e.whitecaps*white) + float64(e.speed*way)))

	r := math.Max(0, in.Rain)
	l.Rain = rainLevel(&rainRecipe, r)
	l.Drum = rainLevel(&drumRecipe, r)
	return l
}

// level is a voice's level at x: most times the ramp from from to full.
func level(r *levelRecipe, x float64) float64 {
	return float64(r.most * ramp(r.from, r.full, x))
}

// rainLevel is a voice's level in rain of rate mm an hour, rising with the
// logarithm of the rate from nothing at from to most at full: rain is
// heard by its logarithm, as loudness goes.
func rainLevel(r *levelRecipe, rate float64) float64 {
	if !(rate > r.from) {
		return 0
	}
	t := math.Min(physics.Log(rate/r.from)/physics.Log(r.full/r.from), 1)
	return float64(r.most * t)
}

// The words for what the boat sounds like. Each voice's gain is weighed by
// how loud a listener hears it against the water's low rumble at the same
// gain: the bow wave's hiss lies about 4 kHz, where the ear is most
// sensitive, some 12 dB over the rumble's band; the rigging's song is a
// tone, which stands out of broadband noise by as much; the flogging cloth
// and the drumming rain beat, which a listener picks out by 6 dB; and the
// sea is heard through the hull a sailor sits on as well as through the
// air, 12 dB. The wind's own noise and the rigging's song are one sound to
// a sailor, the wind in the rigging, and the rain's hiss and its drumming
// another, rain on the deck: each pair is heard together, its weighed gains
// summed as powers.
const (
	hissWeight = 4
	rigWeight  = 4
	flogWeight = 2
	drumWeight = 2
	seaWeight  = 4
	// hearFloor is the weighed gain below which nothing is named: an
	// eighth of the wind at its loudest.
	hearFloor = 0.04
	// hearSecond is the share of the loudest's weighed gain a second
	// sound must reach to be named after it: half, 6 dB down.
	hearSecond = 0.5
)

// boatWords are the words for the boat's sounds, in the order a tie is
// broken in.
var boatWords = [...]string{
	"water along the hull", "surging", "the sail flogging", "wind in the rigging", "rain on the deck", "the hull slapping",
}

// Words is what the boat sounds like at these levels, loudest first: one
// sound, or two where the second is at least half as loud as the first,
// or "quiet" where none reaches the floor.
func (l *BoatLevels) Words() string {
	heard := [len(boatWords)]float64{
		l.Water,
		float64(hissWeight * l.Hiss),
		float64(flogWeight * l.Flogging),
		hypot(l.Wind, float64(rigWeight*l.Rigging)),
		hypot(l.Rain, float64(drumWeight*l.Drum)),
		float64(seaWeight * l.Sea),
	}
	first, second := -1, -1
	for i, h := range heard {
		switch {
		case !(h >= hearFloor):
		case first < 0 || h > heard[first]:
			first, second = i, first
		case second < 0 || h > heard[second]:
			second = i
		}
	}
	if first < 0 {
		return "quiet"
	}
	if second < 0 || heard[second] < float64(hearSecond*heard[first]) {
		return boatWords[first]
	}
	return boatWords[first] + ", " + boatWords[second]
}
