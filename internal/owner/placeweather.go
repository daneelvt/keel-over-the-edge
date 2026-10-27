// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"math"
	"net/http"
	"strconv"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	position "github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen/chart"
)

// A place's weather on the world page, as a box on the chart gives it to a
// sailor there: its wind, gusts, sky, visibility and barometer at the tick
// shown, measured about the point clicked, an island over its bounds, or a
// place; its outlook from the issue in force; and its position, as every
// chart writes it.

// placeWeatherPage is place.json.
type placeWeatherPage struct {
	At       int64   `json:"at"`
	Issue    int64   `json:"issue"` // the issue the outlook is of
	East     float64 `json:"east"`
	North    float64 `json:"north"`
	Position string  `json:"position"`
	// Name is the island's or the place's asked about; "" for a point.
	Name    string      `json:"name"`
	Box     weather.Box `json:"box"`
	Outlook string      `json:"outlook"`
}

// placeWeather serves place.json: a place's box and outlook at a tick, ?at=
// or now, of a point (?east= and ?north=, m), an island (?island=, its
// number) or a place (?place=, its number).
func (o *Owner) placeWeather(w http.ResponseWriter, r *http.Request) {
	tl, now, ws, ss := o.weatherState()
	if tl == nil || tl.Week() == nil {
		http.Error(w, "the world has no week of weather yet", http.StatusNotFound)
		return
	}
	tick, ok := at(r, now)
	if !ok {
		http.Error(w, "at is a tick", http.StatusBadRequest)
		return
	}
	q := r.URL.Query()
	page := placeWeatherPage{At: tick}
	var bounds *[4]float64
	b := o.cfg.Bundle
	switch {
	case q.Has("island"):
		n, err := strconv.Atoi(q.Get("island"))
		if err != nil || b == nil || n < 0 || n >= len(b.Islands) {
			http.Error(w, "no such island", http.StatusNotFound)
			return
		}
		is := &b.Islands[n]
		page.East, page.North, page.Name = is.X, is.Y, is.Name
		if x0, y0, x1, y1, ok := chart.IslandBounds(b, n); ok {
			bounds = &[4]float64{x0, y0, x1, y1}
		}
	case q.Has("place"):
		n, err := strconv.Atoi(q.Get("place"))
		found := false
		if err == nil && b != nil {
			for i := range b.Places {
				if p := &b.Places[i]; int(p.Number) == n {
					page.East, page.North, page.Name, found = p.X, p.Y, p.Name, true
				}
			}
		}
		if !found {
			http.Error(w, "no such place", http.StatusNotFound)
			return
		}
	default:
		east, err1 := strconv.ParseFloat(q.Get("east"), 64)
		north, err2 := strconv.ParseFloat(q.Get("north"), 64)
		if err1 != nil || err2 != nil || math.IsNaN(east) || math.IsNaN(north) || math.Abs(east) > 20000 || math.Abs(north) > 20000 {
			http.Error(w, "east and north, m within 20 km of the centre, an island or a place is required", http.StatusBadRequest)
			return
		}
		page.East, page.North = east, north
	}
	points := weather.PlacePoints(page.East, page.North, bounds)
	page.Box, page.Outlook, page.Issue = o.placeWords(tl, tick, ws, ss, &points)
	page.Position = position.Format(page.East, page.North)
	page.East, page.North = round2(page.East), round2(page.North)
	writeJSON(w, &page)
}

// placeWords are a place's box at a tick, measured at its points, and its
// outlook from the issue in force then, with that issue.
func (o *Owner) placeWords(tl *weather.Timeline, tick int64, ws []bus.Weather, ss []bus.System, points *[9][2]float64) (weather.Box, string, int64) {
	minute := int64(60 * physics.StepsPerSecond)
	pw := weather.PlaceAt(physicsAt(tl, tick, ws, ss), physicsAt(tl, tick-5*minute, ws, ss), physicsAt(tl, tick-15*minute, ws, ss), points)
	box := weather.BoxOf(&pw, &o.cfg.Words)

	// The outlook: the place's weather on the forecast at each of the
	// samples after the issue, as the forecast's spells and steps make it.
	x, _ := o.shownIssue(tl, tick, ws, ss)
	f := &x.Forecast
	p := tl.Prepared()
	fw := &physics.Weather{Prepared: p}
	on := func(t int64) *physics.WeatherTick {
		out := new(physics.WeatherTick)
		physics.ForecastAt(fw, f, float64(t))
		physics.WeatherAt(fw, out, float64(t))
		return out
	}
	var samples []weather.OutlookSample
	for _, m := range o.cfg.Outlook {
		t := x.Tick + int64(math.Round(m*float64(minute)))
		s := weather.OutlookSample{At: m}
		s.PlaceWeather = weather.PlaceAt(on(t), on(t-5*minute), on(t-15*minute), points)
		samples = append(samples, s)
	}
	end := worldEnd(tl)
	falls := end > 0 && end <= x.Tick+p.ForecastHorizon()
	return box, weather.Outlook(samples, falls, &o.cfg.Words), x.Tick
}
