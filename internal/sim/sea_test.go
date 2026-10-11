// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"fmt"
	"math"
	"runtime"
	"slices"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// seaWorld is a world with the catalog's sea, at tick tick.
func seaWorld(t testing.TB, tick int64, workers int) *World {
	t.Helper()
	w, err := New(Config{Capacity: 64, Kinds: kinds(t), Waves: waves(t), Workers: workers, Tick: tick, Grace: 600})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	return w
}

// under is the sea a wind raises: every area's inputs.
func under(t testing.TB, wind bus.Wind) physics.SeaInput {
	t.Helper()
	return waves(t).OpenSea(wind.Speed, wind.From)
}

func uniform(areas []physics.SeaInput, in physics.SeaInput) bool {
	return !slices.ContainsFunc(areas, func(a physics.SeaInput) bool { return a != in })
}

// A world starts with the sea its wind raises, in every area.
func TestSeaAtStart(t *testing.T) {
	w := seaWorld(t, 100, 1)
	f := w.Latest()
	in := under(t, DefaultWind)
	if in.Speed != 514 || in.From != 0 || in.Fetch != 11112 {
		t.Fatalf("10 knots from the north over open water is %+v", in)
	}
	if len(f.Sea.Now) != physics.SeaAreas*physics.SeaAreas || !uniform(f.Sea.Now, in) || !uniform(f.Sea.Next, in) {
		t.Fatalf("the sea at the start is not the wind's everywhere")
	}
	w.Tick()
	if hs := w.sea.view.Window.Hs[0]; hs < 0.2 || hs > 0.3 {
		t.Errorf("10 knots raise waves of %.2f m, want about a quarter of a metre", hs)
	}
	// A world with no waves has a sea of nothing, and flat water.
	flat := newWorld(t, 4, 1)
	flat.Tick()
	if !uniform(flat.Latest().Sea.Now, physics.SeaInput{}) || flat.sea.at != nil {
		t.Error("a world with no waves has a sea")
	}
}

// A change of wind reaches the waves no sooner than the next second but
// one, whatever tick of a second it comes at: the sea of a second is fixed
// in the second before, so that every client hears of it in time.
func TestSetWindReachesTheSeaASecondAhead(t *testing.T) {
	gale := bus.Wind{Speed: 34 * 1852.0 / 3600, From: 2}
	for offset := range int64(bus.SeaPeriod) {
		w := seaWorld(t, 119, 1)
		do(t, w, bus.Command{Op: bus.Join, Account: acct(1)})
		for w.Now() < 150+offset-1 {
			w.Tick()
		}
		do(t, w, bus.Command{Op: bus.SetWind, Wind: gale})
		at := w.Now()
		if at != 150+offset || w.Latest().Wind != gale {
			t.Fatalf("the wind changed at tick %d", at)
		}
		old, raised := under(t, DefaultWind), under(t, gale)
		fixed := (bus.SeaSecond(at) + 1) * bus.SeaPeriod // the next second's first tick
		applies := fixed + bus.SeaPeriod
		calm := w.sea.view.Window.Hs[0]
		for w.Now() < applies+bus.SeaPeriod {
			f := w.Latest()
			wantNow, wantNext := old, old
			if f.Tick >= fixed {
				wantNext = raised
			}
			if f.Tick >= applies {
				wantNow = raised
			}
			if !uniform(f.Sea.Now, wantNow) || !uniform(f.Sea.Next, wantNext) {
				t.Fatalf("wind changed at tick %d: at tick %d the sea is %+v, next %+v; want %+v, %+v",
					at, f.Tick, f.Sea.Now[0], f.Sea.Next[0], wantNow, wantNext)
			}
			// The steps sail in the frame's sea, never the next one early.
			win := w.sea.view.Window
			if !slices.Equal(win.Inputs, f.Sea.Now) {
				t.Fatalf("wind changed at tick %d: at tick %d the waves are not the frame's sea", at, f.Tick)
			}
			if hs := win.Hs[0]; f.Tick < applies && hs != calm || f.Tick >= applies && !(hs > 3*calm) {
				t.Fatalf("wind changed at tick %d: at tick %d the waves are %.2f m (%.2f m before)", at, f.Tick, hs, calm)
			}
			w.Tick()
		}
		// Within the second before it applies, the next sea is ready.
		if ready := w.sea.windows[1-w.sea.now]; !slices.Equal(ready.Inputs, w.Latest().Sea.Next) && w.sea.cursor >= seaAreas {
			t.Fatalf("wind changed at tick %d: the next second's waves were not made ready", at)
		}
	}
}

// A boat the tick steps in waves is the boat physics.Step gives in the
// frame's sea at the frame's tick, bit for bit, through a change of wind.
func TestTickMatchesStepInWaves(t *testing.T) {
	w := seaWorld(t, 740_000_000, 3)
	for i := range 40 {
		do(t, w, bus.Command{Op: bus.Join, Account: acct(uint64(i + 1))})
	}
	wv, kind := waves(t), &kinds(t)[0]
	win := physics.SeaWindow{
		Size: 1, Inputs: make([]physics.SeaInput, 1), Amp: make([]float64, physics.SeaComponents),
		Hs: make([]float64, 1), Peak: make([]float64, 1),
	}
	var tick physics.SeaTick
	sea := physics.Sea{Waves: wv, Window: &win, Tick: &tick}
	wind := DefaultWind
	moved := false
	for i := range 240 {
		if i == 50 {
			wind = bus.Wind{Speed: 16, From: 4}
			send(t, w, bus.Command{Op: bus.SetWind, Wind: wind})
		}
		before := slices.Clone(w.Latest().State[:40])
		w.Tick()
		f := w.Latest()
		physics.SeaArea(wv, &win, 0, f.Sea.Now[0])
		win.Seal()
		physics.SeaAtTick(wv, &tick, f.Tick)
		for s := range 40 {
			want := before[s]
			c := physics.Control{Helm: f.Control[s].Helm(), Sheet: f.Control[s].Sheet()}
			e := physics.Env{WindSpeed: wind.Speed, WindFrom: wind.From}
			var o physics.Out
			physics.Step(&want, &c, &e, &sea, kind, &o)
			if !sameState(f.State[s], want) {
				t.Fatalf("tick %d, slot %d: %+v, Step in the frame's sea gives %+v", f.Tick, s, f.State[s], want)
			}
			moved = moved || f.State[s].Heave != 0 && f.State[s].Pitch != 0
		}
	}
	if !moved {
		t.Error("no boat heaved or pitched in the waves")
	}
}

// Ticks skipped move the sea on as the seconds they span would have.
func TestSeaOverASkip(t *testing.T) {
	gale := bus.Wind{Speed: 17, From: 1}
	for _, c := range []struct {
		skip      int64
		now, next bool // whether the sea in effect, and the next, are the gale's after the skip
	}{{0, false, false}, {27, false, false}, {28, false, true}, {57, false, true}, {58, true, true}, {900, true, true}} {
		w := seaWorld(t, 119, 1)
		w.Tick() // 120: a second begins
		// The wind changes at tick 121; the tick after the skip is 122 + skip,
		// and the seconds begin at 150 and 180.
		do(t, w, bus.Command{Op: bus.SetWind, Wind: gale})
		w.Skip(c.skip)
		w.Tick()
		f := w.Latest()
		old, raised := under(t, DefaultWind), under(t, gale)
		wantNow, wantNext := old, old
		if c.now {
			wantNow = raised
		}
		if c.next {
			wantNext = raised
		}
		if !uniform(f.Sea.Now, wantNow) || !uniform(f.Sea.Next, wantNext) {
			t.Errorf("after skipping %d ticks to tick %d: the sea is %+v, next %+v; want %+v, %+v", c.skip, f.Tick, f.Sea.Now[0], f.Sea.Next[0], wantNow, wantNext)
		}
		if !slices.Equal(w.sea.view.Window.Inputs, f.Sea.Now) {
			t.Errorf("after skipping %d ticks the waves are not the frame's sea", c.skip)
		}
	}
}

// A world loaded from a snapshot taken between a change of wind and the
// sea's following it sails on exactly as the world that was not stopped.
func TestSnapshotResumesTheSea(t *testing.T) {
	for _, at := range []int64{135, 151, 179, 181, 215} {
		w := seaWorld(t, 100, 2)
		for i := range 8 {
			do(t, w, bus.Command{Op: bus.Join, Account: acct(uint64(i + 1))})
		}
		for w.Now() < 130 {
			w.Tick()
		}
		do(t, w, bus.Command{Op: bus.SetWind, Wind: bus.Wind{Speed: 15, From: 5}})
		for w.Now() < at {
			w.Tick()
		}
		snap := AppendSnapshot(nil, w.Latest())
		twin := seaWorld(t, 0, 1)
		if err := twin.Load(snap); err != nil {
			t.Fatal(err)
		}
		if Digest(twin.Latest()) != Digest(w.Latest()) {
			t.Fatalf("snapshot at tick %d: the loaded world's digest differs", at)
		}
		if again := AppendSnapshot(nil, twin.Latest()); !slices.Equal(again, snap) {
			t.Fatalf("snapshot at tick %d: the loaded world writes another snapshot", at)
		}
		for range 120 {
			w.TickWith(&Input{})
			twin.TickWith(&Input{})
			a, b := w.Latest(), twin.Latest()
			if Digest(a) != Digest(b) {
				t.Fatalf("snapshot at tick %d: the worlds differ at tick %d", at, a.Tick)
			}
			if !slices.Equal(twin.sea.view.Window.Inputs, b.Sea.Now) {
				t.Fatalf("snapshot at tick %d: at tick %d the loaded world's waves are not its frame's sea", at, b.Tick)
			}
		}
		if f := w.Latest(); !uniform(f.Sea.Now, under(t, f.Wind)) {
			t.Fatalf("snapshot at tick %d: the wind never reached the sea", at)
		}
	}
}

// A restored world's sea is what the wind had made it by the present.
func TestRestoreMovesTheSeaOn(t *testing.T) {
	gale := bus.Wind{Speed: 17, From: 1}
	w := seaWorld(t, 119, 1)
	w.Tick()
	do(t, w, bus.Command{Op: bus.Join, Account: acct(1), Conn: 1})
	do(t, w, bus.Command{Op: bus.SetWind, Wind: gale})
	for w.Now() < 155 {
		w.Tick()
	}
	// Tick 155: the gale is fixed for the second from 180, not yet in effect.
	f := w.Latest()
	old, raised := under(t, DefaultWind), under(t, gale)
	if !uniform(f.Sea.Now, old) || !uniform(f.Sea.Next, raised) {
		t.Fatalf("the sea at tick 155: %+v, next %+v", f.Sea.Now[0], f.Sea.Next[0])
	}
	snap := AppendSnapshot(nil, f)
	for _, c := range []struct {
		now    int64
		effect physics.SeaInput
	}{{160, old}, {179, old}, {180, raised}, {209, raised}, {210, raised}, {100_000, raised}} {
		r := seaWorld(t, c.now, 1)
		if _, err := r.Restore(snap, c.now); err != nil {
			t.Fatal(err)
		}
		rf := r.Latest()
		if !uniform(rf.Sea.Now, c.effect) || !uniform(rf.Sea.Next, raised) {
			t.Errorf("restored at tick %d: the sea is %+v, next %+v; want %+v, %+v", c.now, rf.Sea.Now[0], rf.Sea.Next[0], c.effect, raised)
		}
		r.Tick()
		if !slices.Equal(r.sea.view.Window.Inputs, r.Latest().Sea.Now) {
			t.Errorf("restored at tick %d: the waves are not the frame's sea", c.now)
		}
	}
}

// A sea that differs from area to area survives a snapshot, run by run, and
// a snapshot whose sea is malformed is refused.
func TestSnapshotSea(t *testing.T) {
	w := seaWorld(t, 100, 1)
	w.Tick()
	f := w.Latest()
	for i := range f.Sea.Now {
		f.Sea.Now[i] = physics.SeaInput{Speed: uint32(i / 50), From: uint32(i % 7), Fetch: 9000}
		f.Sea.Next[i] = physics.SeaInput{Speed: uint32(i), From: 65535, Fetch: uint32(i * 3)}
	}
	snap := AppendSnapshot(nil, f)
	g := bus.NewFrame(f.Capacity())
	if err := ReadSnapshot(snap, g); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(g.Sea.Now, f.Sea.Now) || !slices.Equal(g.Sea.Next, f.Sea.Next) || Digest(g) != Digest(f) {
		t.Fatal("the sea did not survive the snapshot")
	}
	before := Digest(f)
	f.Sea.Next[700].Fetch++
	if Digest(f) == before {
		t.Error("the digest does not cover the next sea")
	}
	f.Sea.Next[700].Fetch--
	f.Sea.Now[3].From++
	if Digest(f) == before {
		t.Error("the digest does not cover the sea in effect")
	}

	// A uniform sea is one run: a few bytes.
	u := seaWorld(t, 100, 1).Latest()
	if n := len(AppendSnapshot(nil, u)); n > 64 {
		t.Errorf("an empty world's snapshot is %d bytes", n)
	}
	// The sea starts after the version, the tick and the wind.
	head := 1 + 2 + 16
	bad := func(name string, edit func(b []byte) []byte) {
		t.Helper()
		b := edit(slices.Clone(AppendSnapshot(nil, u)))
		if err := ReadSnapshot(b, bus.NewFrame(u.Capacity())); err == nil {
			t.Errorf("%s: read", name)
		}
	}
	bad("no runs", func(b []byte) []byte { b[head] = 0; return b })
	bad("a run too short", func(b []byte) []byte { b[head+1]--; return b })
	bad("a direction past a turn", func(b []byte) []byte {
		// The run is its length (2 bytes), speed (2), direction (1), fetch (2).
		return slices.Concat(b[:head+5], []byte{0x80, 0x80, 0x04}, b[head+6:])
	})
	if math.MaxUint32 < physics.SeaFromSteps {
		t.Fatal("a direction does not fit the wire")
	}
}

// With the wind steady the sea costs a tick nothing but its time; when it
// changes, the work is spread: no tick makes more than its share of areas.
func TestSeaWorkIsSpread(t *testing.T) {
	w := seaWorld(t, 119, 1)
	for range 70 {
		w.Tick()
	}
	if n := testing.AllocsPerRun(100, w.Tick); n != 0 {
		t.Errorf("a tick in a steady sea allocates %v times", n)
	}
	// A sea that differs in every area, from the next second on.
	for w.Now()%bus.SeaPeriod != 0 {
		w.Tick()
	}
	f := w.Latest()
	for i := range f.Sea.Next {
		f.Sea.Next[i] = physics.SeaInput{Speed: 600 + uint32(i), From: uint32(i * 40), Fetch: 11112}
	}
	other := &w.sea.windows[1-w.sea.now]
	w.sea.cursor = 0
	done := 0
	for range bus.SeaPeriod - 1 {
		w.Tick()
		// The frames are copied forward, so the edit stays.
		ready := 0
		for i, in := range w.Latest().Sea.Next {
			if other.Inputs[i] == in {
				ready++
			}
		}
		if ready-done > seaShare {
			t.Fatalf("tick %d made %d areas ready, more than its share of %d", w.Now(), ready-done, seaShare)
		}
		done = ready
	}
	if done != seaAreas {
		t.Fatalf("%d of %d areas ready a tick before the second ends", done, seaAreas)
	}
	w.Tick()
	if !slices.Equal(w.sea.view.Window.Inputs, w.Latest().Sea.Now) || w.sea.view.Window != other {
		t.Fatal("the sea made ready did not come into effect")
	}
	if w.sea.view.Window.Count < 150 {
		t.Errorf("a sea of every wind has %d waves active", w.sea.view.Window.Count)
	}
}

// BenchmarkTickInSea times the tick with boats sailing in the sea of the
// world's first wind, and in a gale's.
func BenchmarkTickInSea(b *testing.B) {
	for _, knots := range []float64{10, 34} {
		for _, n := range []int{100, 1000, 4000} {
			b.Run(fmt.Sprintf("%gknots/%d", knots, n), func(b *testing.B) {
				w, err := New(Config{Kinds: kinds(b), Waves: waves(b), Workers: runtime.GOMAXPROCS(0), Tick: 740_000_000})
				if err != nil {
					b.Fatal(err)
				}
				b.Cleanup(w.Close)
				fill(b, w, n, 1)
				send(b, w, bus.Command{Op: bus.SetWind, Wind: bus.Wind{Speed: knots * 1852.0 / 3600, From: 0}})
				for range 3 * bus.SeaPeriod {
					w.Tick()
				}
				if w.sea.view.Window.Inputs[0] != under(b, w.Latest().Wind) {
					b.Fatal("the sea did not follow the wind")
				}
				b.ReportAllocs()
				for b.Loop() {
					w.Tick()
				}
				b.ReportMetric(float64(w.Workers()), "workers")
				b.ReportMetric(float64(w.sea.view.Window.Count), "waves")
			})
		}
	}
}
