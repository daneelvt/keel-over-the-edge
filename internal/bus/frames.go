// SPDX-License-Identifier: AGPL-3.0-only

package bus

import (
	"sync/atomic"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// A Frame is the whole world after a tick. Once published it never changes
// while anyone holds it, so readers (encoders, the input log) work on it
// while the next tick runs, without a lock.
//
// Slots are kept as arrays, one entry per slot, sized to the world's capacity
// once. Only the entries of occupied slots (those in Live) mean anything,
// except Gen, which every slot keeps.
type Frame struct {
	readers atomic.Int32

	Tick     int64  // the tick that made this frame
	Skipped  int64  // ticks skipped, by the clock falling behind, just before Tick
	Wind     Wind   // the one wind every boat sails in
	NextBoat uint64 // the next boat's ID: IDs are never reused within a run

	Live     []int32   // occupied slots, ascending
	Occupied []bool    // per slot
	Gen      []uint16  // per slot: how many times it has been freed, modulo GenMask + 1
	Boat     []uint64  // per slot: the boat's ID
	Owner    []Account // per slot: the account sailing it
	Conn     []uint64  // per slot: the connection sailing it, 0 for none
	Grace    []int64   // per slot: the tick at which a disconnected boat leaves, 0 while connected
	Kind     []uint16  // per slot: the boat's kind, an index into the world's kinds
	Control  []Word    // per slot: the controls in force
	State    []physics.State
	Sail     []uint8 // per slot: physics.SailByte of the boat's last step, for drawing

	// Grid is the live boats by the grid cell they are in, built after
	// the physics.
	Grid Grid

	// Queue is who waits for a boat while the world is at its limit, the
	// head first.
	Queue []Waiting

	// What the tick applied, in the order it applied it: the input log
	// records these.
	Changed []SlotWord // control words that changed, by slot, ascending
	Events  []Event    // commands, with their results
}

// Grid lists the live boats by their cell, physics.Cell of their position:
// the boats of cell c are Slots[Start[c]:Start[c+1]], in ascending slot
// order. It is derived from the state, so it is in no snapshot or digest.
type Grid struct {
	Start []int32 // per cell, and one more: Slots's index of the cell's first boat
	Slots []int32 // the live slots, by cell
	Cell  []int32 // per slot: the cell of an occupied slot's boat
}

// Cells is the number of the grid's cells.
const Cells = physics.GridCells * physics.GridCells

// Boats lists the slots of the boats in cell c.
func (g *Grid) Boats(c int32) []int32 { return g.Slots[g.Start[c]:g.Start[c+1]] }

// Waiting is a connection waiting for a boat.
type Waiting struct {
	Account Account
	Conn    uint64
	Since   int64 // the tick it was queued at
}

// QueueLimit is the most connections that may wait for a boat.
const QueueLimit = 4096

// SlotWord is a control word applied to a slot.
type SlotWord struct {
	Slot int32
	Word Word
}

// An Event is a command the tick applied and what came of it. Its Reply
// channel is always nil.
type Event struct {
	Command
	Reply Reply
}

// NewFrame makes an empty frame with room for capacity slots.
func NewFrame(capacity int) *Frame {
	return &Frame{
		Live:     make([]int32, 0, capacity),
		Occupied: make([]bool, capacity),
		Gen:      make([]uint16, capacity),
		Boat:     make([]uint64, capacity),
		Owner:    make([]Account, capacity),
		Conn:     make([]uint64, capacity),
		Grace:    make([]int64, capacity),
		Kind:     make([]uint16, capacity),
		Control:  make([]Word, capacity),
		State:    make([]physics.State, capacity),
		Sail:     make([]uint8, capacity),
		Grid: Grid{
			Start: make([]int32, Cells+1),
			Slots: make([]int32, 0, capacity),
			Cell:  make([]int32, capacity),
		},
		Queue:   make([]Waiting, 0, QueueLimit),
		Changed: make([]SlotWord, 0, capacity),
		Events:  make([]Event, 0, 64),
	}
}

// Capacity is the number of slots.
func (f *Frame) Capacity() int { return len(f.Occupied) }

// Release gives back a frame from Acquire. The frame must not be read after.
func (f *Frame) Release() { f.readers.Add(-1) }

// Frames publishes frames and recycles them once no reader holds them.
//
// A reader's Acquire loads the current frame, counts itself as a reader, and
// loads the current frame again: if it has changed, the frame it counted
// itself on may already be being rewritten, so it backs off and tries again.
// The writer takes for the next tick only a frame that is neither current nor
// held. Go's atomic operations are sequentially consistent, so a reader whose
// second load still finds its frame current counted itself before the writer
// could next look at that frame, and the writer leaves it alone.
type Frames struct {
	cur       atomic.Pointer[Frame]
	pool      []*Frame // only the writer touches it
	capacity  int
	allocated atomic.Uint64
}

// PoolSize is how many frames a pool starts with: the current one, the one
// being written, and two for readers.
const PoolSize = 4

// NewFrames makes a pool of frames with room for capacity slots, and
// publishes an empty one.
func NewFrames(capacity int) *Frames {
	fs := &Frames{capacity: capacity}
	for range PoolSize {
		fs.pool = append(fs.pool, NewFrame(capacity))
	}
	fs.cur.Store(fs.pool[0])
	return fs
}

// Acquire returns the current frame, held until Release.
func (fs *Frames) Acquire() *Frame {
	for {
		f := fs.cur.Load()
		f.readers.Add(1)
		if fs.cur.Load() == f {
			return f
		}
		f.readers.Add(-1)
	}
}

// Latest is the current frame, for the writer only: nobody else may read a
// frame they have not acquired.
func (fs *Frames) Latest() *Frame { return fs.cur.Load() }

// Next returns a frame for the writer to fill: one neither current nor held,
// or a new one if every frame is in use. Only the writer calls it.
func (fs *Frames) Next() *Frame {
	cur := fs.cur.Load()
	for _, f := range fs.pool {
		if f != cur && f.readers.Load() == 0 {
			return f
		}
	}
	f := NewFrame(fs.capacity)
	fs.pool = append(fs.pool, f)
	fs.allocated.Add(1)
	return f
}

// Publish makes f, from Next and now filled, the current frame.
func (fs *Frames) Publish(f *Frame) { fs.cur.Store(f) }

// Allocated counts the frames made because every frame was in use. It
// should stay flat once a server is running.
func (fs *Frames) Allocated() uint64 { return fs.allocated.Load() }

// Pooled is the number of frames in the pool.
func (fs *Frames) Pooled() int { return len(fs.pool) }

// Bus is everything outside the simulation needs to reach a world.
type Bus struct {
	Controls *Controls
	Commands *Queue
	Frames   *Frames
}

// New makes a bus for a world of capacity slots.
func New(capacity int) *Bus {
	return &Bus{
		Controls: NewControls(capacity),
		Commands: NewQueue(),
		Frames:   NewFrames(capacity),
	}
}
