// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// A boat is sailed in its sailor's look, as its Join gave it, and a
// SetLook changes it only in Port Royal's harbour; a place in the queue
// takes it, and the boat it is given has it; with neither, the sailor is
// ashore.
func TestSetLook(t *testing.T) {
	harbour := &physics.Harbour{X: 1000, Y: 0, Radius: 200, MouthX: 1400, MouthY: 0, Narrows: 80}
	w, err := New(Config{Capacity: 4, Kinds: kinds(t), Workers: 1, Tick: 100, Limit: 1, Terrain: &Terrain{Harbour: harbour}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	ann, bob, cat := acct(1), acct(2), acct(3)
	joined := do(t, w, bus.Command{Op: bus.Join, Account: ann, Conn: 1, Look: 0x12345})
	if joined.Result != bus.Joined || w.Latest().Look[joined.Slot] != 0x12345 {
		t.Fatalf("joined %+v, look %#x", joined, w.Latest().Look[joined.Slot])
	}
	place := func(x, y float64) {
		t.Helper()
		if r := do(t, w, bus.Command{Op: bus.Place, Boat: joined.Boat, State: physics.State{X: x, Y: y}}); r.Result != bus.Done {
			t.Fatalf("placed: %+v", r)
		}
	}
	look := func() uint32 { return w.Latest().Look[joined.Slot] }

	place(0, 0)
	if r := do(t, w, bus.Command{Op: bus.SetLook, Account: ann, Look: 7}); r.Result != bus.Away || look() != 0x12345 {
		t.Fatalf("at sea: %+v, look %#x", r, look())
	}
	for _, at := range [][2]float64{{1000, 0}, {1150, 50}, {1380, 30}} {
		place(at[0], at[1])
		next := uint32(at[0])
		if r := do(t, w, bus.Command{Op: bus.SetLook, Account: ann, Look: next}); r.Result != bus.Done || r.Slot != joined.Slot || look() != next {
			t.Fatalf("in the harbour at %v: %+v, look %#x", at, r, look())
		}
	}
	// The narrows are narrow: beside them is not in the harbour.
	place(1300, 100)
	if r := do(t, w, bus.Command{Op: bus.SetLook, Account: ann, Look: 9}); r.Result != bus.Away {
		t.Fatalf("beside the narrows: %+v", r)
	}

	// Bob waits for a boat, the world at its limit; his look changes there.
	if r := do(t, w, bus.Command{Op: bus.Join, Account: bob, Conn: 2, Look: 1}); r.Result != bus.Queued {
		t.Fatalf("bob: %+v", r)
	}
	if r := do(t, w, bus.Command{Op: bus.SetLook, Account: bob, Look: 0x40}); r.Result != bus.Done || r.Slot != -1 {
		t.Fatalf("bob waiting: %+v", r)
	}
	do(t, w, bus.Command{Op: bus.Leave, Boat: joined.Boat})
	f := w.Latest()
	if len(f.Live) != 1 || f.Owner[f.Live[0]] != bob || f.Look[f.Live[0]] != 0x40 {
		t.Fatalf("bob's boat: %v, look %#x", f.Live, f.Look[f.Live[0]])
	}
	if r := do(t, w, bus.Command{Op: bus.SetLook, Account: cat, Look: 3}); r.Result != bus.NoBoat {
		t.Fatalf("ashore: %+v", r)
	}
}

// A world with no harbour changes no look at sea.
func TestSetLookWithoutAHarbour(t *testing.T) {
	w := newWorld(t, 2, 1)
	joined := do(t, w, bus.Command{Op: bus.Join, Account: acct(1), Conn: 1, Look: 5})
	if r := do(t, w, bus.Command{Op: bus.SetLook, Account: acct(1), Look: 6}); r.Result != bus.Away || w.Latest().Look[joined.Slot] != 5 {
		t.Fatalf("%+v", r)
	}
}
