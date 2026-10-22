// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sight"
	"github.com/daneelvt/keel-over-the-edge/internal/sky"
)

// Sighting, in the rules phase. Each boat's lookout looks once every
// Sight.Every ticks, the boats in turn by their numbers, for what the world
// has not charted: the sight table says what it sees (package sight). The
// first boat to see a thing charts it, for everyone, and its sailor is
// credited: of two that see it in one tick, the nearer, then the one of
// the lower number, as a ship's log credits the first to sight land. What
// is charted with a thing (its island's features seen from no water) is
// charted with it, credited to no one. A boat placed by the owner's tools
// in its voyage charts nothing, nor one staying while its owner's free
// camera roams, nor one falling over the lip.
//
// A look sees through the weather at the tick: the optical depth along
// the line to a thing, the clear air's, the fog banks', the rain's and the
// mist band's (package sight). A light is lit while the sun is below the
// horizon at it, or while the visibility at it is poor or worse, looked
// at again once a second; it is seen against night's threshold while the
// sun is a degree or more below the horizon, against the day's while it
// is up, and between them across the sun's last degree, as the lanterns
// light.

// Sight is what a world's lookouts see by.
type Sight struct {
	Table *sight.Table
	// Every is how many ticks apart a boat looks.
	Every int64
	// Lookouts are the lookouts' heights by boat kind, m.
	Lookouts []float64
	// Sky and Epoch, the world's epoch in µs of UTC since 1970, say when
	// the sun is down at a light; nil for always.
	Sky   *sky.Prepared
	Epoch int64
	// Night and Day are the thresholds a light is seen against at night
	// and by day, lux; nothing for the table's night's always.
	Night, Day float64
}

// lastDegree is the sun's last degree below the horizon, rad, across which
// a light's threshold goes from the day's to night's.
const lastDegree = math.Pi / 180

// litEvery is how often the lights are looked at, ticks: a second.
const litEvery = physics.StepsPerSecond

// chartState is what a world keeps of its chart.
type chartState struct {
	sight    *Sight
	charted  []uint64
	lit      []bool
	thr      []float64 // each light's threshold, ln lux
	litAt    int64
	lookouts []sight.Lookout
	seen     []sight.Seen
	found    []chartFound
}

// chartFound is a subject first seen this tick: by the boat in slot, d2 m²
// from it.
type chartFound struct {
	subject int32
	slot    int32
	d2      float64
}

// initChart readies the world's sighting.
func (w *World) initChart(s *Sight, kinds int) {
	if s == nil || s.Table == nil {
		return
	}
	c := &w.chart
	c.sight = s
	if c.sight.Every < 1 {
		c.sight.Every = 1
	}
	c.charted = make([]uint64, sight.Words(len(s.Table.Subjects())))
	c.lit = make([]bool, s.Table.Lights())
	if s.Night > 0 && s.Day > 0 {
		c.thr = make([]float64, s.Table.Lights())
	}
	c.litAt = -1 << 62
	for k := range kinds {
		h := 2.0
		if k < len(s.Lookouts) {
			h = s.Lookouts[k]
		}
		c.lookouts = append(c.lookouts, s.Table.Lookout(h))
	}
	c.seen = make([]sight.Seen, 0, 64)
	c.found = make([]chartFound, 0, 64)
}

// SetCharted marks the subjects given charted, by their index in the sight
// table: what the world's chart already holds. Before the first tick only.
func (w *World) SetCharted(subjects []int32) {
	c := &w.chart
	for _, s := range subjects {
		if s >= 0 && int(s>>6) < len(c.charted) {
			c.charted[s>>6] |= 1 << (s & 63)
		}
	}
}

// IsCharted reports whether subject s is charted.
func (w *World) IsCharted(s int32) bool {
	c := &w.chart
	return s >= 0 && int(s>>6) < len(c.charted) && c.charted[s>>6]&(1<<(s&63)) != 0
}

// sighting has the boats due to look look, and charts what they see first.
func (w *World) sighting() {
	c := &w.chart
	if c.sight == nil {
		return
	}
	f := w.next
	if f.Tick-c.litAt >= litEvery {
		c.litAt = f.Tick
		w.lights(f.Tick)
	}
	every := c.sight.Every
	c.found = c.found[:0]
	cond := sight.Conditions{Weather: &w.wind, Lit: c.lit, Threshold: c.thr}
	for _, s := range f.Live {
		if (int64(f.Boat[s])+f.Tick)%every != 0 {
			continue
		}
		v := &f.Voyage[s]
		if v.Placed || v.Falling() || f.Stay[s] || int(f.Kind[s]) >= len(c.lookouts) {
			continue
		}
		l := c.lookouts[f.Kind[s]]
		l.X, l.Y = f.State[s].X, f.State[s].Y
		c.seen = c.sight.Table.Look(&l, c.charted, &cond, c.seen[:0])
		for _, seen := range c.seen {
			w.found(f, seen.Subject, s, seen.D2)
		}
	}
	for _, fd := range c.found {
		w.charts(f, fd.subject, -1, fd.slot)
		for _, with := range c.sight.Table.With(fd.subject) {
			if !w.IsCharted(with) {
				w.charts(f, with, fd.subject, fd.slot)
			}
		}
	}
}

// found keeps subject seen from slot s at d2 m², unless a nearer boat, or
// one as near of a lower number, saw it this tick.
func (w *World) found(f *bus.Frame, subject, s int32, d2 float64) {
	c := &w.chart
	for i := range c.found {
		fd := &c.found[i]
		if fd.subject != subject {
			continue
		}
		if d2 < fd.d2 || d2 == fd.d2 && f.Boat[s] < f.Boat[fd.slot] {
			fd.slot, fd.d2 = s, d2
		}
		return
	}
	c.found = append(c.found, chartFound{subject: subject, slot: s, d2: d2})
}

// charts charts subject in f, sighted from slot s, or with another; s −1
// for none: charted by no boat.
func (w *World) charts(f *bus.Frame, subject, with, s int32) {
	c := &w.chart
	c.charted[subject>>6] |= 1 << (subject & 63)
	ch := bus.Charted{Tick: f.Tick, Subject: subject, With: with, Slot: s}
	if s >= 0 {
		st := &f.State[s]
		ch.Boat, ch.Owner, ch.X, ch.Y = f.Boat[s], f.Owner[s], st.X, st.Y
	}
	f.Charted = append(f.Charted, ch)
}

// chartByHand charts subject, or with all every subject, by no boat, with
// what is charted with each: what the chart holds from the world's start.
func (w *World) chartByHand(f *bus.Frame, subject int32, all bool) {
	c := &w.chart
	if c.sight == nil {
		return
	}
	n := int32(len(c.sight.Table.Subjects()))
	for s := range n {
		if !all && s != subject || w.IsCharted(s) {
			continue
		}
		w.charts(f, s, -1, -1)
		for _, with := range c.sight.Table.With(s) {
			if !w.IsCharted(with) {
				w.charts(f, with, s, -1)
			}
		}
	}
}

// lights sets which lights are lit at tick, those with the sun below the
// horizon at them or the visibility at them poor or worse, and the
// threshold each is seen against.
func (w *World) lights(tick int64) {
	c := &w.chart
	sk := c.sight.Sky
	t := 0.0
	if sk != nil {
		t = sky.Time(sk, float64(c.sight.Epoch), float64(float64(tick)*1e6)/physics.StepsPerSecond)
	}
	p := w.wind.Prepared()
	night, day := 0.0, 0.0
	if c.thr != nil {
		night, day = physics.Log(c.sight.Night), physics.Log(c.sight.Day)
	}
	for i := range c.lit {
		x, y, _ := c.sight.Table.LightAt(i)
		sun := -math.Pi / 2
		if sk != nil {
			sun = sky.SunAltitude(sk, t, x, y)
		}
		c.lit[i] = sun < 0 || p != nil && p.VisibilityWord(physics.VisibilityAt(&w.wind, x, y)) >= physics.VisibilityPoor
		if c.thr != nil {
			share := min(max(float64((sun+lastDegree)/lastDegree), 0), 1)
			c.thr[i] = night + float64(share*(day-night))
		}
	}
}
