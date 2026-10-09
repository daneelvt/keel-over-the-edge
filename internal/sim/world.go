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
// once, and controls are decoded by exact divisions. go run ./tools/physics
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
)

// Capacity is the number of boat slots in a world.
const Capacity = 4096

// DefaultWind is the wind a world starts with: 10 knots from the north.
var DefaultWind = bus.Wind{Speed: 10 * 1852.0 / 3600, From: 0}

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
}

// A Phase is a part of a tick.
type Phase uint8

// The phases of a tick, in order. Weather and sea, collisions and the rules
// will come between them; the events of a tick are gathered as its commands
// are applied.
const (
	PhaseInputs  Phase = iota // read the control slots, apply the commands, admit from the queue
	PhasePhysics              // step every boat
	PhaseGrid                 // sort the boats into the grid's cells
	PhasePublish              // publish the frame, hand it to the recorder
	Phases                    // the number of phases
)

var phaseNames = [Phases]string{"inputs", "physics", "grid", "publish"}

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

// World is a world's boats and wind, and the machinery that ticks them.
// Everything but Bus and Close is for the one goroutine that ticks.
type World struct {
	bus       *bus.Bus
	capacity  int
	limit     int
	kinds     []physics.Prepared
	grace     int64
	observer  Observer
	recorders []Recorder
	ctx       context.Context // for trace regions

	// The tick in progress.
	cur, next *bus.Frame
	skip      int64
	given     *Input
	env       physics.Env

	workers workers

	// The phases as function values made once, so that running one inside
	// a trace region allocates nothing.
	inputsFn, physicsFn, gridFn, publishFn func()
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
	w := &World{
		bus:      bus.New(cfg.Capacity),
		capacity: cfg.Capacity,
		limit:    cfg.Limit,
		kinds:    cfg.Kinds,
		grace:    cfg.Grace,
		ctx:      context.Background(),
	}
	w.inputsFn, w.physicsFn, w.gridFn, w.publishFn = w.inputs, w.physics, w.grid, w.publish
	f := w.bus.Frames.Latest()
	f.Tick = cfg.Tick
	f.Wind = DefaultWind
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
func (w *World) Load(snapshot []byte) error {
	f := w.bus.Frames.Next()
	if err := ReadSnapshot(snapshot, f); err != nil {
		return err
	}
	for _, s := range f.Live {
		if int(f.Kind[s]) >= len(w.kinds) {
			return fmt.Errorf("sim: slot %d is a boat of kind %d; the world has %d kinds", s, f.Kind[s], len(w.kinds))
		}
	}
	// Each slot holds the controls in force until its sailor writes again.
	for _, s := range f.Live {
		w.bus.Controls.Store(s, f.Control[s])
	}
	buildGrid(f)
	w.bus.Frames.Publish(f)
	return nil
}

// Workers is the number of goroutines that stepped boats in the last tick.
func (w *World) Workers() int { return w.workers.used }

// Close stops the workers. The world must not tick after.
func (w *World) Close() { w.workers.stop() }

// spawnSpacing is the distance between new boats, m.
const spawnSpacing = 20

// spawnRow is how many new boats stand side by side in a row.
const spawnRow = 64

// spawn is where a new boat in slot s appears: on a grid south of the
// world's centre, spawnSpacing apart, heading east, at rest. The grid is in
// whole metres, so its positions convert to floats exactly.
func spawn(s int32) physics.State {
	col := int64(s%spawnRow) - spawnRow/2
	row := int64(s/spawnRow) + 1
	return physics.State{
		X:       float64(col * spawnSpacing),
		Y:       float64(-row * spawnSpacing),
		Heading: math.Pi / 2,
	}
}
