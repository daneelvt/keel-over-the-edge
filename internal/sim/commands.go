// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// apply applies one command to the next frame, records it as an event and
// replies without waiting.
func (w *World) apply(c *bus.Command) {
	f := w.next
	var r bus.Reply
	var sailor bus.Account // a Leave's: the boat's
	switch c.Op {
	case bus.Join:
		r = w.join(c)
	case bus.Leave:
		r = bus.Reply{Result: bus.NoBoat, Slot: -1, Boat: c.Boat}
		if s := slotOf(f, c.Boat); s >= 0 {
			r = bus.Reply{Result: bus.Left, Slot: s, Boat: c.Boat, Gen: f.Gen[s]}
			sailor = f.Owner[s]
			w.free(s)
		}
	case bus.SetWeather:
		wx := c.Weather
		if !wx.Mode.Valid() {
			wx = bus.Weather{}
		}
		if wx.Mode == bus.WeatherSystem {
			f.Systems = w.timeline.Place(f.Systems, wx, f.Tick, f.Weathers)
		} else {
			f.Weathers = w.timeline.Set(f.Weathers, wx, f.Tick)
		}
		r = bus.Reply{Result: bus.Done, Slot: -1}
	case bus.Place:
		r = bus.Reply{Result: bus.NoBoat, Slot: -1, Boat: c.Boat}
		if s := slotOf(f, c.Boat); s >= 0 {
			f.State[s] = c.State
			// A boat falling over the lip is afloat where it is put.
			f.Voyage[s].Over = 0
			r = bus.Reply{Result: bus.Done, Slot: s, Boat: c.Boat, Gen: f.Gen[s]}
		}
	case bus.Teleport:
		r = bus.Reply{Result: bus.NoBoat, Slot: -1, Boat: c.Boat}
		if s := slotOf(f, c.Boat); s >= 0 {
			w.teleport(f, s, c)
			r = bus.Reply{Result: bus.Done, Slot: s, Boat: c.Boat, Gen: f.Gen[s]}
		}
	case bus.Stay, bus.Unseen:
		r = bus.Reply{Result: bus.NoBoat, Slot: -1, Boat: c.Boat}
		if s := slotOf(f, c.Boat); s >= 0 {
			if c.Op == bus.Stay {
				f.Stay[s] = c.On
			} else {
				f.Unseen[s] = c.On
			}
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
	case bus.Chart:
		r = bus.Reply{Result: bus.Done, Slot: -1}
		w.chartByHand(f, c.Subject, c.On)
	case bus.End:
		r = bus.Reply{Result: bus.Done, Slot: -1}
		w.endAt = max(c.At, f.Tick)
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

// teleport moves the boat in slot s of f as the owner's tools ask: to the
// state given, or to the start, clear of every other hull, as a new boat
// appears; at rest either way. Its course is cleared, as when it starts
// again, a fall over the lip ends, and its voyage is marked placed: it
// earns nothing from here on.
func (w *World) teleport(f *bus.Frame, s int32, c *bus.Command) {
	if c.Start {
		f.State[s] = w.spawn(f, s)
	} else {
		f.State[s] = c.State
	}
	f.Course[s] = physics.Course{}
	f.Voyage[s].Over = 0
	f.Voyage[s].Placed = true
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

// free ends the voyage of the boat in slot s of the next frame, unless it
// ended going over the lip, and empties the slot.
func (w *World) free(s int32) {
	f := w.next
	if w.edge != nil && !f.Voyage[s].Falling() {
		w.voyageEnds(f, s)
	}
	f.Occupied[s] = false
	f.Stay[s], f.Unseen[s] = false, false
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
