// SPDX-License-Identifier: AGPL-3.0-only

package weather

import (
	"fmt"
	"math"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The signs before weather: a squall's tower before its gust front, a
// storm's cloud before its wind, a shower's before its own, and a front's
// cirrus before its line, at the places each reaches, as a sailor 2 m up
// sees them over the dome's horizon.

// cloudLead is a heaped cloud's lead on its own wind at the places that
// wind reaches: how many, at how many the wind came first, at how many the
// lead was under its warning, and the leads, minutes.
type cloudLead struct {
	systems, places, windFirst, short int
	leads                             []float64
}

// cloudSigns are the heaped clouds whose lead is tallied: the form, the
// knots of its own wind the lead is measured to, and the warning it must
// give at nineteen places in twenty.
var cloudSigns = []struct {
	form            catalog.CloudForm
	name            string
	knots, warnings float64
}{
	{catalog.CloudFormCumulonimbus, "A squall's tower, to its 10-knot gust front", 10, 5},
	{catalog.CloudFormCumulus, "A shower's cloud, to its 4-knot wind", 4, 2},
	{catalog.CloudFormStorm, "A storm's cloud, to its 20-knot wind", 20, 10},
}

// frontWarning is the least lead a front's cirrus gives on its line,
// minutes; its cirrus is seen once it covers cirrusSeen of the sky, its
// first streaks.
const (
	frontWarning = 40
	cirrusSeen   = 0.1
)

// seenFrom reports whether any of a heaped cloud shows above the horizon
// of a sailor at (x, y), on a dome of radius dome: its top, from behind to
// ahead of its centre along its track, or its deck.
func seenFrom(c *physics.Cloud, dome, x, y float64) bool {
	ux, uy := math.Sin(c.Heading), math.Cos(c.Heading)
	dx, dy := x-c.East, y-c.North
	along := math.Min(math.Max(dx*ux+dy*uy, -c.Behind), c.Ahead)
	if math.Hypot(dx-along*ux, dy-along*uy) <= physics.CloudSight(dome, c.Top) {
		return true
	}
	return c.Deck > 0 && math.Hypot(dx, dy)-c.Deck <= physics.CloudSight(dome, c.DeckTop)
}

// checkCloudLeads tallies the week's heaped clouds' leads on their own
// wind: on a grid step apart over the disk, every half minute from a
// system's birth to its end, the first tick its cloud shows over a place's
// horizon and the first its own wind, alone in still air, reaches its
// knots there.
func checkCloudLeads(cat *catalog.Catalog, tl *Timeline, w *Week, step float64, tally *weeksTally) {
	p := tl.Prepared()
	dome := cat.World.Handout.Dome
	edge := 0.97 * p.Edge()
	type place struct {
		x, y       float64
		seen, wind int64
	}
	for _, s := range w.Systems {
		r := &s.SystemRecord
		sign := -1
		for k, g := range cloudSigns {
			if cat.Weather.Systems[int(r.Kind)].Cloud.Form == g.form {
				sign = k
			}
		}
		if sign < 0 {
			continue
		}
		cl := &tally.clouds[sign]
		cl.systems++
		var places []place
		for x := -edge; x <= edge; x += step {
			for y := -edge; y <= edge; y += step {
				if math.Hypot(x, y) <= edge {
					places = append(places, place{x: x, y: y, seen: -1, wind: -1})
				}
			}
		}
		knots := cloudSigns[sign].knots * knot
		var clouds [physics.MaxClouds]physics.Cloud
		for tick := int64(r.Born); tick < int64(r.Gone); tick += ticksPerMinute / 2 {
			own := stormOnly(tl, tick, s.Slot)
			n := physics.HeapedClouds(own, clouds[:])
			for i := range places {
				pl := &places[i]
				if pl.seen < 0 && n > 0 && seenFrom(&clouds[0], dome, pl.x, pl.y) {
					pl.seen = tick
				}
				if pl.wind < 0 {
					if v, _ := meanAt(own, pl.x, pl.y); v >= knots {
						pl.wind = tick
					}
				}
			}
		}
		for _, pl := range places {
			if pl.wind < 0 {
				continue
			}
			cl.places++
			lead := math.Inf(-1)
			if pl.seen >= 0 {
				lead = float64(pl.wind-pl.seen) / ticksPerMinute
			}
			cl.leads = append(cl.leads, lead)
			if !(lead > 0) {
				cl.windFirst++
			}
			if lead < cloudSigns[sign].warnings {
				cl.short++
			}
		}
	}
}

// checkFrontCirrus tallies each front's cirrus's lead on its line: on a
// grid step apart over the disk, every half minute from an hour before its
// spell begins to its line's arrival, the first tick its cirrus covers
// cirrusSeen of the sky where a sailor at the place sees furthest toward it, the
// spells in play and the coming front as a phone holds them.
func checkFrontCirrus(cat *catalog.Catalog, tl *Timeline, w *Week, step float64, tally *weeksTally) {
	p := tl.Prepared()
	sight := physics.CloudSight(cat.World.Handout.Dome, p.LayerHeight(physics.LayerCirrus))
	edge := 0.97 * p.Edge()
	reach := p.FrontReach()
	for i := 1; i < len(w.Spells); i++ {
		s := w.Spells[i]
		if s.Front == 0 || s.Begin+s.Change > float64(w.Until) || s.Begin < 2*hourTicks {
			continue
		}
		tally.fronts++
		fe, fn := physics.SinCos(s.Toward * (2 * math.Pi / turn))
		speed := 2 * reach / s.Change
		type place struct {
			x, y, arrive float64
			seen         int64
		}
		var places []place
		for x := -edge; x <= edge; x += step {
			for y := -edge; y <= edge; y += step {
				if math.Hypot(x, y) <= edge {
					along := x*fe + y*fn
					places = append(places, place{x: x, y: y, seen: -1, arrive: s.Begin + (along+reach)/speed})
				}
			}
		}
		begin := int64(s.Begin)
		for tick := begin - hourTicks; tick < begin+int64(s.Change); tick += ticksPerMinute / 2 {
			at := phoneWeather(tl, tick)
			for k := range places {
				pl := &places[k]
				if pl.seen >= 0 || float64(tick) > pl.arrive {
					continue
				}
				if physics.SheetAt(at, pl.x-sight*fe, pl.y-sight*fn).Cirrus >= cirrusSeen {
					pl.seen = tick
				}
			}
		}
		for _, pl := range places {
			lead := math.Inf(-1)
			if pl.seen >= 0 {
				lead = (pl.arrive - float64(pl.seen)) / ticksPerMinute
			}
			tally.cirrus = append(tally.cirrus, lead)
			if lead < frontWarning {
				tally.cirrusShort++
			}
		}
	}
}

// phoneWeather is the weather a phone holds at a tick: the spells in play,
// the coming front and the keyframes, as the server sends them.
func phoneWeather(tl *Timeline, tick int64) *physics.WeatherTick {
	w := &physics.Weather{Prepared: tl.Prepared()}
	var sp [physics.WeatherSpells]physics.Spell
	w.Set(sp[:tl.Spells(tick, nil, &sp)])
	c := tl.Coming(tick, nil)
	w.SetComing(&c)
	var keys [bus.KeyFrames]physics.Keyframe
	tl.Keyframes(tick, nil, &keys)
	w.SetKeys(keys[:2])
	var at physics.WeatherTick
	physics.WeatherAt(w, &at, float64(tick))
	return &at
}

// cloudsMarkdown is the clouds' part of the tally.
func (t *weeksTally) cloudsMarkdown() string {
	var b strings.Builder
	b.WriteString("\nThe clouds' leads on their own wind, at the places it reaches, seen over the horizon 2 m up.\n\n")
	b.WriteString("| Sign | Systems | Places | Lead: 10th percentile, median | Share under its warning | The wind first |\n|---|---|---|---|---|---|\n")
	for i, c := range t.clouds {
		fmt.Fprintf(&b, "| %s (%.0f min) | %d | %d | %.1f, %.1f min | %.1f%% | %d |\n", cloudSigns[i].name, cloudSigns[i].warnings, c.systems, c.places,
			percentile(c.leads, 0.1), percentile(c.leads, 0.5), share(c.short, c.places), c.windFirst)
	}
	if len(t.cirrus) > 0 {
		fmt.Fprintf(&b, "| A front's cirrus, to its line (%d min) | %d | %d | %.1f, %.1f min | %.1f%% | — |\n", frontWarning, t.fronts, len(t.cirrus),
			percentile(t.cirrus, 0.1), percentile(t.cirrus, 0.5), share(t.cirrusShort, len(t.cirrus)))
	}
	return b.String()
}
