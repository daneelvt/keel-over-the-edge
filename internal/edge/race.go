// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"context"
	"math"
	"sync"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/race/committee"
)

// Races on the wire. One race picture for everyone: a race's boats and
// those watching them are sent where every boat of the race is every two
// seconds (RacePicture), beyond their view, by race number, never by
// name. A connection is told a race (RaceTold: its course, and its boats
// with their names as the reader may be told them) when its eye's boat
// races in it, or when its course is within sight of its eye: the marks
// in the sea are everyone's to see. The names are read from the
// database apart from the encoder: the race is told at once without them,
// and again with them once they are read. What happens in a race (its
// signals, its calls, its finishes, its results) goes to every connection
// told it.

// raceSight is how far beyond its own reach a race's course is told to a
// connection's eye, m: the committee boat's flags and smoke are seen far.
const raceSight = 1500

// pictureEvery is how often a race's picture goes to its boats and those
// watching them, ticks.
const pictureEvery = 2 * committee.Second

// RaceNamer names a race's skippers, in order, as reader may be told them:
// "" for one not named. It may read the database.
type RaceNamer func(ctx context.Context, reader bus.Account, racers []bus.Account) ([]string, error)

// connRaces is what a connection has been told of the world's races: the
// encoder's, but for named, which the reader of names fills.
type connRaces struct {
	told map[uint32]*toldRace
	// event is the tick of the newest race event sent; pictured that of
	// the last picture.
	event, pictured int64
	mu              sync.Mutex
	named           []namedRace
}

// toldRace is a race told to a connection.
type toldRace struct {
	asked   bool // its names asked for
	results bool // its results sent
}

// namedRace is a race's names read for a connection, to be told.
type namedRace struct {
	key   uint32
	names []string
}

// races tells c of the races of f about its eye, the boat in slot s,
// boat, at (x, y): false if c has closed.
func (c *conn) races(f *bus.Frame, s int32, boat uint64, x, y float64) bool {
	cr := &c.racesTold
	if len(f.Races) == 0 && len(cr.told) == 0 {
		return true
	}
	if cr.told == nil {
		cr.told = map[uint32]*toldRace{}
	}
	mine := uint32(0)
	for j := range f.Racers {
		if rc := &f.Racers[j]; rc.Slot == s && rc.Boat == boat {
			mine = rc.Race
		}
	}
	// Names read since.
	cr.mu.Lock()
	named := cr.named
	cr.named = nil
	cr.mu.Unlock()
	for _, n := range named {
		if i := raceIndex(f, n.key); i >= 0 && cr.told[n.key] != nil {
			if !c.send(raceTold(f, i, c.account, n.names), outRaceTold) {
				return false
			}
		}
	}
	for i := range f.Races {
		r := &f.Races[i]
		if cr.told[r.Key] != nil || r.Phase == bus.RaceEnded {
			continue
		}
		cs := r.Course
		if r.Key != mine && math.Hypot(x-cs.X, y-cs.Y) > cs.Reach+raceSight {
			continue
		}
		cr.told[r.Key] = &toldRace{}
		if !c.send(raceTold(f, i, c.account, nil), outRaceTold) {
			return false
		}
		c.askNames(f, i)
	}
	// What happened since.
	newest := cr.event
	for k := range f.RaceEvents {
		e := &f.RaceEvents[k]
		if e.Tick <= cr.event {
			continue
		}
		newest = max(newest, e.Tick)
		t := cr.told[e.Race]
		if t == nil {
			continue
		}
		m, kind := raceEvent(f, e)
		if m == nil {
			continue
		}
		if e.Kind == bus.RaceOver {
			t.results = true
		}
		if !c.send(m, kind) {
			return false
		}
	}
	cr.event = newest
	if mine != 0 && f.Tick-cr.pictured >= pictureEvery {
		if i := raceIndex(f, mine); i >= 0 && cr.told[mine] != nil {
			cr.pictured = f.Tick
			if !c.send(racePicture(f, i), outRacePicture) {
				return false
			}
		}
	}
	// Races let go: their courses taken up.
	for key := range cr.told {
		if raceIndex(f, key) < 0 {
			delete(cr.told, key)
			if !c.send(&pb.ServerMessage{Body: &pb.ServerMessage_RaceTold{RaceTold: &pb.RaceTold{Race: key, Gone: true}}}, outRaceTold) {
				return false
			}
		}
	}
	return true
}

// askNames reads the names of f.Races[i]'s boats for c, apart.
func (c *conn) askNames(f *bus.Frame, i int) {
	namer := c.e.cfg.RaceNames
	if namer == nil {
		return
	}
	key := f.Races[i].Key
	t := c.racesTold.told[key]
	if t == nil || t.asked {
		return
	}
	t.asked = true
	var racers []bus.Account
	for j := range f.Racers {
		if f.Racers[j].Race == key {
			racers = append(racers, f.Racers[j].Account)
		}
	}
	reader := c.account
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		names, err := namer(ctx, reader, racers)
		if err != nil {
			c.e.cfg.Log.Warn("naming a race's boats", "err", err)
			return
		}
		cr := &c.racesTold
		cr.mu.Lock()
		cr.named = append(cr.named, namedRace{key: key, names: names})
		cr.mu.Unlock()
	}()
}

// raceIndex is the index in f.Races of the race of key, or −1.
func raceIndex(f *bus.Frame, key uint32) int {
	for i := range f.Races {
		if f.Races[i].Key == key {
			return i
		}
	}
	return -1
}

// metres is a length as the wire's whole metres.
func metres(v float64) int32 {
	return int32(min(max(math.Round(v), math.MinInt32), math.MaxInt32))
}

// raceTold is f.Races[i] as reader is told it, its boats named by names
// (nil for none yet).
func raceTold(f *bus.Frame, i int, reader bus.Account, names []string) *pb.ServerMessage {
	r := &f.Races[i]
	c := r.Course
	m := &pb.RaceTold{Race: r.Key, Boat: uint32(r.Kind), Trial: r.Trial, Run: uint32(max(r.Run, 0)), Warning: r.Warning, Start: r.Start,
		Line:   []int32{metres(c.Pin[0]), metres(c.Pin[1]), metres(c.Committee[0]), metres(c.Committee[1])},
		Finish: []int32{metres(c.FinishA[0]), metres(c.FinishA[1]), metres(c.FinishB[0]), metres(c.FinishB[1])},
		East:   metres(c.X), North: metres(c.Y), Reach: uint32(max(metres(c.Reach), 0)), Laps: uint32(max(c.Laps, 1)),
		Expected: float32(c.Expected)}
	for _, mk := range c.Marks {
		m.Marks = append(m.Marks, &pb.RaceMark{East: metres(mk.X), North: metres(mk.Y), Number: uint32(max(mk.Number, 0)), Side: int32(mk.Side)})
	}
	for _, p := range c.Way {
		m.Way = append(m.Way, metres(p[0]), metres(p[1]))
	}
	for _, ch := range c.Checks {
		m.Legs = append(m.Legs, &pb.RaceLeg{Mark: uint32(max(ch.Mark, 0)), East: metres(ch.AtX), North: metres(ch.AtY)})
	}
	n := 0
	for j := range f.Racers {
		rc := &f.Racers[j]
		if rc.Race != r.Key {
			continue
		}
		e := &pb.RaceEntrant{Number: uint32(max(rc.Number, 0)), Machine: rc.Machine, Me: rc.Account == reader}
		if s := rc.Slot; s >= 0 && f.Occupied[s] && f.Boat[s] == rc.Boat {
			e.Boat = f.BoatName[s]
		}
		if n < len(names) {
			e.Name = names[n]
		}
		n++
		m.Entrants = append(m.Entrants, e)
	}
	return &pb.ServerMessage{Body: &pb.ServerMessage_RaceTold{RaceTold: m}}
}

// The racers' states on the wire, by theirs.
var racerStates = [...]pb.RacerState{
	bus.RacerDNS: pb.RacerState_RACER_STATE_DNS, bus.RacerPlaced: pb.RacerState_RACER_STATE_PLACED,
	bus.RacerRacing: pb.RacerState_RACER_STATE_RACING, bus.RacerFinished: pb.RacerState_RACER_STATE_FINISHED,
	bus.RacerRetired: pb.RacerState_RACER_STATE_RETIRED, bus.RacerPlacedAtEnd: pb.RacerState_RACER_STATE_PLACED_AT_END,
}

func racerState(s uint8) pb.RacerState {
	if int(s) < len(racerStates) {
		return racerStates[s]
	}
	return pb.RacerState_RACER_STATE_UNSPECIFIED
}

// racePicture is f.Races[i] as it stands.
func racePicture(f *bus.Frame, i int) *pb.ServerMessage {
	r := &f.Races[i]
	c := r.Course
	order := committee.Standings(f, r.Key)
	m := &pb.RacePicture{Race: r.Key, Tick: f.Tick}
	// The gap: to the first's time for those home; for the rest, the way
	// between them at the course's own speed.
	speed := 1.0
	if c.Expected > 0 {
		speed = max(c.Length/c.Expected, 0.1)
	}
	var lead *bus.Racer
	for place, j := range order {
		rc := &f.Racers[j]
		at := &pb.RacerAt{Number: uint32(max(rc.Number, 0)), Added: uint32(rc.Added / committee.Second), State: racerState(rc.State),
			Leg: uint32(max(rc.Next, 0)), ToGo: uint32(max(metres(rc.ToGo), 0)), Cheers: rc.Cheers}
		if rc.State != bus.RacerDNS && rc.State != bus.RacerRetired {
			at.Place = uint32(place + 1)
			if lead == nil {
				lead = rc
			}
			at.Gap = gapOf(r, lead, rc, speed)
		}
		if s := rc.Slot; s >= 0 && f.Occupied[s] && f.Boat[s] == rc.Boat {
			st := &f.State[s]
			at.East, at.North = metres(st.X), metres(st.Y)
			at.Heading = uint32(math.Mod(math.Round(st.Heading*180/math.Pi)+360, 360))
		}
		m.Racers = append(m.Racers, at)
	}
	return &pb.ServerMessage{Body: &pb.ServerMessage_RacePicture{RacePicture: m}}
}

// gapOf is racer rc's gap to the first, lead, in race r, tenths of a
// second: their times' for two boats home, else the way between them at
// speed m/s.
func gapOf(r *bus.Race, lead, rc *bus.Racer, speed float64) uint32 {
	if rc == lead {
		return 0
	}
	if rc.State == bus.RacerFinished && lead.State == bus.RacerFinished {
		d := float64(rc.Home-lead.Home+rc.Added-lead.Added) / committee.Second
		return uint32(max(math.Round(d*10), 0))
	}
	ahead := lead.ToGo
	if lead.State == bus.RacerFinished {
		ahead = 0
	}
	return uint32(max(math.Round((rc.ToGo-ahead)/speed*10), 0))
}

// raceSignals are the signals on the wire, by theirs.
var raceSignals = [...]pb.RaceSignalKind{
	bus.SignalWarning: pb.RaceSignalKind_RACE_SIGNAL_KIND_WARNING, bus.SignalPreparatory: pb.RaceSignalKind_RACE_SIGNAL_KIND_PREPARATORY,
	bus.SignalStart: pb.RaceSignalKind_RACE_SIGNAL_KIND_START, bus.SignalRecall: pb.RaceSignalKind_RACE_SIGNAL_KIND_RECALL,
	bus.SignalFinish: pb.RaceSignalKind_RACE_SIGNAL_KIND_FINISH,
}

// raceEvent is race event e of f as a message, and its kind for the
// counts; nil for one that is not sent.
func raceEvent(f *bus.Frame, e *bus.RaceEvent) (*pb.ServerMessage, int) {
	call := func(kind pb.RaceCallKind) (*pb.ServerMessage, int) {
		return &pb.ServerMessage{Body: &pb.ServerMessage_RaceCall{RaceCall: &pb.RaceCall{Race: e.Race, Kind: kind,
			Number: uint32(max(e.Number, 0)), Other: uint32(max(e.Other, 0)), Article: protocol.ArticleName(e.Article),
			Mark: uint32(max(e.Mark, 0)), Added: uint32(max(e.Added, 0)), Place: uint32(max(e.Place, 0))}}}, outRaceCall
	}
	switch e.Kind {
	case bus.RaceSignalled:
		sig := pb.RaceSignalKind_RACE_SIGNAL_KIND_UNSPECIFIED
		if int(e.Signal) < len(raceSignals) {
			sig = raceSignals[e.Signal]
		}
		return &pb.ServerMessage{Body: &pb.ServerMessage_RaceSignal{RaceSignal: &pb.RaceSignal{Race: e.Race, Signal: sig, Gun: e.Gun,
			Number: uint32(max(e.Number, 0)), Place: uint32(max(e.Place, 0))}}}, outRaceSignal
	case bus.RaceCalled:
		return call(pb.RaceCallKind_RACE_CALL_KIND_BUMP)
	case bus.RaceOverEarly:
		return call(pb.RaceCallKind_RACE_CALL_KIND_OVER_EARLY)
	case bus.RaceMissed:
		return call(pb.RaceCallKind_RACE_CALL_KIND_MISSED_MARK)
	case bus.RaceDrifting:
		return call(pb.RaceCallKind_RACE_CALL_KIND_DRIFTING)
	case bus.RaceRetired:
		return call(pb.RaceCallKind_RACE_CALL_KIND_RETIRED)
	case bus.RaceRounded:
		return call(pb.RaceCallKind_RACE_CALL_KIND_ROUNDED)
	case bus.RaceFinished:
		i := raceIndex(f, e.Race)
		m := &pb.RaceFinish{Race: e.Race, Number: uint32(max(e.Number, 0)), Place: uint32(max(e.Place, 0)), Added: uint32(max(e.Added, 0))}
		if i >= 0 {
			for j := range f.Racers {
				if rc := &f.Racers[j]; rc.Race == e.Race && rc.Number == e.Number {
					m.ElapsedMs = uint32(max(math.Round(committee.Elapsed(&f.Races[i], rc)*1000), 0))
				}
			}
		}
		return &pb.ServerMessage{Body: &pb.ServerMessage_RaceFinish{RaceFinish: m}}, outRaceFinish
	case bus.RaceOver:
		if i := raceIndex(f, e.Race); i >= 0 {
			return raceResults(f, i), outRaceResults
		}
	}
	return nil, 0
}

// The ways a boat's race ends, as its result says them.
var raceHows = [...]string{bus.RacerDNS: "dns", bus.RacerRetired: "ret", bus.RacerFinished: "finished", bus.RacerPlacedAtEnd: "placed",
	bus.RacerRacing: "placed", bus.RacerPlaced: "placed"}

// raceResults are f.Races[i]'s results.
func raceResults(f *bus.Frame, i int) *pb.ServerMessage {
	r := &f.Races[i]
	m := &pb.RaceResults{Race: r.Key, Prizes: r.Prizes}
	for _, j := range committee.Standings(f, r.Key) {
		rc := &f.Racers[j]
		res := &pb.RaceResult{Number: uint32(max(rc.Number, 0)), Place: uint32(max(rc.Place, 0)), Added: uint32(rc.Added / committee.Second),
			Medal: committee.MedalName(rc.Medal), Awards: committee.Awards(rc.Awards)}
		if int(rc.State) < len(raceHows) {
			res.How = raceHows[rc.State]
		}
		if rc.State == bus.RacerFinished {
			res.ElapsedMs = uint32(max(math.Round(committee.Elapsed(r, rc)*1000), 0))
		} else if rc.State != bus.RacerDNS {
			res.ToGo = uint32(max(metres(rc.ToGo), 0))
		}
		for k := 0; k < int(rc.Next) && k < len(r.Course.Checks); k++ {
			if r.Course.Checks[k].Mark > 0 {
				res.Marks++
			}
		}
		m.Results = append(m.Results, res)
	}
	return &pb.ServerMessage{Body: &pb.ServerMessage_RaceResults{RaceResults: m}}
}

// raceCommand does what a Command asks of a race, if it asks anything: a
// retirement goes to the committee; a cheer waits for the crowd to be
// counted.
func (c *conn) raceCommand(cmd *pb.Command) {
	if cmd.GetRaceRetire() == nil {
		return
	}
	if err := c.e.cfg.Bus.Commands.Players().TrySend(bus.Command{Op: bus.RaceRetire, Account: c.account}); err != nil {
		c.e.cfg.Log.Warn("retiring from a race", "err", err)
	}
}
