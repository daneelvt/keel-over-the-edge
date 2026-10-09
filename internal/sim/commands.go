// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
)

// apply applies one command to the next frame, records it as an event and
// replies without waiting.
func (w *World) apply(c *bus.Command) {
	f := w.next
	var r bus.Reply
	switch c.Op {
	case bus.Join:
		r = w.join(c.Account, c.Conn)
	case bus.Leave:
		r = bus.Reply{Result: bus.NoBoat, Slot: -1, Boat: c.Boat}
		if s := slotOf(f, c.Boat); s >= 0 {
			r = bus.Reply{Result: bus.Left, Slot: s, Boat: c.Boat, Gen: f.Gen[s]}
			w.free(s)
		}
	case bus.SetWind:
		f.Wind = c.Wind
		r = bus.Reply{Result: bus.Done, Slot: -1}
	case bus.Place:
		r = bus.Reply{Result: bus.NoBoat, Slot: -1, Boat: c.Boat}
		if s := slotOf(f, c.Boat); s >= 0 {
			f.State[s] = c.State
			r = bus.Reply{Result: bus.Done, Slot: s, Boat: c.Boat, Gen: f.Gen[s]}
		}
	case bus.Disconnect:
		r = w.disconnect(c.Boat, c.Conn)
	default:
		return
	}
	r.Tick = f.Tick
	ev := bus.Event{Command: *c, Reply: r}
	ev.Command.Reply = nil
	f.Events = append(f.Events, ev)
	if c.Reply != nil {
		select {
		case c.Reply <- r:
		default:
		}
	}
}

// join gives account its boat, sailed from now on through connection conn:
// the one it already has, or a new one in the lowest free slot. One account
// sails one boat, so a sailor who reconnects finds theirs, and its grace,
// if it had begun, ends.
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
	if len(f.Live) == w.capacity {
		return bus.Reply{Result: bus.Full, Slot: -1}
	}
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
	return bus.Reply{Result: bus.Joined, Slot: s, Boat: f.Boat[s], Gen: gen}
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

// expire takes out the boats whose grace has ended, each recorded as an
// event of its own: a Leave with the result Expired, which a replay does
// not apply again, since the tick does it.
func (w *World) expire() {
	f := w.next
	for i := 0; i < len(f.Live); {
		s := f.Live[i]
		if g := f.Grace[s]; g == 0 || f.Tick < g {
			i++
			continue
		}
		boat := f.Boat[s]
		r := bus.Reply{Result: bus.Expired, Slot: s, Boat: boat, Gen: f.Gen[s], Tick: f.Tick}
		w.free(s)
		f.Events = append(f.Events, bus.Event{Command: bus.Command{Op: bus.Leave, Boat: boat}, Reply: r})
	}
}

// free empties slot s of the next frame.
func (w *World) free(s int32) {
	f := w.next
	f.Occupied[s] = false
	f.Gen[s] = (f.Gen[s] + 1) & bus.GenMask
	i, _ := slices.BinarySearch(f.Live, s)
	f.Live = slices.Delete(f.Live, i, i+1)
}

// slotOf finds a boat's slot, or returns −1.
func slotOf(f *bus.Frame, boat uint64) int32 {
	for _, s := range f.Live {
		if f.Boat[s] == boat {
			return s
		}
	}
	return -1
}
