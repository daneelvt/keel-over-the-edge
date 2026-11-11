// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"math"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// A boat sails in its own look and name, as its Join gave it. In port it
// may be swapped for a boat of another kind, where it lies and at rest,
// unless another boat or shoal water is too near; and given a new look.
// Out of port neither; a place in the queue takes both, and the boat it is
// given has them; with neither, the sailor is ashore.
func TestSetBoat(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	keelboat := uint16(0)
	for i := range cat.Boats {
		if cat.Boats[i].ID == "keelboat" {
			keelboat = uint16(i)
		}
	}
	if keelboat == 0 {
		t.Fatal("no keelboat in the catalog")
	}
	// Deep water but a shoal at (1100, 0), and a port about (1000, 0).
	g := &physics.Ground{Prepared: cat.PrepareGround()}
	for _, x := range []float64{1000, 1100, 0} {
		n, _, ok := physics.ChunkOf(physics.HexCell(physics.HexAt(x, 0)))
		if !ok {
			t.Fatal("off the ground")
		}
		if g.Chunks[n] != nil {
			continue
		}
		ch := new(physics.GroundChunk)
		c0, j0 := physics.ChunkCorner(n)
		for i := range int32(physics.ChunkHexes) {
			ch.Elevation[i] = physics.DeepWater
			if cx, cy := physics.CellCentre(c0+i/physics.ChunkRows, j0+i%physics.ChunkRows); math.Abs(cx-1100) < 6 && math.Abs(cy) < 6 {
				ch.Elevation[i] = -10
			}
		}
		g.Chunks[n] = ch
	}
	terrain := &Terrain{Ground: g, Shelter: new(physics.Shelter), Ports: []Disc{{X: 1000, Y: 0, R: 300}}}
	w, err := New(Config{Capacity: 4, Kinds: kinds(t), Waves: waves(t), Workers: 2, Tick: 100, Limit: 2,
		Encounters: encounters(t), Terrain: terrain})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	ann, bob, cat3, dan := acct(1), acct(2), acct(3), acct(4)
	joined := do(t, w, bus.Command{Op: bus.Join, Account: ann, Conn: 1, BoatLook: 12<<8 | 1, BoatName: "Saltpeter"})
	if f := w.Latest(); joined.Result != bus.Joined || f.BoatLook[joined.Slot] != 12<<8|1 || f.BoatName[joined.Slot] != "Saltpeter" {
		t.Fatalf("joined %+v, look %#x %q", joined, f.BoatLook[joined.Slot], f.BoatName[joined.Slot])
	}
	place := func(boat uint64, x, y float64) {
		t.Helper()
		if r := do(t, w, bus.Command{Op: bus.Place, Boat: boat, State: physics.State{X: x, Y: y, Heading: 1, Surge: 2}}); r.Result != bus.Done {
			t.Fatalf("placed: %+v", r)
		}
	}
	swap := bus.Command{Op: bus.SetBoat, Account: ann, BoatKind: keelboat, BoatLook: 311 << 8, BoatName: "Kittiwake"}

	place(joined.Boat, 0, 0)
	if r := do(t, w, swap); r.Result != bus.Away || w.Latest().Kind[joined.Slot] != 0 {
		t.Fatalf("at sea: %+v", r)
	}
	if r := do(t, w, bus.Command{Op: bus.SetBoatLook, Account: ann, BoatLook: 3}); r.Result != bus.Away || w.Latest().BoatLook[joined.Slot] != 12<<8|1 {
		t.Fatalf("a look at sea: %+v", r)
	}
	// Beside the shoal: no room for the keelboat's keel.
	place(joined.Boat, 1097, 0)
	if r := do(t, w, swap); r.Result != bus.NoRoom || w.Latest().Kind[joined.Slot] != 0 {
		t.Fatalf("by the shoal: %+v", r)
	}
	// Beside another boat: none either.
	other := do(t, w, bus.Command{Op: bus.Join, Account: dan, Conn: 4})
	place(other.Boat, 1006, 0)
	place(joined.Boat, 1000, 0)
	if r := do(t, w, swap); r.Result != bus.NoRoom {
		t.Fatalf("beside a boat: %+v", r)
	}
	place(other.Boat, 0, 300)
	r := do(t, w, swap)
	f := w.Latest()
	s := joined.Slot
	if r.Result != bus.Done || r.Slot != s || f.Boat[s] != joined.Boat || f.Kind[s] != keelboat || f.BoatLook[s] != 311<<8 || f.BoatName[s] != "Kittiwake" {
		t.Fatalf("swapped in port: %+v, kind %d, look %#x %q", r, f.Kind[s], f.BoatLook[s], f.BoatName[s])
	}
	if st := f.State[s]; math.Abs(st.X-1000) > 0.5 || math.Abs(st.Heading-1) > 0.01 || math.Abs(st.Surge) > 0.1 {
		t.Fatalf("the keelboat lies at (%v, %v) heading %v at %v m/s", st.X, st.Y, st.Heading, st.Surge)
	}
	if c := f.Control[s]; c.SheetIndex() != bus.Steps || f.Rig[s].Reef() != 0 {
		t.Fatalf("the controls after the swap: sheet %d, reef %d", c.SheetIndex(), f.Rig[s].Reef())
	}
	if r := do(t, w, bus.Command{Op: bus.SetBoatLook, Account: ann, BoatLook: 0x45, BoatName: ""}); r.Result != bus.Done ||
		w.Latest().BoatLook[s] != 0x45 || w.Latest().BoatName[s] != "" {
		t.Fatalf("a look in port: %+v", r)
	}

	// Bob waits, the world at its limit: his place takes his boat and look.
	if r := do(t, w, bus.Command{Op: bus.Join, Account: bob, Conn: 2}); r.Result != bus.Queued {
		t.Fatalf("bob: %+v", r)
	}
	if r := do(t, w, bus.Command{Op: bus.SetBoat, Account: bob, BoatKind: keelboat, BoatLook: 2 << 8, BoatName: "Jo"}); r.Result != bus.Done || r.Slot != -1 {
		t.Fatalf("bob's swap waiting: %+v", r)
	}
	if r := do(t, w, bus.Command{Op: bus.SetBoatLook, Account: bob, BoatLook: 2<<8 | 0x12, BoatName: "Jo"}); r.Result != bus.Done || r.Slot != -1 {
		t.Fatalf("bob's look waiting: %+v", r)
	}
	do(t, w, bus.Command{Op: bus.Leave, Boat: other.Boat})
	f = w.Latest()
	for _, s := range f.Live {
		if f.Owner[s] == bob && (f.Kind[s] != keelboat || f.BoatLook[s] != 2<<8|0x12 || f.BoatName[s] != "Jo") {
			t.Fatalf("bob's boat: kind %d, look %#x %q", f.Kind[s], f.BoatLook[s], f.BoatName[s])
		}
	}
	if r := do(t, w, bus.Command{Op: bus.SetBoat, Account: cat3, BoatKind: keelboat}); r.Result != bus.NoBoat {
		t.Fatalf("ashore: %+v", r)
	}
	if r := do(t, w, bus.Command{Op: bus.SetBoatLook, Account: cat3}); r.Result != bus.NoBoat {
		t.Fatalf("a look ashore: %+v", r)
	}
}
