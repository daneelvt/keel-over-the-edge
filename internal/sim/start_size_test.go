// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"math"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// A boat starts by its size: a keelboat joining among dinghies passes a
// place 10 m from one, where its hull would lie within 5 m of the other's,
// and one in 1.5 m of water, too shallow for its keel, and starts at the
// first that fits; a dinghy takes either.
func TestStartPlacesBySize(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	ks := kinds(t)
	keelboat := -1
	for i := range cat.Boats {
		if cat.Boats[i].ID == "keelboat" {
			keelboat = i
		}
	}
	if keelboat < 0 {
		t.Fatal("no keelboat in the catalog")
	}
	jolly, keel := &ks[0], &ks[keelboat]
	if d := physics.Draught(jolly) + startDeep; d > 1.5 {
		t.Fatalf("the first boat needs %.2f m of water: the shallow place does not fit it", d)
	}
	if d := physics.Draught(keel) + startDeep; d <= 1.5 {
		t.Fatalf("the keelboat needs only %.2f m of water", d)
	}
	if r := physics.Radius(jolly) + physics.Radius(keel) + startClear; r <= 10 {
		t.Fatalf("the keelboat fits within %.1f m of a dinghy", r)
	}
	// Places along a line, the fourth 10 m from the third, the fifth in
	// shoal water; deep water elsewhere.
	const y = -2000
	start := []physics.State{{X: 0, Y: y}, {X: 20, Y: y}, {X: 40, Y: y}, {X: 50, Y: y}, {X: 70, Y: y}, {X: 100, Y: y}}
	for i := range start {
		start[i].Heading = math.Pi / 2
	}
	g := &physics.Ground{Prepared: cat.PrepareGround()}
	n, _, ok := physics.ChunkOf(physics.HexCell(physics.HexAt(70, y)))
	if !ok {
		t.Fatal("the shoal is off the ground")
	}
	ch := new(physics.GroundChunk)
	c0, j0 := physics.ChunkCorner(n)
	for i := range int32(physics.ChunkHexes) {
		ch.Elevation[i] = physics.DeepWater
		if x, cy := physics.CellCentre(c0+i/physics.ChunkRows, j0+i%physics.ChunkRows); math.Abs(x-70) < 8 && math.Abs(cy-y) < 8 {
			ch.Elevation[i] = -15
		}
	}
	g.Chunks[n] = ch
	if e, _ := g.At(70, y); e != -1.5 {
		t.Fatalf("the shoal is %.1f m deep", -e)
	}
	w := terrainWorld(t, 8, 1, &Terrain{Ground: g, Shelter: new(physics.Shelter), Start: start})
	for i := range 3 {
		if r := do(t, w, bus.Command{Op: bus.Join, Account: acct(uint64(i + 1))}); r.Result != bus.Joined || r.Slot != int32(i) {
			t.Fatalf("dinghy %d: %+v", i, r)
		}
	}
	r := do(t, w, bus.Command{Op: bus.Join, Account: acct(9), BoatKind: uint16(keelboat)})
	f := w.Latest()
	if r.Result != bus.Joined || f.Kind[r.Slot] != uint16(keelboat) {
		t.Fatalf("the keelboat: %+v, of kind %d", r, f.Kind[r.Slot])
	}
	// A tick on from its place: within a few centimetres of it.
	if st := f.State[r.Slot]; math.Hypot(st.X-100, st.Y-y) > 0.1 {
		t.Errorf("the keelboat starts at (%v, %v), not the last place", st.X, st.Y)
	}
	// Dinghies take the places it passed: the next slot's place first.
	for _, want := range []float64{70, 50} {
		r := do(t, w, bus.Command{Op: bus.Join, Account: acct(uint64(10 + want))})
		f := w.Latest()
		if st := f.State[r.Slot]; r.Result != bus.Joined || f.Kind[r.Slot] != 0 || math.Abs(st.X-want) > 0.1 {
			t.Errorf("a dinghy after the keelboat: %+v, of kind %d, at x = %v (want %v)", r, f.Kind[r.Slot], st.X, want)
		}
	}
	// A kind the world does not have is its first.
	r = do(t, w, bus.Command{Op: bus.Join, Account: acct(99), BoatKind: uint16(len(ks))})
	if f := w.Latest(); r.Result != bus.Joined || f.Kind[r.Slot] != 0 {
		t.Errorf("a join of no kind the world has: %+v, of kind %d", r, f.Kind[r.Slot])
	}
}
