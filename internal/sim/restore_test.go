// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"bytes"
	"slices"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
)

// TestHoldAdmission: while admission is held, a Join without a boat waits
// even with room, and the queue gives none; a sailor with a boat still
// gets it back; let go, the queue admits at once, in order.
func TestHoldAdmission(t *testing.T) {
	w := limitedWorld(t, 8, 1, 3)
	if r := do(t, w, bus.Command{Op: bus.Join, Account: acct(1), Conn: 1}); r.Result != bus.Joined {
		t.Fatalf("join: %+v", r)
	}
	if r := do(t, w, bus.Command{Op: bus.Hold, Held: true}); r != (bus.Reply{Result: bus.Done, Slot: -1}) || !w.Latest().Held {
		t.Fatalf("hold: %+v", r)
	}
	w2 := limitedWorld(t, 8, 1, 3)
	if err := w2.Load(AppendSnapshot(nil, w.Latest())); err != nil {
		t.Fatal(err)
	}
	if !w2.Latest().Held {
		t.Fatal("the hold is not in the snapshot")
	}
	w2.Latest().Held = false
	if Digest(w2.Latest()) == Digest(w.Latest()) {
		t.Fatal("the hold is not in the digest")
	}
	for i := range 2 {
		r := do(t, w, bus.Command{Op: bus.Join, Account: acct(uint64(2 + i)), Conn: uint64(2 + i)})
		if r != (bus.Reply{Result: bus.Queued, Slot: -1, Position: int32(i + 1)}) {
			t.Fatalf("join %d while held: %+v", i, r)
		}
	}
	for range 3 {
		w.Tick()
	}
	if f := w.Latest(); len(f.Live) != 1 || len(f.Queue) != 2 {
		t.Fatalf("while held: %d boats, %d waiting", len(f.Live), len(f.Queue))
	}
	do(t, w, bus.Command{Op: bus.Disconnect, Boat: 1, Conn: 1})
	if r := do(t, w, bus.Command{Op: bus.Join, Account: acct(1), Conn: 9}); r.Result != bus.Rejoined || r.Boat != 1 {
		t.Fatalf("back to a boat while held: %+v", r)
	}
	do(t, w, bus.Command{Op: bus.Hold})
	f := w.Latest()
	if f.Held || len(f.Queue) != 0 || len(f.Events) != 3 || f.Events[1].Reply.Result != bus.Admitted || f.Events[1].Account != acct(2) ||
		f.Events[2].Account != acct(3) {
		t.Fatalf("let go: held %v, queue %v, events %+v", f.Held, queueOf(f), f.Events)
	}
}

// restorable is a world to checkpoint: at its limit of 4, with a boat
// sailed, a boat in its grace, a boat whose grace ends soon, and two
// waiting; admission held.
func restorable(t *testing.T) *World {
	t.Helper()
	w, err := New(Config{Capacity: 16, Kinds: kinds(t), Workers: 1, Tick: 100, Grace: 600, Limit: 4})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	for i := range 6 {
		do(t, w, bus.Command{Op: bus.Join, Account: acct(uint64(i + 1)), Conn: uint64(i + 1)})
	}
	// Boat 3's sailor left long ago; boat 2's a moment ago.
	do(t, w, bus.Command{Op: bus.Disconnect, Boat: 3, Conn: 3})
	for range 500 {
		w.Tick()
	}
	do(t, w, bus.Command{Op: bus.Disconnect, Boat: 2, Conn: 2})
	do(t, w, bus.Command{Op: bus.Place, Boat: 1, State: spawn(9)})
	do(t, w, bus.Command{Op: bus.Hold, Held: true})
	for range 10 {
		w.Tick()
	}
	f := w.Latest()
	if len(f.Live) != 4 || len(f.Queue) != 2 || f.Grace[2] == 0 || f.Grace[1] == 0 || !f.Held {
		t.Fatalf("live %v, queue %v, graces %v", f.Live, queueOf(f), f.Grace[:4])
	}
	return w
}

// TestRestore: a restored world's tick is the present's; its boats are
// where the checkpoint had them, every one in its grace, a grace already
// running keeping its end; its queue is kept, with no connections, each
// place for the grace; admission is no longer held.
func TestRestore(t *testing.T) {
	old := restorable(t)
	of := old.Latest()
	snap := AppendSnapshot(nil, of)
	const gap = 300
	now := of.Tick + gap

	w, err := New(Config{Capacity: 16, Kinds: kinds(t), Workers: 1, Tick: now, Grace: 600, Limit: 4})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	r, err := w.Restore(snap, now)
	if err != nil {
		t.Fatal(err)
	}
	if r != (Restored{From: of.Tick, Gap: gap, Boats: 4, Waiting: 2}) {
		t.Fatalf("restored %+v", r)
	}
	f := w.Latest()
	if f.Tick != now || f.Held || f.NextBoat != of.NextBoat || !slices.Equal(f.Live, of.Live) {
		t.Fatalf("tick %d, held %v, next boat %d, live %v", f.Tick, f.Held, f.NextBoat, f.Live)
	}
	for _, s := range f.Live {
		want := of.Grace[s]
		if want == 0 {
			want = now + 600
		}
		if f.Boat[s] != of.Boat[s] || f.Owner[s] != of.Owner[s] || f.Conn[s] != 0 || f.Grace[s] != want ||
			f.Control[s] != of.Control[s] || !sameState(f.State[s], of.State[s]) {
			t.Fatalf("slot %d: boat %d, connection %d, grace %d (want %d)", s, f.Boat[s], f.Conn[s], f.Grace[s], want)
		}
		if w.Bus().Controls.Load(s) != f.Control[s] {
			t.Fatalf("slot %d's control slot was not set", s)
		}
	}
	for i, q := range f.Queue {
		if q.Account != of.Queue[i].Account || q.Since != of.Queue[i].Since || q.Conn != 0 || q.Grace != now+600 {
			t.Fatalf("place %d: %+v", i, q)
		}
	}
	// It round-trips, the queue's graces included, byte for byte.
	again := bus.NewFrame(16)
	if err := ReadSnapshot(AppendSnapshot(nil, f), again); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(AppendSnapshot(nil, again), AppendSnapshot(nil, f)) || !slices.Equal(again.Queue, f.Queue) || Digest(again) != Digest(f) {
		t.Fatal("a restored world's snapshot does not round-trip")
	}

	// Boat 3's grace ended during the pause: it leaves at the first tick,
	// and the queue's head gets its slot, with its place's grace running.
	w.Tick()
	f = w.Latest()
	if len(f.Events) != 2 || f.Events[0].Reply.Result != bus.Expired || f.Events[0].Boat != 3 ||
		f.Events[1].Reply.Result != bus.Admitted || f.Events[1].Account != acct(5) {
		t.Fatalf("the first tick: %+v", f.Events)
	}
	head, headBoat := f.Events[1].Reply.Slot, f.Events[1].Reply.Boat
	if f.Conn[head] != 0 || f.Grace[head] != now+600 {
		t.Fatalf("the head's boat: connection %d, grace %d", f.Conn[head], f.Grace[head])
	}

	// Within the grace, sailors find their boats, and places.
	if r := do(t, w, bus.Command{Op: bus.Join, Account: acct(1), Conn: 1}); r.Result != bus.Rejoined || r.Boat != 1 {
		t.Fatalf("boat 1's sailor: %+v", r)
	}
	if r := do(t, w, bus.Command{Op: bus.Join, Account: acct(5), Conn: 2}); r.Result != bus.Rejoined || r.Boat != headBoat {
		t.Fatalf("the head, back: %+v", r)
	}
	if r := do(t, w, bus.Command{Op: bus.Join, Account: acct(6), Conn: 3}); r != (bus.Reply{Result: bus.Queued, Slot: -1, Position: 1}) {
		t.Fatalf("the second, back: %+v", r)
	}
	if q := w.Latest().Queue[0]; q.Conn != 3 || q.Grace != 0 {
		t.Fatalf("a place taken back: %+v", q)
	}

	// Past the grace: the boats nobody came back to leave, and their
	// sailors get new boats.
	for w.Now() < now+600 {
		w.Tick()
	}
	f = w.Latest()
	if slotOf(f, 2) >= 0 || slotOf(f, 4) >= 0 || slotOf(f, 1) < 0 {
		t.Fatalf("live %v after the grace", f.Live)
	}
	if r := do(t, w, bus.Command{Op: bus.Join, Account: acct(2), Conn: 4}); r.Result != bus.Joined || r.Boat < of.NextBoat {
		t.Fatalf("boat 2's sailor after the grace: %+v", r)
	}
}

// TestRestoredPlaceGivenUp: a place in the queue whose account does not
// come back within the grace is given up, and those behind move up.
func TestRestoredPlaceGivenUp(t *testing.T) {
	old := restorable(t)
	of := old.Latest()
	w, err := New(Config{Capacity: 16, Kinds: kinds(t), Workers: 1, Tick: of.Tick, Grace: 600, Limit: 4})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	if _, err := w.Restore(AppendSnapshot(nil, of), of.Tick+1); err != nil {
		t.Fatal(err)
	}
	// Admission held again, so the queue keeps its places.
	do(t, w, bus.Command{Op: bus.Hold, Held: true})
	do(t, w, bus.Command{Op: bus.Join, Account: acct(6), Conn: 7})
	for w.Now() < of.Tick+601 {
		w.Tick()
	}
	if q := queueOf(w.Latest()); !slices.Equal(q, [][2]uint64{{6, 7}}) {
		t.Fatalf("queue %v once the grace ended", q)
	}
}

func TestRestoreRejects(t *testing.T) {
	w := newWorld(t, 8, 1)
	if _, err := w.Restore([]byte{1, 2, 3}, 5); err == nil {
		t.Fatal("garbage restored")
	}
	if _, err := w.Restore(AppendSnapshot(nil, restorable(t).Latest()), 5); err == nil {
		t.Fatal("a world of another capacity restored")
	}
}
