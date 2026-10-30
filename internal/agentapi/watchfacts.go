// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/lookout"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sight"
	"github.com/daneelvt/keel-over-the-edge/internal/sky"
	"github.com/daneelvt/keel-over-the-edge/internal/watch"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// The facts the list of sailors to watch tells of each boat, and the card
// about one, made by the same functions as the lookout report, so that a
// spectator choosing a boat and the machine sailor sailing it are told the
// same weather, the same edge and the same land in sight.

var _ watch.Sea = (*Sea)(nil)

// Facts are the facts of the boats in the slots of f, in order: the sky
// at each as the weather pusher draws it, night or day there, the mean
// wind's force, the speed through the water, whether upright, how far
// inside the lip, its approach and closest pass, and what it last charted.
func (s *Sea) Facts(f *bus.Frame, slots []int32, out []watch.Facts) {
	wt := s.weatherAt(f)
	before, quarter := s.weatherBefore(f, 5), s.weatherBefore(f, 15)
	prepared := s.Timeline.Prepared()
	charted := s.chartedBy(f)
	tm := 0.0
	if s.Sky != nil {
		tm = sky.Time(s.Sky, float64(s.Epoch.UnixMicro()), float64(int64(float64(f.Tick)*1e6/physics.StepsPerSecond)))
	}
	var wp physics.WindPoint
	for i, sl := range slots {
		st := &f.State[sl]
		x := &out[i]
		points := weather.PlacePoints(st.X, st.Y, nil)
		pw := weather.PlaceAt(wt, before, quarter, &points)
		x.Sky = weather.SkyOf(&pw, weather.BoxOf(&pw, &s.Words))
		x.Night = s.Sky != nil && sky.SunAltitude(s.Sky, tm, st.X, st.Y) <= 0
		physics.WindPointAt(wt, st.X, st.Y, &wp, s.Shelter)
		x.Force = lookout.BeaufortForce(wp.MeanSpeed)
		x.Knots = math.Floor(knots(math.Sqrt(st.Surge*st.Surge+st.Sway*st.Sway))*10+0.5) / 10
		switch st.SailorMode {
		case physics.InWater:
			x.State = watch.StateCapsized
		case physics.OnBoard, physics.Climbing:
			x.State = watch.StateRighting
		default:
			x.State = watch.StateSailing
		}
		x.Edge = -1
		if prepared != nil {
			x.Edge = math.Floor(max(physics.EdgeDistance(prepared, st.X, st.Y), 0)/nm*10+0.5) / 10
		}
		v := &f.Voyage[sl]
		x.Approaching = v.Approaching
		if v.Survived {
			x.Skimmed = v.Best
		}
		if c, ok := charted[f.Boat[sl]]; ok {
			x.Charted = c.subject
			x.Minutes = int((f.Tick - c.tick) / (60 * physics.StepsPerSecond))
		}
	}
}

// Card is the card's facts of the boat in slot sl of f: the weather at
// it, the nearest charted island, and the land its lookout sees now,
// charted by name and the rest by its look, as the report gives them.
func (s *Sea) Card(f *bus.Frame, sl int32) watch.Card {
	st := &f.State[sl]
	var out watch.Card
	var wp physics.WindPoint
	physics.WindPointAt(s.weatherAt(f), st.X, st.Y, &wp, s.Shelter)
	out.Weather.WindFrom = degrees(wp.MeanFrom)
	if sea := seaOf(s, f, st.X, st.Y); sea != nil {
		out.Weather.Waves = sea.Waves
	}
	w := weatherOf(s, f, st.X, st.Y)
	out.Weather.Barometer, out.Weather.Visibility, out.Weather.Rain, out.Weather.Clouds = w.Barometer, w.Visibility, w.Rain, w.Clouds
	out.Where.Island = s.nearestIsland(st.X, st.Y)
	for _, l := range s.landLines(f, sl) {
		out.Where.InSight = append(out.Where.InSight, l.text)
	}
	return out
}

// nearestIsland is the charted island nearest (x, y), nil for none.
func (s *Sea) nearestIsland(x, y float64) *watch.Island {
	if s.Chart == nil {
		return nil
	}
	w := s.Chart.World()
	var best *watch.Island
	bestD := math.Inf(1)
	for _, i := range s.Chart.Load().Subjects {
		if int(i) >= len(w.Subjects) {
			continue
		}
		sub := &w.Subjects[i]
		if sub.Kind != sight.Island {
			continue
		}
		dx, dy := sub.X-x, sub.Y-y
		if d := math.Sqrt(dx*dx + dy*dy); d < bestD {
			bestD = d
			best = &watch.Island{Name: sub.Name, Bearing: degrees(physics.Atan2(dx, dy)), NM: math.Floor(d/nm*10+0.5) / 10}
		}
	}
	return best
}

// charting is what a boat last charted, and the tick.
type charting struct {
	subject string
	tick    int64
}

// chartedBy is what each boat last charted, by its boat's id: a boat's
// id is its voyage's, so these are this voyage's.
func (s *Sea) chartedBy(f *bus.Frame) map[uint64]charting {
	if s.Chart == nil {
		return nil
	}
	w := s.Chart.World()
	c := s.Chart.Load()
	out := map[uint64]charting{}
	for i := range c.Rows {
		r := &c.Rows[i]
		if r.Boat == 0 || r.Tick > f.Tick || int(c.Subjects[i]) >= len(w.Subjects) {
			continue
		}
		if was, ok := out[r.Boat]; ok && was.tick >= r.Tick {
			continue
		}
		sub := &w.Subjects[c.Subjects[i]]
		name := sub.Name
		if name == "" {
			name = sub.Title
		}
		out[r.Boat] = charting{subject: name, tick: r.Tick}
	}
	return out
}
