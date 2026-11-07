// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"fmt"
	"math"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/lookout"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sky"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// The sky as the boat's sailor sees it, in the report's words: the sun,
// its bearing and its height, or at night the moon and its phase; the
// light, dawn or dusk, moonlit, starlight or dark; and the cloud, the rain
// and the fog at the boat, and the showers, squalls and storms about, as
// the phone draws them. The Sky line is in a full report always and in a
// brief one when its words change.
//
// The moments of a day at sea are events: the sun rising and setting at
// the boat, a light in sight lit at dusk or put out at dawn (wake_on
// sky); rain beginning and ending at the boat, fog closing in and lifting,
// the wind up or down a force held a minute (wake_on weather); and the
// first to watch the boat coming and the last going, which wake no one.

// skyFacts are the sky over the boat.
type skyFacts struct {
	// Sun is the sun's words, "sun rising ESE"; or at night the moon's,
	// "a half moon low in the W", or "no moon".
	Sun string `json:"sun"`
	// SunBearing and SunHeight are where it stands, degrees; the height
	// is negative below the horizon.
	SunBearing int    `json:"sunBearing"`
	SunHeight  int    `json:"sunHeight"`
	Light      string `json:"light,omitempty"`
	Clouds     string `json:"clouds"`
	// key is its words without the sun's bearing and height, which change
	// a little every look: a brief report tells the line when it changes.
	key string
}

// The sun's heights the words change at, degrees.
const (
	sunHigh   = 50
	sunLow    = 12
	twilight  = -6
	moonLow   = 15
	moonHigh  = 50
	moonShown = 0.05 // the least lit share of a moon in sight
)

// skyTime is the sky's time at f's tick.
func skyTime(s *Sea, f *bus.Frame) float64 {
	return sky.Time(s.Sky, float64(s.Epoch.UnixMicro()), float64(int64(float64(f.Tick)*1e6/physics.StepsPerSecond)))
}

// skyOf is the sky over (x, y) at f's tick, nil without a sky.
func skyOf(s *Sea, f *bus.Frame, x, y float64) *skyFacts {
	if s.Sky == nil {
		return nil
	}
	t := skyTime(s, f)
	var sk sky.Sky
	sky.At(s.Sky, t, x, y, &sk)
	alt := deg(sk.Sun.Altitude)
	out := &skyFacts{SunBearing: degrees(sk.Sun.Bearing), SunHeight: int(math.Round(alt))}
	rising := sky.SunAltitude(s.Sky, t+60e6, x, y) > sk.Sun.Altitude
	clouds, overcast := cloudsOf(s, f, x, y)
	out.Clouds = clouds
	body := ""
	switch {
	case alt >= sunHigh:
		out.Sun, body = "sun high", "high"
	case alt >= sunLow:
		up := 5 * int(math.Round(alt/5))
		out.Sun, body = fmt.Sprintf("sun %s %d° up", point16(sk.Sun.Bearing), up), "up"
	case alt >= 0 && rising:
		out.Sun, body = "sun rising "+point16(sk.Sun.Bearing), "rising"
	case alt >= 0:
		out.Sun, body = "sun setting "+point16(sk.Sun.Bearing), "setting"
	default:
		out.Sun, body = moonWords(&sk)
		switch {
		case alt >= twilight && rising:
			out.Light = "dawn"
		case alt >= twilight:
			out.Light = "dusk"
		case overcast:
			out.Light = "dark"
		case deg(sk.Moon.Altitude) > 0 && sk.Lit >= 0.4:
			out.Light = "moonlit"
		case clouds == "clear":
			out.Light = "starlight"
		default:
			out.Light = "dark"
		}
	}
	out.key = body + "|" + out.Light + "|" + out.Clouds
	return out
}

// moonWords are the moon's words at night, and its key: its phase and
// where it stands, "a half moon low in the W", or "no moon".
func moonWords(sk *sky.Sky) (string, string) {
	alt := deg(sk.Moon.Altitude)
	if alt <= 0 || sk.Lit < moonShown {
		return "no moon", "no moon"
	}
	phase := "a full moon"
	switch {
	case sk.Lit < 0.35:
		phase = "a crescent moon"
	case sk.Lit < 0.65:
		phase = "a half moon"
	case sk.Lit < 0.95:
		phase = "a gibbous moon"
	}
	switch {
	case alt < moonLow:
		return phase + " low in the " + point16(sk.Moon.Bearing), phase + " low"
	case alt < moonHigh:
		return phase + " in the " + point16(sk.Moon.Bearing), phase
	}
	return phase + " high", phase + " high"
}

// The sheet cloud's cover the words change at: low and middle cloud over
// cloudyFrom is cloudy, over overcastFrom overcast; cirrus alone over
// highFrom is high cloud.
const (
	cloudyFrom   = 0.35
	overcastFrom = 0.75
	highFrom     = 0.4
)

// cloudsOf is the cloud at (x, y) and what is about, "overcast, light rain
// · a squall about", and whether it is overcast.
func cloudsOf(s *Sea, f *bus.Frame, x, y float64) (string, bool) {
	wt := s.weatherAt(f)
	if wt == nil || wt.Prepared() == nil {
		return "clear", false
	}
	sh := physics.SheetAt(wt, x, y)
	cover := max(sh.Low, sh.Middle)
	words := "clear"
	switch {
	case cover >= overcastFrom:
		words = "overcast"
	case cover >= cloudyFrom:
		words = "cloudy"
	case sh.Cirrus >= highFrom:
		words = "high cloud"
	}
	if rain := physics.RainAt(wt, x, y); rain > rainBegins {
		if words == "clear" || words == "high cloud" {
			words = rainWords(rain, s.RainWords)
		} else {
			words += ", " + rainWords(rain, s.RainWords)
		}
	}
	if weather.VisibilityWord(physics.VisibilityAt(wt, x, y), &s.Words) >= int(physics.VisibilityPoor) {
		words += ", fog"
	}
	if about := aboutOf(physics.NearAt(wt, x, y)); about != "" {
		words += " · " + about
	}
	return words, cover >= overcastFrom
}

// aboutOf is what weather is about a boat, from NearAt's bits: "showers
// about", "a squall, showers about".
func aboutOf(near int32) string {
	var about []string
	if near&weather.NearStorm != 0 {
		about = append(about, "a thunderstorm")
	}
	if near&weather.NearSquall != 0 {
		about = append(about, "a squall")
	}
	if near&weather.NearShower != 0 {
		about = append(about, "showers")
	}
	if near&weather.NearFog != 0 {
		about = append(about, "fog banks")
	}
	if len(about) == 0 {
		return ""
	}
	return strings.Join(about, ", ") + " about"
}

// text is the Sky line's words.
func (k *skyFacts) text() string {
	parts := []string{k.Sun}
	if k.Light != "" {
		parts = append(parts, k.Light)
	}
	return strings.Join(append(parts, k.Clouds), " · ")
}

// The rain at the boat that begins a shower and that ends it, mm/h: apart,
// so rain at the edge of a shower does not begin and end it over and over.
const (
	rainBegins = 0.1
	rainEnds   = 0.03
)

// forceHeld is how long the wind's force must hold, s, before its change
// is told; lightsEvery how often the lights in sight are looked at, s.
const (
	forceHeld   = 60
	lightsEvery = 5
)

// moments are what a helm remembers of the day at its boat, to tell the
// moments as they come: whether it knows them yet; the sun up; rain,
// fog; the force told and one held since a tick; the lights lit and those
// in sight at the last sighting look; how many were watching.
type moments struct {
	known          bool
	at, lightsAt   int64
	sunUp          bool
	raining, foggy bool
	force          int
	next           int
	nextSince      int64
	lit, seen      []bool
	watched        int
}

// moments are the moments at the helm's boat in slot sl since its last
// look, as events. With mu held.
func (h *helm) moments(s *Sea, f *bus.Frame, sl int32, sighted bool) []event {
	m := &h.days
	if !sighted && m.known && f.Tick-m.at < physics.StepsPerSecond {
		return nil
	}
	m.at = f.Tick
	st := &f.State[sl]
	// The lights are looked for at a sighting look every lightsEvery s.
	sighted = sighted && (!m.known || f.Tick-m.lightsAt >= lightsEvery*physics.StepsPerSecond)
	if sighted {
		m.lightsAt = f.Tick
	}
	var out []event
	tell := func(k evKind, words string) {
		if m.known {
			out = append(out, event{Tick: f.Tick, Kind: k, Words: words})
		}
	}
	if s.Sky != nil {
		t := skyTime(s, f)
		var sk sky.Sky
		sky.At(s.Sky, t, st.X, st.Y, &sk)
		up := sk.Sun.Altitude > 0
		if up != m.sunUp {
			if up {
				tell(evSunrise, "sunrise, the sun rising "+point16(sk.Sun.Bearing))
			} else {
				tell(evSunset, "sunset, the sun gone down in the "+point16(sk.Sun.Bearing))
			}
			m.sunUp = up
		}
	}
	if wt := s.weatherAt(f); wt != nil && wt.Prepared() != nil {
		rain := physics.RainAt(wt, st.X, st.Y)
		switch {
		case !m.raining && rain > rainBegins:
			m.raining = true
			tell(evRain, rainWords(rain, s.RainWords)+" beginning")
		case m.raining && rain < rainEnds:
			m.raining = false
			tell(evRainEnds, "the rain has stopped")
		}
		vis := weather.VisibilityWord(physics.VisibilityAt(wt, st.X, st.Y), &s.Words)
		foggy := vis >= int(physics.VisibilityPoor)
		if foggy != m.foggy {
			m.foggy = foggy
			word := [...]string{"good", "moderate", "poor", "very poor"}[vis]
			if foggy {
				tell(evFog, "fog closing in, visibility "+word)
			} else {
				tell(evFogLifts, "the fog lifting, visibility "+word)
			}
		}
		mean, _ := physics.MeanWindAt(wt, st.X, st.Y)
		force := lookout.BeaufortForce(mean)
		switch {
		case !m.known:
			m.force, m.next = force, force
		case force != m.next:
			m.next, m.nextSince = force, f.Tick
		case m.next != m.force && f.Tick-m.nextSince >= forceHeld*physics.StepsPerSecond:
			way := "up"
			if m.next < m.force {
				way = "down"
			}
			m.force = m.next
			tell(evForce, fmt.Sprintf("the wind %s to force %d, %d kn", way, m.force, knots0(mean)))
		}
	}
	if sighted && s.Sight != nil && s.Sight.Table != nil && s.Chart != nil {
		out = append(out, h.lightMoments(s, f, sl, m.known)...)
	}
	out = append(out, h.lifeMoments(s, f, sl, m.known)...)
	if s.Watchers != nil {
		n := s.Watchers(bus.Account(h.account))
		switch {
		case m.watched == 0 && n > 0:
			tell(evWatched, "someone is watching")
		case m.watched > 0 && n == 0:
			tell(evUnwatched, "no one watching now")
		}
		m.watched = n
	}
	m.known = true
	return out
}

// lightMoments are the lights in sight lit or put out since the last
// sighting look, when the helm knows them already. With mu held.
func (h *helm) lightMoments(s *Sea, f *bus.Frame, sl int32, known bool) []event {
	m := &h.days
	t := s.Sight.Table
	lit, _ := s.lights(f)
	seen := map[int32]bool{}
	for _, x := range s.seenSubjects(f, sl) {
		seen[x.Subject] = true
	}
	n := t.Lights()
	if len(m.lit) != n {
		m.lit, m.seen = make([]bool, n), make([]bool, n)
		known = false
	}
	var out []event
	for i := range n {
		_, _, sub := t.LightAt(i)
		now := seen[sub]
		switch {
		case !known:
		case lit[i] && !m.lit[i] && now:
			out = append(out, event{Tick: f.Tick, Kind: evLightLit, Words: s.lightWords(f, sl, sub) + " lit"})
		case !lit[i] && m.lit[i] && m.seen[i]:
			out = append(out, event{Tick: f.Tick, Kind: evLightOut, Words: s.lightWords(f, sl, sub) + " put out"})
		}
		m.lit[i], m.seen[i] = lit[i], now
	}
	return out
}

// lightWords name a lighthouse's light: by its charted name, or by its
// bearing from the boat in slot sl.
func (s *Sea) lightWords(f *bus.Frame, sl int32, subject int32) string {
	w := s.Chart.World()
	if int(subject) >= len(w.Subjects) {
		return "a light"
	}
	sub := &w.Subjects[subject]
	for _, c := range s.Chart.Load().Subjects {
		if c == subject {
			return titleOf(sub)
		}
	}
	st := &f.State[sl]
	return "a light " + three(bearing5(physics.Atan2(sub.X-st.X, sub.Y-st.Y)))
}
