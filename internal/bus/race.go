// SPDX-License-Identifier: AGPL-3.0-only

package bus

import "github.com/daneelvt/keel-over-the-edge/internal/physics"

// Races in the world: the committee (internal/race/committee) runs each race
// under way inside the tick. A race is handed to it by the server at its
// warning signal (RacePlace), with its entrants; the committee lays its
// course to the wind, places the boats on its line, fires its signals,
// judges the roundings, calls the bumps, finishes the boats and places
// everyone. A time trial's run is a race of one, placed as its sailor asks
// and timed from its crossing of the line. What a race is and what each of
// its boats has done is world state, in the snapshot and the digest; what
// happens in a race is told as events, kept a second in the frames.

// RaceCall is a race handed to the committee: which race and run, its
// course and boat, its start, and its entrants. It never changes once
// sent: a Command carries a pointer to it.
type RaceCall struct {
	// ID is the race's own, its row's; Run 0 for a race, a time trial's
	// run from 1.
	ID  [16]byte
	Run int32
	// Trial: a time trial's run, timed from its crossing of the line.
	Trial bool
	// Island is an island course, Course its number in the world; or a
	// buoy course laid in the racing area of number Course (0 for a buoy
	// trial's: the committee chooses), a triangle or a windward–leeward,
	// long or short, or (Across) a reach: across the wind to one mark and
	// back; or (Across and Dash) a Dash: across the wind to one mark and
	// home to a finish line of its own, laid up the wind of the start's.
	Island   bool
	Course   int32
	Triangle bool
	Across   bool
	Dash     bool
	Long     bool
	// Kind is the boat's kind, an index into the world's kinds.
	Kind uint16
	// Start is the tick of the start's gun; a trial's is when its boat
	// crosses the line.
	Start int64
	// Entrants are the boats entered, by their race numbers.
	Entrants []RaceEntrant
}

// RaceEntrant is a boat entered in a race: its skipper's account, its race
// number, whether a machine sailor's, whether those aboard race with it,
// and the skipper's own boat of the race's kind, its look and name, for a
// skipper sailing another kind as the boats are placed.
type RaceEntrant struct {
	Account  Account
	Number   int16
	Machine  bool
	Crew     bool
	BoatLook uint32
	BoatName string
}

// MaxEntrants is the most boats a race is handed with.
const MaxEntrants = 256

// RaceSlots are how many check points a course may hold: its rounding
// rays, gates and lines.
const RaceSlots = 64

// RaceCourse is a race's course as the committee laid it, at its warning
// signal (a trial's at its placing): it never changes after, and frames
// share it.
type RaceCourse struct {
	// Island is an island course, Number its number; or a buoy course in
	// the racing area of Number, Triangle or windward–leeward, with Laps
	// laps, or (Across) a reach: its line along the wind, its one mark
	// straight across the wind from it; a Dash (Across and Dash) as a
	// reach, home to a finish line of its own up the wind of the start's.
	// Upwind: an island course laid with its first leg closer to the wind
	// than any start the committee could find off it.
	Island   bool
	Number   int32
	Triangle bool
	Across   bool
	Dash     bool
	Upwind   bool
	Laps     int32
	// Wind is the mean wind it was laid to, m/s 10 m up, and From where it
	// came from, rad clockwise from north.
	Wind, From float64
	// X and Y are where it lies, m east and north of the world's centre:
	// a racing area's centre, an island course's start; Reach how far
	// from there it reaches, m.
	X, Y, Reach float64
	// Committee and Pin are the start line's ends: the committee boat at
	// its starboard end, the pin at its port end; FinishA and FinishB the
	// finish line's, the same line for a buoy course.
	Committee, Pin   [2]float64
	FinishA, FinishB [2]float64
	// Marks are the marks laid in the water, in the order they are
	// rounded on the first lap: a gate's two buoys with one number.
	Marks []RaceMark
	// Checks are what a boat must pass, in order: the start line, each
	// rounding, the finish line.
	Checks []RaceCheck
	// Way is the way sailed, from the start line's middle to the finish
	// line's, m east and north; Length its length, m. Expected is how long
	// the race's boat takes to sail it in the wind it was laid to, s, by
	// her polar: the time limit's and a trial's par.
	Way      [][2]float64
	Length   float64
	Expected float64
}

// RaceMark is a mark laid: where, its number, and the side it is left to:
// MarkStarboard, MarkPort, or MarkGate for a gate's buoy.
type RaceMark struct {
	X, Y   float64
	Number int16
	Side   int8
}

// The sides a mark is left to.
const (
	MarkPort      int8 = -1
	MarkGate      int8 = 0
	MarkStarboard int8 = 1
)

// RaceCheck is a point of the course a boat must pass: a ray, a half-line
// from (X, Y) toward bearing (S, C) its sine and cosine, to be crossed Want
// times clockwise about its start, less anticlockwise (−1 a mark left to
// port); or a line (Line) from (X, Y) to (X2, Y2), crossed from its left to
// its right (Want 1) or the other way (Want −1). Mark is the mark it
// rounds, 0 for the start and the finish; Along is how far along the way
// it lies, m, and AtX and AtY the way's point there.
type RaceCheck struct {
	Line     bool
	X, Y     float64
	S, C     float64
	X2, Y2   float64
	Want     int8
	Mark     int16
	Along    float64
	AtX, AtY float64
}

// The phases of a race, Race.Phase.
const (
	RaceWarning     uint8 = iota + 1 // from the warning signal: the boats placed, the course laid
	RacePreparatory                  // from the preparatory signal, a minute before the start: bumps are called
	RaceStarted                      // under way, from the gun
	RaceEnded                        // over: everyone placed, its results kept, until the server has written them
)

// Race is a race under way, as its committee runs it.
type Race struct {
	// Key is the committee's own number for it in this world, from 1;
	// boats and events name their race by it.
	Key uint32
	// ID and Run are the race's own and its run (RaceCall's).
	ID    [16]byte
	Run   int32
	Trial bool
	// Long: a long buoy course; Kind the boat's kind.
	Long bool
	Kind uint16
	// Course is its course, laid at its warning.
	Course *RaceCourse
	// Warning and Start are the ticks of the warning signal and the start
	// (a trial's: when its boat crossed the line, 0 until then).
	Warning, Start int64
	Phase          uint8
	// Home is the tick its first boat finished, 0 none yet; Closes the tick
	// it ends, 0 not yet known: the window's close once a boat is home.
	Home, Closes int64
	// Ended is the tick it ended, 0 under way; Prizes whether its boats
	// came from enough accounts for its prizes.
	Ended  int64
	Prizes bool
	// Alone: a race with one boat as its boats were placed, judged as a
	// time trial is: no sequence, its clock from its boat's crossing of the
	// line, a medal against its expected time. CalledOff: a race called off
	// at its warning signal, for a storm at its place: no boat placed, it
	// ended as it began.
	Alone     bool
	CalledOff bool
}

// The states of a boat in a race, Racer.State.
const (
	RacerDNS         uint8 = iota + 1 // did not start: not at sea as the boats were placed
	RacerPlaced                       // on the line, before the start or a trial's crossing
	RacerRacing                       // under way
	RacerFinished                     // home
	RacerRetired                      // retired: by choice, out of the water, or drifting
	RacerPlacedAtEnd                  // still racing as the race ended: placed by its progress
)

// The awards, Racer.Awards's bits.
const (
	AwardBestStart = 1 << iota // first across the line after the gun, on time
	AwardComeback              // most places gained after the first mark
	AwardPhoto                 // home within PhotoTicks of another
	AwardCrowd                 // most cheered
	AwardSpoon                 // the last boat still racing at the end
)

// The medals of a time trial's run, Racer.Medal.
const (
	MedalBronze        uint8 = iota + 1 // within half as long again as par
	MedalSilver                         // within a fifth
	MedalGold                           // at par
	MedalHarbourmaster                  // a tenth under
)

// Racer is a boat in a race: its skipper and race number, its boat, and
// what it has done.
type Racer struct {
	// Race is its race's Key.
	Race    uint32
	Account Account
	Number  int16
	Machine bool
	// Crew: those aboard race with it.
	Crew bool
	// Piloted: its autopilot steered it in a tick of its run; Company:
	// someone else was aboard in a tick of its run. A run sailed with
	// neither is one sailed alone by hand.
	Piloted, Company bool
	// Slot and Boat are its boat in the world.
	Slot  int32
	Boat  uint64
	State uint8
	// Next is the check it is to pass next, and Net its crossings of it
	// so far (a ray's).
	Next int16
	Net  int8
	// Over: over the line at the gun. Crossed is the tick it crossed the
	// start line, or the gun's for a boat over early; Home the tick it
	// finished; Added the ticks added for fouls and an early start.
	Over    bool
	Crossed int64
	Home    int64
	Added   int64
	// ToGo is how far it has to go along the course, m, as last read;
	// Least the least it has read since LeastAt; Asked when it was asked
	// whether it still races, 0 not.
	ToGo    float64
	Least   float64
	LeastAt int64
	Asked   int64
	// First is its place rounding the first mark, 0 not yet.
	First int16
	// Place, Medal and Awards are what it came to, once its race ended.
	Place  int16
	Medal  uint8
	Awards uint8
	// Cheers are the cheers its spectators gave it.
	Cheers uint32
	// Track is its track, coded (internal/race/committee): frames share
	// it, and only ever append to it. Sampled is the tick of its last
	// sample, and SX, SY, SH and SV that sample as coded.
	Track          []byte
	Sampled        int64
	SX, SY, SH, SV int32
}

// RaceHome is where a boat was just before a race or a trial's run took
// it to its line: its skipper's, its slot and boat, its kind, look and
// name, its place and heading. Once the race is over for it, it goes
// back there, HomeAfter later.
type RaceHome struct {
	Account  Account
	Slot     int32
	Boat     uint64
	Kind     uint16
	BoatLook uint32
	BoatName string
	X, Y     float64
	Heading  float64
	// At is the tick it goes home, 0 while it still races.
	At int64
}

// HomeAfter is how many ticks after its race is over for it a boat goes
// back to where it was: a few seconds, to see itself across the line.
const HomeAfter = 5 * physics.StepsPerSecond

// The kinds of RaceEvent.
const (
	RaceSignalled uint8 = iota + 1 // a signal: Signal, with the gun if Gun
	RaceRounded                    // boat Number rounded mark Mark, in Place
	RaceCalled                     // boat Number at fault in a bump with Other by Article: Added s
	RaceOverEarly                  // boat Number over the line at the gun: Added s
	RaceMissed                     // boat Number crossed the finish with mark Mark missed
	RaceFinished                   // boat Number home, in Place
	RaceRetired                    // boat Number retired
	RaceDrifting                   // boat Number asked whether it still races
	RacePlaced                     // the boats were placed: Number of them, the rest did not start
	RaceOver                       // the race ended: its results are its boats'
)

// The signals, RaceEvent.Signal.
const (
	SignalWarning     uint8 = iota + 1 // the class's pennant up
	SignalPreparatory                  // P up: a minute to go
	SignalStart                        // both down: the start
	SignalRecall                       // X up: a boat over early
	SignalFinish                       // a boat finished: Number, the winner's the loudest
)

// RaceEvent is something that happened in a race, at Tick.
type RaceEvent struct {
	Tick    int64
	Race    uint32
	Kind    uint8
	Signal  uint8
	Gun     bool
	Number  int16
	Other   int16
	Mark    int16
	Place   int16
	Article uint8
	Added   float64
}
