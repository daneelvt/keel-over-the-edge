// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"context"
	"errors"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/race/committee"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/watch"
)

// Watching a race. A boat racing may be watched from its placing on the
// line until it is out of the race, whatever its sailor's choice of
// spectators (watch.Allowed), and its watch is asked for by its race and
// race number rather than by its sailor's name, which the spectator may
// not be told: the boat chosen, or, with no number, the one at the front
// of the closest battle (before the start, the first entered). Its
// Welcome names its sailor as the race names them to the spectator.
//
// A spectator cheers the boat it watches, one cheer every CheerEvery; the
// edge gathers them every two seconds, tells the simulation how many each
// boat had (bus.RaceCheer, which the crowd's favourite is judged by), and
// tells the boat's racers and spectators (RaceCheered).

// CheerEvery is how often a spectator's cheer counts, at most, ticks.
const CheerEvery = 10 * committee.Second

// raceAsk is a watch of a race's boat: its race by key or by its link's
// code, and its race number, 0 for the boat the edge chooses.
type raceAsk struct {
	race   uint32
	code   string
	number int16
}

// raceAskOf is a Watch's race's boat, ok false for none asked.
func raceAskOf(w *pb.Watch) (raceAsk, bool) {
	if w == nil || w.GetRace() == 0 && w.GetCode() == "" {
		return raceAsk{}, false
	}
	return raceAsk{race: w.GetRace(), code: w.GetCode(), number: int16(min(w.GetNumber(), math.MaxInt16))}, true
}

// raceWatchCommand is a watch of a race's boat the client asked for: the
// race and its boat found in the latest frame, then its skipper looked up
// and watched as watchCommand watches a sailor.
func (c *conn) raceWatchCommand(a raceAsk, now time.Time) {
	e := c.e
	if c.crew.Load() {
		c.refuse(pb.WatchEnd_WATCH_END_ABOARD, "")
		return
	}
	if !c.lastWatch.IsZero() && now.Sub(c.lastWatch) < watchEvery {
		e.m.watch[watchQuick].Inc()
		c.refuse(pb.WatchEnd_WATCH_END_QUICK, "")
		return
	}
	c.lastWatch = now
	if e.cfg.WatchByID == nil {
		c.refuse(pb.WatchEnd_WATCH_END_NO_RACE, "")
		return
	}
	var id [16]byte
	if a.race == 0 {
		if e.cfg.RaceOf == nil {
			c.refuse(pb.WatchEnd_WATCH_END_NO_RACE, "")
			return
		}
		ctx, cancel := context.WithTimeout(e.ctx, WatchLookup)
		got, err := e.cfg.RaceOf(ctx, a.code)
		cancel()
		switch {
		case errors.Is(err, store.ErrNotFound):
			e.m.watch[watchAbsent].Inc()
			c.refuse(pb.WatchEnd_WATCH_END_NO_RACE, "")
			return
		case err != nil:
			e.m.watch[watchBusy].Inc()
			e.cfg.Log.Warn("looking up a race to watch", "request_id", c.reqID, "conn", c.id, "err", err)
			c.refuse(pb.WatchEnd_WATCH_END_BUSY, "")
			return
		}
		id = got
	}
	f := e.cfg.Bus.Frames.Acquire()
	i := -1
	for k := range f.Races {
		if r := &f.Races[k]; a.race != 0 && r.Key == a.race || a.race == 0 && r.ID == id && !r.Trial {
			i = k
		}
	}
	j := -1
	if i >= 0 {
		a.race = f.Races[i].Key
		if a.number > 0 {
			j = racerNumbered(f, a.race, a.number)
		} else {
			j = closestBattle(f, i)
		}
	}
	var racer bus.Account
	if j >= 0 && watchable(f, &f.Racers[j]) {
		racer, a.number = f.Racers[j].Account, f.Racers[j].Number
	} else {
		j = -1
	}
	f.Release()
	if j < 0 {
		e.m.watch[watchAbsent].Inc()
		c.refuse(pb.WatchEnd_WATCH_END_NO_RACE, "")
		return
	}
	ctx, cancel := context.WithTimeout(e.ctx, WatchLookup)
	t, err := e.cfg.WatchByID(ctx, racer)
	cancel()
	switch {
	case errors.Is(err, store.ErrNotFound):
		e.m.watch[watchAbsent].Inc()
		c.refuse(pb.WatchEnd_WATCH_END_NO_RACE, "")
		return
	case err != nil:
		e.m.watch[watchBusy].Inc()
		e.cfg.Log.Warn("looking up a racer to watch", "request_id", c.reqID, "conn", c.id, "err", err)
		c.refuse(pb.WatchEnd_WATCH_END_BUSY, "")
		return
	}
	c.watchTarget(t, &a)
}

// racerNumbered is the index in f.Racers of race key's boat of number n,
// or −1.
func racerNumbered(f *bus.Frame, key uint32, n int16) int {
	for j := range f.Racers {
		if rc := &f.Racers[j]; rc.Race == key && rc.Number == n {
			return j
		}
	}
	return -1
}

// watchable reports whether rc, a boat of a race of f, may be watched as a
// racer: on the line, racing, or home while its race is in the world.
func watchable(f *bus.Frame, rc *bus.Racer) bool {
	switch rc.State {
	case bus.RacerPlaced, bus.RacerRacing, bus.RacerFinished, bus.RacerPlacedAtEnd:
	default:
		return false
	}
	return rc.Slot >= 0 && int(rc.Slot) < len(f.Occupied) && f.Occupied[rc.Slot] && f.Boat[rc.Slot] == rc.Boat
}

// racing reports whether the boat in slot s of f races: a boat of a race
// in the world, on the line, racing, or home, not retired.
func racing(f *bus.Frame, s int32) bool {
	if s < 0 || len(f.Racers) == 0 {
		return false
	}
	for j := range f.Racers {
		if rc := &f.Racers[j]; rc.Slot == s && rc.Boat == f.Boat[s] && watchable(f, rc) {
			return true
		}
	}
	return false
}

// closestBattle is the boat of f.Races[i] the edge chooses to watch, an
// index in f.Racers, −1 for none: before the start, the first entered on
// the line; under way, the boat ahead of the two racing nearest one
// another, the front's pairs counting more; with no pair, the leader.
func closestBattle(f *bus.Frame, i int) int {
	r := &f.Races[i]
	order := committee.Standings(f, r.Key)
	if r.Phase < bus.RaceStarted {
		best := -1
		for _, j := range order {
			if rc := &f.Racers[j]; watchable(f, rc) && (best < 0 || rc.Number < f.Racers[best].Number) {
				best = j
			}
		}
		return best
	}
	var lead *bus.Racer
	best, score, first := -1, math.Inf(1), -1
	prev, prevGap := -1, 0.0
	place := 0
	for _, j := range order {
		rc := &f.Racers[j]
		if !watchable(f, rc) {
			continue
		}
		if lead == nil {
			lead = rc
		}
		if first < 0 {
			first = j
		}
		gap := committee.Gap(r, lead, rc)
		if rc.State == bus.RacerRacing && prev >= 0 && f.Racers[prev].State == bus.RacerRacing {
			// Seconds between the two, the further back the more.
			if s := (gap - prevGap) * (1 + 0.25*float64(place-1)); s < score {
				best, score = prev, s
			}
		}
		prev, prevGap = j, gap
		place++
	}
	if best < 0 {
		// One boat racing, or none: the first still racing, else the leader.
		for _, j := range order {
			if rc := &f.Racers[j]; watchable(f, rc) && rc.State == bus.RacerRacing {
				return j
			}
		}
		return first
	}
	return best
}

// bandOf is the age band of a month of birth as kept, now.
func bandOf(born int32, now time.Time) aboard.Band {
	b, ok := aboard.BornOf(born)
	if !ok {
		return aboard.Unknown
	}
	return aboard.BandOf(b, now)
}

// raceNameOf is how the boat of number n of race key is named to c, as
// the race's names were read for it: "" for not named, or not read yet.
func (c *conn) raceNameOf(key uint32, n int16) string {
	if t := c.racesTold.told[key]; t != nil {
		return t.names[n]
	}
	return ""
}

// crowds are the cheers spectators give the boats they watch, gathered
// every two seconds.
type crowds struct {
	mu sync.Mutex
	// by is each boat's spectators' latest cheers within CheerEvery, by
	// connection: the tick it counted at; fresh are the cheers since the
	// last gathering, by boat, and from whom.
	by    map[uint64]map[uint64]int64
	fresh map[uint64][]uint64
	// at is the tick of the last gathering; last what it gathered.
	at   atomic.Int64
	last atomic.Pointer[gathered]
}

// gathered is one gathering of the crowds' cheers: at tick, each boat's.
type gathered struct {
	tick  int64
	boats map[uint64]*cheered
}

// cheered is a boat's cheers in a gathering: its race and number, how
// many cheers, how many have cheered within CheerEvery, and whose they
// were, by connection.
type cheered struct {
	race   uint32
	number int16
	count  uint32
	crowd  uint32
	from   []uint64
}

// cheer counts c's cheer of the boat it watches in frame f, if it may
// cheer it now: watching a racer in a race from its warning signal until
// it ends, at most once every CheerEvery.
func (enc *encoder) cheer(c *conn, f *bus.Frame) {
	if !c.w.on {
		return
	}
	s, boat := c.w.slot, c.w.boat
	if !racing(f, s) {
		return
	}
	for j := range f.Racers {
		rc := &f.Racers[j]
		if rc.Slot != s || rc.Boat != boat {
			continue
		}
		if i := raceIndex(f, rc.Race); i < 0 || f.Races[i].Phase == bus.RaceEnded {
			return
		}
	}
	cr := &enc.e.crowd
	cr.mu.Lock()
	defer cr.mu.Unlock()
	if cr.by == nil {
		cr.by, cr.fresh = map[uint64]map[uint64]int64{}, map[uint64][]uint64{}
	}
	by := cr.by[boat]
	if by == nil {
		by = map[uint64]int64{}
		cr.by[boat] = by
	}
	if at, ok := by[c.id]; ok && f.Tick-at < CheerEvery {
		return
	}
	by[c.id] = f.Tick
	cr.fresh[boat] = append(cr.fresh[boat], c.id)
}

// gather gathers the crowds' cheers once every two seconds, by whichever
// encoder comes first with f: each boat cheered is told to the
// simulation, and the gathering kept for its racers' and spectators'
// connections to be told.
func (e *Edge) gather(f *bus.Frame) {
	cr := &e.crowd
	at := cr.at.Load()
	if f.Tick-at < pictureEvery || !cr.at.CompareAndSwap(at, f.Tick) {
		return
	}
	cr.mu.Lock()
	fresh := cr.fresh
	cr.fresh = map[uint64][]uint64{}
	g := &gathered{tick: f.Tick, boats: map[uint64]*cheered{}}
	for boat, by := range cr.by {
		for id, t := range by {
			if f.Tick-t >= CheerEvery {
				delete(by, id)
			}
		}
		if len(by) == 0 {
			delete(cr.by, boat)
		}
	}
	for boat, from := range fresh {
		g.boats[boat] = &cheered{count: uint32(len(from)), crowd: uint32(len(cr.by[boat])), from: from}
	}
	cr.mu.Unlock()
	if len(g.boats) == 0 {
		return
	}
	send := e.cfg.Bus.Commands.Server()
	for j := range f.Racers {
		rc := &f.Racers[j]
		ch := g.boats[rc.Boat]
		if ch == nil || rc.Slot < 0 || f.Boat[rc.Slot] != rc.Boat {
			continue
		}
		ch.race, ch.number = rc.Race, rc.Number
		if err := send.TrySend(bus.Command{Op: bus.RaceCheer, Account: rc.Account, Cheers: ch.count}); err != nil {
			e.cfg.Log.Warn("counting a racer's cheers", "err", err)
		}
	}
	cr.last.Store(g)
}

// cheers tells c of the cheers gathered for its eye's boat since it was
// last told: false if c has closed.
func (c *conn) cheers(boat uint64) bool {
	g := c.e.crowd.last.Load()
	cr := &c.racesTold
	if g == nil || g.tick <= cr.cheered {
		return true
	}
	cr.cheered = g.tick
	ch := g.boats[boat]
	if ch == nil || ch.race == 0 {
		return true
	}
	mine := false
	for _, id := range ch.from {
		mine = mine || id == c.id
	}
	return c.send(&pb.ServerMessage{Body: &pb.ServerMessage_RaceCheered{RaceCheered: &pb.RaceCheered{Race: ch.race,
		Number: uint32(max(ch.number, 0)), Count: ch.count, Crowd: ch.crowd, Mine: mine}}}, outRaceCheered)
}

// raceBoat is what the rule is told of the boat in slot s of f as a
// racer's: whether it races, and the age bands of its sailor, born, and
// of c's.
func (c *conn) raceBoat(f *bus.Frame, s int32, born int32, b *watch.Boat) {
	if !racing(f, s) {
		return
	}
	now := time.Now()
	b.Racing, b.Band, b.Viewer = true, bandOf(born, now), aboard.Band(c.band.Load())
}
