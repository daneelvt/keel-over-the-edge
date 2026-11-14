// SPDX-License-Identifier: AGPL-3.0-only

package bus

import (
	"slices"
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

	Tick    int64 // the tick that made this frame
	Skipped int64 // ticks skipped, by the clock falling behind, just before Tick
	// Weathers are the developer's weathers, by the tick each takes effect
	// from, ascending: the world's own weather until the first. Those of
	// the past are kept as long as the sea may still follow them.
	Weathers []Weather
	// Spells are the spells of weather in play about the tick: those a
	// client needs to step its boat ahead of the server and replay it
	// behind, which follow from the tick and Weathers.
	Spells  [physics.WeatherSpells]physics.Spell
	NSpells int32
	// Coming is the next front before its spell is in play, from when its
	// cirrus can be seen: its line, which the sky shows.
	Coming physics.ComingFront
	// Systems are the developer's weather systems, by their birth: kept
	// while the sea may still follow them.
	Systems []System
	// Keys are the systems' keyframes about the tick: at the last keyframe
	// at or before it and the two after, which follow from the tick, the
	// weathers and the systems.
	Keys     [KeyFrames]physics.Keyframe
	Sea      Sea    // what raises the waves, area by area
	NextBoat uint64 // the next boat's ID: IDs are never reused within a world
	// Held: admission is held (Hold): a Join without a boat waits in the
	// queue, and the queue gives no boats.
	Held bool

	Live     []int32   // occupied slots, ascending
	Occupied []bool    // per slot
	Gen      []uint16  // per slot: how many times it has been freed, modulo GenMask + 1
	Boat     []uint64  // per slot: the boat's ID
	Owner    []Account // per slot: the account sailing it
	Conn     []uint64  // per slot: the connection sailing it, 0 for none
	Grace    []int64   // per slot: the tick at which a disconnected boat leaves, 0 while connected
	Kind     []uint16  // per slot: the boat's kind, an index into the world's kinds
	// Machine and Priority are per slot its account's kind: a machine
	// sailor's boat, sailed by an AI agent, and a priority account's.
	Machine  []bool
	Priority []bool
	// Look is per slot its sailor's look: a look code (internal/looks).
	// BoatLook is the boat's own look, its paint, cloth and sail number (a
	// boat look code), and BoatName its name, player text, "" for none.
	Look     []uint32
	BoatLook []uint32
	BoatName []string
	Control  []Word // per slot: the controls in force: the helm and sheet, the autopilot's and the rig's
	Pilot    []PilotWord
	Rig      []RigWord
	State    []physics.State
	Sail     []uint8 // per slot: physics.SailByte of the boat's last step, for drawing
	// Trim is per slot the hull's trim after its last step (physics.Out's
	// Trim), for drawing: 0 but on a boat whose rig pitches her.
	Trim []float64
	// Course is per slot what the Articles keep of a boat between ticks.
	Course []physics.Course
	// Voyage is per slot what the edge keeps of a boat's voyage: whether
	// it is falling, and its approaches to the lip.
	Voyage []Voyage
	// Stay and Unseen are per slot the owner's tools' marks: a boat that
	// stays is not stepped, while its owner's free camera roams; an unseen
	// boat is in no other connection's view. Neither touches anything or
	// casts a shadow.
	Stay   []bool
	Unseen []bool
	// Wind and Wake are derived from each boat's state: the true wind at
	// its place at the frame's tick, before any shadow, and the wake its
	// sail leaves for the next tick. They are in no snapshot or digest.
	Wind []physics.Env
	Wake []physics.Wake
	// Instruments are per slot what a machine boat's last step read, for
	// its agent; a human's sailor reads its own phone's. They are in no
	// snapshot or digest: the next step makes them again.
	Instruments []Instruments

	// Pairs are the boats near enough each other that the Articles
	// remember them, by their slots, ascending.
	Pairs []Pair
	// Bumps are the bumps of the last BumpTicks ticks, oldest first: an
	// encoder that skips a frame still finds every one. They are events,
	// in no snapshot or digest.
	Bumps []Bump

	// Edges are the boats this tick sent over the lip, and the approaches
	// to it recorded as voyages ended, in the order of their slots. They
	// are events, in no snapshot or digest.
	Edges []EdgeEvent

	// VoyageEnds are the voyages this tick ended, and AboardEnds the
	// times aboard another's boat it ended. They are events, in no
	// snapshot or digest.
	VoyageEnds []VoyageEnded
	AboardEnds []AboardEnded

	// Charted are the subjects this tick charted, sighted or charted with
	// another, in the order they were. They are events, in no snapshot or
	// digest.
	Charted []Charted

	// Life is the sea's life alive at the tick: each encounter from its
	// start to its end, the oldest first. It follows from the world's life
	// schedule and the boats, so it is in no snapshot or digest.
	Life []LifeEncounter

	// Races are the races under way, by their keys, and Racers their
	// boats, by their races' keys, then their numbers; NextRace the key
	// the next race takes. RaceEvents are what happened in them in the
	// last BumpTicks ticks, oldest first: events, in no snapshot or
	// digest.
	Races      []Race
	Racers     []Racer
	NextRace   uint32
	RaceEvents []RaceEvent

	// Ended says this tick was the world's last: the falls took every boat
	// afloat (their EdgeTaken events are in Edges), and no tick follows.
	Ended bool

	// Grid is the live boats by the grid cell they are in, built after
	// the physics.
	Grid Grid

	// Queue is who waits for a boat while the world is at its limit, the
	// head first.
	Queue []Waiting

	// Crew is everyone aboard a boat not their own, by their boat's slot,
	// then their seat. Holder is per slot who holds the boat's controls:
	// one of its crew, or the zero account for its skipper, its Owner.
	// Deck is per slot a count of the changes to who is aboard and who
	// holds the controls, for those who tell of them: it is in no snapshot
	// or digest.
	Crew   []Aboard
	Holder []Account
	Deck   []uint32

	// What the tick applied, in the order it applied it: the input log
	// records these.
	Changed []SlotWord // control words that changed, by slot, ascending
	Events  []Event    // commands, with their results
}

// Sea is what raises the waves in each of the world's sea areas, row by row
// from the south-west. The sea changes only on a second's first tick, and
// what it changes to is fixed a second before: Now is in effect during the
// frame's second, Next from the first tick of the second after. So a client,
// which predicts its boat a fraction of a second ahead of the server, is
// told of every change before it steps a tick the change applies to.
type Sea struct {
	Now  []physics.SeaInput
	Next []physics.SeaInput
}

// SeaPeriod is how many ticks the sea holds between changes: a second.
const SeaPeriod = physics.StepsPerSecond

// SeaSecond is the second a tick is in, counted from tick 0: the sea of
// ticks in one second is the same.
func SeaSecond(tick int64) int64 {
	s := tick / SeaPeriod
	if tick%SeaPeriod < 0 {
		s--
	}
	return s
}

// Grid lists the live boats by their cell, physics.Cell of their position:
// the boats of cell c are Slots[Start[c]:Start[c+1]], in ascending slot
// order. It is derived from the state, so it is in no snapshot or digest.
type Grid struct {
	Start []int32 // per cell, and one more: Slots's index of the cell's first boat
	Slots []int32 // the live slots, by cell
	Cell  []int32 // per slot: the cell of an occupied slot's boat
}

// Pair is two boats near each other, as the Articles remember them: which
// keeps clear and by which Article, since when and by whose action, and
// when they last touched. First is the lower slot, Second the higher.
type Pair struct {
	A, B         int32  // slots, A < B
	BoatA, BoatB uint64 // their boats: a slot another boat takes is another pair
	Keeper       uint8  // physics.Neither, First or Second
	Article      uint8  // the Article that makes it keep clear
	By           uint8  // whose action made it the keep-clear boat: physics.Neither, First or Second
	Since        int64  // the tick the keep-clear boat last changed
	Touched      int64  // the last tick they touched, or long before the pair began
}

// Bump is two boats touching after being apart: the boats and their
// sailors at the tick, where they touched and how hard, and whose fault it
// was by which Article.
type Bump struct {
	Tick           int64
	A, B           int32 // slots, A < B
	BoatA, BoatB   uint64
	OwnerA, OwnerB Account
	X, Y           float64 // the contact's point, m east and north
	Closing        float64 // the speed they closed at along the contact's normal, m/s
	Fault          uint8   // physics.Neither, First (A) or Second (B)
	Article        uint8   // the Article that puts the fault there
}

// Voyage is what a boat's voyage keeps at the edge. A voyage runs from the
// boat entering the water, by joining or starting again after going over,
// to its leaving, its expiring or its going over. An approach begins as
// the boat enters the mist band and ends as it leaves it again, survived,
// or as the voyage ends: afloat, survived; over the lip, not.
type Voyage struct {
	// Over is the tick the boat went over the lip, 0 while afloat.
	Over int64
	// Approaching is true while an approach is under way; Least is its
	// least distance inside the lip so far, m, and X and Y where that was.
	Approaching bool
	Least, X, Y float64
	// Survived is true once an approach of the voyage has been survived;
	// Best is the least distance of those, and BestX and BestY where.
	Survived           bool
	Best, BestX, BestY float64
	// Placed is true once the owner's tools have moved the boat in this
	// voyage: it earns nothing, and its going over and its approaches are
	// written as no event.
	Placed bool
	// Log is what the voyage keeps for the sailor's log.
	Log VoyageLog
}

// VoyageLog is what a voyage keeps for the sailor's log, read once a
// second (LogEvery): when it began, the distance run over the ground, the
// bumps it had, and the weather it met.
type VoyageLog struct {
	// Began is the tick the voyage began.
	Began int64
	// Run is the distance sailed over the ground, m: the straight line
	// from each second's place to the next. Read is true once the voyage
	// has a place read, X and Y, at tick At; Port is true if that place
	// was in port.
	Run  float64
	Read bool
	At   int64
	X, Y float64
	Port bool
	// Seconds counts the seconds under way that the log has read; Dark
	// those with the sun below the horizon at the boat.
	Seconds, Dark int32
	// BumpsAt and BumpsNot count the bumps it had, at fault and not.
	BumpsAt, BumpsNot uint16
	// Met is the weather it met, Met… flags.
	Met uint8
	// Wind is the true wind's minute means at the boat, the newest last
	// of the Minutes kept so far (at most WindMinutes), in quarter metres
	// a second; Sum the wind of the minute under way, summed each second.
	Wind    [WindMinutes]uint8
	Minutes uint8
	Sum     float64
	// Blow is the wind's ten-minute mean as it stands: BlowNone, BlowGale
	// or BlowStorm, held until the mean falls below Force 7.
	Blow uint8
	// GaleX and GaleY are where it first met a gale (or a storm), FogX and
	// FogY where it made a landfall in fog.
	GaleX, GaleY float64
	FogX, FogY   float64
}

// The weather a voyage met, VoyageLog.Met's flags: a gale or a storm met,
// and ridden out; a landfall in fog; a night at sea.
const (
	MetGale  = 1 << iota // a gale, Force 8, held as a ten-minute mean
	MetStorm             // a storm, Force 10
	RodeGale             // a gale ridden out: the mean fell below Force 7, or the voyage ended in port
	RodeStorm
	MetFog   // a port made with the visibility under a nautical mile
	MetNight // half an hour under way with the sun down
	MetAll   = MetGale | MetStorm | RodeGale | RodeStorm | MetFog | MetNight
)

// The wind's ten-minute mean, VoyageLog.Blow.
const (
	BlowNone  = 0
	BlowGale  = 1
	BlowStorm = 2
)

// WindMinutes is how many minute means of the wind a voyage keeps: ten.
const WindMinutes = 10

// LogEvery is how often a voyage's log is read, ticks: a second.
const LogEvery = physics.StepsPerSecond

// How a voyage ended, VoyageEnded.How; and how a time aboard another's
// boat ended, AboardEnded.How.
const (
	EndReturned = 1 + iota // the sailor brought the boat out of the water
	EndExpired             // its connection's grace ran out
	EndOver                // it went over the lip
	EndTaken               // the falls took the world
	EndAboard              // its sailor went aboard another's boat
	EndAshore              // one aboard went ashore, or was put ashore
	EndLanded              // the boat they were aboard left the water
)

// VoyageEnded is a voyage ended: the boat, its sailor and its kind, how
// it ended and where, its closest approach to the lip survived, and the
// voyage's log. Placed is a voyage the owner's tools moved: the log
// leaves it out. It is an event, in no snapshot or digest.
type VoyageEnded struct {
	Tick     int64
	Slot     int32
	Boat     uint64
	Owner    Account
	Machine  bool
	Kind     uint16
	BoatName string
	How      uint8
	Placed   bool
	X, Y     float64
	// Survived is true if an approach to the lip was survived, Least the
	// closest, m inside the lip.
	Survived bool
	Least    float64
	Log      VoyageLog
}

// AboardEnded is someone's time aboard another's boat ended: who, the boat
// and its skipper, when they came aboard, the distance the boat ran while
// they were, the weather met, and how it ended. Placed is a time aboard a
// boat the owner's tools moved. It is an event, in no snapshot or digest.
type AboardEnded struct {
	Tick           int64
	Account        Account
	Machine        bool
	Slot           int32
	Boat           uint64
	Skipper        Account
	SkipperMachine bool
	Kind           uint16
	BoatName       string
	Since          int64
	Run            float64
	Met            uint8
	How            uint8
	Placed         bool
	X, Y           float64
}

// Falling reports whether the boat is over the lip, falling.
func (v *Voyage) Falling() bool { return v.Over != 0 }

// The kinds of EdgeEvent.
const (
	EdgeOver     = 1 // the boat went over the lip at X, Y
	EdgeApproach = 2 // its voyage ended with Distance its closest survived approach, at X, Y
	EdgeTaken    = 3 // it was afloat at X, Y when the falls took the world
)

// EdgeEvent is a boat going over the lip, or the closest approach to it
// that a voyage survived, as the voyage ends.
type EdgeEvent struct {
	Tick     int64
	Kind     uint8 // EdgeOver, EdgeApproach or EdgeTaken
	Slot     int32
	Boat     uint64
	Owner    Account
	X, Y     float64 // m east and north
	Distance float64 // the approach's distance inside the lip, m; 0 going over
	// Placed: the voyage was placed by the owner's tools: counted, but
	// written as no event.
	Placed bool
}

// Charted is a subject of the world's chart charted: by its index in the
// world's sight table, and With the subject it was charted with, or −1 if
// it was sighted itself; the boat whose lookout sighted it, and where.
type Charted struct {
	Tick    int64
	Subject int32
	With    int32
	Slot    int32
	Boat    uint64
	Owner   Account
	X, Y    float64
}

// LifeEncounter is a group of one kind of the sea's life met from Start to
// End, its record as every phone draws it: where it is and which way it
// goes, how fast, how many, its own seed, and the boat it is with, if any.
// A free group's path is a function of the record and world time alone; a
// group with a boat moves about that boat as it is drawn. Rev counts its
// changes: a binding ended early, or its end moved.
type LifeEncounter struct {
	ID    uint64
	Kind  uint16 // an index into the catalog's life kinds
	Rev   uint32
	Start int64 // ticks
	End   int64
	// East and North are its centre, m from the world's centre, in whole
	// centimetres; Heading the way it goes, rad clockwise from north, and
	// Speed how fast, m/s, each a float32's.
	East, North    float64
	Heading, Speed float64
	Count          uint16
	Seed           uint32
	// Boat is the boat it is with, 0 for none, and Slot that boat's slot,
	// −1 for none.
	Boat uint64
	Slot int32
	// Over is the encounter on whose patch it comes, 0 for none: the
	// birds and the dolphins with bait, the flying fish of a ground.
	Over uint64
}

// BumpTicks is how many ticks a frame keeps a bump: a second.
const BumpTicks = 30

// LifeRoom is how many encounters with the sea's life a frame has room for
// without growing.
const LifeRoom = 256

// Cells is the number of the grid's cells.
const Cells = physics.GridCells * physics.GridCells

// Boats lists the slots of the boats in cell c.
func (g *Grid) Boats(c int32) []int32 { return g.Slots[g.Start[c]:g.Start[c+1]] }

// Waiting is a connection waiting for a boat.
type Waiting struct {
	Account Account
	Conn    uint64 // 0 for none: a place kept for its account, as across a restart
	Since   int64  // the tick it was queued at
	// Grace, for a place with no connection, is the tick it is given up
	// at, unless its account joins first; 0 while connected.
	Grace int64
	// Machine and Priority are its account's kind, as the Join gave it,
	// Look its sailor's look and BoatKind the kind of boat it is to have,
	// BoatLook and BoatName that boat's own look and name.
	Machine  bool
	Priority bool
	Look     uint32
	BoatKind uint16
	BoatLook uint32
	BoatName string
}

// Aboard is someone aboard another sailor's boat, as its crew: they have
// no boat of their own in the world, and hold no place against the boat
// limit. Seat is their station on deck, 1 up to the boat's capacity less
// one (the skipper's is 0).
type Aboard struct {
	Slot    int32  // the boat's slot
	Boat    uint64 // the boat
	Seat    uint8
	Account Account
	Conn    uint64 // the connection they are aboard through, 0 for none
	// Grace is the tick they go ashore at, their connection gone, unless
	// they come back first; 0 while connected.
	Grace int64
	Since int64 // the tick they came aboard
	// Run is the distance the boat has run since they came aboard, m, and
	// Met the weather met meanwhile, as the voyage's log reads them.
	Run float64
	Met uint8
	// Machine and Priority are their account's kind; Look their sailor's
	// look and Name their name, as players see it.
	Machine  bool
	Priority bool
	Look     uint32
	Name     string
	// BoatKind, BoatLook and BoatName are their own boat's, for when they
	// go ashore.
	BoatKind uint16
	BoatLook uint32
	BoatName string
}

// MaxCrew is the most people aboard one boat but its skipper.
const MaxCrew = 63

// CrewOf is the crew of the boat in slot s: f.Crew[lo:hi].
func (f *Frame) CrewOf(s int32) (lo, hi int) {
	lo, _ = slices.BinarySearchFunc(f.Crew, s, func(a Aboard, s int32) int { return int(a.Slot - s) })
	hi = lo
	for hi < len(f.Crew) && f.Crew[hi].Slot == s {
		hi++
	}
	return lo, hi
}

// Aboard is the index in f.Crew of account, or −1 if it is aboard no boat.
func (f *Frame) Aboard(account Account) int {
	for i := range f.Crew {
		if f.Crew[i].Account == account {
			return i
		}
	}
	return -1
}

// HelmLook is the look of whoever holds the controls of the boat in slot
// s, drawn at its helm: its skipper's, or the crew member's they handed
// them to.
func (f *Frame) HelmLook(s int32) uint32 {
	if f.Holder[s] == (Account{}) {
		return f.Look[s]
	}
	lo, hi := f.CrewOf(s)
	for i := lo; i < hi; i++ {
		if f.Crew[i].Account == f.Holder[s] {
			return f.Crew[i].Look
		}
	}
	return f.Look[s]
}

// QueuePlace is the place in the queue of q[i] among those of its kind, human
// or machine, 1 for the head, and how many of its kind wait: humans and
// machine sailors wait in queues of their own.
func QueuePlace(q []Waiting, i int) (position, waiting int32) {
	for j := range q {
		if q[j].Machine != q[i].Machine {
			continue
		}
		waiting++
		if j <= i {
			position++
		}
	}
	return position, waiting
}

// Instruments are what a machine boat's last step read: the true wind it
// felt, in the shadow of the boats about it, the wind over its deck, its
// way over the ground and the water under it.
type Instruments struct {
	WindSpeed        float32 // the true wind 10 m up, m/s
	WindFrom         float32 // where it comes from, rad clockwise from north
	ApparentSpeed    float32 // at the masthead, m/s
	ApparentAngle    float32 // where it comes from off the bow, rad, positive from starboard
	SpeedOverGround  float32 // m/s
	CourseOverGround float32 // rad clockwise from north
	Depth            float32 // under the daggerboard, m; negative over land
	// Sail is the sail's state as its agent is told it, the phone's sheet
	// shows it: SailDrawing, or what the step says of it (physics.Out's
	// Sail) once it has held SailHold ticks, until it has drawn again
	// SailClear. SailRaw is what the last step said, and SailFor how many
	// steps in a row it has said so.
	Sail    uint8
	SailRaw uint8
	SailFor int32
}

// The sail's states, for Instruments.Sail: the physics'.
const (
	SailDrawing = physics.SailDrawing
	SailLuffing = physics.SailLuffing
	SailStalled = physics.SailStalled
	SailAback   = physics.SailAback
)

// SailHold is how many ticks a sail must luff, stall or lie aback before
// its state is told: a second and a half, so that a gust's flutter is not.
// SailClear is how long it must draw again before the state clears: a
// second. The phone's sheet control holds its word as long.
const (
	SailHold  = 45
	SailClear = 30
)

// WeatherHistory is the most developer's weathers a frame keeps.
const WeatherHistory = 8

// KeyFrames is how many keyframes a frame holds: the one in effect, the
// next, and the one after, which a client is sent ahead.
const KeyFrames = 3

// SpellsInPlay is the frame's spells in play.
func (f *Frame) SpellsInPlay() []physics.Spell { return f.Spells[:f.NSpells] }

// QueueLimit is the most connections that may wait for a boat.
const QueueLimit = 4096

// SlotWord is the control words applied to a slot.
type SlotWord struct {
	Slot  int32
	Word  Word
	Pilot PilotWord
	Rig   RigWord
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
		Machine:  make([]bool, capacity),
		Priority: make([]bool, capacity),
		Look:     make([]uint32, capacity),
		BoatLook: make([]uint32, capacity),
		BoatName: make([]string, capacity),
		Control:  make([]Word, capacity),
		Pilot:    make([]PilotWord, capacity),
		Rig:      make([]RigWord, capacity),
		State:    make([]physics.State, capacity),
		Sea: Sea{
			Now:  make([]physics.SeaInput, physics.SeaAreas*physics.SeaAreas),
			Next: make([]physics.SeaInput, physics.SeaAreas*physics.SeaAreas),
		},
		Sail:        make([]uint8, capacity),
		Trim:        make([]float64, capacity),
		Course:      make([]physics.Course, capacity),
		Voyage:      make([]Voyage, capacity),
		Stay:        make([]bool, capacity),
		Unseen:      make([]bool, capacity),
		Edges:       make([]EdgeEvent, 0, 64),
		Charted:     make([]Charted, 0, 64),
		VoyageEnds:  make([]VoyageEnded, 0, 64),
		AboardEnds:  make([]AboardEnded, 0, 16),
		Wind:        make([]physics.Env, capacity),
		Wake:        make([]physics.Wake, capacity),
		Instruments: make([]Instruments, capacity),
		Pairs:       make([]Pair, 0, capacity),
		Bumps:       make([]Bump, 0, 64),
		Life:        make([]LifeEncounter, 0, LifeRoom),
		Races:       make([]Race, 0, 16),
		Racers:      make([]Racer, 0, 64),
		RaceEvents:  make([]RaceEvent, 0, 64),
		Grid: Grid{
			Start: make([]int32, Cells+1),
			Slots: make([]int32, 0, capacity),
			Cell:  make([]int32, capacity),
		},
		Queue:    make([]Waiting, 0, QueueLimit),
		Crew:     make([]Aboard, 0, 64),
		Holder:   make([]Account, capacity),
		Deck:     make([]uint32, capacity),
		Weathers: make([]Weather, 0, WeatherHistory),
		Systems:  make([]System, 0, SystemSlots),
		Changed:  make([]SlotWord, 0, capacity),
		Events:   make([]Event, 0, 64),
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
