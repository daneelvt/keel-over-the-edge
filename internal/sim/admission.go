// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Admission: a world holds at most its limit of boats, those in their grace
// included. A Join beyond it, or while others wait ahead of it, or while
// admission is held, joins the queue; at the end of each tick's inputs,
// while there is room and admission is not held, a waiting account gets a
// boat. The queue and the hold are world state, in the snapshot and the
// digest, since who gets a boat when depends on when boats leave, and a
// replay must admit the same connections at the same ticks. A place may be
// kept for an account with no connection, as across a restart, until its
// grace ends.
//
// Humans and machine sailors wait in queues of their own, each first come
// first served, and humans go first: machine sailors sail at most half the
// limit's boats (the cap), and while they sail fewer than half of that (the
// reserve) the first of them waiting is admitted before any human. No boat
// at sea is ever taken out for another. A priority account never waits: it
// gets a boat at once, beyond the limit and the cap if need be, while a slot
// is free.

// aiCap and aiReserve are the most boats machine sailors sail, and how many
// they are kept, in a world of limit boats.
func aiCap(limit int) int     { return limit / 2 }
func aiReserve(limit int) int { return limit / 4 }

// AICap is the most boats machine sailors sail at once, and AIReserve how
// many places are kept for them ahead of humans waiting.
func (w *World) AICap() int     { return aiCap(w.limit) }
func (w *World) AIReserve() int { return aiReserve(w.limit) }

// machines counts f's machine boats.
func machines(f *bus.Frame) int {
	n := 0
	for _, s := range f.Live {
		if f.Machine[s] {
			n++
		}
	}
	return n
}

// nextAdmitted is the index in f's queue of whoever gets the next boat, or −1 for
// none: a priority account's place while a slot is free; else, while the
// world is under its limit, the first machine sailor while they sail fewer
// than the reserve, then the first human, then the first machine sailor
// while they sail fewer than the cap.
func (w *World) nextAdmitted(f *bus.Frame, ai int) int {
	if len(f.Live) >= w.capacity {
		return -1
	}
	for i := range f.Queue {
		if f.Queue[i].Priority {
			return i
		}
	}
	if len(f.Live) >= w.limit {
		return -1
	}
	firstAI, firstHuman := -1, -1
	for i := range f.Queue {
		if f.Queue[i].Machine {
			if firstAI < 0 {
				firstAI = i
			}
		} else if firstHuman < 0 {
			firstHuman = i
		}
		if firstAI >= 0 && firstHuman >= 0 {
			break
		}
	}
	switch {
	case firstAI >= 0 && ai < aiReserve(w.limit):
		return firstAI
	case firstHuman >= 0:
		return firstHuman
	case firstAI >= 0 && ai < aiCap(w.limit):
		return firstAI
	}
	return -1
}

// join gives c's account its boat, sailed from now on through connection
// c.Conn: the one it already has, or a new one in the lowest free slot, or,
// when admission would not give it the next place were it waiting, a place
// in the queue. One account sails one boat, so a sailor who reconnects
// finds theirs, and its grace, if it had begun, ends; and one account
// waits once, so a sailor who reconnects while waiting keeps their place,
// with the new connection, and a place kept for them is theirs again.
func (w *World) join(c *bus.Command) bus.Reply {
	account, conn := c.Account, c.Conn
	f := w.next
	for _, s := range f.Live {
		if f.Owner[s] == account {
			f.Conn[s] = conn
			f.Grace[s] = 0
			if w.given == nil {
				// Whoever wrote the slot before is no longer the boat's
				// sailor: a word it left waiting for its tick is put back
				// to the word in force, so only the new sailor's are applied
				// from here on.
				w.bus.Controls.Store(s, f.Control[s], f.Pilot[s])
			}
			return bus.Reply{Result: bus.Rejoined, Slot: s, Boat: f.Boat[s], Gen: f.Gen[s]}
		}
	}
	if i := queued(f, account); i >= 0 {
		f.Queue[i].Conn = conn
		f.Queue[i].Grace = 0
		pos, _ := bus.QueuePlace(f.Queue, i)
		return bus.Reply{Result: bus.Queued, Slot: -1, Position: pos}
	}
	if len(f.Queue) == bus.QueueLimit {
		return bus.Reply{Result: bus.Full, Slot: -1}
	}
	// The newcomer waits at the tail, and gets the next boat at once if
	// admission would give it to them.
	f.Queue = append(f.Queue, bus.Waiting{Account: account, Conn: conn, Since: f.Tick, Machine: c.Machine, Priority: c.Priority})
	last := len(f.Queue) - 1
	if !f.Held && w.nextAdmitted(f, machines(f)) == last {
		f.Queue = f.Queue[:last]
		s := w.newBoat(account, conn, c.Machine, c.Priority)
		return bus.Reply{Result: bus.Joined, Slot: s, Boat: f.Boat[s], Gen: f.Gen[s]}
	}
	pos, _ := bus.QueuePlace(f.Queue, last)
	return bus.Reply{Result: bus.Queued, Slot: -1, Position: pos}
}

// admit gives boats to those waiting, in admission's order, while the
// world has room and admission is not held, each recorded as an event of
// its own: a Join with the result Admitted, which a replay does not apply
// again, since the tick does it. A place kept with no connection gets its
// boat with the place's grace running, so its sailor finds it on coming
// back.
func (w *World) admit() {
	f := w.next
	if f.Held || len(f.Queue) == 0 {
		return
	}
	ai := machines(f)
	for {
		i := w.nextAdmitted(f, ai)
		if i < 0 {
			return
		}
		q := f.Queue[i]
		f.Queue = slices.Delete(f.Queue, i, i+1)
		s := w.newBoat(q.Account, q.Conn, q.Machine, q.Priority)
		if q.Machine {
			ai++
		}
		f.Grace[s] = q.Grace
		r := bus.Reply{Result: bus.Admitted, Slot: s, Boat: f.Boat[s], Gen: f.Gen[s], Tick: f.Tick, Since: q.Since}
		f.Events = append(f.Events, bus.Event{Command: bus.Command{Op: bus.Join, Account: q.Account, Conn: q.Conn,
			Machine: q.Machine, Priority: q.Priority}, Reply: r})
	}
}

// newBoat puts a new boat for account, of its kind, sailed through conn,
// in the lowest free slot, and returns the slot. The world must have room.
func (w *World) newBoat(account bus.Account, conn uint64, machine, priority bool) int32 {
	f := w.next
	s := int32(slices.Index(f.Occupied, false))
	gen := f.Gen[s]
	f.Occupied[s] = true
	f.Boat[s] = f.NextBoat
	f.NextBoat++
	f.Owner[s] = account
	f.Conn[s] = conn
	f.Grace[s] = 0
	f.Kind[s] = 0
	f.Machine[s], f.Priority[s] = machine, priority
	f.Control[s] = bus.Centred(gen)
	f.Pilot[s] = bus.PilotOffWord(gen)
	f.State[s] = w.spawn(f, s)
	f.Course[s] = physics.Course{}
	f.Voyage[s] = bus.Voyage{}
	f.Stay[s], f.Unseen[s] = false, false
	i, _ := slices.BinarySearch(f.Live, s)
	f.Live = slices.Insert(f.Live, i, s)
	if w.given == nil {
		// The slot may hold a word for the boat that had it before, which
		// its generation already disowns; this one the new sailor's writer
		// overwrites.
		w.bus.Controls.Store(s, f.Control[s], f.Pilot[s])
	}
	return s
}

// disconnect begins a boat's grace when the connection sailing it ends. A
// connection that no longer sails it, replaced by a newer one, is ignored.
func (w *World) disconnect(boat, conn uint64) bus.Reply {
	f := w.next
	s := slotOf(f, boat)
	if s < 0 {
		return bus.Reply{Result: bus.NoBoat, Slot: -1, Boat: boat}
	}
	r := bus.Reply{Result: bus.Stale, Slot: s, Boat: boat, Gen: f.Gen[s]}
	if f.Conn[s] == conn && f.Grace[s] == 0 {
		f.Grace[s] = f.Tick + w.grace
		r.Result = bus.Done
	}
	return r
}

// disconnectAccount ends account's connection conn, whatever it had: a
// place in the queue, which it leaves, those behind moving up; or a boat,
// whose grace begins, as when a connection's edge did not yet know the
// queue had given it one. A connection the account no longer uses is
// ignored.
func (w *World) disconnectAccount(account bus.Account, conn uint64) bus.Reply {
	f := w.next
	if i := queued(f, account); i >= 0 {
		if f.Queue[i].Conn != conn {
			return bus.Reply{Result: bus.Stale, Slot: -1}
		}
		pos, _ := bus.QueuePlace(f.Queue, i)
		f.Queue = slices.Delete(f.Queue, i, i+1)
		return bus.Reply{Result: bus.Dequeued, Slot: -1, Position: pos}
	}
	for _, s := range f.Live {
		if f.Owner[s] == account {
			return w.disconnect(f.Boat[s], conn)
		}
	}
	return bus.Reply{Result: bus.NoBoat, Slot: -1}
}

// queued is account's index in the queue, or −1.
func queued(f *bus.Frame, account bus.Account) int {
	for i := range f.Queue {
		if f.Queue[i].Account == account {
			return i
		}
	}
	return -1
}
