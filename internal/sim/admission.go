// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
)

// Admission: a world holds at most its limit of boats, those in their grace
// included. A Join beyond it, or while others wait, or while admission is
// held, joins the queue's tail; at the end of each tick's inputs, while
// there is room and admission is not held, the queue's head gets a boat.
// The queue and the hold are world state, in the snapshot and the digest,
// since who gets a boat when depends on when boats leave, and a replay must
// admit the same connections at the same ticks. A place may be kept for an
// account with no connection, as across a restart, until its grace ends.

// join gives account its boat, sailed from now on through connection conn:
// the one it already has, or a new one in the lowest free slot, or, when the
// world is at its limit, others wait or admission is held, a place in the
// queue. One account sails one boat, so a sailor who reconnects finds
// theirs, and its grace, if it had begun, ends; and one account waits once,
// so a sailor who reconnects while waiting keeps their place, with the new
// connection, and a place kept for them is theirs again.
func (w *World) join(account bus.Account, conn uint64) bus.Reply {
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
				w.bus.Controls.Store(s, f.Control[s])
			}
			return bus.Reply{Result: bus.Rejoined, Slot: s, Boat: f.Boat[s], Gen: f.Gen[s]}
		}
	}
	if i := queued(f, account); i >= 0 {
		f.Queue[i].Conn = conn
		f.Queue[i].Grace = 0
		return bus.Reply{Result: bus.Queued, Slot: -1, Position: int32(i + 1)}
	}
	if len(f.Live) < w.limit && len(f.Queue) == 0 && !f.Held {
		s := w.newBoat(account, conn)
		return bus.Reply{Result: bus.Joined, Slot: s, Boat: f.Boat[s], Gen: f.Gen[s]}
	}
	if len(f.Queue) == bus.QueueLimit {
		return bus.Reply{Result: bus.Full, Slot: -1}
	}
	f.Queue = append(f.Queue, bus.Waiting{Account: account, Conn: conn, Since: f.Tick})
	return bus.Reply{Result: bus.Queued, Slot: -1, Position: int32(len(f.Queue))}
}

// admit gives the queue's head a boat while the world has room and
// admission is not held, each recorded as an event of its own: a Join with
// the result Admitted, which a replay does not apply again, since the tick
// does it. A place kept with no connection gets its boat with the place's
// grace running, so its sailor finds it on coming back.
func (w *World) admit() {
	f := w.next
	if f.Held {
		return
	}
	n := 0
	for n < len(f.Queue) && len(f.Live) < w.limit {
		q := f.Queue[n]
		s := w.newBoat(q.Account, q.Conn)
		f.Grace[s] = q.Grace
		r := bus.Reply{Result: bus.Admitted, Slot: s, Boat: f.Boat[s], Gen: f.Gen[s], Tick: f.Tick, Since: q.Since}
		f.Events = append(f.Events, bus.Event{Command: bus.Command{Op: bus.Join, Account: q.Account, Conn: q.Conn}, Reply: r})
		n++
	}
	if n > 0 {
		f.Queue = slices.Delete(f.Queue, 0, n)
	}
}

// newBoat puts a new boat for account, sailed through conn, in the lowest
// free slot, and returns the slot. The world must have room.
func (w *World) newBoat(account bus.Account, conn uint64) int32 {
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
	f.Control[s] = bus.Centred(gen)
	f.State[s] = spawn(s)
	i, _ := slices.BinarySearch(f.Live, s)
	f.Live = slices.Insert(f.Live, i, s)
	if w.given == nil {
		// The slot may hold a word for the boat that had it before, which
		// its generation already disowns; this one the new sailor's writer
		// overwrites.
		w.bus.Controls.Store(s, f.Control[s])
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
		f.Queue = slices.Delete(f.Queue, i, i+1)
		return bus.Reply{Result: bus.Dequeued, Slot: -1, Position: int32(i + 1)}
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
