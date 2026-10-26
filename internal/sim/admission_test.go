// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"math"
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

// TestAdmissionByKind: humans and machine sailors wait apart, humans go
// first, machine sailors are kept a reserve within their cap, a priority
// account never waits, and no boat at sea is ever taken out for another.
// In a world of 4 boats the cap is 2 and the reserve 1.
func TestAdmissionByKind(t *testing.T) {
	w := limitedWorld(t, 8, 1, 4)
	if w.AICap() != 2 || w.AIReserve() != 1 {
		t.Fatalf("a cap of %d and a reserve of %d", w.AICap(), w.AIReserve())
	}
	human := func(n uint64) bus.Command { return bus.Command{Op: bus.Join, Account: acct(n), Conn: n} }
	machine := func(n uint64) bus.Command {
		return bus.Command{Op: bus.Join, Account: acct(n), Conn: n, Machine: true}
	}
	boatOf := map[uint64]uint64{}
	join := func(c bus.Command, want bus.Result, position int32) {
		t.Helper()
		r := do(t, w, c)
		if r.Result != want || want == bus.Queued && r.Position != position {
			t.Fatalf("join of %d: %+v, not %s at %d", c.Account[15], r, want, position)
		}
		if r.Result == bus.Joined {
			boatOf[uint64(c.Account[15])] = r.Boat
		}
	}
	// Who sails, by account, and how many are machine sailors.
	sailing := func() (who []uint64, ai int) {
		f := w.Latest()
		for _, s := range f.Live {
			who = append(who, uint64(f.Owner[s][15]))
			if f.Machine[s] {
				ai++
			}
		}
		slices.Sort(who)
		return who, ai
	}
	leave := func(n uint64) {
		t.Helper()
		f := w.Latest()
		for _, s := range f.Live {
			if f.Owner[s] == acct(n) {
				if r := do(t, w, bus.Command{Op: bus.Leave, Boat: f.Boat[s]}); r.Result != bus.Left {
					t.Fatalf("leave of %d: %+v", n, r)
				}
				return
			}
		}
		t.Fatalf("%d sails no boat", n)
	}
	expect := func(want ...uint64) {
		t.Helper()
		if who, _ := sailing(); !slices.Equal(who, want) {
			t.Fatalf("sailing %v, not %v", who, want)
		}
	}

	for n := uint64(1); n <= 4; n++ {
		join(human(n), bus.Joined, 0)
	}
	// Two machine sailors and three humans wait, each told their place
	// in their own queue.
	join(machine(11), bus.Queued, 1)
	join(machine(12), bus.Queued, 2)
	join(human(5), bus.Queued, 1)
	join(human(6), bus.Queued, 2)
	join(human(7), bus.Queued, 3)

	// Machine sailors below the reserve: the first of them goes first.
	leave(1)
	expect(2, 3, 4, 11)
	// At the reserve, humans go first while any wait.
	leave(2)
	expect(3, 4, 5, 11)
	leave(3)
	leave(4)
	expect(5, 6, 7, 11)
	// With no human waiting, a machine sailor below the cap.
	leave(5)
	expect(6, 7, 11, 12)
	// At the cap, a machine sailor waits though there is room; a human
	// arriving is given the room at once.
	join(machine(13), bus.Queued, 1)
	leave(6)
	expect(7, 11, 12)
	join(human(8), bus.Joined, 0)
	expect(7, 8, 11, 12)

	// A priority account never waits, beyond the limit and the cap.
	join(bus.Command{Op: bus.Join, Account: acct(20), Conn: 20, Priority: true}, bus.Joined, 0)
	join(bus.Command{Op: bus.Join, Account: acct(21), Conn: 21, Priority: true, Machine: true}, bus.Joined, 0)
	if who, ai := sailing(); len(who) != 6 || ai != 3 {
		t.Fatalf("sailing %v, %d of them machine sailors", who, ai)
	}
	if f := w.Latest(); !f.Priority[slotOf(f, boatOf[20])] || f.Priority[slotOf(f, boatOf[8])] {
		t.Fatal("priority is not the boat's")
	}
	// Room again under the limit is the humans' first: none wait, and the
	// machine sailors are above their cap.
	leave(20)
	leave(21)
	leave(7)
	expect(8, 11, 12)
	if q := queueOf(w.Latest()); !slices.Equal(q, [][2]uint64{{13, 13}}) {
		t.Fatalf("queue %v", q)
	}
	leave(11)
	expect(8, 12, 13)
}

// TestPriorityWaitsOnlyForASlot: a priority account beyond the limit is
// bounded by the world's slots, and while admission is held waits like
// anyone, first when it is let go.
func TestPriorityWaitsOnlyForASlot(t *testing.T) {
	w := limitedWorld(t, 3, 1, 2)
	for n := uint64(1); n <= 3; n++ {
		if r := do(t, w, bus.Command{Op: bus.Join, Account: acct(n), Conn: n, Priority: true}); r.Result != bus.Joined {
			t.Fatalf("join %d: %+v", n, r)
		}
	}
	if r := do(t, w, bus.Command{Op: bus.Join, Account: acct(4), Conn: 4}); r.Result != bus.Queued {
		t.Fatalf("a human with every slot taken: %+v", r)
	}
	r := do(t, w, bus.Command{Op: bus.Join, Account: acct(5), Conn: 5, Priority: true})
	if r.Result != bus.Queued || r.Position != 2 {
		t.Fatalf("a priority account with every slot taken: %+v", r)
	}
	if r := do(t, w, bus.Command{Op: bus.Leave, Boat: 1}); r.Result != bus.Left {
		t.Fatalf("leave: %+v", r)
	}
	if f := w.Latest(); len(f.Queue) != 1 || f.Queue[0].Account != acct(4) || f.Owner[0] != acct(5) {
		t.Fatalf("queue %v, slot 0 %v's", queueOf(f), f.Owner[0][15])
	}
}

// TestKindsInTheCheckpoint: a restored checkpoint keeps its machine and
// priority boats and places.
func TestKindsInTheCheckpoint(t *testing.T) {
	w := limitedWorld(t, 8, 1, 2)
	do(t, w, bus.Command{Op: bus.Join, Account: acct(1), Conn: 1, Machine: true})
	do(t, w, bus.Command{Op: bus.Join, Account: acct(2), Conn: 2, Priority: true})
	do(t, w, bus.Command{Op: bus.Join, Account: acct(3), Conn: 3})
	do(t, w, bus.Command{Op: bus.Join, Account: acct(4), Conn: 4, Machine: true})
	f := w.Latest()
	if len(f.Queue) != 2 {
		t.Fatalf("queue %v", queueOf(f))
	}
	w2 := limitedWorld(t, 8, 1, 2)
	if err := w2.Load(AppendCheckpoint(nil, f)); err != nil {
		t.Fatal(err)
	}
	g := w2.Latest()
	for _, s := range f.Live {
		if g.Machine[s] != f.Machine[s] || g.Priority[s] != f.Priority[s] {
			t.Fatalf("slot %d: machine %v priority %v, saved %v %v", s, g.Machine[s], g.Priority[s], f.Machine[s], f.Priority[s])
		}
	}
	if !slices.Equal(g.Queue, f.Queue) || !g.Queue[1].Machine || g.Queue[0].Machine {
		t.Fatalf("queue %+v, saved %+v", g.Queue, f.Queue)
	}
	if Digest(g) != Digest(f) {
		t.Fatal("the restored world's digest differs")
	}
	// The kinds count in the digest: the same world of humans differs.
	g.Machine[f.Live[0]] = false
	if Digest(g) == Digest(f) {
		t.Fatal("a boat's kind is not in the digest")
	}
}

// TestInstruments: a machine boat's step leaves what it read in the
// frame; a human's leaves nothing.
func TestInstruments(t *testing.T) {
	w := limitedWorld(t, 8, 1, 8)
	do(t, w, bus.Command{Op: bus.Join, Account: acct(1), Conn: 1, Machine: true})
	do(t, w, bus.Command{Op: bus.Join, Account: acct(2), Conn: 2})
	for range 60 {
		w.Tick()
	}
	f := w.Latest()
	in := f.Instruments[0]
	// The default weather: 10 knots from the north, the same everywhere.
	if math.Abs(float64(in.WindSpeed)-f.Wind[0].WindSpeed) > 1e-6 || in.WindFrom != float32(f.Wind[0].WindFrom) ||
		in.ApparentSpeed <= 0 || in.SpeedOverGround <= 0 {
		t.Fatalf("a machine boat's instruments %+v, its wind %+v", in, f.Wind[0])
	}
	if f.Instruments[1] != (bus.Instruments{}) {
		t.Fatalf("a human's boat's instruments %+v", f.Instruments[1])
	}
}
