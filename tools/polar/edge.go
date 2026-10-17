// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"fmt"
	"math"
	"runtime"
	"strings"
	"sync"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/scripted"
)

// The line of no return at the lip: how close to the lip a Jolly boat can
// lie and still sail clear of it against the drain and the falls' draft.
// At each distance inside the lip the boat is put on the autopilot at each
// of the angles off the wind on the tack that leads inward, its sheet set
// for the angle and the wind as a sailor sets it, and sailed for two
// minutes in the wind, the current and the sea of that place; its best
// course's mean speed over the ground away from the lip over the second
// minute says whether it gains there. The line is the least distance at
// which it does: 1 m where it gains from the lip itself.
//
// In flat water and a steady wind the measurement is the reference; with a
// spell's gusts and shifts and the sea its wind raises over open water it
// is the game's.

// edgeDistances are the distances inside the lip the boat is tried at, m.
var edgeDistances = []float64{1, 25, 50, 75, 100, 150, 200, 250, 300, 350, 400, 450, 500}

// edgeAngles are the angles off the wind the boat is tried on, degrees:
// seventeen from 38° to 170°.
func edgeAngles() []float64 {
	a := make([]float64, 17)
	for i := range a {
		a[i] = 38 + float64(i)*(170-38)/16
	}
	return a
}

const (
	edgeSettle  = 60 * physics.StepsPerSecond // the first minute
	edgeMeasure = 60 * physics.StepsPerSecond // the second
)

// edgeWorld is what a boat at the lip sails in: the wind's constants and a
// spell, whether it sails in the sea the spell raises, and the world's way
// round the disk.
type edgeWorld struct {
	prepared *physics.WeatherPrepared
	spell    physics.Spell
	waves    *physics.Waves
	sea      bool
	way      float64
}

// edgeTick is the tick the boats sail from: late in a world's life.
const edgeTick = 740_000_000

// gains is the best course's mean speed away from the lip at d metres
// inside it, m/s: negative where every course loses ground. The point of
// the lip it lies off is the one the wind blows onto (onto) or off.
func (w *edgeWorld) gains(b *physics.Prepared, d float64, onto bool) float64 {
	weather := physics.Weather{Prepared: w.prepared}
	weather.Set([]physics.Spell{w.spell})
	var at physics.WeatherTick
	physics.WeatherAt(&weather, &at, edgeTick)
	// Where the spell's mean wind blows onto the lip: the point the wind
	// blows toward, out from the centre.
	_, from := physics.MeanWindAt(&at, 0, 0)
	bearing := from + math.Pi
	if !onto {
		bearing = from
	}
	r := w.prepared.Edge() - d
	x0, y0 := r*math.Sin(bearing), r*math.Cos(bearing)
	ce, cn := physics.CurrentAt(w.prepared, w.way, x0, y0, nil)
	var sea *openSea
	if w.sea {
		speed, from := physics.MeanWindAt(&at, x0, y0)
		sea = newOpenSeaFrom(w.waves, speed, from)
	}
	best := math.Inf(-1)
	for _, angle := range edgeAngles() {
		// The tack that leads inward: the angle measured from the wind
		// toward the centre's side.
		for _, side := range []float64{-1, 1} {
			v := w.sail(b, &weather, sea, x0, y0, ce, cn, side*angle)
			best = max(best, v)
		}
	}
	return best
}

// sail sails the boat at angle degrees off the wind (positive with the
// wind over starboard) in the wind, current and sea of (x0, y0), and
// returns its mean speed toward the centre over the second minute, m/s.
func (w *edgeWorld) sail(b *physics.Prepared, weather *physics.Weather, sea *openSea, x0, y0, ce, cn, angle float64) float64 {
	var at physics.WeatherTick
	physics.WeatherAt(weather, &at, edgeTick)
	e := physics.WindAt(&at, x0, y0, nil)
	var s physics.State
	s.Heading = math.Remainder(e.MeanFrom-angle*deg, 2*math.Pi)
	s.Surge = 1.5
	sheet := float64(scripted.SheetIndex(angle, e.WindSpeed)) / bus.Steps
	s.SheetLimit = math.Pi / 2 * sheet
	s.Boom = math.Copysign(s.SheetLimit, -angle)
	c := physics.Control{Sheet: sheet, Pilot: physics.PilotWind, Target: float64(scripted.Target(angle))}
	var o physics.Out
	var ps *physics.Sea
	if sea != nil {
		ps = &sea.sea
	}
	r0 := w.prepared.Edge()
	var start float64
	for i := range edgeSettle + edgeMeasure {
		tick := float64(edgeTick + i)
		physics.WeatherAt(weather, &at, tick)
		e = physics.WindAt(&at, x0, y0, nil)
		e.CurrentEast, e.CurrentNorth = ce, cn
		if sea != nil {
			physics.SeaAt(sea.sea.Waves, &sea.time, tick)
		}
		// The boat feels the place it was put at wherever it sails: its
		// distance from the lip is measured from there.
		physics.Step(&s, &c, &e, ps, nil, b, &o)
		if i == edgeSettle-1 {
			start = r0 - math.Hypot(x0+s.X, y0+s.Y)
		}
	}
	end := r0 - math.Hypot(x0+s.X, y0+s.Y)
	return (end - start) / (float64(edgeMeasure) * physics.Dt)
}

// newOpenSeaFrom is the sea a wind of speed m/s, 10 m up, from from raises
// over open water.
func newOpenSeaFrom(w *physics.Waves, speed, from float64) *openSea {
	o := &openSea{win: physics.SeaWindow{
		Size:   1,
		Inputs: make([]physics.SeaInput, 1),
		Amp:    make([]float64, physics.SeaComponents),
		Hs:     make([]float64, 1),
		Peak:   make([]float64, 1),
	}}
	physics.SeaArea(w, &o.win, 0, w.OpenSea(speed, from))
	o.win.Seal()
	o.sea = physics.Sea{Waves: w, Window: &o.win, Tick: &o.time}
	return o
}

// lineOfNoReturn is the least distance inside the lip from which the boat
// gains, m, by the distances tried; or +Inf where it gains from none.
func (w *edgeWorld) lineOfNoReturn(b *physics.Prepared, onto bool) float64 {
	for _, d := range edgeDistances {
		if w.gains(b, d, onto) > 0 {
			return d
		}
	}
	return math.Inf(1)
}

// edgeCase is one wind the line is found in: its regime ("steady" for a
// steady wind), its number, and its wind at the lip, knots.
type edgeCase struct {
	name       string
	lipKnots   float64
	onto, off  float64 // the lines, m
	flatOnto   float64 // the same wind's in flat water, steady
	flatOff    float64
	gainedOnto float64 // m/s made good from 1 m inside the lip onto it
}

// runEdge prints the line of no return for a Jolly boat: in each regime's
// spells, with their gusts and shifts and the sea they raise, beside a
// steady wind of the same strength at the lip in flat water.
func runEdge(b *physics.Prepared, waves *physics.Waves, cat *catalog.Catalog) error {
	cases, err := edgeCases(b, waves, cat, 4)
	if err != nil {
		return err
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "%-14s %9s %16s %16s %14s\n", "spell", "wind lip", "onto: weather", "off: weather", "from 1 m onto")
	for _, c := range cases {
		fmt.Fprintf(&sb, "%-14s %6.1f kn %7s (%5s) %7s (%5s) %9.2f kn\n", c.name, c.lipKnots,
			metres(c.onto), metres(c.flatOnto), metres(c.off), metres(c.flatOff), c.gainedOnto/knot)
	}
	fmt.Print(sb.String())
	runEdgeTables(b, cat.PrepareWeather())
	return nil
}

func metres(m float64) string {
	if math.IsInf(m, 1) {
		return "none"
	}
	return fmt.Sprintf("%.0f m", m)
}

// edgeCases finds the lines in n spells of each regime, each beside a
// steady wind of its strength at the lip in flat water. The boats sail on
// as many goroutines as there are processors.
func edgeCases(b *physics.Prepared, waves *physics.Waves, cat *catalog.Catalog, n int) ([]edgeCase, error) {
	prepared := cat.PrepareWeather()
	regimes := catalog.Regimes(cat)
	type job struct {
		i     int
		world edgeWorld
		flat  edgeWorld
		name  string
	}
	var jobs []job
	for ri := range regimes {
		for k := range n {
			var s physics.Spell
			physics.DrawSpell(prepared, &regimes[ri], uint32(1000+k), 24, &s)
			s.Regime = float64(ri)
			s.Begin, s.Start = edgeTick-3600, edgeTick-3600
			s.Length = 4 * 3600 * physics.StepsPerSecond
			w := edgeWorld{prepared: prepared, spell: s, waves: waves, sea: true, way: 1}
			// The steady wind of the spell's strength at the lip.
			weather := physics.Weather{Prepared: prepared}
			weather.Set([]physics.Spell{s})
			var at physics.WeatherTick
			physics.WeatherAt(&weather, &at, edgeTick)
			_, from := physics.MeanWindAt(&at, 0, 0)
			r := prepared.Edge() - 1
			speed, _ := physics.MeanWindAt(&at, r*math.Sin(from+math.Pi), r*math.Cos(from+math.Pi))
			flat := edgeWorld{prepared: prepared, spell: physics.SteadySpell(speed, from, 0), waves: waves, way: 1}
			jobs = append(jobs, job{i: len(jobs), world: w, flat: flat, name: fmt.Sprintf("%s %d", cat.Weather.Regimes[ri].ID, k+1)})
		}
	}
	cases := make([]edgeCase, len(jobs))
	work := make(chan job)
	var wg sync.WaitGroup
	for range runtime.GOMAXPROCS(0) {
		wg.Go(func() {
			for j := range work {
				c := edgeCase{name: j.name, lipKnots: j.flat.spell.Speed * physics.SeaSpeedStep / knot}
				c.onto = j.world.lineOfNoReturn(b, true)
				c.off = j.world.lineOfNoReturn(b, false)
				c.flatOnto = j.flat.lineOfNoReturn(b, true)
				c.flatOff = j.flat.lineOfNoReturn(b, false)
				c.gainedOnto = j.world.gains(b, 1, true)
				cases[j.i] = c
			}
		})
	}
	for _, j := range jobs {
		work <- j
	}
	close(work)
	wg.Wait()
	return cases, nil
}

// edgeSteady are the steady winds at the lip the flat-water table is found
// in, knots.
var edgeSteady = []float64{3, 4, 6, 8, 10, 14, 18, 24}

// steadyWorld is flat water and a steady wind of knots at the lip, from
// the north.
func steadyWorld(prepared *physics.WeatherPrepared, knots float64) edgeWorld {
	return edgeWorld{prepared: prepared, spell: physics.SteadySpell(knots*knot, 0, 0), way: 1}
}

// recovery is a capsize near the lip, recovered as a sailor would: once
// sailing again, bear away to a reach along the lip for speed, then harden
// up onto the tack that leads inward.
type recovery struct {
	knots    float64
	sailing  float64 // s until sailing again
	least    float64 // the least distance inside the lip, m
	leastAt  float64 // s: when it was, after which the boat made ground
	after    float64 // the distance inside the lip after five minutes, m
	over     bool
	lostToIt float64 // m lost to the lip before making ground
}

// capsize lays the boat flat d metres inside the lip, the wind of knots
// blowing onto it, its sailor in the water, and sails the recovery for
// five minutes.
func capsize(b *physics.Prepared, prepared *physics.WeatherPrepared, knots, d float64) recovery {
	weather := physics.Weather{Prepared: prepared}
	weather.Set([]physics.Spell{physics.SteadySpell(knots*knot, math.Pi, 0)})
	var at physics.WeatherTick
	// North of the centre the wind from the south blows onto the lip.
	r0 := prepared.Edge()
	s := physics.State{Y: r0 - d, Heading: math.Pi / 2, Heel: 1.55, SheetLimit: 0.4, Boom: 0.4,
		SailorMode: physics.InWater, SailorTimer: 10}
	c := physics.Control{Sheet: 1}
	var o physics.Out
	rec := recovery{knots: knots, least: d}
	sailingAt := -1
	for i := range 5 * 60 * physics.StepsPerSecond {
		tick := float64(edgeTick + i)
		physics.WeatherAt(&weather, &at, tick)
		e := physics.WindAt(&at, s.X, s.Y, nil)
		e.CurrentEast, e.CurrentNorth = physics.CurrentAt(prepared, 1, s.X, s.Y, nil)
		if s.SailorMode == physics.Sailing {
			if sailingAt < 0 {
				sailingAt = i
				rec.sailing = float64(i) * physics.Dt
			}
			// Bear away to a reach along the lip for 20 s, then harden up
			// close-hauled away from it, the sheet set for each: the wind
			// from the south over starboard, heading east, then south-east.
			angle := 90.0
			if i-sailingAt > 20*physics.StepsPerSecond {
				angle = 50
			}
			c = physics.Control{Pilot: physics.PilotWind, Target: float64(scripted.Target(angle)),
				Sheet: float64(scripted.SheetIndex(angle, e.WindSpeed)) / bus.Steps}
		}
		physics.Step(&s, &c, &e, nil, nil, b, &o)
		dist := r0 - math.Hypot(s.X, s.Y)
		if dist < rec.least {
			rec.least, rec.leastAt = dist, float64(i)*physics.Dt
		}
		rec.after = dist
		if physics.OverEdge(prepared, s.X, s.Y) {
			rec.over = true
			break
		}
	}
	rec.lostToIt = d - rec.least
	return rec
}

// runEdgeTables prints the flat-water table and the capsizes.
func runEdgeTables(b *physics.Prepared, prepared *physics.WeatherPrepared) {
	fmt.Printf("\nflat water, steady wind at the lip: the line of no return, onto / off the lip\n")
	for _, k := range edgeSteady {
		w := steadyWorld(prepared, k)
		fmt.Printf("%4.0f kn  %7s / %7s\n", k, metres(w.lineOfNoReturn(b, true)), metres(w.lineOfNoReturn(b, false)))
	}
	fmt.Printf("\ncapsized 150 m inside the lip, the wind onto it, recovered: bear away, build speed, harden up\n")
	for _, k := range []float64{10, 13, 16, 22} {
		r := capsize(b, prepared, k, 150)
		end := fmt.Sprintf("making ground after %.0f s; %.0f m inside it after five minutes", r.leastAt, r.after)
		if r.over {
			end = "over the lip"
		}
		fmt.Printf("%4.0f kn  sailing after %.0f s, lost %.0f m to the lip, %s\n", k, r.sailing, r.lostToIt, end)
	}
}
