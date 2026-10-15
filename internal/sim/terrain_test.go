// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"math"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// beachTerrain is land about the centre: a sandy slope rising east, dry
// from x = 150, and the start area's places in a row in deep water west of
// it, heading east.
func beachTerrain(t testing.TB) *Terrain {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	g := &physics.Ground{Prepared: cat.PrepareGround()}
	for _, n := range []int32{7*physics.ChunkSide + 7, 7*physics.ChunkSide + 8, 8*physics.ChunkSide + 7, 8*physics.ChunkSide + 8} {
		ch := new(physics.GroundChunk)
		c0, j0 := physics.ChunkCorner(n)
		for i := range int32(physics.ChunkHexes) {
			x, _ := physics.CellCentre(c0+i/physics.ChunkRows, j0+i%physics.ChunkRows)
			ch.Elevation[i] = int16(math.Round(10 * math.Max(-4, -4+(x-50)/25)))
		}
		g.Chunks[n] = ch
	}
	var start []physics.State
	for i := range 64 {
		start = append(start, physics.State{X: 100, Y: float64(20 * (i - 32)), Heading: math.Pi / 2})
	}
	return &Terrain{Ground: g, Shelter: new(physics.Shelter), Start: start}
}

func terrainWorld(t testing.TB, capacity, workers int, terrain *Terrain) *World {
	t.Helper()
	w, err := New(Config{Capacity: capacity, Kinds: kinds(t), Waves: waves(t), Workers: workers, Tick: 100,
		Encounters: encounters(t), Terrain: terrain, Weather: nil})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	return w
}

// TestGroundingReplays: boats run aground on the beach and are pushed off;
// a world loaded from a snapshot taken while one is aground, given the same
// inputs, goes on tick for tick as the one it was taken from.
func TestGroundingReplays(t *testing.T) {
	terrain := beachTerrain(t)
	a := terrainWorld(t, 16, 2, terrain)
	q := a.Bus().Commands.Developer()
	for i := range 4 {
		if err := q.TrySend(bus.Command{Op: bus.Join, Account: acct(uint64(i + 1)), Conn: uint64(i + 1)}); err != nil {
			t.Fatal(err)
		}
	}
	a.Tick()
	f := a.Latest()
	if len(f.Live) != 4 {
		t.Fatalf("%d boats", len(f.Live))
	}
	for _, s := range f.Live {
		if st := f.State[s]; math.Abs(st.X-100) > 1 {
			t.Fatalf("a boat started at (%v, %v), not in the start area", st.X, st.Y)
		}
	}
	// Each boat runs east before the wind (10 knots from the north, steady
	// by default), onto the beach.
	input := func(f *bus.Frame) Input {
		var in Input
		for _, s := range f.Live {
			in.Changed = append(in.Changed, bus.SlotWord{Slot: s, Word: bus.Pack(uint32(f.Tick+1), bus.Steps/2, bus.Steps*3/4, f.Gen[s])})
		}
		return in
	}
	var snapshot []byte
	var inputs []Input
	aground := false
	for range 30 * 90 {
		in := input(a.Latest())
		if snapshot != nil {
			inputs = append(inputs, in)
		}
		a.TickWith(&in)
		f := a.Latest()
		for _, s := range f.Live {
			if f.State[s].GroundTimer > 0 {
				aground = true
				if snapshot == nil {
					snapshot = AppendSnapshot(nil, f)
				}
			}
		}
	}
	if !aground {
		t.Fatal("no boat ran aground")
	}
	b := terrainWorld(t, 16, 1, terrain)
	if err := b.Load(snapshot); err != nil {
		t.Fatal(err)
	}
	want := make([]uint64, 0, len(inputs))
	// a's digests from the snapshot on, made again by replaying a too.
	c := terrainWorld(t, 16, 3, terrain)
	if err := c.Load(snapshot); err != nil {
		t.Fatal(err)
	}
	for i := range inputs {
		c.TickWith(&inputs[i])
		want = append(want, Digest(c.Latest()))
	}
	for i := range inputs {
		b.TickWith(&inputs[i])
		if got := Digest(b.Latest()); got != want[i] {
			t.Fatalf("tick %d after the snapshot: the digests differ", i+1)
		}
	}
	if Digest(b.Latest()) != Digest(a.Latest()) {
		t.Fatal("the world loaded while aground ends other than the one it was taken from")
	}
}

// TestFetchFollowsLand: an area with a short fetch has its waves' inputs
// with that fetch; every other area is open water's, as with no terrain.
func TestFetchFollowsLand(t *testing.T) {
	fetch := make([]physics.Fetch, seaAreas)
	for i := range fetch {
		for k := range fetch[i] {
			fetch[i][k] = waves(t).FetchCap()
		}
	}
	const area = 18*physics.SeaAreas + 20
	for k := range fetch[area] {
		fetch[area][k] = 500
	}
	land := terrainWorld(t, 4, 1, &Terrain{Fetch: fetch})
	open := terrainWorld(t, 4, 1, nil)
	for range 40 {
		land.Tick()
		open.Tick()
	}
	l, o := land.Latest().Sea.Now, open.Latest().Sea.Now
	for i := range l {
		switch {
		case i == area:
			if l[i].Fetch != 500 || l[i].Speed != o[i].Speed || l[i].From != o[i].From {
				t.Errorf("the sheltered area's inputs are %+v; open water's %+v", l[i], o[i])
			}
		case l[i] != o[i]:
			t.Fatalf("area %d's inputs differ from open water's: %+v, %+v", i, l[i], o[i])
		}
	}
}

// TestTickWithLandAllocatesNothing: a tick of a thousand boats on a world
// with land, some of them aground, allocates nothing.
func TestTickWithLandAllocatesNothing(t *testing.T) {
	if testing.Short() {
		t.Skip("a thousand boats for twenty seconds")
	}
	w := terrainWorld(t, Capacity, 4, beachTerrain(t))
	fill(t, w, 1000, 1)
	sail(w, 30*20, 2)
	if n := testing.AllocsPerRun(100, w.Tick); n != 0 {
		t.Fatalf("a tick allocates %v times", n)
	}
}

func BenchmarkTickWithLand(b *testing.B) {
	w := terrainWorld(b, Capacity, 4, beachTerrain(b))
	fill(b, w, 1000, 1)
	b.ReportAllocs()
	for b.Loop() {
		w.Tick()
	}
}
