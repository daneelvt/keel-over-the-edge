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
	var sailor bus.Account // a Leave's: the boat's
	switch c.Op {
	case bus.Join:
		r = w.join(c.Account, c.Conn)
	case bus.Leave:
		r = bus.Reply{Result: bus.NoBoat, Slot: -1, Boat: c.Boat}
		if s := slotOf(f, c.Boat); s >= 0 {
			r = bus.Reply{Result: bus.Left, Slot: s, Boat: c.Boat, Gen: f.Gen[s]}
			sailor = f.Owner[s]
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
		if c.Boat == 0 {
			r = w.disconnectAccount(c.Account, c.Conn)
		} else {
			r = w.disconnect(c.Boat, c.Conn)
		}
	case bus.Hold:
		f.Held = c.Held
		r = bus.Reply{Result: bus.Done, Slot: -1}
	default:
		return
	}
	r.Tick = f.Tick
	ev := bus.Event{Command: *c, Reply: r}
	ev.Command.Reply = nil
	if c.Op == bus.Leave {
		ev.Account = sailor
	}
	f.Events = append(f.Events, ev)
	if c.Reply != nil {
		select {
		case c.Reply <- r:
		default:
		}
	}
}

// expire takes out the boats whose grace has ended, each recorded as an
// event of its own: a Leave with the result Expired, which a replay does
// not apply again, since the tick does it; and gives up the places in the
// queue kept for accounts that have not come back, which the tick does
// too.
func (w *World) expire() {
	f := w.next
	kept := f.Queue[:0]
	for _, q := range f.Queue {
		if q.Grace == 0 || f.Tick < q.Grace {
			kept = append(kept, q)
		}
	}
	f.Queue = kept
	for i := 0; i < len(f.Live); {
		s := f.Live[i]
		if g := f.Grace[s]; g == 0 || f.Tick < g {
			i++
			continue
		}
		boat := f.Boat[s]
		r := bus.Reply{Result: bus.Expired, Slot: s, Boat: boat, Gen: f.Gen[s], Tick: f.Tick}
		sailor := f.Owner[s]
		w.free(s)
		f.Events = append(f.Events, bus.Event{Command: bus.Command{Op: bus.Leave, Boat: boat, Account: sailor}, Reply: r})
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
