// SPDX-License-Identifier: AGPL-3.0-only

// Package committee is the race committee: it runs each race under way
// inside the simulation's tick, from the frame. Handed a race at its
// warning signal (bus.RacePlace), it lays the course to the mean wind of
// that moment, says where the boats go behind the line and in what order,
// by lot; then, tick by tick, it fires the signals, judges each boat's
// crossings of the course's lines and rounding rays, calls the bumps
// between its boats from the preparatory signal on, reads their progress,
// finishes them, closes the finishing window or the time limit, and
// places everyone, with their awards or a trial's medal. Its tracks are
// the boats' places every two seconds, coded small.
//
// It is held to the simulation's rules: no clock, no I/O, no map ranged
// over, no unseeded randomness, and floats only as every machine works
// them out alike (products rounded before they are added, the physics
// package's trigonometry), so that a replay of the same inputs reaches the
// same race. Its state is the frame's (bus.Race, bus.Racer): the
// simulation copies it from tick to tick and keeps it in its snapshot.
package committee

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The race's numbers, in ticks of the simulation (physics.StepsPerSecond a
// second).
const (
	// Second is a second's ticks.
	Second = physics.StepsPerSecond
	// Penalty is what a foul or an early start adds.
	Penalty = 10 * Second
	// Window is the least the finishing window stays open after the first
	// boat home; it stays open half the winner's time if that is longer.
	Window = 300 * Second
	// TrackEvery is how often a boat's track is sampled.
	TrackEvery = 2 * Second
	// PhotoTicks is how near two boats finish for a photo finish.
	PhotoTicks = 2 * Second
	// ShortSeconds and LongSeconds are what a buoy course is sized to,
	// short and long, in the race's boat's time.
	ShortSeconds = 10 * 60
	LongSeconds  = 20 * 60
)

// The waits of a race, variables only so that a test may wait less: the
// sequence before the start; how long a boat may make no progress before it is asked whether it still
// races, and how long it has to answer by sailing on; how long a trial's
// boat has to cross the line once placed; and how far a boat must gain to
// count as progress, m.
var (
	// Warning is how long before the start the warning signal is: the
	// boats are placed then. Preparatory is the preparatory signal's,
	// after which bumps are called.
	Warning     int64 = 120 * Second
	Preparatory int64 = 60 * Second
	DriftAfter  int64 = 5 * 60 * Second
	DriftAnswer int64 = 60 * Second
	TrialWait   int64 = 5 * 60 * Second
	DriftGain         = 10.0
)

// Stage is what a world's races are run on: its racing areas off Port
// Royal, its island courses, and its kinds of boat.
type Stage struct {
	Areas   []Area
	Courses []Course
	Kinds   []Kind
}

// Area is a racing area: its number, its centre, m east and north of the
// world's, and its radius, m.
type Area struct {
	Number int32
	X, Y   float64
	Radius float64
}

// Course is an island course: its number, where it starts and finishes,
// its rounding rays in the order its way crosses them, its way from the
// start to the finish, m east and north, and the way's length, m.
type Course struct {
	Number        int32
	Start, Finish Site
	Rays          []Ray
	Way           [][2]float64
	Length        float64
}

// Site is a course's start or finish: its middle, and the room of clear
// water about it, m.
type Site struct {
	X, Y, Room float64
}

// Ray is a rounding ray: from (X, Y) toward Bearing, rad clockwise from
// north, crossed Crossings times clockwise about its start, less
// anticlockwise; Along how far along the way it is crossed, m; Mark the
// number of what it rounds, from 1.
type Ray struct {
	X, Y, Bearing float64
	Crossings     int8
	Along         float64
	Mark          int16
}

// Kind is a kind of boat as races know her: her polar and her length
// overall, m.
type Kind struct {
	Polar  *physics.Polar
	Length float64
}

// area is the racing area of a number, or nil.
func (s *Stage) area(n int32) *Area {
	for i := range s.Areas {
		if s.Areas[i].Number == n {
			return &s.Areas[i]
		}
	}
	return nil
}

// course is the island course of a number, or nil.
func (s *Stage) course(n int32) *Course {
	for i := range s.Courses {
		if s.Courses[i].Number == n {
			return &s.Courses[i]
		}
	}
	return nil
}

// kind is a kind of boat, or a small one if the stage has none.
func (s *Stage) kind(k uint16) Kind {
	if int(k) < len(s.Kinds) {
		return s.Kinds[k]
	}
	return Kind{Length: 4}
}

// Where is where the race of call is laid, m east and north, for the
// wind there: its racing area's centre, or its island course's start; a
// buoy trial in the area f's races use least. ok is false for a course
// or area the stage does not have.
func (s *Stage) Where(f *bus.Frame, call *bus.RaceCall) (x, y float64, ok bool) {
	if call.Island {
		c := s.course(call.Course)
		if c == nil || len(c.Way) < 2 {
			return 0, 0, false
		}
		return c.Start.X, c.Start.Y, true
	}
	a := s.areaFor(f, call)
	if a == nil {
		return 0, 0, false
	}
	return a.X, a.Y, true
}

// areaFor is the racing area of a buoy race: its own, or for a buoy
// trial's run the one f's races use least, the lowest numbered of those.
func (s *Stage) areaFor(f *bus.Frame, call *bus.RaceCall) *Area {
	if call.Course != 0 || !call.Trial {
		return s.area(call.Course)
	}
	var best *Area
	least := math.MaxInt
	for i := range s.Areas {
		a := &s.Areas[i]
		n := 0
		for j := range f.Races {
			if c := f.Races[j].Course; c != nil && !c.Island && c.Number == a.Number {
				n++
			}
		}
		if n < least {
			best, least = a, n
		}
	}
	return best
}

// toInt32 is f rounded toward zero as an int32, held to its range.
func toInt32(f float64) int32 {
	switch {
	case !(f > math.MinInt32):
		return math.MinInt32
	case f > math.MaxInt32:
		return math.MaxInt32
	}
	return int32(f)
}

// round is f rounded to the nearest whole number, halves up.
func round(f float64) float64 { return math.Floor(f + 0.5) }

// hypot is the length of (x, y), as every machine works it out.
func hypot(x, y float64) float64 { return math.Sqrt(float64(x*x) + float64(y*y)) }

// bearing is the direction of (x, y), rad clockwise from north.
func bearing(x, y float64) float64 { return physics.Atan2(x, y) }

// raceOf is the index in f.Races of the race of key, or −1.
func raceOf(f *bus.Frame, key uint32) int {
	for i := range f.Races {
		if f.Races[i].Key == key {
			return i
		}
	}
	return -1
}

// racersOf are the indices in f.Racers of race key's boats: f.Racers[lo:hi].
func racersOf(f *bus.Frame, key uint32) (lo, hi int) {
	lo = 0
	for lo < len(f.Racers) && f.Racers[lo].Race < key {
		lo++
	}
	hi = lo
	for hi < len(f.Racers) && f.Racers[hi].Race == key {
		hi++
	}
	return lo, hi
}

// Holds reports whether f has the race of id and run under way or ended
// and not yet written.
func Holds(f *bus.Frame, id [16]byte, run int32) bool {
	for i := range f.Races {
		if f.Races[i].ID == id && f.Races[i].Run == run {
			return true
		}
	}
	return false
}

// RacerOf is the index in f.Racers of the boat account skippers in a race
// not over, placed or racing, or −1.
func RacerOf(f *bus.Frame, account bus.Account) int {
	for i := range f.Racers {
		r := &f.Racers[i]
		if r.Account == account && (r.State == bus.RacerPlaced || r.State == bus.RacerRacing) {
			return i
		}
	}
	return -1
}

// event appends a race's event to f.
func event(f *bus.Frame, e bus.RaceEvent) {
	e.Tick = f.Tick
	f.RaceEvents = append(f.RaceEvents, e)
}
