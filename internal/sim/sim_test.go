// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"bytes"
	"fmt"
	"math"
	"math/rand/v2"
	"reflect"
	"runtime"
	"runtime/trace"
	"slices"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// kinds is the catalog's boats, prepared.
func kinds(t testing.TB) []physics.Prepared {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	ks := make([]physics.Prepared, len(cat.Boats))
	for i := range cat.Boats {
		p := catalog.PhysicsParams(&cat.Boats[i])
		physics.Prepare(&p, &ks[i])
	}
	return ks
}

func newWorld(t testing.TB, capacity, workers int) *World {
	t.Helper()
	return limitedWorld(t, capacity, workers, 0)
}

// limitedWorld is a world that holds at most limit boats.
func limitedWorld(t testing.TB, capacity, workers, limit int) *World {
	t.Helper()
	w, err := New(Config{Capacity: capacity, Kinds: kinds(t), Workers: workers, Tick: 100, Limit: limit})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	return w
}

// send queues a developer's command and returns its reply channel.
func send(t testing.TB, w *World, c bus.Command) chan bus.Reply {
	t.Helper()
	reply := make(chan bus.Reply, 1)
	c.Reply = reply
	if err := w.Bus().Commands.Developer().TrySend(c); err != nil {
		t.Fatal(err)
	}
	return reply
}

// do sends a command, ticks and returns the reply, its tick (checked to be
// the tick just run) left out.
func do(t testing.TB, w *World, c bus.Command) bus.Reply {
	t.Helper()
	reply := send(t, w, c)
	w.Tick()
	select {
	case r := <-reply:
		if r.Tick != w.Now() {
			t.Fatalf("%s replied with tick %d, applied at %d", c.Op, r.Tick, w.Now())
		}
		r.Tick = 0
		return r
	default:
		t.Fatalf("no reply to %s", c.Op)
		return bus.Reply{}
	}
}

// stepped is s after one step with word's controls in wind.
func stepped(t testing.TB, s physics.State, word bus.Word, wind bus.Wind) physics.State {
	t.Helper()
	c := physics.Control{Helm: word.Helm(), Sheet: word.Sheet()}
	e := physics.Env{WindSpeed: wind.Speed, WindFrom: wind.From}
	var o physics.Out
	physics.Step(&s, &c, &e, &kinds(t)[0], &o)
	return s
}

// acct is a test's account n.
func acct(n uint64) bus.Account {
	var a bus.Account
	for k := range 8 {
		a[15-k] = byte(n >> (8 * k))
	}
	return a
}

func sameState(a, b physics.State) bool {
	pa, pb := StateFields(&a), StateFields(&b)
	for i := range pa {
		if math.Float64bits(*pa[i]) != math.Float64bits(*pb[i]) {
			return false
		}
	}
	return true
}

func TestJoin(t *testing.T) {
	w := newWorld(t, 128, 1)
	r := do(t, w, bus.Command{Op: bus.Join, Account: acct(10)})
	if r != (bus.Reply{Result: bus.Joined, Slot: 0, Boat: 1, Gen: 0}) {
		t.Fatalf("first join: %+v", r)
	}
	f := w.Latest()
	if f.Tick != 101 || !slices.Equal(f.Live, []int32{0}) || f.Owner[0] != acct(10) || f.Control[0] != bus.Centred(0) {
		t.Fatalf("frame after the join: tick %d, live %v, owner %s, control %#x", f.Tick, f.Live, f.Owner[0], f.Control[0])
	}
	// The boat appeared on the grid and sailed the rest of the tick.
	start := physics.State{X: -640, Y: -20, Heading: math.Pi / 2}
	if !sameState(f.State[0], stepped(t, start, bus.Centred(0), DefaultWind)) {
		t.Fatalf("state after the join %+v", f.State[0])
	}
	if got := w.Bus().Controls.Load(0); got != bus.Centred(0) {
		t.Fatalf("the control slot holds %#x", got)
	}

	if r := do(t, w, bus.Command{Op: bus.Join, Account: acct(11)}); r.Slot != 1 || r.Boat != 2 || r.Result != bus.Joined {
		t.Fatalf("second join: %+v", r)
	}
	if r := do(t, w, bus.Command{Op: bus.Join, Account: acct(10)}); r != (bus.Reply{Result: bus.Rejoined, Slot: 0, Boat: 1}) {
		t.Fatalf("the same account again: %+v", r)
	}
	for range 63 {
		send(t, w, bus.Command{Op: bus.Join, Account: acct(uint64(100 + len(w.Latest().Live)))})
		w.Tick()
	}
	if s := spawn(64); s.X != -640 || s.Y != -40 {
		t.Fatalf("slot 64 starts at %v, %v", s.X, s.Y)
	}
	if s := spawn(63); s.X != 620 || s.Y != -20 {
		t.Fatalf("slot 63 starts at %v, %v", s.X, s.Y)
	}
}

// TestFull: a world at its capacity queues; once the queue too is full,
// a join is refused.
func TestFull(t *testing.T) {
	w := newWorld(t, 2, 1)
	for i := range 2 {
		if r := do(t, w, bus.Command{Op: bus.Join, Account: acct(uint64(i))}); r.Result != bus.Joined {
			t.Fatalf("join %d: %+v", i, r)
		}
	}
	if r := do(t, w, bus.Command{Op: bus.Join, Account: acct(9)}); r != (bus.Reply{Result: bus.Queued, Slot: -1, Position: 1}) {
		t.Fatalf("join at capacity: %+v", r)
	}
	q := w.Bus().Commands.Developer()
	for i := range bus.QueueLimit - 1 {
		q.TrySend(bus.Command{Op: bus.Join, Account: acct(uint64(100 + i))})
	}
	w.Tick()
	if n := len(w.Latest().Queue); n != bus.QueueLimit {
		t.Fatalf("%d waiting", n)
	}
	if r := do(t, w, bus.Command{Op: bus.Join, Account: acct(99)}); r != (bus.Reply{Result: bus.Full, Slot: -1}) {
		t.Fatalf("join with the queue full: %+v", r)
	}
	// One already waiting keeps its place.
	if r := do(t, w, bus.Command{Op: bus.Join, Account: acct(100), Conn: 5}); r != (bus.Reply{Result: bus.Queued, Slot: -1, Position: 2}) {
		t.Fatalf("join again while waiting in a full queue: %+v", r)
	}
}

func TestLeave(t *testing.T) {
	w := newWorld(t, 4, 1)
	do(t, w, bus.Command{Op: bus.Join, Account: acct(1)})
	do(t, w, bus.Command{Op: bus.Join, Account: acct(2)})
	if r := do(t, w, bus.Command{Op: bus.Leave, Boat: 1}); r != (bus.Reply{Result: bus.Left, Slot: 0, Boat: 1, Gen: 0}) {
		t.Fatalf("leave: %+v", r)
	}
	f := w.Latest()
	if f.Occupied[0] || f.Gen[0] != 1 || !slices.Equal(f.Live, []int32{1}) {
		t.Fatalf("after leaving: occupied %v, gen %d, live %v", f.Occupied[0], f.Gen[0], f.Live)
	}
	if r := do(t, w, bus.Command{Op: bus.Leave, Boat: 1}); r.Result != bus.NoBoat {
		t.Fatalf("leaving twice: %+v", r)
	}
	r := do(t, w, bus.Command{Op: bus.Join, Account: acct(3)})
	if r != (bus.Reply{Result: bus.Joined, Slot: 0, Boat: 3, Gen: 1}) {
		t.Fatalf("the freed slot: %+v", r)
	}

	// A writer left over from the boat that had the slot cannot steer the
	// new one; the new boat's writer can.
	controls := w.Bus().Controls
	controls.Store(0, bus.Pack(9, 0, 0, 0))
	w.Tick()
	if f := w.Latest(); f.Control[0] != bus.Centred(1) || len(f.Changed) != 0 {
		t.Fatalf("a stale generation was applied: %#x", f.Control[0])
	}
	word := bus.Pack(1, 0, 1024, 1)
	controls.Store(0, word)
	w.Tick()
	if f := w.Latest(); f.Control[0] != word || !slices.Equal(f.Changed, []bus.SlotWord{{Slot: 0, Word: word}}) {
		t.Fatalf("the new boat's word was not applied: %#x, %v", f.Control[0], f.Changed)
	}
	w.Tick()
	if f := w.Latest(); len(f.Changed) != 0 {
		t.Fatalf("an unchanged word was applied again: %v", f.Changed)
	}
}

func TestSetWindAndPlace(t *testing.T) {
	w := newWorld(t, 4, 1)
	do(t, w, bus.Command{Op: bus.Join, Account: acct(1)})
	placed := physics.State{X: 5, Y: 7, Heading: 1, Surge: 2, SheetLimit: 0.5}
	wind := bus.Wind{Speed: 8, From: 1.5}
	send(t, w, bus.Command{Op: bus.SetWind, Wind: wind})
	r := do(t, w, bus.Command{Op: bus.Place, Boat: 1, State: placed})
	if r != (bus.Reply{Result: bus.Done, Slot: 0, Boat: 1}) {
		t.Fatalf("place: %+v", r)
	}
	f := w.Latest()
	if f.Wind != wind || !sameState(f.State[0], stepped(t, placed, bus.Centred(0), wind)) {
		t.Fatalf("wind %+v, state %+v", f.Wind, f.State[0])
	}
	if len(f.Events) != 2 || f.Events[0].Op != bus.SetWind || f.Events[1].Reply.Result != bus.Done || f.Events[1].Command.Reply != nil {
		t.Fatalf("events %+v", f.Events)
	}
	if r := do(t, w, bus.Command{Op: bus.Place, Boat: 99}); r.Result != bus.NoBoat {
		t.Fatalf("placing no boat: %+v", r)
	}
}

// A boat stepped by the tick is the boat physics.Step gives, bit for bit,
// with its controls changing as it goes.
func TestTickMatchesStep(t *testing.T) {
	w := newWorld(t, 4, 1)
	do(t, w, bus.Command{Op: bus.Join, Account: acct(1)})
	want := w.Latest().State[0]
	rng := rand.New(rand.NewPCG(1, 2))
	word := bus.Centred(0)
	for i := range 900 {
		if i%20 == 0 {
			word = bus.Pack(uint32(i), uint16(rng.IntN(bus.Steps+1)), uint16(rng.IntN(bus.Steps+1)), 0)
			w.Bus().Controls.Store(0, word)
		}
		w.Tick()
		want = stepped(t, want, word, DefaultWind)
		if got := w.Latest().State[0]; !sameState(got, want) {
			t.Fatalf("tick %d: %+v, Step gives %+v", i, got, want)
		}
	}
}

func TestSkip(t *testing.T) {
	w := newWorld(t, 4, 1)
	do(t, w, bus.Command{Op: bus.Join, Account: acct(1)})
	before := w.Latest().State[0]
	w.Skip(5)
	w.Tick()
	f := w.Latest()
	if f.Tick != 107 || f.Skipped != 5 {
		t.Fatalf("tick %d, skipped %d", f.Tick, f.Skipped)
	}
	// A skipped tick moves nobody: one step, not six.
	if !sameState(f.State[0], stepped(t, before, bus.Centred(0), DefaultWind)) {
		t.Fatal("boats moved during the skip")
	}
	w.Tick()
	if f := w.Latest(); f.Tick != 108 || f.Skipped != 0 {
		t.Fatalf("after: tick %d, skipped %d", f.Tick, f.Skipped)
	}
}

func TestTickWith(t *testing.T) {
	w := newWorld(t, 4, 1)
	w.TickWith(&Input{Commands: []bus.Command{{Op: bus.Join, Account: acct(4)}}})
	word := bus.Pack(3, 100, 900, 0)
	w.TickWith(&Input{Changed: []bus.SlotWord{{Slot: 0, Word: word}, {Slot: 3, Word: word}, {Slot: -1}}})
	f := w.Latest()
	if f.Control[0] != word || len(f.Changed) != 1 {
		t.Fatalf("control %#x, changed %v", f.Control[0], f.Changed)
	}
	// A replay's ticks read nothing from the bus.
	w.Bus().Controls.Store(0, bus.Pack(4, 0, 0, 0))
	w.TickWith(&Input{})
	if f := w.Latest(); f.Control[0] != word {
		t.Fatal("TickWith read the control slots")
	}
}

// fill joins n boats, gives them random controls and sails them a while.
func fill(t testing.TB, w *World, n int, seed uint64) {
	t.Helper()
	q := w.Bus().Commands.Developer()
	for i := range n {
		if err := q.TrySend(bus.Command{Op: bus.Join, Account: acct(uint64(i + 1)), Conn: uint64(3 * (i + 1))}); err != nil {
			t.Fatal(err)
		}
	}
	w.Tick()
	if got := len(w.Latest().Live); got != n {
		t.Fatalf("%d boats joined, not %d", got, n)
	}
	sail(w, 30, seed)
}

// sail runs ticks, changing a third of the boats' controls each tick.
func sail(w *World, ticks int, seed uint64) {
	rng := rand.New(rand.NewPCG(seed, 0))
	for range ticks {
		f := w.Latest()
		for i, s := range f.Live {
			if i%3 == rng.IntN(3) {
				w.Bus().Controls.Store(s, bus.Pack(uint32(f.Tick), uint16(rng.IntN(bus.Steps+1)), uint16(rng.IntN(bus.Steps+1)), f.Gen[s]))
			}
		}
		w.Tick()
	}
}

func TestWorkersGiveTheSameWorld(t *testing.T) {
	var want []byte
	for _, n := range []int{1, 2, 3, 8} {
		w := newWorld(t, 2048, n)
		fill(t, w, 1000, 1)
		sail(w, 60, 2)
		got := AppendSnapshot(nil, w.Latest())
		if want == nil {
			want = got
		} else if !bytes.Equal(got, want) {
			t.Fatalf("%d workers: a different world from 1 worker's", n)
		}
		if w.Workers() != n {
			t.Errorf("1,000 boats used %d of %d workers", w.Workers(), n)
		}
	}
}

func TestFewBoatsUseOneGoroutine(t *testing.T) {
	w := newWorld(t, 64, 8)
	fill(t, w, minRange-1, 1)
	if w.Workers() != 1 {
		t.Fatalf("%d boats used %d workers", minRange-1, w.Workers())
	}
	fill(t, w, 2*minRange, 1)
	if w.Workers() != 2 {
		t.Fatalf("%d boats used %d workers", 2*minRange, w.Workers())
	}
}

// TestStateFields checks the list the snapshot and the digest read has every
// field of State, in order.
func TestStateFields(t *testing.T) {
	var s physics.State
	v := reflect.ValueOf(&s).Elem()
	fields := StateFields(&s)
	if v.NumField() != len(fields) {
		t.Fatalf("State has %d fields, StateFields lists %d", v.NumField(), len(fields))
	}
	for i, p := range fields {
		if v.Field(i).Addr().Interface().(*float64) != p {
			t.Errorf("StateFields[%d] is not State.%s", i, v.Type().Field(i).Name)
		}
	}
}

// world for snapshot tests: boats in scattered slots, freed slots with
// generations, states with every kind of float.
func scatteredWorld(t testing.TB) *World {
	w := limitedWorld(t, 300, 1, 210)
	fill(t, w, 200, 5)
	q := w.Bus().Commands.Developer()
	for b := uint64(3); b < 200; b += 7 {
		q.TrySend(bus.Command{Op: bus.Leave, Boat: b})
	}
	odd := physics.State{X: math.Inf(-1), Y: math.Copysign(0, -1), Heading: math.NaN(), Surge: 5e-324, SailorMode: 3}
	q.TrySend(bus.Command{Op: bus.Place, Boat: 10, State: odd})
	q.TrySend(bus.Command{Op: bus.SetWind, Wind: bus.Wind{Speed: 3, From: -2}})
	// Some sailors' connections end: their graces run.
	for b := uint64(5); b < 200; b += 11 {
		q.TrySend(bus.Command{Op: bus.Disconnect, Boat: b, Conn: 3 * b})
	}
	w.Tick()
	// More join than the limit has room for: some wait.
	for i := range 45 {
		q.TrySend(bus.Command{Op: bus.Join, Account: acct(uint64(1000 + i)), Conn: uint64(5000 + i)})
	}
	w.Tick()
	if len(w.Latest().Queue) == 0 {
		t.Fatal("nobody waits")
	}
	return w
}

func TestSnapshotRoundTrips(t *testing.T) {
	w := scatteredWorld(t)
	f := w.Latest()
	snap := AppendSnapshot(nil, f)
	g := bus.NewFrame(f.Capacity())
	if err := ReadSnapshot(snap, g); err != nil {
		t.Fatal(err)
	}
	if again := AppendSnapshot(nil, g); !bytes.Equal(again, snap) {
		t.Fatal("a snapshot read and written again differs")
	}
	if g.Tick != f.Tick || g.Wind != f.Wind || g.NextBoat != f.NextBoat || g.Held != f.Held || !slices.Equal(g.Live, f.Live) ||
		!slices.Equal(g.Gen, f.Gen) || !slices.Equal(g.Occupied, f.Occupied) || !slices.Equal(g.Queue, f.Queue) {
		t.Fatal("the frame read differs")
	}
	for _, s := range f.Live {
		if g.Boat[s] != f.Boat[s] || g.Owner[s] != f.Owner[s] || g.Conn[s] != f.Conn[s] || g.Grace[s] != f.Grace[s] ||
			g.Kind[s] != f.Kind[s] || g.Control[s] != f.Control[s] || !sameState(g.State[s], f.State[s]) {
			t.Fatalf("slot %d differs", s)
		}
	}
	if Digest(g) != Digest(f) {
		t.Fatal("the digests differ")
	}
	graces := 0
	for _, s := range g.Live {
		if g.Grace[s] != 0 {
			graces++
		}
	}
	if graces == 0 {
		t.Fatal("no grace in the snapshot")
	}

	// Loading it into a new world of the same limit and ticking both gives
	// the same world.
	w2 := limitedWorld(t, 300, 2, 210)
	if err := w2.Load(snap); err != nil {
		t.Fatal(err)
	}
	w.Tick()
	w2.Tick()
	if !bytes.Equal(AppendSnapshot(nil, w.Latest()), AppendSnapshot(nil, w2.Latest())) {
		t.Fatal("the loaded world ticked differently")
	}
}

func TestSnapshotRejects(t *testing.T) {
	w := scatteredWorld(t)
	snap := AppendSnapshot(nil, w.Latest())
	g := bus.NewFrame(300)
	for n := range len(snap) {
		if err := ReadSnapshot(snap[:n], g); err == nil {
			t.Fatalf("a snapshot cut to %d of %d bytes was read", n, len(snap))
		}
	}
	if err := ReadSnapshot(append(slices.Clip(snap), 0), g); err == nil {
		t.Fatal("trailing data was read")
	}
	if err := ReadSnapshot(snap, bus.NewFrame(299)); err == nil {
		t.Fatal("a snapshot was read into a frame of another capacity")
	}
	bad := slices.Clone(snap)
	bad[0] = 9
	if err := ReadSnapshot(bad, g); err == nil {
		t.Fatal("another version was read")
	}
}

func TestDigest(t *testing.T) {
	w := scatteredWorld(t)
	f := w.Latest()
	d := Digest(f)
	g := bus.NewFrame(f.Capacity())
	if err := ReadSnapshot(AppendSnapshot(nil, f), g); err != nil {
		t.Fatal(err)
	}
	s := g.Live[len(g.Live)/2]
	g.State[s].Sway = math.Float64frombits(math.Float64bits(g.State[s].Sway) ^ 1)
	if Digest(g) == d {
		t.Fatal("a one-bit change in a state left the digest the same")
	}
	g.State[s] = f.State[s]
	g.Control[s] ^= 1 << 40
	if Digest(g) == d {
		t.Fatal("a changed control word left the digest the same")
	}
	g.Control[s] = f.Control[s]
	for name, change := range map[string]func(){
		"owner":            func() { g.Owner[s][3] ^= 1 },
		"connection":       func() { g.Conn[s]++ },
		"grace":            func() { g.Grace[s]++ },
		"waiting account":  func() { g.Queue[1].Account[0] ^= 1 },
		"waiting conn":     func() { g.Queue[1].Conn++ },
		"waiting since":    func() { g.Queue[1].Since++ },
		"waiting grace":    func() { g.Queue[1].Grace++ },
		"hold":             func() { g.Held = !g.Held },
		"queue's order":    func() { g.Queue[0], g.Queue[1] = g.Queue[1], g.Queue[0] },
		"one waiting less": func() { g.Queue = g.Queue[1:] },
	} {
		change()
		if Digest(g) == d {
			t.Errorf("a changed %s left the digest the same", name)
		}
		if err := ReadSnapshot(AppendSnapshot(nil, f), g); err != nil {
			t.Fatal(err)
		}
	}
}

func TestGrace(t *testing.T) {
	w := newWorld(t, 8, 1)
	if r := do(t, w, bus.Command{Op: bus.Join, Account: acct(1), Conn: 7}); r.Result != bus.Joined {
		t.Fatalf("join: %+v", r)
	}
	boat := uint64(1)
	f := w.Latest()
	if f.Conn[0] != 7 || f.Grace[0] != 0 {
		t.Fatalf("connection %d, grace %d", f.Conn[0], f.Grace[0])
	}
	// Another connection's end is not this boat's.
	if r := do(t, w, bus.Command{Op: bus.Disconnect, Boat: boat, Conn: 8}); r.Result != bus.Stale || w.Latest().Grace[0] != 0 {
		t.Fatalf("a stale disconnection: %+v, grace %d", r, w.Latest().Grace[0])
	}
	if r := do(t, w, bus.Command{Op: bus.Disconnect, Boat: 99, Conn: 7}); r.Result != bus.NoBoat {
		t.Fatalf("no boat: %+v", r)
	}
	if r := do(t, w, bus.Command{Op: bus.Disconnect, Boat: boat, Conn: 7}); r.Result != bus.Done {
		t.Fatalf("disconnect: %+v", r)
	}
	if got, want := w.Latest().Grace[0], w.Now()+GraceTicks; got != want {
		t.Fatalf("grace ends at %d, want %d", got, want)
	}
	// Back within the grace: the same boat, the grace over.
	for range 100 {
		w.Tick()
	}
	if r := do(t, w, bus.Command{Op: bus.Join, Account: acct(1), Conn: 9}); r.Result != bus.Rejoined || r.Boat != boat {
		t.Fatalf("rejoin: %+v", r)
	}
	if f := w.Latest(); f.Conn[0] != 9 || f.Grace[0] != 0 {
		t.Fatalf("after rejoining: connection %d, grace %d", f.Conn[0], f.Grace[0])
	}
	// Gone again, for the whole grace: the boat sails on its held controls
	// until the grace's last tick, then leaves.
	word := bus.Pack(uint32(w.Now()+1), 300, 700, 0)
	w.Bus().Controls.Store(0, word)
	do(t, w, bus.Command{Op: bus.Disconnect, Boat: boat, Conn: 9})
	end := w.Latest().Grace[0]
	for w.Now() < end-1 {
		w.Tick()
	}
	if f := w.Latest(); !f.Occupied[0] || f.Control[0] != word {
		t.Fatalf("the boat left before its grace ended, or dropped its controls: %#x", f.Control[0])
	}
	w.Tick()
	f = w.Latest()
	if f.Tick != end || f.Occupied[0] || len(f.Live) != 0 {
		t.Fatalf("at tick %d (grace ends %d): occupied %v", f.Tick, end, f.Occupied[0])
	}
	if len(f.Events) != 1 || f.Events[0].Op != bus.Leave || f.Events[0].Boat != boat ||
		f.Events[0].Reply != (bus.Reply{Result: bus.Expired, Slot: 0, Boat: boat, Gen: 0, Tick: end}) {
		t.Fatalf("events %+v", f.Events)
	}
	// The next join is a new boat at the start.
	if r := do(t, w, bus.Command{Op: bus.Join, Account: acct(1), Conn: 10}); r.Result != bus.Joined || r.Boat == boat || r.Gen != 1 {
		t.Fatalf("after the grace: %+v", r)
	}
}

// TestGraceAcrossSkip: a grace that ends during skipped ticks ends at the
// first tick run after.
func TestGraceAcrossSkip(t *testing.T) {
	w, err := New(Config{Capacity: 4, Kinds: kinds(t), Workers: 1, Tick: 100, Grace: 10})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	do(t, w, bus.Command{Op: bus.Join, Account: acct(1), Conn: 1})
	do(t, w, bus.Command{Op: bus.Disconnect, Boat: 1, Conn: 1})
	w.Skip(50)
	w.Tick()
	if f := w.Latest(); len(f.Live) != 0 || len(f.Events) != 1 || f.Events[0].Reply.Result != bus.Expired {
		t.Fatalf("live %v, events %+v", f.Live, f.Events)
	}
}

// TestWordWaitsForItsTick: a word is applied at the tick it is stamped for
// when it arrives before it, at once when it arrives late or stamped more
// than bus.MaxAhead ahead, and a newer word replaces one still waiting.
func TestWordWaitsForItsTick(t *testing.T) {
	for _, start := range []int64{100, 1<<32 - 3} { // the second crosses the wrap of seq
		w, err := New(Config{Capacity: 4, Kinds: kinds(t), Workers: 1, Tick: start})
		if err != nil {
			t.Fatal(err)
		}
		do(t, w, bus.Command{Op: bus.Join, Account: acct(1), Conn: 1})
		controls := w.Bus().Controls
		appliedAt := func(word bus.Word, limit int) int64 {
			t.Helper()
			for range limit {
				w.Tick()
				f := w.Latest()
				if f.Control[0] == word {
					if !slices.Equal(f.Changed, []bus.SlotWord{{Slot: 0, Word: word}}) {
						t.Fatalf("changed %v", f.Changed)
					}
					return f.Tick
				}
			}
			return -1
		}

		at := w.Now() + 5
		word := bus.Pack(uint32(at), 100, 200, 0)
		controls.Store(0, word)
		if got := appliedAt(word, 10); got != at {
			t.Fatalf("from %d: a word for tick %d applied at %d", start, at, got)
		}
		late := bus.Pack(uint32(w.Now()-3), 101, 200, 0)
		controls.Store(0, late)
		if want, got := w.Now()+1, appliedAt(late, 3); got != want {
			t.Fatalf("from %d: a late word applied at %d, want %d", start, got, want)
		}
		far := bus.Pack(uint32(w.Now()+1+bus.MaxAhead+1), 102, 200, 0)
		controls.Store(0, far)
		if want, got := w.Now()+1, appliedAt(far, 3); got != want {
			t.Fatalf("from %d: a word too far ahead applied at %d, want %d", start, got, want)
		}
		at = w.Now() + 1 + bus.MaxAhead
		held := bus.Pack(uint32(at), 103, 200, 0)
		controls.Store(0, held)
		if got := appliedAt(held, bus.MaxAhead+3); got != at {
			t.Fatalf("from %d: a word %d ticks ahead applied at %d, want %d", start, bus.MaxAhead, got, at)
		}

		// A newer word, stamped sooner, replaces one still waiting.
		waiting := bus.Pack(uint32(w.Now()+8), 104, 200, 0)
		newer := bus.Pack(uint32(w.Now()+3), 105, 200, 0)
		controls.Store(0, waiting)
		w.Tick()
		controls.Store(0, newer)
		at = w.Now() + 2
		if got := appliedAt(newer, 5); got != at {
			t.Fatalf("from %d: the newer word applied at %d, want %d", start, got, at)
		}
		for range 10 {
			w.Tick()
			if w.Latest().Control[0] == waiting {
				t.Fatalf("from %d: the replaced word was applied", start)
			}
		}
		w.Close()
	}
}

// TestRejoinDropsWaitingWord: a word the old connection left waiting for
// its tick is never applied once the account has joined again.
func TestRejoinDropsWaitingWord(t *testing.T) {
	w := newWorld(t, 4, 1)
	do(t, w, bus.Command{Op: bus.Join, Account: acct(1), Conn: 1})
	inForce := w.Latest().Control[0]
	stale := bus.Pack(uint32(w.Now()+10), 0, 0, 0)
	w.Bus().Controls.Store(0, stale)
	do(t, w, bus.Command{Op: bus.Join, Account: acct(1), Conn: 2})
	if got := w.Bus().Controls.Load(0); got != inForce {
		t.Fatalf("the slot holds %#x after the rejoin, not the word in force %#x", got, inForce)
	}
	for range 20 {
		w.Tick()
		if w.Latest().Control[0] == stale {
			t.Fatal("the old connection's waiting word was applied")
		}
	}
}

func TestNewRejects(t *testing.T) {
	if _, err := New(Config{}); err == nil {
		t.Fatal("a world with no kinds")
	}
	if _, err := New(Config{Capacity: -1, Kinds: kinds(t)}); err == nil {
		t.Fatal("a world of negative capacity")
	}
}

func TestPhaseNames(t *testing.T) {
	for p := range Phases {
		if p.String() == "unknown" {
			t.Errorf("phase %d has no name", p)
		}
	}
}

// TestTickAllocatesNothing: ticks with a thousand boats at the world's
// limit, a third of them changing controls, some of those words held for a
// later tick, and every tick a join that waits, a leave that makes room for
// it, another join that waits and gives up, a disconnection, a sailor's
// return and, a few ticks later, a grace that ends.
func TestTickAllocatesNothing(t *testing.T) {
	w, err := New(Config{Capacity: Capacity, Kinds: kinds(t), Workers: 4, Tick: 100, Grace: 5, Limit: 1000})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	fill(t, w, 1000, 1)
	rng := rand.New(rand.NewPCG(3, 3))
	q := w.Bus().Commands.Developer()
	account := uint64(5000)
	reply := make(chan bus.Reply, 1)
	var queued, left int // joins that waited; and those still waiting after a tick
	tick := func() {
		f := w.Latest()
		for i, s := range f.Live {
			if i%3 == 0 {
				w.Bus().Controls.Store(s, bus.Pack(uint32(f.Tick+int64(i%5)), uint16(rng.IntN(bus.Steps+1)), 512, f.Gen[s]))
			}
		}
		q.TrySend(bus.Command{Op: bus.Join, Account: acct(account), Conn: account, Reply: reply})
		q.TrySend(bus.Command{Op: bus.Leave, Boat: f.Boat[f.Live[len(f.Live)/2]]})
		q.TrySend(bus.Command{Op: bus.Join, Account: acct(account + 1<<32), Conn: account})
		q.TrySend(bus.Command{Op: bus.Disconnect, Account: acct(account + 1<<32), Conn: account})
		s := f.Live[len(f.Live)/3]
		q.TrySend(bus.Command{Op: bus.Disconnect, Boat: f.Boat[s], Conn: f.Conn[s]})
		s = f.Live[len(f.Live)/4]
		q.TrySend(bus.Command{Op: bus.Join, Account: f.Owner[s], Conn: f.Conn[s] + 1})
		account++
		w.Tick()
		if r := <-reply; r.Result == bus.Queued {
			queued++
		}
		left += len(w.Latest().Queue)
	}
	for range 10 {
		tick()
	}
	if n := testing.AllocsPerRun(100, tick); n != 0 {
		t.Fatalf("a tick allocates %v times", n)
	}
	if queued < 50 || left != 0 {
		t.Fatalf("%d of 111 joins waited; %d were left waiting", queued, left)
	}
}

func BenchmarkTick(b *testing.B) {
	for _, n := range []int{1, 100, 1000, 4000} {
		b.Run(fmt.Sprint(n), func(b *testing.B) {
			w := newWorld(b, Capacity, runtime.GOMAXPROCS(0))
			fill(b, w, n, 1)
			b.ReportAllocs()
			for b.Loop() {
				w.Tick()
			}
			b.ReportMetric(float64(w.Workers()), "workers")
		})
	}
}

// TestRegionsAllocateNothingWhileTracing: the tick's phases run in trace
// regions, which must not allocate while the flight recorder traces. Ticks
// of one boat are short, so the tracer's own allocations, on its goroutine,
// do not reach one per tick.
func TestRegionsAllocateNothingWhileTracing(t *testing.T) {
	fr := trace.NewFlightRecorder(trace.FlightRecorderConfig{MinAge: 10 * time.Second, MaxBytes: 32 << 20})
	if err := fr.Start(); err != nil {
		t.Fatal(err)
	}
	defer fr.Stop()
	w := newWorld(t, 8, 1)
	fill(t, w, 1, 1)
	if n := testing.AllocsPerRun(1000, w.Tick); n != 0 {
		t.Fatalf("a tick allocates %v times while tracing", n)
	}
}
