// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"context"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// Aboard: a connection let aboard another sailor's boat is encoded as a
// spectator of it is, its eye the boat's, and welcomed to it with the
// Welcome's aboard. Each frame its encoder reads who holds the boat's
// controls: the connection steers the boat only while it does, with the
// slot's generation of that frame, and so does its skipper's. When it is
// no longer aboard (it went ashore, was put ashore, or the boat left the
// water) it is told why, then welcomed to its own boat at the nearest port,
// or told its place in the queue.

// aboardWelcome welcomes c, just let aboard or back aboard, to the boat in
// slot s of f, from that frame on.
func (enc *encoder) aboardWelcome(c *conn, f *bus.Frame, s int32, skipper string) {
	e := enc.e
	if c.w.on {
		enc.endWatch(c, pb.WatchEnd_WATCH_END_UNSPECIFIED, "")
		e.spect.release(c)
	}
	if c.queued.Load() {
		enc.unqueue(c)
		c.queued.Store(false)
	}
	if c.joined.Load() {
		// Its boat has left the water: the simulation took it out.
		c.wmu.Lock()
		c.steering, c.nheld = false, 0
		c.waiting.Store(0)
		c.wmu.Unlock()
		c.ready.Store(false)
		c.land()
		c.joined.Store(false)
	}
	i := -1
	lo, hi := f.CrewOf(s)
	for j := lo; j < hi; j++ {
		if f.Crew[j].Account == c.account {
			i = j
		}
	}
	if i < 0 {
		// Gone ashore again before this frame.
		c.active = false
		return
	}
	a := &f.Crew[i]
	c.wmu.Lock()
	c.slot, c.gen, c.boat, c.rejoined, c.joinTick = s, f.Gen[s], a.Boat, false, f.Tick
	c.steering = false
	c.wmu.Unlock()
	c.holding, c.seat = false, a.Seat
	c.crew.Store(true)
	c.toldDeck, c.toldCrew = [2]uint64{}, false
	c.toldWatchers = 0
	c.toldLook = f.Look[s]
	c.toldBoat(f, s)
	if skipper == "" {
		skipper = e.decks.name(f.Owner[s])
	}
	wt, _ := e.cfg.Clock.WorldTime()
	c.rmu.Lock()
	ok := c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Welcome{Welcome: &pb.Welcome{
		World: e.cfg.World, Tick: f.Tick, WorldTimeUs: wt.Microseconds(),
		Boat: a.Boat, Kind: uint32(f.Kind[s]), Look: c.toldLook, BoatLook: c.toldBoatLook, BoatName: c.toldBoatName,
		EpochUs: e.cfg.Epoch.UnixMicro(), Land: e.cfg.Land, Circulation: e.cfg.Circulation, Harbour: e.cfg.Harbour,
		Tools: c.tools.Load(), Light: e.cfg.MainLight, EndsUs: e.endsUs.Load(), ClosingUs: e.closingUs.Load(), Zone: e.cfg.Zone,
		Aboard: &pb.Aboard{Skipper: skipper, Look: f.Look[s], Seat: uint32(a.Seat)},
	}}}, outWelcome)
	ok = ok && c.firstChart()
	c.rmu.Unlock()
	c.ready.Store(ok)
	c.box.restart()
	c.bumped = f.Tick
	if !ok || !c.chunks(e.cfg.Chunks, f.State[s].X, f.State[s].Y) {
		return
	}
	enc.hands(c, f)
	enc.activate(c)
}

// hands has c steer the boat it sails or is aboard while it holds its
// controls in f, with the slot's generation, and not while it does not;
// and a connection aboard that is aboard no longer goes ashore.
func (enc *encoder) hands(c *conn, f *bus.Frame) {
	s := c.slot
	if !f.Occupied[s] || f.Boat[s] != c.boat {
		if c.crew.Load() {
			enc.ashore(c, f)
		}
		return
	}
	var holds bool
	if c.crew.Load() {
		in := false
		lo, hi := f.CrewOf(s)
		for i := lo; i < hi; i++ {
			if f.Crew[i].Account == c.account {
				in = true
				c.seat = f.Crew[i].Seat
			}
		}
		if !in {
			enc.ashore(c, f)
			return
		}
		holds = f.Holder[s] == c.account
	} else {
		holds = f.Holder[s] == (bus.Account{})
	}
	if holds == c.holding && (!holds || c.gen == f.Gen[s]) {
		return
	}
	c.holding = holds
	c.wmu.Lock()
	c.gen = f.Gen[s]
	c.steering = holds
	if !holds {
		c.nheld = 0
		c.waiting.Store(0)
	}
	c.wmu.Unlock()
}

// ashore takes c, aboard a boat no longer, ashore: it is told why, then
// welcomed to its own boat, put in the water at the nearest port, or told
// its place in the queue; with neither, it is idle.
func (enc *encoder) ashore(c *conn, f *bus.Frame) {
	e := enc.e
	why := pb.AshoreWhy_ASHORE_WHY_UNSPECIFIED
	for i := range f.Events {
		ev := &f.Events[i]
		if ev.Op != bus.Ashore || ev.Account != c.account {
			continue
		}
		switch ev.Why {
		case bus.AshoreChose:
			why = pb.AshoreWhy_ASHORE_WHY_CHOSE
			e.m.deck[deckAshoreChose].Inc()
		case bus.AshorePut:
			why = pb.AshoreWhy_ASHORE_WHY_PUT
			e.m.deck[deckAshorePut].Inc()
		case bus.AshoreLeft:
			why = pb.AshoreWhy_ASHORE_WHY_LEFT
			e.m.deck[deckAshoreLeft].Inc()
		}
	}
	c.crew.Store(false)
	c.wmu.Lock()
	c.steering, c.nheld = false, 0
	c.waiting.Store(0)
	c.wmu.Unlock()
	c.ready.Store(false)
	c.holding = false
	c.toldCrew = false
	c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Ashore{Ashore: &pb.Ashore{Why: why}}}, outAshore)
	for _, s := range f.Live {
		if f.Owner[s] == c.account && f.Conn[s] == c.id {
			c.wmu.Lock()
			c.slot, c.gen, c.boat, c.rejoined, c.joinTick = s, f.Gen[s], f.Boat[s], false, f.Tick
			c.wmu.Unlock()
			c.joined.Store(true)
			enc.sail(c, f)
			return
		}
	}
	for i := range f.Queue {
		if f.Queue[i].Account == c.account && f.Queue[i].Conn == c.id {
			c.queued.Store(true)
			enc.queued[c.id] = c
			e.m.queuedConns.Inc()
			pos, _ := bus.QueuePlace(f.Queue, i)
			c.place(pos, humansWaiting(f))
			c.active = false
			return
		}
	}
	c.active = false
}

// crewOf tells c who is aboard the boat in slot s of f, its eye's, if that
// has changed since it was last told: names only to those aboard it, and
// nothing to the sailor of a boat with nobody else aboard, unless they
// were told of someone before.
func (c *conn) crewOf(f *bus.Frame, s int32) bool {
	told := [2]uint64{f.Boat[s], uint64(f.Deck[s])}
	if told == c.toldDeck && !c.recrew.Load() {
		return true
	}
	c.recrew.Store(false)
	c.toldDeck = told
	lo, hi := f.CrewOf(s)
	if lo == hi && !c.toldCrew {
		return true
	}
	c.toldCrew = lo < hi
	named := !c.w.on
	var ties *aboard.Ties
	if c.e.cfg.Chat != nil && named {
		ties = c.e.cfg.Chat.Rules.Ties
	}
	tie := func(p *pb.Person, a bus.Account) {
		if ties != nil && !p.You {
			p.Muted, p.Blocked = ties.Mutes(c.account, a), ties.Blocked(c.account, a)
		}
	}
	holder := uint32(0)
	people := make([]*pb.Person, 0, hi-lo+1)
	skipper := &pb.Person{Seat: 0, Look: f.Look[s], Machine: f.Machine[s], You: !c.w.on && !c.crew.Load()}
	if named {
		skipper.Name = c.e.decks.name(f.Owner[s])
	}
	tie(skipper, f.Owner[s])
	people = append(people, skipper)
	for _, a := range f.Crew[lo:hi] {
		p := &pb.Person{Seat: uint32(a.Seat), Look: a.Look, Machine: a.Machine, You: !c.w.on && a.Account == c.account}
		if named {
			p.Name = a.Name
		}
		tie(p, a.Account)
		if f.Holder[s] == a.Account {
			holder = uint32(a.Seat)
		}
		people = append(people, p)
	}
	if !c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Crew{Crew: &pb.Crew{People: people, Holder: holder}}}, outCrew) {
		return false
	}
	// Those aboard, and an owner watching their machine sailor, are told
	// how chat stands for them with each change aboard.
	if named || c.w.mine {
		return c.chatState(true)
	}
	return true
}

// joinedAboard is a Join answered with the connection aboard a boat, as
// after a restart or a dropped connection: the skipper's name looked up if
// the edge has forgotten it, then the encoder welcomes it aboard.
func (c *conn) joinedAboard(r bus.Reply) {
	e := c.e
	f := e.cfg.Bus.Frames.Acquire()
	var skipper bus.Account
	if f.Occupied[r.Slot] && f.Boat[r.Slot] == r.Boat {
		skipper = f.Owner[r.Slot]
	}
	f.Release()
	name := e.decks.name(skipper)
	if name == "" && e.cfg.Knocker != nil && skipper != (bus.Account{}) {
		ctx, cancel := context.WithTimeout(e.ctx, DeckLookup)
		if k, err := e.cfg.Knocker(ctx, skipper); err == nil {
			name = k.Name
			e.decks.knowName(skipper, name)
		}
		cancel()
	}
	c.boarded.Store(true)
	c.ask(ask{kind: askAboard, r: r, name: name})
}

// noMoreAboard is the end of a connection that was let aboard: the
// simulation is told by its account, whatever the edge saw of it, so its
// grace aboard begins.
func (c *conn) noMoreAboard() {
	if c.boarded.Load() {
		c.e.disconnect(bus.Command{Op: bus.Disconnect, Account: c.account, Conn: c.id})
	}
}

// Aboard counts those aboard boats not their own, for the metrics, once a
// second.
func (e *Edge) countAboard(ctx context.Context) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		f := e.cfg.Bus.Frames.Acquire()
		e.m.aboard.Set(float64(len(f.Crew)))
		f.Release()
	}
}
