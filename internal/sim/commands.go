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
		r = w.join(c.Account)
	case bus.Leave:
		r = bus.Reply{Result: bus.NoBoat, Slot: -1, Boat: c.Boat}
		if s := slotOf(f, c.Boat); s >= 0 {
			r = bus.Reply{Result: bus.Left, Slot: s, Boat: c.Boat, Gen: f.Gen[s]}
			f.Occupied[s] = false
			f.Gen[s] = (f.Gen[s] + 1) & bus.GenMask
			i, _ := slices.BinarySearch(f.Live, s)
			f.Live = slices.Delete(f.Live, i, i+1)
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
	default:
		return
	}
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

// join gives account its boat: the one it already has, or a new one in the
// lowest free slot. One account sails one boat, so a sailor who reconnects
// finds theirs.
func (w *World) join(account uint64) bus.Reply {
	f := w.next
	for _, s := range f.Live {
		if f.Owner[s] == account {
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

// slotOf finds a boat's slot, or returns −1.
func slotOf(f *bus.Frame, boat uint64) int32 {
	for _, s := range f.Live {
		if f.Boat[s] == boat {
			return s
		}
	}
	return -1
}
