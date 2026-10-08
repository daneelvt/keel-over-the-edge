// SPDX-License-Identifier: AGPL-3.0-only

package bus

import (
	"errors"
	"sync/atomic"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// QueueSize is how many commands may wait for the next tick, and the most a
// tick applies.
const QueueSize = 4096

// Op is what a command asks for.
type Op uint8

// The commands. Join and Leave come from players; SetWind and Place are for
// developers only: tests, scripted sailors and replays.
const (
	Join    Op = iota + 1 // a boat for Account: its existing one, or a new one
	Leave                 // Boat leaves the world
	SetWind               // the wind becomes Wind
	Place                 // Boat's state becomes State
	opEnd
)

// Ops lists every op, in order, for tables keyed by op.
var Ops = []Op{Join, Leave, SetWind, Place}

var opNames = [...]string{"", "join", "leave", "set_wind", "place"}

func (o Op) String() string {
	if o == 0 || o >= opEnd {
		return "unknown"
	}
	return opNames[o]
}

// Developer reports whether only developer sources may send o.
func (o Op) Developer() bool { return o == SetWind || o == Place }

// Wind is the true wind 10 m above the sea.
type Wind struct {
	Speed float64 // m/s
	From  float64 // direction it comes from, rad clockwise from north
}

// A Command asks the simulation to change the world. It is a value; the reply
// channel is its only pointer.
type Command struct {
	Op      Op
	Account uint64        // Join: the account the boat is for
	Boat    uint64        // Leave, Place: the boat
	Wind    Wind          // SetWind
	State   physics.State // Place
	// Reply, if not nil, receives the result. The simulation never waits on
	// it, so it should have room for one reply.
	Reply chan<- Reply
}

// Result is what came of a command.
type Result uint8

// The results.
const (
	Joined   Result = iota + 1 // a new boat
	Rejoined                   // the account's existing boat
	Full                       // no free slot
	Left                       // the boat has gone
	Done                       // SetWind or Place applied
	NoBoat                     // no such boat
	resultEnd
)

// Results lists every result, in order, for tables keyed by result.
var Results = []Result{Joined, Rejoined, Full, Left, Done, NoBoat}

var resultNames = [...]string{"", "joined", "rejoined", "full", "left", "done", "no_boat"}

func (r Result) String() string {
	if r == 0 || r >= resultEnd {
		return "unknown"
	}
	return resultNames[r]
}

// Reply is a command's result, with the boat it concerns.
type Reply struct {
	Result Result
	Slot   int32
	Boat   uint64
	Gen    uint16
}

// Errors from TrySend.
var (
	// ErrBusy means the queue is full: try again later.
	ErrBusy = errors.New("bus: the command queue is full")
	// ErrNotAllowed means the sender may not send that command: a developer
	// command from a player's sender, or no command at all.
	ErrNotAllowed = errors.New("bus: command not allowed from this sender")
)

// Queue holds commands until the next tick.
type Queue struct {
	ch      chan Command
	refused atomic.Uint64
}

// NewQueue makes a queue of QueueSize commands.
func NewQueue() *Queue {
	return &Queue{ch: make(chan Command, QueueSize)}
}

// Players returns a sender for players' commands: Join and Leave.
func (q *Queue) Players() Sender { return Sender{q: q} }

// Developer returns a sender for every command. Only code in the server's own
// process (tests, scripted sailors, replays) is given one.
func (q *Queue) Developer() Sender { return Sender{q: q, developer: true} }

// Refused counts the commands refused because the queue was full.
func (q *Queue) Refused() uint64 { return q.refused.Load() }

// Receive takes the next command without waiting; ok is false when there is
// none. Only the simulation calls it.
func (q *Queue) Receive() (c Command, ok bool) {
	select {
	case c = <-q.ch:
		return c, true
	default:
		return Command{}, false
	}
}

// A Sender puts commands on a queue.
type Sender struct {
	q         *Queue
	developer bool
}

// TrySend queues c without waiting: ErrBusy if the queue is full,
// ErrNotAllowed if c is a developer command and s is not a developer's.
func (s Sender) TrySend(c Command) error {
	if c.Op == 0 || c.Op >= opEnd || c.Op.Developer() && !s.developer {
		return ErrNotAllowed
	}
	select {
	case s.q.ch <- c:
		return nil
	default:
		s.q.refused.Add(1)
		return ErrBusy
	}
}
