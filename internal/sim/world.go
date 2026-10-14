// SPDX-License-Identifier: AGPL-3.0-only

// Package sim is the simulation: the only writer of world state. A tick is a
// deterministic function of the world, the tick's inputs and the tick number,
// so a world started from a snapshot and given the inputs an input log
// recorded reaches the same state, bit for bit, on any machine and however
// its boats are split between goroutines.
//
// To keep that true the package follows rules that rules_test.go checks: it
// never reads the clock, does no I/O and uses no unseeded randomness; it never
// ranges over a map, whose order varies from run to run; it does not use
// sync.Pool; and it does no floating-point arithmetic on the world's state,
// which is the physics package's alone: positions are whole metres converted
// once, controls are decoded by exact divisions, and the sea's waves are the
// physics package's from the wind on. go run ./tools/physics
// -check also disassembles it for fused multiply-adds.
//
// The clock, the schedule and the metrics are package loop's, which calls
// Tick; keel replay calls the same Tick without a clock.
package sim

import (
	"context"
	"errors"
	"fmt"
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// Capacity is the number of boat slots in a world.
const Capacity = 4096

// DefaultSpell is the weather of a world given no timeline: 10 knots from
// the north, steady, everywhere.
var DefaultSpell = physics.SteadySpell(10*1852.0/3600, 0, 0)

// GraceTicks is how long a boat sails on, on its held controls, after its
// connection ends: 60 s, room for a server's restart and a phone's dropout.
// A Join from the same account within it gets the boat back; after it the
// boat leaves.
const GraceTicks = 1800

// Config sets up a world.
type Config struct {
	// Capacity is the number of boat slots; 0 means Capacity.
	Capacity int
	// Kinds are the kinds of boat, prepared; a slot's Kind indexes them. A
	// new boat is of the first kind.
	Kinds []physics.Prepared
	// Waves are the sea's waves, prepared, with which the kinds were
	// prepared too; nil is a world of flat water.
	Waves *physics.Waves
	// Workers is how many goroutines step boats, the ticking goroutine
	// included; fewer than 1 means 1.
	Workers int
	// Tick is the tick of the empty world the world starts as.
	Tick int64
	// Grace is how many ticks a disconnected boat sails on; 0 means
	// GraceTicks.
	Grace int64
	// Limit is the most boats the world holds at once, from 1 to the
	// capacity; 0 means the capacity. Beyond it, connections wait their
	// turn in a queue.
	Limit int
	// Weather is the world's own weather; nil is DefaultSpell for ever.
	Weather *weather.Timeline
	// Encounters are how boats meet, prepared: their contacts, the wind
	// they take from each other and the Articles. nil is a world of
	// ghosts, whose boats pass through each other in clean air.
	Encounters *physics.EncounterPrepared
}

// A Phase is a part of a tick.
type Phase uint8

// The phases of a tick, in order. The events of a tick are gathered as its
// commands are applied, and its bumps as its contacts are found.
const (
	PhaseInputs   Phase = iota // read the control slots, apply the commands, admit from the queue
	PhaseSea                   // the waves at this tick, and a share of the next second's amplitudes
	PhasePhysics               // step every boat, in the shadow of the boats near it
	PhaseGrid                  // sort the boats into the grid's cells
	PhaseContacts              // pairs, contacts and bumps, under the Articles
	PhasePublish               // publish the frame, hand it to the recorder
	Phases                     // the number of phases
)

var phaseNames = [Phases]string{"inputs", "sea", "physics", "grid", "contacts", "publish"}

func (p Phase) String() string {
	if p >= Phases {
		return "unknown"
	}
	return phaseNames[p]
}

// An Observer is told as each phase of a tick ends, so that whoever runs the
// tick can time its phases without the simulation reading the clock. It is
// called on the ticking goroutine and must not block.
type Observer interface {
	PhaseDone(Phase)
}

// A Recorder is given each frame as soon as it is published, on the ticking
// goroutine. It must not block; to keep the frame beyond the call it must
// Acquire it, which then returns this frame unless a later tick has run.
type Recorder interface {
	Record(*bus.Frame)
}

// Input is a tick's inputs given rather than read from the bus: a replay's.
type Input struct {
	Changed  []bus.SlotWord
	Commands []bus.Command
}

// World is a world's boats and weather, and the machinery that ticks them.
// Everything but Bus and Close is for the one goroutine that ticks.
type World struct {
	bus       *bus.Bus
	capacity  int
	limit     int
	kinds     []physics.Prepared
	sea       sea
	timeline  *weather.Timeline
	weather   physics.Weather
	wind      physics.WeatherTick
	grace     int64
	observer  Observer
	recorders []Recorder
	ctx       context.Context // for trace regions

	// The tick in progress.
	cur, next *bus.Frame
	skip      int64
	given     *Input

	workers workers

	// Encounters: their constants, or nil for none; how many cells about
	// its own a boat looks for wakes; and the contacts phase's room.
	enc        *physics.EncounterPrepared
	reachCells int32
	candidates []candidate
	touching   []physics.Touching
	touched    []candidate
	meeting    physics.Encounter
	hulls      physics.Hulls

	// The phases as function values made once, so that running one inside
	// a trace region allocates nothing.
	inputsFn, seaFn, physicsFn, gridFn, contactsFn, publishFn func()
}

// New makes a world of empty slots and starts its workers. Close stops them.
func New(cfg Config) (*World, error) {
	if cfg.Capacity == 0 {
		cfg.Capacity = Capacity
	}
	if cfg.Capacity < 1 || cfg.Capacity > math.MaxInt32 {
		return nil, fmt.Errorf("sim: capacity %d", cfg.Capacity)
	}
	if len(cfg.Kinds) == 0 || len(cfg.Kinds) > math.MaxUint16+1 {
		return nil, errors.New("sim: a world needs from 1 to 65536 kinds of boat")
	}
	if cfg.Grace == 0 {
		cfg.Grace = GraceTicks
	}
	if cfg.Grace < 1 {
		return nil, fmt.Errorf("sim: grace of %d ticks", cfg.Grace)
	}
	if cfg.Limit == 0 {
		cfg.Limit = cfg.Capacity
	}
	if cfg.Limit < 1 || cfg.Limit > cfg.Capacity {
		return nil, fmt.Errorf("sim: a limit of %d boats in a world of %d slots", cfg.Limit, cfg.Capacity)
	}
	if cfg.Weather == nil {
		cfg.Weather = weather.Fixed(DefaultSpell)
	}
	w := &World{
		bus:      bus.New(cfg.Capacity),
		capacity: cfg.Capacity,
		limit:    cfg.Limit,
		kinds:    cfg.Kinds,
		grace:    cfg.Grace,
		timeline: cfg.Weather,
		ctx:      context.Background(),
		enc:      cfg.Encounters,
	}
	if w.enc != nil {
		for i := range w.kinds {
			w.reachCells = max(w.reachCells, w.enc.ReachCells(&w.kinds[i]))
		}
		w.candidates = make([]candidate, 0, cfg.Capacity)
		w.touching = make([]physics.Touching, 0, 256)
		w.touched = make([]candidate, 0, 256)
	}
	w.weather.Prepared = cfg.Weather.Prepared()
	w.inputsFn, w.seaFn, w.physicsFn, w.gridFn, w.contactsFn, w.publishFn = w.inputs, w.seaPhase, w.physics, w.grid, w.contacts, w.publish
	w.sea.init(cfg.Waves, cfg.Weather)
	f := w.bus.Frames.Latest()
	f.Tick = cfg.Tick
	f.Weathers = f.Weathers[:0]
	w.spells(f)
	w.sea.under(&f.Sea, f.Tick, f.Weathers)
	f.NextBoat = 1
	w.workers.start(w, max(cfg.Workers, 1))
	return w, nil
}

// Observe has o told as each phase of a tick ends; nil stops it.
func (w *World) Observe(o Observer) { w.observer = o }

// Record has each of rs given each frame as it is published, in order;
// none stops it.
func (w *World) Record(rs ...Recorder) { w.recorders = rs }

// Bus is how the world is reached from outside.
func (w *World) Bus() *bus.Bus { return w.bus }

// Capacity is the number of boat slots.
func (w *World) Capacity() int { return w.capacity }

// Grace is how many ticks a boat sails on after its connection ends.
func (w *World) Grace() int64 { return w.grace }

// Limit is the most boats the world holds at once.
func (w *World) Limit() int { return w.limit }

// Now is the tick of the latest frame.
func (w *World) Now() int64 { return w.bus.Frames.Latest().Tick }

// Latest is the latest frame, for the ticking goroutine; anyone else must
// Acquire a frame from the bus.
func (w *World) Latest() *bus.Frame { return w.bus.Frames.Latest() }

// Skip makes the next tick n ticks later than it would be: the world's time
// jumps, and boats do not move for the ticks skipped.
func (w *World) Skip(n int64) {
	if n > 0 {
		w.skip += n
	}
}

// Load replaces the world with a snapshot, before the first tick.
func (w *World) Load(snapshot []byte) error { return w.load(snapshot, nil) }

// load replaces the world with a snapshot, changed by adjust, if not nil,
// before it is published.
func (w *World) load(snapshot []byte, adjust func(*bus.Frame)) error {
	f := w.bus.Frames.Next()
	if err := ReadSnapshot(snapshot, f); err != nil {
		return err
	}
	for _, s := range f.Live {
		if int(f.Kind[s]) >= len(w.kinds) {
			return fmt.Errorf("sim: slot %d is a boat of kind %d; the world has %d kinds", s, f.Kind[s], len(w.kinds))
		}
	}
	w.sea.loaded()
	if adjust != nil {
		adjust(f)
	}
	w.spells(f)
	w.sea.under(&f.Sea, f.Tick, f.Weathers)
	// Each slot holds the controls in force until its sailor writes again.
	for _, s := range f.Live {
		w.bus.Controls.Store(s, f.Control[s])
	}
	// The wind and the wakes follow from the state, as the tick that made
	// it left them.
	w.weatherAt(f)
	for _, s := range f.Live {
		w.settle(f, s)
	}
	buildGrid(f)
	w.bus.Frames.Publish(f)
	return nil
}

// Timeline is the world's own weather.
func (w *World) Timeline() *weather.Timeline { return w.timeline }

// spells sets f's spells in play from its tick and weathers.
func (w *World) spells(f *bus.Frame) {
	f.NSpells = w.timeline.Spells(f.Tick, f.Weathers, &f.Spells)
}

// Workers is the number of goroutines that stepped boats in the last tick.
func (w *World) Workers() int { return w.workers.used }

// Close stops the workers. The world must not tick after.
func (w *World) Close() { w.workers.stop() }

// spawnSpacing is the distance between new boats, m.
const spawnSpacing = 20

// spawnRow is how many new boats stand side by side in a row.
const spawnRow = 64

// spawnClear is how far a new boat's place must be from every hull, m.
const spawnClear = 10

// spawnAt is the place p of the spawn grid: south of the world's centre,
// spawnSpacing apart, spawnRow to a row, heading east, at rest. The grid is
// in whole metres, so its positions convert to floats exactly.
func spawnAt(p int64) physics.State {
	col := p%spawnRow - spawnRow/2
	row := p/spawnRow + 1
	return physics.State{
		X:       float64(col * spawnSpacing),
		Y:       float64(-row * spawnSpacing),
		Heading: math.Pi / 2,
	}
}

// spawn is where a new boat in slot s of f appears: the first place of the
// spawn grid from its slot's, along the row then the next, with no hull
// within spawnClear, so that no boat appears inside another. In a world of
// ghosts, its slot's place.
func (w *World) spawn(f *bus.Frame, s int32) physics.State {
	p := int64(s)
	if w.enc == nil {
		return spawnAt(p)
	}
	for end := p + int64(w.capacity); p < end; p++ {
		st := spawnAt(p)
		free := true
		for _, o := range f.Live {
			if o != s && physics.Within(&f.State[o], st.X, st.Y, spawnClear) {
				free = false
				break
			}
		}
		if free {
			return st
		}
	}
	return spawnAt(int64(s))
}
