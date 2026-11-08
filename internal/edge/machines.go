// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"context"
	"errors"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Machine sailors and sailing together. No machine sailor's boat takes a
// person aboard but its owner, who comes aboard without knocking: the
// boat is theirs. The owner comes aboard from watching it (ComeAboard),
// and is crew there as anyone let aboard is; chat's rule lets their lines
// and their machine sailor's reach each other.

// comeAboardCommand brings the connection's account aboard the boat of
// the machine sailor of its own that it watches, as crew. It is told how
// it stands as a knocker is.
func (c *conn) comeAboardCommand() {
	e := c.e
	name := c.watched.Load()
	if !c.spectating.Load() || name == nil || e.cfg.Watch == nil || e.cfg.Knocker == nil {
		c.knocked(pb.KnockState_KNOCK_STATE_CLOSED, "", 0, "")
		return
	}
	ctx, cancel := context.WithTimeout(e.ctx, DeckLookup)
	defer cancel()
	t, err := e.cfg.Watch(ctx, moderation.Key(*name))
	switch {
	case errors.Is(err, store.ErrNotFound):
		c.knocked(pb.KnockState_KNOCK_STATE_NOT_AT_SEA, *name, 0, "")
		return
	case err != nil:
		c.knocked(pb.KnockState_KNOCK_STATE_TRY_AGAIN, *name, 0, "")
		return
	case !t.Mine(store.AccountID(c.account)):
		// Nobody but its owner comes aboard a machine sailor's boat.
		c.knocked(pb.KnockState_KNOCK_STATE_CLOSED, t.Name, 0, "")
		return
	}
	who, err := e.cfg.Knocker(ctx, c.account)
	if err != nil {
		c.knocked(pb.KnockState_KNOCK_STATE_TRY_AGAIN, t.Name, 0, "")
		return
	}
	if !mayBoard(who, time.Now()) {
		c.knocked(pb.KnockState_KNOCK_STATE_FIRST, t.Name, 0, "")
		return
	}
	f := e.cfg.Bus.Frames.Acquire()
	s := findBoat(f, bus.Account(t.ID))
	var kn knock
	state := pb.KnockState_KNOCK_STATE_UNSPECIFIED
	if s < 0 {
		// Not in the water, or aboard another's boat: its owner comes
		// aboard only its own.
		state = pb.KnockState_KNOCK_STATE_NOT_AT_SEA
	} else {
		kn = knock{boat: f.Boat[s], skipper: f.Owner[s], by: c, name: who.Name, look: who.Look, skipperName: t.Name,
			kind: f.Kind[s], boatName: f.BoatName[s]}
		state = e.roomAboard(f, s)
	}
	f.Release()
	if state != pb.KnockState_KNOCK_STATE_UNSPECIFIED {
		c.knocked(state, t.Name, kn.kind, kn.boatName)
		return
	}
	e.decks.knowName(kn.skipper, t.Name)
	e.decks.knowName(c.account, who.Name)
	c.board(&kn)
}

// roomAboard is why the boat in slot s of f takes nobody more aboard, or
// unspecified while it may: boarding on for everyone, room aboard, and the
// crews across the world under their limit.
func (e *Edge) roomAboard(f *bus.Frame, s int32) pb.KnockState {
	if e.cfg.Switches != nil && !e.cfg.Switches.Boarding() {
		return pb.KnockState_KNOCK_STATE_CLOSED
	}
	lo, hi := f.CrewOf(s)
	if hi-lo+1 >= e.capacityOf(f.Kind[s]) {
		return pb.KnockState_KNOCK_STATE_FULL
	}
	if len(f.Crew) >= e.crewLimit() {
		return pb.KnockState_KNOCK_STATE_CROWDED
	}
	return pb.KnockState_KNOCK_STATE_UNSPECIFIED
}

// Machines are the machine sailors' helms, as sailing together reaches
// them.
type Machines interface {
	// Board brings a machine sailor aboard boat through its helm, its own
	// boat leaving the water, and returns the simulation's answer; an
	// error for one whose helm is not at sea.
	Board(ctx context.Context, machine bus.Account, boat uint64) (bus.Reply, error)
	// Handed tells a machine sailor's agent the controls are offered it by
	// from, or that the offer stands no longer.
	Handed(machine bus.Account, from string, gone bool)
}

// Machine sailors aboard each other's boats. A machine sailor's owner
// makes its link; another player, opening it, sends a machine sailor of
// theirs aboard (Knock.machine), which knocks as a person does, but the
// knock is answered by the skipper machine sailor's owner, wherever they
// are in the game, never by its agent; with no connection of theirs in
// the game, it lapses. Let aboard, the machine sailor's helm sends Board
// and its own boat leaves the water. The token never passes through an
// agent.

// machineKnock is a knock by a link's token, sending the connection's
// account's machine sailor named machine aboard.
func (c *conn) machineKnock(token, machine string, now time.Time) {
	e := c.e
	if e.cfg.Link == nil || e.cfg.Knocker == nil || e.cfg.Watch == nil || e.cfg.Machines == nil {
		c.knockedAs(machine, pb.KnockState_KNOCK_STATE_ENDED, "", 0, "")
		return
	}
	if !c.knockAllowed(now) {
		c.knockedAs(machine, pb.KnockState_KNOCK_STATE_OFTEN, "", 0, "")
		return
	}
	hash, err := aboard.TokenHash(token)
	if err != nil {
		c.knockedAs(machine, pb.KnockState_KNOCK_STATE_ENDED, "", 0, "")
		return
	}
	ctx, cancel := context.WithTimeout(e.ctx, DeckLookup)
	defer cancel()
	l, err := e.cfg.Link(ctx, hash)
	switch {
	case errors.Is(err, store.ErrNotFound):
		c.knockedAs(machine, pb.KnockState_KNOCK_STATE_ENDED, "", 0, "")
		return
	case err != nil:
		e.cfg.Log.Warn("looking up a link to come aboard", "request_id", c.reqID, "conn", c.id, "err", err)
		c.knockedAs(machine, pb.KnockState_KNOCK_STATE_TRY_AGAIN, "", 0, "")
		return
	}
	sw := e.cfg.Switches
	if sw != nil && (!sw.Links() || !aboard.Live(l.Made, l.Expires, l.Ended, sw.Lifetime(), now)) || sw == nil && l.Ended {
		c.knockedAs(machine, pb.KnockState_KNOCK_STATE_ENDED, l.Name, 0, "")
		return
	}
	if !l.Machine {
		// No machine sailor comes aboard a person's boat.
		c.knockedAs(machine, pb.KnockState_KNOCK_STATE_CLOSED, l.Name, 0, "")
		return
	}
	t, err := e.cfg.Watch(ctx, moderation.Key(machine))
	switch {
	case errors.Is(err, store.ErrNotFound) || err == nil && !t.Mine(store.AccountID(c.account)):
		c.knockedAs(machine, pb.KnockState_KNOCK_STATE_CLOSED, l.Name, 0, "")
		return
	case err != nil:
		c.knockedAs(machine, pb.KnockState_KNOCK_STATE_TRY_AGAIN, l.Name, 0, "")
		return
	}
	m := bus.Account(t.ID)
	if l.Skipper == m {
		c.knockedAs(t.Name, pb.KnockState_KNOCK_STATE_OWN, l.Name, 0, "")
		return
	}
	who, err := e.cfg.Knocker(ctx, c.account)
	if err != nil {
		c.knockedAs(t.Name, pb.KnockState_KNOCK_STATE_TRY_AGAIN, l.Name, 0, "")
		return
	}
	// The owner answers for their machine sailor: their age and the Rules.
	if !mayBoard(who, now) {
		c.knockedAs(t.Name, pb.KnockState_KNOCK_STATE_FIRST, l.Name, 0, "")
		return
	}
	if who.Rested {
		c.knockedAs(t.Name, pb.KnockState_KNOCK_STATE_CLOSED, l.Name, 0, "")
		return
	}
	f := e.cfg.Bus.Frames.Acquire()
	s := findBoat(f, l.Skipper)
	kn := &knock{skipper: l.Skipper, by: c, name: t.Name, skipperName: l.Name, approver: l.Owner, machine: m, ownerName: who.Name}
	state := e.machineBoardable(f, s, m, c.account, l.Owner)
	if s >= 0 {
		kn.boat, kn.kind, kn.boatName = f.Boat[s], f.Kind[s], f.BoatName[s]
	}
	switch at := whereMachine(f, m); {
	case state != pb.KnockState_KNOCK_STATE_UNSPECIFIED:
	case at < 0:
		state = pb.KnockState_KNOCK_STATE_AWAY
	case at == s && findBoat(f, m) < 0:
		state = pb.KnockState_KNOCK_STATE_LET
	default:
		kn.look = f.Look[at]
		if i := f.Aboard(m); i >= 0 {
			kn.look = f.Crew[i].Look
		}
	}
	f.Release()
	if state != pb.KnockState_KNOCK_STATE_UNSPECIFIED {
		kn.tell(state)
		return
	}
	d := &e.decks
	d.mu.Lock()
	e.tidyDecks(now)
	k := d.deckOf(kn.boat, l.Skipper)
	switch {
	case k.closed || k.put[m]:
		state = pb.KnockState_KNOCK_STATE_CLOSED
	case now.Before(d.notNow[notNowKey{m, kn.boat}]):
		state = pb.KnockState_KNOCK_STATE_OFTEN
	case len(k.knocks) >= KnocksWaiting:
		state = pb.KnockState_KNOCK_STATE_BUSY
	}
	if state != pb.KnockState_KNOCK_STATE_UNSPECIFIED {
		d.mu.Unlock()
		kn.tell(state)
		return
	}
	old := d.knocking[c]
	if old != nil {
		e.dropKnock(old)
	}
	d.next++
	kn.id = d.next
	k.knocks = append(k.knocks, kn)
	d.knocks[kn.id] = kn
	d.knocking[c] = kn
	kn.timer = time.AfterFunc(KnockLapse, func() { e.lapse(kn) })
	d.mu.Unlock()
	if old != nil {
		if sk := e.registry.get(old.approver); sk != nil {
			sk.card(old, true)
		}
	}
	d.knowName(l.Skipper, l.Name)
	d.knowName(m, t.Name)
	kn.tell(pb.KnockState_KNOCK_STATE_WAITING)
	// The skipper machine sailor's owner is shown it wherever they are in
	// the game: sailing, watching, or idle.
	if ap := e.registry.get(l.Owner); ap != nil {
		ap.card(kn, false)
	}
}

// knockAllowed counts a knock against the account's hour, and reports
// whether it is within it.
func (c *conn) knockAllowed(now time.Time) bool {
	d := &c.e.decks
	d.mu.Lock()
	defer d.mu.Unlock()
	ts := d.hour[c.account]
	for len(ts) > 0 && now.Sub(ts[0]) > time.Hour {
		ts = ts[1:]
	}
	if len(ts) >= KnocksAnHour {
		d.hour[c.account] = ts
		return false
	}
	d.hour[c.account] = append(ts, now)
	return true
}

// whereMachine is the slot of the boat a machine sailor sails or is
// aboard in f, −1 for none.
func whereMachine(f *bus.Frame, m bus.Account) int32 {
	if s := findBoat(f, m); s >= 0 {
		return s
	}
	if i := f.Aboard(m); i >= 0 {
		return f.Crew[i].Slot
	}
	return -1
}

// machineBoardable is why the boat in slot s of f takes no machine sailor
// m of owner's aboard, its skipper's owner skipperOwner, or unspecified
// while it may: in the water, a machine sailor's, nothing between the two
// nor their owners, and room aboard.
func (e *Edge) machineBoardable(f *bus.Frame, s int32, m, owner, skipperOwner bus.Account) pb.KnockState {
	switch {
	case s < 0:
		return pb.KnockState_KNOCK_STATE_NOT_AT_SEA
	case !f.Machine[s]:
		return pb.KnockState_KNOCK_STATE_CLOSED
	case e.refuses(f.Owner[s], m) || e.refuses(skipperOwner, owner):
		return pb.KnockState_KNOCK_STATE_CLOSED
	}
	return e.roomAboard(f, s)
}

// boardMachine brings the machine sailor of a knock let aboard aboard,
// through its helm, and tells its owner's connection how it went.
func (e *Edge) boardMachine(kn *knock) {
	f := e.cfg.Bus.Frames.Acquire()
	s := findBoat(f, kn.skipper)
	state := e.machineBoardable(f, s, kn.machine, kn.by.account, kn.approver)
	if state == pb.KnockState_KNOCK_STATE_UNSPECIFIED && f.Boat[s] != kn.boat {
		state = pb.KnockState_KNOCK_STATE_NOT_AT_SEA
	}
	f.Release()
	if state != pb.KnockState_KNOCK_STATE_UNSPECIFIED {
		kn.tell(state)
		return
	}
	ctx, cancel := context.WithTimeout(e.ctx, e.lim.Join)
	defer cancel()
	r, err := e.cfg.Machines.Board(ctx, kn.machine, kn.boat)
	switch {
	case err != nil:
		kn.tell(pb.KnockState_KNOCK_STATE_AWAY)
	case r.Result == bus.Crewed:
		e.m.deck[deckArrived].Inc()
		e.decks.knowName(kn.skipper, kn.skipperName)
		e.decks.knowName(kn.machine, kn.name)
		kn.tell(pb.KnockState_KNOCK_STATE_LET)
	case r.Result == bus.NoRoom:
		kn.tell(pb.KnockState_KNOCK_STATE_FULL)
	default:
		kn.tell(pb.KnockState_KNOCK_STATE_NOT_AT_SEA)
	}
}

// nameOf is a sailor's name as the edge or chat knows it, "" for neither.
func (e *Edge) nameOf(a bus.Account) string {
	if n := e.decks.name(a); n != "" {
		return n
	}
	if e.cfg.Chat != nil {
		return e.cfg.Chat.Name(a)
	}
	return ""
}

// handsOn is boat's company in f as account stands to it: false if the
// boat is not in the water or account is not aboard it.
func handsOn(f *bus.Frame, boat uint64, account bus.Account) (hands, bool) {
	for _, s := range f.Live {
		if f.Boat[s] != boat {
			continue
		}
		h := hands{slot: s, boat: boat, skipper: f.Owner[s], holder: f.Holder[s], mine: f.Owner[s] == account}
		if h.mine {
			return h, true
		}
		lo, hi := f.CrewOf(s)
		for _, a := range f.Crew[lo:hi] {
			if a.Account == account {
				return h, true
			}
		}
		return h, false
	}
	return hands{}, false
}

// Hand offers boat's controls from from, who holds them, to to, aboard
// it, as the game connection's Hand does: a machine sailor's agent's.
// False if from does not hold them or to is not aboard.
func (e *Edge) Hand(boat uint64, from, to bus.Account) bool {
	f := e.cfg.Bus.Frames.Acquire()
	h, ok := handsOn(f, boat, from)
	var name string
	machine := false
	if ok && h.holds(from) && to != from {
		ok = false
		if to == h.skipper {
			ok, machine = true, f.Machine[h.slot]
		}
		lo, hi := f.CrewOf(h.slot)
		for _, a := range f.Crew[lo:hi] {
			if a.Account == to {
				ok, machine = true, a.Machine
			}
			if a.Account == from {
				name = a.Name
			}
		}
	} else {
		ok = false
	}
	f.Release()
	if !ok {
		return false
	}
	if name == "" {
		name = e.nameOf(from)
	}
	e.offerControls(boat, h.skipper, name, to, machine)
	return true
}

// Take has account take boat's controls offered it, or, its skipper, take
// them back at once, as the game connection's Take does; it reports
// whether they moved.
func (e *Edge) Take(boat uint64, account bus.Account) bool {
	f := e.cfg.Bus.Frames.Acquire()
	h, ok := handsOn(f, boat, account)
	f.Release()
	return ok && e.takeControls(h, account)
}

// PutAshore puts who ashore from boat, by its skipper, for the rest of
// its voyage: they knock on it in vain until it leaves the water. It
// reports whether they were aboard.
func (e *Edge) PutAshore(boat uint64, skipper, who bus.Account) bool {
	f := e.cfg.Bus.Frames.Acquire()
	h, ok := handsOn(f, boat, skipper)
	in := false
	if ok && h.mine {
		lo, hi := f.CrewOf(h.slot)
		for _, a := range f.Crew[lo:hi] {
			in = in || a.Account == who
		}
	}
	f.Release()
	if !in {
		return false
	}
	e.putAshore(boat, skipper, who)
	return true
}

// putAshore keeps who off boat for its voyage, and sends them ashore.
func (e *Edge) putAshore(boat uint64, skipper, who bus.Account) {
	d := &e.decks
	d.mu.Lock()
	k := d.deckOf(boat, skipper)
	if k.put == nil {
		k.put = map[bus.Account]bool{}
	}
	k.put[who] = true
	d.mu.Unlock()
	e.disconnect(bus.Command{Op: bus.Ashore, Account: who, Boat: boat, Why: bus.AshorePut})
}

// CallAshore calls a machine sailor ashore from the boat it is aboard, by
// its owner (the caller's to check): its own boat goes in the water at the
// nearest port. It reports whether it was aboard one.
func (e *Edge) CallAshore(machine store.AccountID) bool {
	f := e.cfg.Bus.Frames.Acquire()
	i := f.Aboard(bus.Account(machine))
	var boat uint64
	if i >= 0 {
		boat = f.Crew[i].Boat
	}
	f.Release()
	if i < 0 {
		return false
	}
	e.disconnect(bus.Command{Op: bus.Ashore, Account: bus.Account(machine), Boat: boat, Why: bus.AshoreChose})
	return true
}

// Aboard reports whether an account is aboard a boat not its own.
func (e *Edge) Aboard(id store.AccountID) bool {
	f := e.cfg.Bus.Frames.Acquire()
	defer f.Release()
	return f.Aboard(bus.Account(id)) >= 0
}

// MachineCan says whether owner's machine sailor machine may be sent
// aboard skipper's boat now, as a knock would answer: "ok", or
// "not-at-sea" (the boat), "away" (the machine sailor not in the water),
// "aboard" (aboard her already), "full", "closed" or "own"; skipperOwner
// is the skipper machine sailor's owner. The link and its lifetime are
// the caller's to check.
func (e *Edge) MachineCan(skipper, skipperOwner, machine, owner store.AccountID) string {
	if skipper == machine {
		return "own"
	}
	f := e.cfg.Bus.Frames.Acquire()
	s := findBoat(f, bus.Account(skipper))
	m := bus.Account(machine)
	state := e.machineBoardable(f, s, m, bus.Account(owner), bus.Account(skipperOwner))
	var boat uint64
	if s >= 0 {
		boat = f.Boat[s]
	}
	at := whereMachine(f, m)
	own := findBoat(f, m) >= 0
	f.Release()
	switch {
	case state != pb.KnockState_KNOCK_STATE_UNSPECIFIED:
	case at < 0:
		return "away"
	case at == s && !own:
		return "aboard"
	default:
		d := &e.decks
		d.mu.Lock()
		if k := d.by[boat]; k != nil && (k.closed || k.put[m]) {
			state = pb.KnockState_KNOCK_STATE_CLOSED
		}
		d.mu.Unlock()
	}
	switch state {
	case pb.KnockState_KNOCK_STATE_UNSPECIFIED:
		return "ok"
	case pb.KnockState_KNOCK_STATE_NOT_AT_SEA:
		return "not-at-sea"
	case pb.KnockState_KNOCK_STATE_FULL, pb.KnockState_KNOCK_STATE_CROWDED:
		return "full"
	}
	return "closed"
}

// ownSkipper is the boat of the connection's own machine sailor it
// watches, if that machine sailor is its boat's skipper: what its owner
// commands from watching it.
func (c *conn) ownSkipper() (h hands, ok bool) {
	e := c.e
	name := c.watched.Load()
	if !c.spectating.Load() || name == nil || e.cfg.Watch == nil {
		return h, false
	}
	ctx, cancel := context.WithTimeout(e.ctx, DeckLookup)
	defer cancel()
	t, err := e.cfg.Watch(ctx, moderation.Key(*name))
	if err != nil || !t.Mine(store.AccountID(c.account)) {
		return h, false
	}
	f := e.cfg.Bus.Frames.Acquire()
	defer f.Release()
	s := findBoat(f, bus.Account(t.ID))
	if s < 0 {
		return h, false
	}
	return hands{slot: s, boat: f.Boat[s], skipper: f.Owner[s], holder: f.Holder[s]}, true
}

// ownerAshore is a watching owner putting the person in seat who ashore
// from their machine sailor's boat.
func (c *conn) ownerAshore(who uint32) {
	e := c.e
	h, ok := c.ownSkipper()
	if !ok || who == 0 {
		return
	}
	f := e.cfg.Bus.Frames.Acquire()
	target, _, found := e.personAt(f, h.slot, who)
	f.Release()
	if found {
		e.putAshore(h.boat, h.skipper, target)
	}
}

// ownerCloses is a watching owner closing their machine sailor's boat to
// knocks, or opening it.
func (c *conn) ownerCloses(closed bool) {
	h, ok := c.ownSkipper()
	if !ok {
		return
	}
	d := &c.e.decks
	d.mu.Lock()
	d.deckOf(h.boat, h.skipper).closed = closed
	d.mu.Unlock()
}
