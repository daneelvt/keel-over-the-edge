// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/watch"
)

// Watching. A connection may watch another sailor's boat rather than sail
// its own: its eye and its snapshots' header are that boat's, and so are
// its view, its sea's window, the land's chunks, the lights, the caps and
// the bumps, with the part seen from the watched boat; its inputs steer
// nothing. It has no boat in the world and holds no place against the
// boat limit, only one against the spectator limit (spectators.go). It is
// one of three states of the one connection an account has: sailing, and
// waiting for a boat, which it may do while it watches; or, between them,
// idle, sent no snapshots.
//
// The reader looks the sailor up in the store, off the encoders, and asks
// the spectators for a place; the watch then begins on the connection's
// encoder with the next frame, which finds the boat, asks the rule again,
// takes the connection's own boat out of the water if it has one, and
// welcomes it to the watched boat. The encoder ends a watch when the boat
// leaves the water or may no longer be watched, the connection idle.

// WatchLookup is how long the store may take to find a sailor to watch.
const WatchLookup = 2 * time.Second

// watchEvery is how often a connection's watch is honoured, at most.
const watchEvery = time.Second

// watching is a connection's watch: the encoder's.
type watching struct {
	on     bool
	target watch.Target
	mine   bool
	slot   int32
	boat   uint64
}

// askKind is what a connection's reader asks of its encoder.
type askKind uint8

const (
	// askJoined: the connection's Join was answered, with r: it sails the
	// boat given, or waits in the queue for one.
	askJoined askKind = iota
	// askWatch: the connection holds a spectator's place: it watches
	// target from the next frame.
	askWatch
	// askUnwatch: the connection's watch ends, or its wait to watch.
	askUnwatch
	// askGone: the connection has ended.
	askGone
)

// ask is something a connection's reader, or the spectators, ask of its
// encoder, which does it with the next frame, in the order asked.
type ask struct {
	c      *conn
	kind   askKind
	r      bus.Reply
	target watch.Target
	// why and name, for askUnwatch: the watch ends as one asked for is
	// refused, the client told so.
	why  pb.WatchEnd
	name string
}

// ask hands the connection's encoder something to do.
func (c *conn) ask(a ask) {
	a.c = c
	c.enc.ask(a)
}

// watchCommand is a watch the client asked for: by Hello, or on an open
// connection. The sailor is looked up, the rule asked, and a place asked
// for; a refusal is told, the connection as it was.
func (c *conn) watchCommand(name string, now time.Time) {
	e := c.e
	if !c.lastWatch.IsZero() && now.Sub(c.lastWatch) < watchEvery {
		e.m.watch[watchQuick].Inc()
		c.refuse(pb.WatchEnd_WATCH_END_QUICK, name)
		return
	}
	c.lastWatch = now
	if e.cfg.Watch == nil {
		c.refuse(pb.WatchEnd_WATCH_END_NO_SAILOR, name)
		return
	}
	ctx, cancel := context.WithTimeout(e.ctx, WatchLookup)
	t, err := e.cfg.Watch(ctx, moderation.Key(name))
	cancel()
	switch {
	case errors.Is(err, store.ErrNotFound):
		e.m.watch[watchAbsent].Inc()
		c.refuse(pb.WatchEnd_WATCH_END_NO_SAILOR, name)
		return
	case err != nil:
		e.m.watch[watchBusy].Inc()
		e.cfg.Log.Warn("looking up a sailor to watch", "request_id", c.reqID, "conn", c.id, "err", err)
		c.refuse(pb.WatchEnd_WATCH_END_BUSY, name)
		return
	}
	f := e.cfg.Bus.Frames.Acquire()
	v := e.verdict(f, t, c.account)
	f.Release()
	if v != watch.Yes {
		c.refused(v, t.Name)
		return
	}
	mine := t.Mine(store.AccountID(c.account))
	granted, position, full := e.spect.take(c, t, c.priority || mine || c.queued.Load())
	switch {
	case full:
		c.closeQueueFull()
	case granted:
		c.ask(ask{kind: askWatch, target: t})
	default:
		e.m.watch[watchQueued].Inc()
		e.spect.mu.Lock()
		c.toldSpect, c.toldSpectOf = int32(position), int32(len(e.spect.queue))
		e.spect.mu.Unlock()
		c.send(spectatorPlace(int32(position), c.toldSpectOf), outQueued)
	}
}

// verdict is the rule for viewer watching t, as f has t's boat.
func (e *Edge) verdict(f *bus.Frame, t watch.Target, viewer bus.Account) watch.Verdict {
	s := findBoat(f, bus.Account(t.ID))
	t.Always = e.cfg.Allowing.Has(t.ID)
	return watch.Allowed(t, e.boatOf(f, s), store.AccountID(viewer))
}

// boatOf is what the rule is told of the boat in slot s of f, −1 for none.
func (e *Edge) boatOf(f *bus.Frame, s int32) watch.Boat {
	if s < 0 {
		return watch.Boat{}
	}
	return watch.Boat{InWater: true, Unseen: f.Unseen[s], Voyage: e.voyages.allows(f.Owner[s], f.Boat[s])}
}

// findBoat is the slot of an account's boat in f, or −1.
func findBoat(f *bus.Frame, a bus.Account) int32 {
	for _, s := range f.Live {
		if f.Owner[s] == a {
			return s
		}
	}
	return -1
}

// refusal is why a verdict refuses a watch.
func refusal(v watch.Verdict) pb.WatchEnd {
	switch v {
	case watch.Own:
		return pb.WatchEnd_WATCH_END_OWN
	case watch.NotAtSea:
		return pb.WatchEnd_WATCH_END_NOT_AT_SEA
	}
	return pb.WatchEnd_WATCH_END_CANNOT
}

// refused tells the client its watch was refused, and counts it.
func (c *conn) refused(v watch.Verdict, name string) {
	why := refusal(v)
	c.e.m.watch[watchRefused].Inc()
	c.refuse(why, name)
}

// refuse tells the client a watch it asked for is refused: one under way
// ends with it, on the encoder, which tells it after the last snapshot of
// the watch; the connection is idle unless it sails or waits for a boat.
func (c *conn) refuse(why pb.WatchEnd, name string) {
	if c.spectating.Load() {
		c.ask(ask{kind: askUnwatch, why: why, name: name})
		return
	}
	c.watchEnded(why, name)
}

// watchEnded tells the client a watch ended, or was refused.
func (c *conn) watchEnded(why pb.WatchEnd, name string) bool {
	return c.send(&pb.ServerMessage{Body: &pb.ServerMessage_WatchEnded{WatchEnded: &pb.WatchEnded{Why: why, Sailor: name}}}, outWatchEnded)
}

// unwatchCommand ends the watch, or the wait to watch: the connection is
// idle, unless it sails or waits for a boat.
func (c *conn) unwatchCommand() {
	c.e.spect.mu.Lock()
	waiting := c.wants != nil
	c.e.spect.mu.Unlock()
	if waiting {
		c.e.spect.release(c)
		return
	}
	c.ask(ask{kind: askUnwatch})
}

// sailCommand asks for a boat, as a connection that opens to sail does:
// the watch goes on until the boat is given. One that sails or waits
// already is answered nothing. False ends the connection.
func (c *conn) sailCommand() bool {
	if c.joined.Load() || c.queued.Load() {
		return true
	}
	c.e.m.join[joinSail].Inc()
	return c.join()
}

// beginWatch begins c's watch of t with frame f, asking the rule again: a
// boat the connection sails, or its account has in the water, leaves it
// at once, and the connection is welcomed to the watched boat.
func (enc *encoder) beginWatch(c *conn, f *bus.Frame, t watch.Target) {
	e := enc.e
	s := findBoat(f, bus.Account(t.ID))
	if v := e.verdict(f, t, c.account); v != watch.Yes {
		// Refused since the reader asked: a watch under way ends too.
		enc.stopWatching(c, pb.WatchEnd_WATCH_END_UNSPECIFIED)
		e.spect.release(c)
		e.m.watch[watchRefused].Inc()
		c.watchEnded(refusal(v), t.Name)
		return
	}
	switched := c.w.on
	if switched {
		enc.endWatch(c, pb.WatchEnd_WATCH_END_UNSPECIFIED, "")
		e.m.watch[watchSwitched].Inc()
	} else {
		e.m.watch[watchStarted].Inc()
	}
	enc.leaveWater(c, f)
	c.w = watching{on: true, target: t, mine: t.Mine(store.AccountID(c.account)), slot: s, boat: f.Boat[s]}
	c.spectating.Store(true)
	c.watched.Store(&t.Name)
	e.spect.watching(bus.Account(t.ID), 1)
	if !c.welcomeWatch(f) {
		return
	}
	enc.activate(c)
}

// leaveWater takes the boat the connection sails, or its account has in
// the water, out of it at once, with no grace.
func (enc *encoder) leaveWater(c *conn, f *bus.Frame) {
	e := enc.e
	boat := uint64(0)
	if c.joined.Load() {
		boat = c.boat
		c.wmu.Lock()
		c.steering, c.nheld = false, 0
		c.waiting.Store(0)
		c.wmu.Unlock()
		c.ready.Store(false)
		c.land()
		c.joined.Store(false)
	} else if s := findBoat(f, c.account); s >= 0 {
		boat = f.Boat[s]
	}
	if boat != 0 {
		e.disconnect(bus.Command{Op: bus.Leave, Boat: boat})
	}
}

// endWatch ends c's watch: it is told why, unless why is unspecified (the
// connection goes on to something else), and holds its place no longer
// unless keep; it is idle unless it sails.
func (enc *encoder) endWatch(c *conn, why pb.WatchEnd, name string) {
	if !c.w.on {
		return
	}
	e := enc.e
	e.spect.watching(bus.Account(c.w.target.ID), -1)
	c.w = watching{}
	c.spectating.Store(false)
	c.watched.Store(nil)
	if why != pb.WatchEnd_WATCH_END_UNSPECIFIED {
		switch why {
		case pb.WatchEnd_WATCH_END_LEFT:
			e.m.watch[watchEndedLeft].Inc()
		case pb.WatchEnd_WATCH_END_OFF:
			e.m.watch[watchEndedOff].Inc()
		default:
			e.m.watch[watchEndedUnseen].Inc()
		}
		c.watchEnded(why, name)
	}
}

// stillWatchable is why c's watch of the boat in slot s of f must end, or
// unspecified while it may go on: its sailor no longer allows spectators,
// or the owner's tools keep it unseen.
func (enc *encoder) stillWatchable(c *conn, f *bus.Frame, s int32) pb.WatchEnd {
	t := &c.w.target
	if c.w.mine || t.Machine() && !f.Unseen[s] {
		return pb.WatchEnd_WATCH_END_UNSPECIFIED
	}
	if f.Unseen[s] {
		return pb.WatchEnd_WATCH_END_CANNOT
	}
	if !enc.e.cfg.Allowing.Has(t.ID) && !enc.e.voyages.allows(f.Owner[s], f.Boat[s]) {
		return pb.WatchEnd_WATCH_END_OFF
	}
	return pb.WatchEnd_WATCH_END_UNSPECIFIED
}

// welcomeWatch queues the Welcome to the watched boat, from the frame the
// watch begins with: the snapshots start afresh, in full, about it.
func (c *conn) welcomeWatch(f *bus.Frame) bool {
	e := c.e
	s := c.w.slot
	wt, _ := e.cfg.Clock.WorldTime()
	c.rmu.Lock()
	ok := c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Welcome{Welcome: &pb.Welcome{
		World: e.cfg.World, Tick: f.Tick, WorldTimeUs: wt.Microseconds(),
		Boat: c.w.boat, Kind: uint32(f.Kind[s]),
		EpochUs: e.cfg.Epoch.UnixMicro(), Land: e.cfg.Land, Circulation: e.cfg.Circulation,
		Tools: c.tools.Load(), Light: e.cfg.MainLight, EndsUs: e.endsUs.Load(), ClosingUs: e.closingUs.Load(), Zone: e.cfg.Zone,
		Watching: &pb.Watching{Sailor: c.w.target.Name, Machine: c.w.target.Machine(), Mine: c.w.mine},
	}}}, outWelcome)
	ok = ok && c.firstChart()
	c.rmu.Unlock()
	c.box.restart()
	c.bumped = f.Tick
	return ok && c.chunks(e.cfg.Chunks, f.State[s].X, f.State[s].Y)
}

// eyeSlot is the slot and boat of f a connection's snapshots are about:
// the boat it watches, or its own.
func (c *conn) eyeSlot() (int32, uint64) {
	if c.w.on {
		return c.w.slot, c.w.boat
	}
	return c.slot, c.boat
}

// marginOf is the margin a snapshot carries: none for a spectator, whose
// inputs steer nothing.
func (c *conn) marginNow() int16 {
	if c.w.on {
		return protocol.NoMargin
	}
	return c.margin.take()
}

// watchersEvery is how often a sailor is told how many watch, at most.
const watchersEvery = 60 // ticks

// tellWatchers tells a sailing connection how many watch its boat, if it
// has changed.
func (c *conn) tellWatchers() {
	n := c.e.spect.count(c.account)
	if n == c.toldWatchers {
		return
	}
	c.toldWatchers = n
	c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Watchers{Watchers: &pb.Watchers{Count: uint32(n)}}}, outWatchers)
}

// voyages are the human sailors who allow spectators for this voyage
// only: held with the boat, never stored, and over when the boat leaves
// the water. A boat that goes over the lip and starts again is the same
// boat, on the same voyage as far as this goes.
type voyages struct {
	mu sync.Mutex
	// m is each account's boat it allows for; 0 for its next, not yet in
	// the water.
	m map[bus.Account]uint64
}

// allows reports whether the account allows spectators for the voyage of
// boat.
func (v *voyages) allows(a bus.Account, boat uint64) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	b, ok := v.m[a]
	return ok && b == boat && boat != 0
}

// sails says the account's boat is in the water: a choice made for its
// next voyage is this one's.
func (v *voyages) sails(a bus.Account, boat uint64) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if b, ok := v.m[a]; ok && b == 0 {
		v.m[a] = boat
	}
}

// SetVoyage says whether an account allows spectators for this voyage
// only: the voyage of its boat in the water, or, with none, of its next.
func (e *Edge) SetVoyage(a bus.Account, on bool) {
	v := &e.voyages
	if !on {
		v.mu.Lock()
		delete(v.m, a)
		v.mu.Unlock()
		return
	}
	f := e.cfg.Bus.Frames.Acquire()
	boat := uint64(0)
	if s := findBoat(f, a); s >= 0 {
		boat = f.Boat[s]
	}
	f.Release()
	v.mu.Lock()
	v.m[a] = boat
	v.mu.Unlock()
}

// Voyage reports whether an account allows spectators for this voyage
// only: its boat's in the water, or its next if it has none.
func (e *Edge) Voyage(a bus.Account) bool {
	v := &e.voyages
	v.mu.Lock()
	b, ok := v.m[a]
	v.mu.Unlock()
	if !ok {
		return false
	}
	f := e.cfg.Bus.Frames.Acquire()
	defer f.Release()
	s := findBoat(f, a)
	if b == 0 {
		return true
	}
	if s < 0 || f.Boat[s] != b {
		// That voyage is over.
		v.mu.Lock()
		if v.m[a] == b {
			delete(v.m, a)
		}
		v.mu.Unlock()
		return false
	}
	return true
}

// VoyageAllows reports whether an account allows spectators for the
// voyage of boat.
func (e *Edge) VoyageAllows(a bus.Account, boat uint64) bool { return e.voyages.allows(a, boat) }

// Watching is whose boat an account's connection watches, if it watches
// one: the sailor's name.
func (e *Edge) Watching(a bus.Account) (string, bool) {
	c := e.registry.get(a)
	if c == nil {
		return "", false
	}
	p := c.watched.Load()
	if p == nil {
		return "", false
	}
	return *p, true
}
