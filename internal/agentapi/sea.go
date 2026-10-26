// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"context"
	"sync"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/forecast"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/sky"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// Sea is the world sailed, as the machine sailors' tools reach it: what a
// world hands the agents' core as it opens. Everything in it is shared
// with the world's other readers, and only read.
type Sea struct {
	Number int
	Epoch  time.Time
	// Ends is when the world ends, zero for none known.
	Ends func() time.Time
	Bus  *bus.Bus
	// Boats are the kinds of boat, by a boat's kind.
	Boats []catalog.Boat
	// Limit is the most boats the world holds; AICap and AIReserve the
	// machine sailors' share of them.
	Limit, AICap, AIReserve int

	Timeline *weather.Timeline
	Waves    *physics.Waves
	// Ground and Shelter are the world's land; nil for open sea.
	Ground  *physics.Ground
	Shelter *physics.Shelter
	Sky     *sky.Prepared
	// Bundle is the world's terrain as made: its islands, places and
	// lights.
	Bundle *worldgen.Bundle
	// Chart is the world's chart as written, Sight what the lookouts see
	// by; nil for a world nobody charts.
	Chart *chart.Model
	Sight *sim.Sight
	// Forecast is the world's forecast; nil for none.
	Forecast *forecast.Issuer
	// Place is how a place's box and outlook are made, as the chart and
	// the harbourmaster's board give them; nil for none.
	Place *forecast.PlaceWords
	// Words are the weather's words, RainWords the rates rain is light,
	// moderate and heavy under, mm an hour.
	Words     weather.Words
	RainWords [3]float64
	// Biomes name the biomes by their ids; PlaceKinds and FeatureKinds the
	// kinds of place and feature, by a subject's sort.
	Biomes       map[string]string
	PlaceKinds   []string
	FeatureKinds []string
	// News is the world's news sheet, newest first: up to n items before
	// the item before, nil for the newest; Columns name its columns by
	// their ids.
	News    func(ctx context.Context, before *[16]byte, n int) ([]store.News, error)
	Columns map[string]string
	// SystemKinds are what the forecast calls each kind of weather system,
	// by the catalog's index: "a squall", "a fog bank".
	SystemKinds []string
	// Start is the place new boats start at: "Port Royal".
	Start string
	// Catalog, Kinds and Encounters are what the phone's overlays and
	// sounds are worked out from: the catalog, the kinds of boat prepared,
	// and how boats meet; nil for none.
	Catalog    *catalog.Catalog
	Kinds      []physics.Prepared
	Encounters *physics.EncounterPrepared

	overlays overlays

	air air
}

// air keeps the weather of the latest tick asked for, worked out once for
// every report of that tick.
type air struct {
	mu   sync.Mutex
	tick int64
	at   *physics.WeatherTick
	// past keeps the weather at whole minutes before, for the barometer.
	past map[int64]*physics.WeatherTick
	// lit and thr are which lights are lit, and their thresholds, at the
	// second litAt.
	lit   []bool
	thr   []float64
	litAt int64
}

// weatherAt is the weather at f's tick, as the simulation works it out
// from the frame: its spells, the front to come and its systems'
// keyframes. The tick returned is never changed after.
func (s *Sea) weatherAt(f *bus.Frame) *physics.WeatherTick {
	a := &s.air
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.at != nil && a.tick == f.Tick {
		return a.at
	}
	w := &physics.Weather{Prepared: s.Timeline.Prepared()}
	w.Set(f.SpellsInPlay())
	w.SetComing(&f.Coming)
	w.SetKeys(f.Keys[:2])
	t := new(physics.WeatherTick)
	physics.WeatherAt(w, t, float64(f.Tick))
	a.tick, a.at = f.Tick, t
	return t
}

// weatherBefore is the weather minutes before f's tick, at a whole
// minute.
func (s *Sea) weatherBefore(f *bus.Frame, minutes int64) *physics.WeatherTick {
	minute := int64(60 * physics.StepsPerSecond)
	return s.weatherAtTick(f, (f.Tick/minute-minutes)*minute)
}

// weatherAtTick is the weather at a tick near f's, as the world's timeline
// and the frame's developer's weathers and systems make it.
func (s *Sea) weatherAtTick(f *bus.Frame, tick int64) *physics.WeatherTick {
	a := &s.air
	a.mu.Lock()
	defer a.mu.Unlock()
	if t, ok := a.past[tick]; ok {
		return t
	}
	tl := s.Timeline
	w := &physics.Weather{Prepared: tl.Prepared()}
	var sp [physics.WeatherSpells]physics.Spell
	w.Set(sp[:tl.Spells(tick, f.Weathers, &sp)])
	var keys [bus.KeyFrames]physics.Keyframe
	tl.Keyframes(tick, f.Systems, &keys)
	w.SetKeys(keys[:2])
	t := new(physics.WeatherTick)
	physics.WeatherAt(w, t, float64(tick))
	if a.past == nil || len(a.past) > 64 {
		a.past = map[int64]*physics.WeatherTick{}
	}
	a.past[tick] = t
	return t
}

// boat is a kind of boat by its index, the first for one out of range.
func (s *Sea) boat(kind uint16) *catalog.Boat {
	if int(kind) < len(s.Boats) {
		return &s.Boats[kind]
	}
	return &s.Boats[0]
}

// ends is when the world ends, zero for none known.
func (s *Sea) ends() time.Time {
	if s.Ends == nil {
		return time.Time{}
	}
	return s.Ends()
}
