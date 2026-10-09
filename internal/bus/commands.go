// SPDX-License-Identifier: AGPL-3.0-only

package bus

import (
	"encoding/hex"
	"errors"
	"sync/atomic"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// QueueSize is how many commands may wait for the next tick, and the most a
// tick applies.
const QueueSize = 4096

// Op is what a command asks for.
type Op uint8

// The commands. Join, Leave and Disconnect come from players' connections;
// SetWind and Place are for developers only: tests, scripted sailors and
// replays.
const (
	Join       Op = iota + 1 // a boat for Account, sailed through connection Conn: its existing one, a new one, or a place in the queue
	Leave                    // Boat leaves the world
	SetWind                  // the wind becomes Wind
	Place                    // Boat's state becomes State
	Disconnect               // connection Conn, Boat's, has ended: its grace begins; with Boat 0, Account's connection Conn, waiting or sailing
	opEnd
)

// Ops lists every op, in order, for tables keyed by op.
var Ops = []Op{Join, Leave, SetWind, Place, Disconnect}

var opNames = [...]string{"", "join", "leave", "set_wind", "place", "disconnect"}

func (o Op) String() string {
	if o == 0 || o >= opEnd {
		return "unknown"
	}
	return opNames[o]
}

// Developer reports whether only developer sources may send o.
func (o Op) Developer() bool { return o == SetWind || o == Place }

// An Account is who sails a boat: the account's UUID, its 16 bytes.
type Account [16]byte

// String writes the account in the UUID's usual form.
func (a Account) String() string {
	var b [36]byte
	hex.Encode(b[0:8], a[0:4])
	b[8] = '-'
	hex.Encode(b[9:13], a[4:6])
	b[13] = '-'
	hex.Encode(b[14:18], a[6:8])
	b[18] = '-'
	hex.Encode(b[19:23], a[8:10])
	b[23] = '-'
	hex.Encode(b[24:], a[10:])
	return string(b[:])
}

// Wind is the true wind 10 m above the sea.
type Wind struct {
	Speed float64 // m/s
	From  float64 // direction it comes from, rad clockwise from north
}

// A Command asks the simulation to change the world. It is a value; the reply
// channel is its only pointer.
type Command struct {
	Op      Op
	Account Account       // Join, Disconnect with no boat: the account
	Conn    uint64        // Join, Disconnect: the connection; 0 for none
	Boat    uint64        // Leave, Place, Disconnect: the boat; Disconnect: 0 for whatever Account has
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
	Full                       // no free slot, and no room in the queue
	Left                       // the boat has gone
	Done                       // SetWind or Place applied; Disconnect's grace begun
	NoBoat                     // no such boat
	Expired                    // the boat left at the end of its grace: the tick's own doing, not a command's
	Stale                      // Disconnect from a connection that no longer sails the boat, or waits: ignored
	Queued                     // the world is at its limit: the connection waits, at Position
	Admitted                   // a waiting connection got its boat: the tick's own doing, recorded as a Join
	Dequeued                   // Disconnect from a waiting connection: it waits no more
	resultEnd
)

// Results lists every result, in order, for tables keyed by result.
var Results = []Result{Joined, Rejoined, Full, Left, Done, NoBoat, Expired, Stale, Queued, Admitted, Dequeued}

var resultNames = [...]string{"", "joined", "rejoined", "full", "left", "done", "no_boat", "expired", "stale", "queued", "admitted", "dequeued"}

func (r Result) String() string {
	if r == 0 || r >= resultEnd {
		return "unknown"
	}
	return resultNames[r]
}

// Reply is a command's result, with the boat it concerns and the tick that
// applied it: the boat is in that tick's frame and every one after, until
// it leaves.
type Reply struct {
	Result Result
	Slot   int32
	Boat   uint64
	Gen    uint16
	Tick   int64
	// Position is a queued connection's place in the queue, 1 for the
	// head; Since, an admitted one's tick of joining it.
	Position int32
	Since    int64
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

// Players returns a sender for players' commands: Join, Leave and
// Disconnect.
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
