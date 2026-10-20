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
// SetWeather and Place are for developers only: tests, scripted sailors
// and replays; Hold is the server's own, from what writes the world to the
// database, Chart, which marks what the world's chart holds from its
// start, and End, which ends the world at its end; Teleport, Stay and
// Unseen are the owner's tools'.
const (
	Join       Op = iota + 1 // a boat for Account, sailed through connection Conn: its existing one, a new one, or a place in the queue
	Leave                    // Boat leaves the world
	SetWeather               // the developer's weather becomes Weather, from the second after next
	Place                    // Boat's state becomes State
	Disconnect               // connection Conn, Boat's, has ended: its grace begins; with Boat 0, Account's connection Conn, waiting or sailing
	Hold                     // admission is held while Held: a Join without a boat waits in the queue, and the queue gives none
	Teleport                 // Boat's state becomes State, or with Start the start's: at rest, its course cleared, its voyage marked placed
	Stay                     // Boat stays where it is while On: not stepped, touching nothing, casting no shadow
	Unseen                   // Boat is in no other connection's view while On, and touches nothing and casts no shadow
	Chart                    // Subject is charted, credited to no one; with On, every subject
	End                      // the world ends after tick At, or after this tick if At has passed: the falls take every boat afloat
	opEnd
)

// Ops lists every op, in order, for tables keyed by op.
var Ops = []Op{Join, Leave, SetWeather, Place, Disconnect, Hold, Teleport, Stay, Unseen, Chart, End}

var opNames = [...]string{"", "join", "leave", "set_weather", "place", "disconnect", "hold", "teleport", "stay", "unseen", "chart", "end"}

func (o Op) String() string {
	if o == 0 || o >= opEnd {
		return "unknown"
	}
	return opNames[o]
}

// Developer reports whether only developer sources may send o.
func (o Op) Developer() bool { return o == SetWeather || o == Place }

// Server reports whether only the server's own parts may send o: a
// developer's sender may too, a player's never.
func (o Op) Server() bool { return o == Hold || o == Chart || o == End }

// Owner reports whether only the owner's tools may send o: a developer's
// sender may too, a player's or the server's never.
func (o Op) Owner() bool { return o == Teleport || o == Stay || o == Unseen }

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

// WeatherMode is how a developer's weather overrides the world's.
type WeatherMode uint8

// The developer's weathers.
const (
	WeatherAuto   WeatherMode = iota // the world's own weather
	WeatherHeld                      // one endless spell of a regime
	WeatherSteady                    // one wind, the same everywhere, with no shifts or gusts
	WeatherFront                     // a front now, crossing the disk, an endless spell of a regime behind it
	WeatherSystem                    // not a weather but a system placed: a kind to reach a point
	weatherModeEnd
)

// Valid reports whether m is one of the modes.
func (m WeatherMode) Valid() bool { return m < weatherModeEnd }

// Weather is a developer's weather: what the world's weather is from a tick
// on, until the next.
type Weather struct {
	From   int64 // the tick it takes effect from: the simulation sets it
	Mode   WeatherMode
	Regime uint16 // WeatherHeld: the regime's index in the catalog
	Speed  uint32 // WeatherSteady: the wind 10 m up, in steps of physics.SeaSpeedStep
	Dir    uint32 // WeatherSteady: the direction it comes from, in steps of a turn / physics.TurnSteps
	// WeatherSystem: the kind's index in the catalog, the point the system
	// reaches, in quarter metres east and north of the centre, and how many
	// ticks after it is placed it reaches it, at its strongest.
	Kind  uint16
	East  int32
	North int32
	In    uint32
}

// A System is a developer's weather system: a kind placed to reach a point
// at a tick, its strength growing from its birth and at its whole there.
// What it is follows from these, as the world's own systems follow from its
// week.
type System struct {
	Born  int64 // the tick it is born at, a keyframe's
	At    int64 // the tick it reaches its point
	Kind  uint16
	East  int32 // the point, quarter metres east of the centre
	North int32 // and north
	Slot  uint8 // its slot among the developer's
	// The way it moves, in steps of a turn, and how fast, in steps of
	// physics.SeaSpeedStep: the wind's, as it was when it was placed.
	Heading uint32
	Speed   uint32
}

// SystemSlots is the most systems a developer may place at once.
const SystemSlots = 4

// A Command asks the simulation to change the world. It is a value; the reply
// channel is its only pointer.
type Command struct {
	Op      Op
	Account Account       // Join, Disconnect with no boat: the account; in a Leave's event, the tick's record of who sailed the boat
	Conn    uint64        // Join, Disconnect: the connection; 0 for none
	Boat    uint64        // Leave, Place, Disconnect, Teleport, Stay, Unseen: the boat; Disconnect: 0 for whatever Account has
	Weather Weather       // SetWeather
	State   physics.State // Place, Teleport
	Held    bool          // Hold: held, or let go
	Start   bool          // Teleport: to the start, where a new boat would appear, rather than State
	On      bool          // Stay, Unseen: on, or off; Chart: every subject
	Subject int32         // Chart: the subject, by its index in the world's sight table
	At      int64         // End: the world's last tick
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
	Done                       // SetWeather, Place, Hold, Teleport, Stay, Unseen or End applied; Disconnect's grace begun
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
	// ErrNotAllowed means the sender may not send that command: a developer,
	// server or owner's command from a player's sender, a command other than
	// the server's from the server's, other than the owner's from the
	// owner's, or no command at all.
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
func (q *Queue) Players() Sender { return Sender{q: q, from: fromPlayers} }

// Developer returns a sender for every command. Only code in the server's own
// process (tests, scripted sailors, replays) is given one.
func (q *Queue) Developer() Sender { return Sender{q: q, from: fromDeveloper} }

// Server returns a sender for the server's own commands, Hold, Chart and
// End: what writes the world to the database holds admission while it is
// behind, the world's chart is marked from its start, and the world is
// ended at its end.
func (q *Queue) Server() Sender { return Sender{q: q, from: fromServer} }

// Owner returns a sender for the owner's tools' commands alone: Teleport,
// Stay and Unseen. The world page and the free camera are given one.
func (q *Queue) Owner() Sender { return Sender{q: q, from: fromOwner} }

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
	q    *Queue
	from source
}

// source is who a sender sends for.
type source uint8

const (
	fromPlayers source = iota
	fromDeveloper
	fromServer
	fromOwner
)

// allowed reports whether a sender for from may send o.
func (from source) allowed(o Op) bool {
	switch {
	case o == 0 || o >= opEnd:
		return false
	case from == fromDeveloper:
		return true
	case from == fromServer:
		return o.Server()
	case from == fromOwner:
		return o.Owner()
	}
	return !o.Developer() && !o.Server() && !o.Owner()
}

// TrySend queues c without waiting: ErrBusy if the queue is full,
// ErrNotAllowed if s may not send c's op.
func (s Sender) TrySend(c Command) error {
	if !s.from.allowed(c.Op) {
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
