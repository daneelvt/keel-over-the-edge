// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"bytes"
	"math"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The owner's tools' commands: a teleport, a boat that stays while its
// owner's free camera roams, and an unseen boat.

// owned sends c through the owner's tools' sender and ticks.
func owned(t testing.TB, w *World, c bus.Command) bus.Reply {
	t.Helper()
	reply := make(chan bus.Reply, 1)
	c.Reply = reply
	if err := w.Bus().Commands.Owner().TrySend(c); err != nil {
		t.Fatal(err)
	}
	w.Tick()
	return <-reply
}

// A teleport puts the boat at rest where it is asked, its course cleared,
// any fall ended and its voyage placed; or at the start, clear of every
// other hull.
func TestTeleport(t *testing.T) {
	w := edgeWorld(t, true)
	a := do(t, w, bus.Command{Op: bus.Join, Account: acct(1)})
	b := do(t, w, bus.Command{Op: bus.Join, Account: acct(2)})
	placeAtEdge(t, w, a.Boat, 100, 100, 0, 3)
	for range 30 {
		w.Tick()
	}
	if w.Latest().Course[a.Slot] == (physics.Course{}) {
		t.Fatal("the boat keeps no course to clear")
	}
	st := physics.State{X: -2000, Y: 1500, Heading: 1}
	if r := owned(t, w, bus.Command{Op: bus.Teleport, Boat: a.Boat, State: st}); r.Result != bus.Done {
		t.Fatalf("teleported: %v", r.Result)
	}
	f := w.Latest()
	// The tick's step sailed it from where it was put.
	if d := math.Hypot(f.State[a.Slot].X-st.X, f.State[a.Slot].Y-st.Y); d > 0.1 {
		t.Fatalf("teleported to %+v, found %v m away", st, d)
	}
	if !f.Voyage[a.Slot].Placed || f.Voyage[b.Slot].Placed {
		t.Fatalf("voyages: %+v, %+v", f.Voyage[a.Slot], f.Voyage[b.Slot])
	}
	// To the start: where a new boat appears, and not on top of b, which
	// lies at a's own place there.
	placeAtEdge(t, w, b.Boat, spawnAt(int64(a.Slot)).X, spawnAt(int64(a.Slot)).Y, math.Pi/2, 0)
	owned(t, w, bus.Command{Op: bus.Teleport, Boat: a.Boat, Start: true})
	f = w.Latest()
	if d := math.Hypot(f.State[a.Slot].X-f.State[b.Slot].X, f.State[a.Slot].Y-f.State[b.Slot].Y); d < spawnClear {
		t.Fatalf("at the start %v m from the other boat", d)
	}
	if r := owned(t, w, bus.Command{Op: bus.Teleport, Boat: 999}); r.Result != bus.NoBoat {
		t.Fatalf("a boat that is not there: %v", r.Result)
	}
}

// A placed voyage that goes over the lip, or survives an approach, is
// counted at the edge but marked placed; the voyage after it starts clear.
func TestPlacedVoyage(t *testing.T) {
	w := edgeWorld(t, false)
	r := do(t, w, bus.Command{Op: bus.Join, Account: acct(1)})
	// An approach survived, then over the lip.
	owned(t, w, bus.Command{Op: bus.Teleport, Boat: r.Boat, State: physics.State{X: 0, Y: 8300}})
	owned(t, w, bus.Command{Op: bus.Teleport, Boat: r.Boat, State: physics.State{X: 0, Y: 7700}})
	owned(t, w, bus.Command{Op: bus.Teleport, Boat: r.Boat, State: physics.State{X: 8333.5, Heading: math.Pi / 2}})
	var ev []bus.EdgeEvent
	for range 60 {
		w.Tick()
		if ev = edges(w); len(ev) > 0 {
			break
		}
	}
	if len(ev) != 2 || ev[0].Kind != bus.EdgeOver || ev[1].Kind != bus.EdgeApproach || !ev[0].Placed || !ev[1].Placed {
		t.Fatalf("a placed voyage over the lip: %+v", ev)
	}
	for w.Latest().Voyage[r.Slot].Falling() {
		w.Tick()
	}
	if v := w.Latest().Voyage[r.Slot]; v != (bus.Voyage{}) {
		t.Fatalf("the voyage after going over: %+v", v)
	}
	// The next voyage's approach is its own, and not placed.
	placeAtEdge(t, w, r.Boat, 0, 8300, -math.Pi/2, 0)
	do(t, w, bus.Command{Op: bus.Leave, Boat: r.Boat})
	if ev := edges(w); len(ev) != 1 || ev[0].Placed {
		t.Fatalf("the next voyage's approach: %+v", ev)
	}
}

// A boat that stays is not stepped, stays in the grid so every view still
// holds it, touches nothing and casts no shadow; let go, it sails again.
func TestStay(t *testing.T) {
	w := edgeWorld(t, true)
	a := do(t, w, bus.Command{Op: bus.Join, Account: acct(1)})
	b := do(t, w, bus.Command{Op: bus.Join, Account: acct(2)})
	placeAtEdge(t, w, a.Boat, 0, 0, 0, 3)
	owned(t, w, bus.Command{Op: bus.Stay, Boat: a.Boat, On: true})
	held := w.Latest().State[a.Slot]
	// b sails into it.
	placeAtEdge(t, w, b.Boat, 0, -4, 0, 2)
	for range 90 {
		w.Tick()
		f := w.Latest()
		if f.State[a.Slot] != held || !f.Stay[a.Slot] || f.Wake[a.Slot] != (physics.Wake{}) {
			t.Fatalf("tick %d: a staying boat moved to %+v", f.Tick, f.State[a.Slot])
		}
		if len(f.Pairs) != 0 || len(f.Bumps) != 0 {
			t.Fatalf("tick %d: pairs %v, bumps %v", f.Tick, f.Pairs, f.Bumps)
		}
		if c := f.Grid.Cell[a.Slot]; c != physics.Cell(held.X, held.Y) || !contains(f.Grid.Boats(c), a.Slot) {
			t.Fatal("a staying boat is not in the grid")
		}
	}
	owned(t, w, bus.Command{Op: bus.Stay, Boat: a.Boat, On: false})
	if w.Latest().State[a.Slot] == held {
		t.Fatal("let go, the boat does not sail")
	}
}

// An unseen boat sails, but touches nothing and casts no shadow.
func TestUnseen(t *testing.T) {
	w := edgeWorld(t, true)
	a := do(t, w, bus.Command{Op: bus.Join, Account: acct(1)})
	b := do(t, w, bus.Command{Op: bus.Join, Account: acct(2)})
	owned(t, w, bus.Command{Op: bus.Unseen, Boat: a.Boat, On: true})
	placeAtEdge(t, w, a.Boat, 0, 0, 0, 3)
	placeAtEdge(t, w, b.Boat, 0, 3, math.Pi, 3)
	start := w.Latest().State[a.Slot]
	for range 60 {
		w.Tick()
		f := w.Latest()
		if len(f.Pairs) != 0 || len(f.Bumps) != 0 || f.Wake[a.Slot] != (physics.Wake{}) {
			t.Fatalf("tick %d: pairs %v, bumps %v, wake %+v", f.Tick, f.Pairs, f.Bumps, f.Wake[a.Slot])
		}
	}
	if w.Latest().State[a.Slot] == start {
		t.Fatal("an unseen boat does not sail")
	}
	owned(t, w, bus.Command{Op: bus.Unseen, Boat: a.Boat, On: false})
	if w.Latest().Unseen[a.Slot] {
		t.Fatal("still unseen")
	}
}

// The owner's marks go through the input log's snapshot whole, and count
// in the digest; a checkpoint leaves them out; a world without them
// snapshots the same bytes and digest as before they were; a restore
// clears them; a slot freed and taken again starts clear.
func TestOwnerMarks(t *testing.T) {
	w := edgeWorld(t, false)
	a := do(t, w, bus.Command{Op: bus.Join, Account: acct(1)})
	b := do(t, w, bus.Command{Op: bus.Join, Account: acct(2)})
	plain, plainSnap := Digest(w.Latest()), AppendSnapshot(nil, w.Latest())
	if !bytes.Equal(plainSnap, AppendCheckpoint(nil, w.Latest())) {
		t.Fatal("a world without marks: the snapshot and the checkpoint differ")
	}
	f := w.Latest()
	for _, set := range []func(){
		func() { f.Stay[a.Slot] = true },
		func() { f.Unseen[b.Slot] = true },
		func() { f.Voyage[a.Slot].Placed = true },
	} {
		set()
		if Digest(f) == plain {
			t.Error("a mark leaves the digest as it was")
		}
		g := bus.NewFrame(f.Capacity())
		if err := ReadSnapshot(AppendSnapshot(nil, f), g); err != nil {
			t.Fatal(err)
		}
		for _, s := range []int32{a.Slot, b.Slot} {
			if g.Stay[s] != f.Stay[s] || g.Unseen[s] != f.Unseen[s] || g.Voyage[s] != f.Voyage[s] {
				t.Errorf("slot %d through a snapshot: %v %v %+v", s, g.Stay[s], g.Unseen[s], g.Voyage[s])
			}
		}
		if !bytes.Equal(AppendCheckpoint(nil, f), plainSnap) {
			t.Error("the checkpoint holds a mark")
		}
	}
	snap := AppendSnapshot(nil, f)
	w2 := edgeWorld(t, false)
	if _, err := w2.Restore(snap, w.Now()+10); err != nil {
		t.Fatal(err)
	}
	g := w2.Latest()
	if g.Stay[a.Slot] || g.Unseen[b.Slot] || g.Voyage[a.Slot].Placed {
		t.Fatal("a restore keeps the owner's marks")
	}
	// A bad trailer is refused.
	for _, bad := range [][]byte{
		append(bytes.Clone(plainSnap), 0),
		append(bytes.Clone(plainSnap), 1, byte(a.Slot), 8),
		append(bytes.Clone(plainSnap), 1, 15, 1),
	} {
		if err := ReadSnapshot(bad, bus.NewFrame(f.Capacity())); err == nil {
			t.Errorf("% x after the pairs read", bad[len(plainSnap):])
		}
	}
	// Freed and taken again, a slot starts clear.
	owned(t, w2, bus.Command{Op: bus.Unseen, Boat: g.Boat[b.Slot], On: true})
	do(t, w2, bus.Command{Op: bus.Leave, Boat: g.Boat[b.Slot]})
	c := do(t, w2, bus.Command{Op: bus.Join, Account: acct(3)})
	if c.Slot != b.Slot || w2.Latest().Unseen[c.Slot] {
		t.Fatalf("slot %d taken again unseen", c.Slot)
	}
}

func contains(s []int32, v int32) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}
