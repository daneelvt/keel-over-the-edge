// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sky"
)

// The voyage's log, in the rules phase, once a second (bus.LogEvery): each
// boat afloat and sailing has its odometer read, the distance over the
// ground from its place a second before, the straight line between them,
// with the square root every machine works out alike; a jump longer than
// any boat sails in that time (the owner's tools moving it, a restart's
// start) adds nothing. The true wind at the boat is summed into minute
// means, and the mean of the last ten (bus.WindMinutes), the wind as
// Beaufort's forces are reckoned, says when a gale or a storm is met and
// when it is ridden out: the mean below Force 7 again, or the voyage
// ended in port. A port made from the sea with the visibility at the boat
// under a nautical mile is a landfall in fog; half an hour in the water
// with the sun below the horizon is a night at sea. Those aboard a boat
// not their own run what it runs, and meet what it meets, while aboard.
//
// When a voyage ends, it is a record of the frame (bus.VoyageEnded), and
// so is the end of a time aboard (bus.AboardEnded): the log's recorder
// writes them.

// The voyage log's numbers.
const (
	// maxRun is faster than any boat sails over the ground, m/s: a move
	// farther in a second is a jump.
	maxRun = 25.0
	// galeWind, stormWind and force7 are the ten-minute means of Beaufort's
	// Force 8, Force 10, and the foot of Force 7, m/s.
	galeWind  = 17.2
	stormWind = 24.5
	force7    = 13.9
	// fogLandfall is the visibility a port made in is fog under, m: a
	// nautical mile.
	fogLandfall = 1852.0
	// nightSeconds is how long in the water with the sun down makes a
	// night at sea.
	nightSeconds = 30 * 60
	// windQuarters is the minute means' unit: a quarter of a metre a
	// second.
	windQuarters = 4.0
)

// newVoyage is the voyage of a boat entering the water at tick.
func newVoyage(tick int64) bus.Voyage { return bus.Voyage{Log: bus.VoyageLog{Began: tick}} }

// logRules reads every sailing boat's voyage log, once a second.
func (w *World) logRules() {
	f := w.next
	if f.Tick%bus.LogEvery != 0 {
		return
	}
	sk, sunT := w.logSky, 0.0
	if sk != nil {
		sunT = sky.Time(sk, w.logEpoch, float64(float64(f.Tick)*1e6)/physics.StepsPerSecond)
	}
	for _, s := range f.Live {
		v := &f.Voyage[s]
		if v.Falling() || f.Stay[s] {
			continue
		}
		lg := &v.Log
		before := lg.Met
		st := &f.State[s]
		d := w.odometer(lg, f.Tick, st.X, st.Y)
		lg.Seconds++
		w.windRead(lg, float64(f.Wind[s].WindSpeed), st.X, st.Y)
		if sk != nil && lg.Met&bus.MetNight == 0 && sky.SunAltitude(sk, sunT, st.X, st.Y) < 0 {
			lg.Dark++
			if lg.Dark >= nightSeconds {
				lg.Met |= bus.MetNight
			}
		}
		lo, hi := f.CrewOf(s)
		for i := lo; i < hi; i++ {
			a := &f.Crew[i]
			a.Run += d
			a.Met |= lg.Met &^ before
		}
	}
}

// odometer reads the odometer of a voyage's log at tick, the boat at
// (x, y), and returns the distance it adds: the straight line from the
// place last read, unless that is a jump.
func (w *World) odometer(lg *bus.VoyageLog, tick int64, x, y float64) float64 {
	port := w.inPort(x, y)
	if !lg.Read {
		lg.Read, lg.At, lg.X, lg.Y = true, tick, x, y
		lg.Port = port
		return 0
	}
	dx, dy := x-lg.X, y-lg.Y
	d := math.Sqrt(float64(dx*dx) + float64(dy*dy))
	secs := float64(tick-lg.At) / physics.StepsPerSecond
	if port && !lg.Port && lg.Met&bus.MetFog == 0 && w.foggy(x, y) {
		lg.Met |= bus.MetFog
		lg.FogX, lg.FogY = x, y
	}
	lg.At, lg.X, lg.Y, lg.Port = tick, x, y, port
	if !(d <= float64(maxRun*secs)) {
		return 0
	}
	lg.Run += d
	return d
}

// foggy reports whether the visibility at (x, y) is under fogLandfall.
func (w *World) foggy(x, y float64) bool {
	if w.visibility != nil {
		return w.visibility(x, y) < fogLandfall
	}
	if w.wind.Prepared() == nil {
		return false
	}
	return physics.VisibilityAt(&w.wind, x, y) < fogLandfall
}

// windRead adds a second's true wind at the boat, ws m/s, at (x, y), to a
// voyage's log, and at each whole minute works out the ten-minute mean.
func (w *World) windRead(lg *bus.VoyageLog, ws, x, y float64) {
	lg.Sum += ws
	if lg.Seconds%60 != 0 {
		return
	}
	mean := lg.Sum / 60
	lg.Sum = 0
	q := math.Floor(float64(mean*windQuarters) + 0.5)
	copy(lg.Wind[:], lg.Wind[1:])
	lg.Wind[bus.WindMinutes-1] = uint8(min(max(q, 0), math.MaxUint8))
	lg.Minutes = min(lg.Minutes+1, bus.WindMinutes)
	if lg.Minutes < bus.WindMinutes {
		return
	}
	sum := 0
	for _, m := range lg.Wind {
		sum += int(m)
	}
	ten := float64(sum) / (bus.WindMinutes * windQuarters)
	switch {
	case ten >= stormWind:
		if lg.Blow == bus.BlowNone {
			lg.GaleX, lg.GaleY = x, y
		}
		lg.Blow = bus.BlowStorm
		lg.Met |= bus.MetGale | bus.MetStorm
	case ten >= galeWind:
		if lg.Blow == bus.BlowNone {
			lg.GaleX, lg.GaleY = x, y
			lg.Blow = bus.BlowGale
		}
		lg.Met |= bus.MetGale
	case ten < force7:
		rideOut(lg)
	}
}

// rideOut ends the gale or storm a voyage is in, ridden out.
func rideOut(lg *bus.VoyageLog) {
	switch lg.Blow {
	case bus.BlowStorm:
		lg.Met |= bus.RodeGale | bus.RodeStorm
	case bus.BlowGale:
		lg.Met |= bus.RodeGale
	}
	lg.Blow = bus.BlowNone
}

// voyageEnded records the voyage of the boat in slot s of f ended, how:
// its odometer read a last time, a gale it is in ridden out if it ends in
// port, and the record made.
func (w *World) voyageEnded(f *bus.Frame, s int32, how uint8) {
	v := &f.Voyage[s]
	lg := &v.Log
	st := &f.State[s]
	if how != bus.EndOver {
		w.odometer(lg, f.Tick, st.X, st.Y)
		if lg.Blow != bus.BlowNone && w.inPort(st.X, st.Y) {
			rideOut(lg)
		}
	}
	f.VoyageEnds = append(f.VoyageEnds, bus.VoyageEnded{
		Tick: f.Tick, Slot: s, Boat: f.Boat[s], Owner: f.Owner[s], Machine: f.Machine[s], Kind: f.Kind[s], BoatName: f.BoatName[s],
		How: how, Placed: v.Placed, X: st.X, Y: st.Y, Survived: v.Survived, Least: v.Best, Log: *lg,
	})
}

// aboardEnded records a's time aboard the boat in its slot of f ended,
// how.
func (w *World) aboardEnded(f *bus.Frame, a *bus.Aboard, how uint8) {
	s := a.Slot
	st := &f.State[s]
	f.AboardEnds = append(f.AboardEnds, bus.AboardEnded{
		Tick: f.Tick, Account: a.Account, Machine: a.Machine, Slot: s, Boat: a.Boat,
		Skipper: f.Owner[s], SkipperMachine: f.Machine[s], Kind: f.Kind[s], BoatName: f.BoatName[s],
		Since: a.Since, Run: a.Run, Met: a.Met, How: how, Placed: f.Voyage[s].Placed, X: st.X, Y: st.Y,
	})
}
