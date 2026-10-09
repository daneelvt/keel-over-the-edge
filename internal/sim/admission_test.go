// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"slices"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
)

// queueOf lists the accounts waiting, the head first, with their
// connections.
func queueOf(f *bus.Frame) [][2]uint64 {
	var q [][2]uint64
	for _, w := range f.Queue {
		q = append(q, [2]uint64{uint64(w.Account[15]), w.Conn})
	}
	return q
}

func TestAdmission(t *testing.T) {
	w := limitedWorld(t, 8, 1, 3)
	// Below the limit: boats.
	for i := range 3 {
		if r := do(t, w, bus.Command{Op: bus.Join, Account: acct(uint64(i + 1)), Conn: uint64(10 + i)}); r.Result != bus.Joined {
			t.Fatalf("join %d: %+v", i, r)
		}
	}
	// At it: places in the queue, in turn.
	for i := range 3 {
		r := do(t, w, bus.Command{Op: bus.Join, Account: acct(uint64(4 + i)), Conn: uint64(20 + i)})
		if r != (bus.Reply{Result: bus.Queued, Slot: -1, Position: int32(i + 1)}) {
			t.Fatalf("join %d at the limit: %+v", i, r)
		}
	}
	if q := queueOf(w.Latest()); !slices.Equal(q, [][2]uint64{{4, 20}, {5, 21}, {6, 22}}) {
		t.Fatalf("queue %v", q)
	}
	queuedAt := w.Latest().Queue[0].Since

	// A boat in its grace counts: its sailor coming back is never queued.
	if r := do(t, w, bus.Command{Op: bus.Disconnect, Boat: 2, Conn: 11}); r.Result != bus.Done {
		t.Fatalf("disconnect: %+v", r)
	}
	if r := do(t, w, bus.Command{Op: bus.Join, Account: acct(2), Conn: 30}); r.Result != bus.Rejoined || r.Boat != 2 {
		t.Fatalf("back within the grace, at the limit: %+v", r)
	}
	if n := len(w.Latest().Live); n != 3 {
		t.Fatalf("%d boats", n)
	}

	// Waiting again from a new connection keeps the place.
	if r := do(t, w, bus.Command{Op: bus.Join, Account: acct(5), Conn: 31}); r != (bus.Reply{Result: bus.Queued, Slot: -1, Position: 2}) {
		t.Fatalf("join again while waiting: %+v", r)
	}
	// The older connection's end leaves the queue alone; the newer one's
	// takes its place out, and those behind move up.
	if r := do(t, w, bus.Command{Op: bus.Disconnect, Account: acct(5), Conn: 21}); r.Result != bus.Stale {
		t.Fatalf("a stale connection's end: %+v", r)
	}
	if q := queueOf(w.Latest()); !slices.Equal(q, [][2]uint64{{4, 20}, {5, 31}, {6, 22}}) {
		t.Fatalf("queue %v", q)
	}
	if r := do(t, w, bus.Command{Op: bus.Disconnect, Account: acct(5), Conn: 31}); r != (bus.Reply{Result: bus.Dequeued, Slot: -1, Position: 2}) {
		t.Fatalf("a waiting connection's end: %+v", r)
	}
	if q := queueOf(w.Latest()); !slices.Equal(q, [][2]uint64{{4, 20}, {6, 22}}) {
		t.Fatalf("queue %v", q)
	}
	if r := do(t, w, bus.Command{Op: bus.Disconnect, Account: acct(9), Conn: 31}); r.Result != bus.NoBoat {
		t.Fatalf("a stranger's end: %+v", r)
	}

	// A boat leaving admits the head in the same tick.
	if r := do(t, w, bus.Command{Op: bus.Leave, Boat: 1}); r.Result != bus.Left {
		t.Fatalf("leave: %+v", r)
	}
	f := w.Latest()
	if len(f.Events) != 2 || f.Events[1].Op != bus.Join || f.Events[1].Account != acct(4) || f.Events[1].Conn != 20 ||
		f.Events[1].Reply != (bus.Reply{Result: bus.Admitted, Slot: 0, Boat: 4, Gen: 1, Tick: f.Tick, Since: queuedAt}) {
		t.Fatalf("events %+v", f.Events)
	}
	if !f.Occupied[0] || f.Owner[0] != acct(4) || f.Conn[0] != 20 || f.Boat[0] != 4 {
		t.Fatalf("slot 0 is %v's", f.Owner[0])
	}
	if q := queueOf(f); !slices.Equal(q, [][2]uint64{{6, 22}}) {
		t.Fatalf("queue %v", q)
	}
	// While anyone waits, a newcomer queues behind them even with room;
	// both are admitted, in order, at the end of the tick.
	w.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.Leave, Boat: 3})
	w.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.Leave, Boat: 2})
	r := do(t, w, bus.Command{Op: bus.Join, Account: acct(7), Conn: 40})
	if r != (bus.Reply{Result: bus.Queued, Slot: -1, Position: 2}) {
		t.Fatalf("join behind a waiting one: %+v", r)
	}
	f = w.Latest()
	if len(f.Queue) != 0 || len(f.Live) != 3 || f.Owner[1] != acct(6) || f.Owner[2] != acct(7) {
		t.Fatalf("queue %v, live %v", queueOf(f), f.Live)
	}
	// A connection whose edge did not see it admitted ends: its boat's
	// grace begins.
	if r := do(t, w, bus.Command{Op: bus.Disconnect, Account: acct(7), Conn: 40}); r.Result != bus.Done || w.Latest().Grace[2] == 0 {
		t.Fatalf("an admitted connection's end: %+v", r)
	}
}

// TestAdmissionReplays: a tick's admissions are the tick's own doing: given
// the commands an input log recorded, which leave them out, a world admits
// the same connections to the same boats.
func TestAdmissionReplays(t *testing.T) {
	w := limitedWorld(t, 8, 1, 2)
	w2 := limitedWorld(t, 8, 1, 2)
	q := w.Bus().Commands.Developer()
	for i := range 4 {
		q.TrySend(bus.Command{Op: bus.Join, Account: acct(uint64(i + 1)), Conn: uint64(i + 1)})
	}
	q.TrySend(bus.Command{Op: bus.Leave, Boat: 1})
	q.TrySend(bus.Command{Op: bus.Disconnect, Account: acct(4), Conn: 4})
	for range 3 {
		w.Tick()
		f := w.Latest()
		in := Input{Changed: f.Changed}
		for _, e := range f.Events {
			if e.Reply.Result != bus.Admitted && e.Reply.Result != bus.Expired {
				in.Commands = append(in.Commands, e.Command)
			}
		}
		w2.TickWith(&in)
		if Digest(w2.Latest()) != Digest(f) || len(w2.Latest().Events) != len(f.Events) {
			t.Fatalf("tick %d replayed differently: events %+v and %+v", f.Tick, w2.Latest().Events, f.Events)
		}
	}
	if f := w.Latest(); len(f.Live) != 2 || f.Owner[0] != acct(3) || len(f.Queue) != 0 {
		t.Fatalf("live %v, queue %v", f.Live, queueOf(f))
	}
}

func TestLimitOutOfRange(t *testing.T) {
	for _, limit := range []int{-1, 9} {
		if _, err := New(Config{Capacity: 8, Kinds: kinds(t), Limit: limit}); err == nil {
			t.Errorf("a limit of %d boats in 8 slots", limit)
		}
	}
	w, err := New(Config{Capacity: 8, Kinds: kinds(t)})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	if w.Limit() != 8 {
		t.Fatalf("the default limit is %d", w.Limit())
	}
}
