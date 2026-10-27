// SPDX-License-Identifier: AGPL-3.0-only

package forecast

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// PlaceWords make a place's box and outlook, as the chart's box and the
// harbourmaster's board give them to a sailor there: the box measured at
// the place's points at a tick, the outlook from an issue of the forecast.
type PlaceWords struct {
	Timeline *weather.Timeline
	Words    weather.Words
	// Outlook are the outlook's samples, minutes after the issue.
	Outlook []float64
}

// At is a place's box at tick, measured at its points, and its outlook from
// the issue x, with the developer's weathers and systems ws and ss.
func (p *PlaceWords) At(tick int64, ws []bus.Weather, ss []bus.System, points *[9][2]float64, x *Issue) (weather.Box, string) {
	tl := p.Timeline
	minute := int64(60 * physics.StepsPerSecond)
	pw := weather.PlaceAt(tickAt(tl, tick, ws, ss), tickAt(tl, tick-5*minute, ws, ss), tickAt(tl, tick-15*minute, ws, ss), points)
	box := weather.BoxOf(&pw, &p.Words)
	if x == nil {
		return box, ""
	}
	// The outlook: the place's weather on the forecast at each of the
	// samples after the issue, as the forecast's spells and steps make it.
	f := &x.Forecast
	prep := tl.Prepared()
	fw := &physics.Weather{Prepared: prep}
	on := func(t int64) *physics.WeatherTick {
		out := new(physics.WeatherTick)
		physics.ForecastAt(fw, f, float64(t))
		physics.WeatherAt(fw, out, float64(t))
		return out
	}
	var samples []weather.OutlookSample
	for _, m := range p.Outlook {
		t := x.Tick + int64(math.Round(m*float64(minute)))
		s := weather.OutlookSample{At: m}
		s.PlaceWeather = weather.PlaceAt(on(t), on(t-5*minute), on(t-15*minute), points)
		samples = append(samples, s)
	}
	end := endOf(tl)
	falls := end > 0 && end <= x.Tick+prep.ForecastHorizon()
	return box, weather.Outlook(samples, falls, &p.Words)
}

// tickAt is the timeline's weather at a tick, ready for the wind and the
// pressure at points.
func tickAt(tl *weather.Timeline, tick int64, ws []bus.Weather, ss []bus.System) *physics.WeatherTick {
	w := &physics.Weather{Prepared: tl.Prepared()}
	var sp [physics.WeatherSpells]physics.Spell
	w.Set(sp[:tl.Spells(tick, ws, &sp)])
	var keys [bus.KeyFrames]physics.Keyframe
	tl.Keyframes(tick, ss, &keys)
	w.SetKeys(keys[:2])
	var t physics.WeatherTick
	physics.WeatherAt(w, &t, float64(tick))
	return &t
}

// endOf is the world's last tick as its week was made for, 0 for none.
func endOf(tl *weather.Timeline) int64 {
	w := tl.Week()
	if w == nil || w.Ends == 0 {
		return 0
	}
	return weather.TicksOf(w.Epoch, w.Ends) + tl.Origin()
}
