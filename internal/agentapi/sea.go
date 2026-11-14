// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"context"
	"sync"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/chat"
	"github.com/daneelvt/keel-over-the-edge/internal/fleet"
	"github.com/daneelvt/keel-over-the-edge/internal/forecast"
	"github.com/daneelvt/keel-over-the-edge/internal/life"
	"github.com/daneelvt/keel-over-the-edge/internal/logbook"
	sailorlooks "github.com/daneelvt/keel-over-the-edge/internal/looks"
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
	// Life is the world's life schedule, whose kinds a frame's life is of;
	// nil for a sea with nothing alive in it.
	Life *life.Schedule
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
	// News is the world's news, a day's edition as a machine sailor reads
	// it; Log a machine sailor's own log. Nil for none.
	News News
	Log  func(ctx context.Context, account store.AccountID) (logbook.Log, error)
	// SystemKinds are each kind of weather system's name, by the catalog's
	// index, as a chart's key gives it: "Squall line", "Low".
	SystemKinds []string
	// Start is the place new boats start at: "Port Royal".
	Start string
	// Watchers, if not nil, is how many watch an account's boat now.
	Watchers func(bus.Account) int
	// Catalog, Kinds and Encounters are what the phone's overlays and
	// sounds are worked out from: the catalog, the kinds of boat prepared,
	// and how boats meet; nil for none.
	Catalog *catalog.Catalog
	Kinds   []physics.Prepared
	// Looks are the catalog's looks, which a boat's look is coded and said
	// by; nil for none.
	Looks      *sailorlooks.Book
	Encounters *physics.EncounterPrepared
	// Fleet is the accounts' fleets, which a machine sailor takes its boat
	// from, swaps and changes the look of; nil for none: it sails the kind
	// each sailor brings, of the first look.
	Fleet *fleet.Fleet
	// Chat is the world's chat aboard, through which a machine sailor says
	// its lines and is handed those said to it; Talker what chat's rule
	// needs of a machine sailor, its human's, and its name. Nil for none.
	Chat   *chat.Hub
	Talker func(ctx context.Context, a bus.Account) (aboard.Speaker, string, error)
	// Deck, if not nil, is the game's own side of sailing together, which
	// a skipper's agent puts someone ashore through.
	Deck Deck

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

// joinedKind is the kind of boat a machine sailor's Join gives it, as a
// player's does: a Join names none, so the world's first, the boat every
// sailor takes to sea.
const joinedKind = 0

// boat is a kind of boat by its index; one out of range, which no boat of
// the world is, is the kind a Join gives.
func (s *Sea) boat(kind uint16) *catalog.Boat {
	if int(kind) < len(s.Boats) {
		return &s.Boats[kind]
	}
	return &s.Boats[joinedKind]
}

// ends is when the world ends, zero for none known.
func (s *Sea) ends() time.Time {
	if s.Ends == nil {
		return time.Time{}
	}
	return s.Ends()
}
