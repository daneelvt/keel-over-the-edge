// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"math"
	"net/http"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/light"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sky"
)

// The fog and the lightning on the world page, as the frame now makes
// them: the visibility at the sea over the disk on a grid, with the words
// it is told in, the Met Office's marine ones on the game's stage; every
// flash of the last minute, where it struck and whether to the sea or in
// the cloud; and every light, whether it is lit, by night or by the fog by
// day, and whether its fog signal is sounding. The flashes are the ones
// every phone finds: each slot's from the weather at its start, made from
// the week and the developer's systems as the simulation makes it.

// visibilityEvery is the visibility grid's spacing, in the sheets'
// lattice: half of it, fine enough to outline a fog bank's very poor core.
const visibilityEvery = 0.5

// visibilityMost is the most visibility the grid and a point give, m: air
// with no extinction at all sees for ever, which JSON cannot say.
const visibilityMost = 99999

// flashesFor is how far back the flashes reach, s.
const flashesFor = 60

// visibilityWordNames are visibility's words, by VisibilityWord's numbers.
var visibilityWordNames = [...]string{"good", "moderate", "poor", "very poor"}

// FogSignal is a fog signal's pattern as the page shows it.
type FogSignal struct {
	Notation string
	Steps    []int // ms, blasts and silences in turn, beginning with a blast
}

// visibilityPage is visibility.json.
type visibilityPage struct {
	Tick int64   `json:"tick"`
	Lip  float64 `json:"lip"` // m
	// Words: very poor under the first, poor under the second, moderate
	// under the third and good above, m. Sounds: a fog signal sounds while
	// the visibility at its light is under it, m.
	Words   [3]float64  `json:"words"`
	Sounds  float64     `json:"sounds"`
	Grid    cloudGrid   `json:"grid"` // a value a point: the visibility at the sea, m, at most visibilityMost
	Flashes []flashJSON `json:"flashes"`
	Lights  []lightNow  `json:"lights"`
}

// flashJSON is a flash of the last minute.
type flashJSON struct {
	Slot    int     `json:"slot"` // its system's
	Tick    float64 `json:"tick"` // its first stroke's
	East    float64 `json:"east"`
	North   float64 `json:"north"`
	Sea     bool    `json:"sea"` // struck the sea; otherwise it stayed in the cloud
	Strokes int     `json:"strokes"`
}

// lightNow is a light as it shows now.
type lightNow struct {
	Number int32   `json:"number"`
	East   float64 `json:"east"`
	North  float64 `json:"north"`
	Signal string  `json:"signal"` // its fog signal as charts write it; "" for none
	// Sounding: its fog signal is blasting, and the visibility at it was
	// under Sounds as the blast began. Lit: the sun is below the horizon
	// at it, or the visibility at it is poor or worse; ByDay, lit while
	// the sun is up.
	Sounding bool `json:"sounding"`
	Lit      bool `json:"lit"`
	ByDay    bool `json:"byDay"`
}

// airShares are the shares of the air's extinction at a point, 0 to 1: the
// clear air's, the fog's, the rain's and the mist's.
type airShares struct {
	Clear float64 `json:"clear"`
	Fog   float64 `json:"fog"`
	Rain  float64 `json:"rain"`
	Mist  float64 `json:"mist"`
}

// visibility serves visibility.json, of the frame now.
func (o *Owner) visibility(w http.ResponseWriter, r *http.Request) {
	t, tick, ws, ss, ok := o.frameState(true)
	if !ok {
		http.Error(w, "no weather", http.StatusNotFound)
		return
	}
	p := o.cfg.Weather
	lip := p.Edge()
	step := visibilityEvery * p.SheetLattice()
	page := visibilityPage{
		Tick: tick, Lip: round2(lip), Words: visibilityWords(p), Sounds: round2(o.cfg.SoundsUnder),
		Flashes: []flashJSON{}, Lights: []lightNow{},
	}
	page.Grid = gridOver(lip+step, step, 1, func(x, y float64, out []float64) {
		out[0] = seen(physics.VisibilityAt(t, x, y))
	})
	at := weatherAt{o: o, ws: ws, ss: ss, now: tick, t: t}
	page.Flashes = o.flashes(&at)
	page.Lights = o.lightsNow(&at)
	writeJSON(w, &page)
}

// seen is a visibility as the page gives it: to the metre, at most
// visibilityMost.
func seen(v float64) float64 {
	if !(v < visibilityMost) {
		return visibilityMost
	}
	return math.Round(v)
}

// visibilityWords are the visibilities the words change at, m, as
// VisibilityWord tells them: each the least visibility of the better word,
// found by halving.
func visibilityWords(p *physics.WeatherPrepared) [3]float64 {
	var out [3]float64
	for k := range out {
		lo, hi := 0.0, 1e6
		for range 60 {
			mid := (lo + hi) / 2
			if p.VisibilityWord(mid) < int32(physics.VisibilityVeryPoor-k) {
				hi = mid
			} else {
				lo = mid
			}
		}
		out[k] = round2(hi)
	}
	return out
}

// visibilityAt is the visibility at (x, y), 2 m above the sea, at the tick
// t was set to, m, its word and what makes it.
func visibilityAt(t *physics.WeatherTick, x, y float64) (float64, string, airShares) {
	v := physics.VisibilityAt(t, x, y)
	word := t.Prepared().VisibilityWord(v)
	a := physics.AirAt(t, x, y, 2)
	var s airShares
	if e := a.Total(); e > 0 {
		s = airShares{Clear: round3(a.Clear / e), Fog: round3(a.Fog / e), Rain: round3(a.Rain / e), Mist: round3(a.Mist / e)}
	}
	return seen(v), visibilityWordNames[min(max(word, 0), int32(len(visibilityWordNames)-1))], s
}

// weatherAt makes the weather at the ticks a request asks of, the frame's
// at its own and the rest from the timeline and the developer's weathers
// and systems as the frame holds them, each made once.
type weatherAt struct {
	o      *Owner
	ws     []bus.Weather
	ss     []bus.System
	now    int64
	t      *physics.WeatherTick
	others map[int64]*physics.WeatherTick
}

// at is the weather at a tick, or nil for a tick not the frame's without
// a timeline.
func (a *weatherAt) at(tick int64) *physics.WeatherTick {
	if tick == a.now {
		return a.t
	}
	tl := a.o.cfg.Timeline
	if tl == nil {
		return nil
	}
	if t, ok := a.others[tick]; ok {
		return t
	}
	if a.others == nil {
		a.others = map[int64]*physics.WeatherTick{}
	}
	t := physicsAt(tl, tick, a.ws, a.ss)
	a.others[tick] = t
	return t
}

// flashes are the flashes of the last minute up to the frame's tick, each
// slot's found from the weather at its start; none without a timeline.
func (o *Owner) flashes(a *weatherAt) []flashJSON {
	out := []flashJSON{}
	if o.cfg.Timeline == nil {
		return out
	}
	p := o.cfg.Weather
	slot := p.SlotTicks()
	from := float64(max(a.now-flashesFor*physics.StepsPerSecond, 0))
	var fl [physics.MaxFlashes]physics.Flash
	for s := p.FlashSlot(from); s <= p.FlashSlot(float64(a.now)); s++ {
		start := s * slot
		t := a.at(int64(start))
		if t == nil || float64(int64(start)) != start {
			// A slot's weather is its start's, a whole tick.
			continue
		}
		for _, f := range fl[:physics.Flashes(t, s, fl[:])] {
			if f.Tick < from || f.Tick > float64(a.now) {
				continue
			}
			out = append(out, flashJSON{
				Slot: int(f.Slot), Tick: round2(f.Tick), East: round2(f.East), North: round2(f.North),
				Sea: f.Sea != 0, Strokes: int(f.Strokes),
			})
		}
	}
	return out
}

// lightsNow is every light as it shows at the frame's tick.
func (o *Owner) lightsNow(a *weatherAt) []lightNow {
	out := []lightNow{}
	b := o.cfg.Bundle
	if b == nil {
		return out
	}
	p := o.cfg.Weather
	us := worldMicros(a.now)
	skyT := 0.0
	if s := o.cfg.Sky; s != nil {
		skyT = sky.Time(s, float64(o.cfg.World.Epoch.UnixMicro()), float64(us))
	}
	for i, l := range b.Lights {
		j := lightNow{Number: l.Number, East: round2(l.X), North: round2(l.Y)}
		sun := -math.Pi / 2
		if s := o.cfg.Sky; s != nil {
			sun = sky.SunAltitude(s, skyT, l.X, l.Y)
		}
		poor := p.VisibilityWord(physics.VisibilityAt(a.t, l.X, l.Y)) >= physics.VisibilityPoor
		j.Lit = sun < 0 || poor
		j.ByDay = j.Lit && sun >= 0
		if i < len(o.cfg.LightSignals) {
			if k := o.cfg.LightSignals[i]; k >= 0 && k < len(o.cfg.FogSignals) {
				sig := &o.cfg.FogSignals[k]
				j.Signal = sig.Notation
				if start, on := light.Blast(sig.Steps, l.Phase, us); on {
					// The blast sounds if the visibility at the light was
					// under the threshold as it began.
					tick := int64(math.Floor(float64(start) * physics.StepsPerSecond / 1e6))
					t := a.at(min(tick, a.now))
					if t == nil {
						t = a.t
					}
					j.Sounding = physics.VisibilityAt(t, l.X, l.Y) < o.cfg.SoundsUnder
				}
			}
		}
		out = append(out, j)
	}
	return out
}

// worldMicros is the world time of a tick, µs.
func worldMicros(tick int64) int64 {
	return int64(float64(tick) * 1e6 / physics.StepsPerSecond)
}
