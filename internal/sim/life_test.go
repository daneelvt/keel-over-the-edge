// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/life"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// lifeSchedule is the catalog's life over open sea, a town by the spawn
// grid to bring the harbours' kinds.
func lifeSchedule(t testing.TB) *life.Schedule {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	p, kinds := life.Prepare(cat)
	h := life.NewHabitat(p, nil, life.Places{Towns: [][2]float64{{0, -40}}, Colonies: [][2]float64{{2000, 2000}}}, 8334)
	return life.NewSchedule(&life.Config{Params: p, Kinds: kinds, Habitat: h, Seed: 5})
}

// lifeWorld is a world of the catalog's boats and weather with the sea's
// life, and n boats in it.
func lifeWorld(t testing.TB, n int, withLife bool) *World {
	t.Helper()
	waves, ks := physicsOnce()
	cfg := Config{Capacity: 128, Kinds: ks, Waves: waves, Weather: sequence(t), Workers: 2, Tick: 900_000}
	if withLife {
		cfg.Life = lifeSchedule(t)
	}
	w, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	fill(t, w, n, 1)
	return w
}

// TestLifeInTheFrame: the frames carry the encounters the schedule began,
// each alive from its start to its end, and those raised by hand.
func TestLifeInTheFrame(t *testing.T) {
	w := lifeWorld(t, 4, true)
	seen := map[uint64]bus.LifeEncounter{}
	for range 30 * 60 * 5 {
		w.Tick()
		f := w.Latest()
		for _, e := range f.Life {
			if !(e.Start <= f.Tick && f.Tick < e.End) {
				t.Fatalf("at %d, %+v is alive", f.Tick, e)
			}
			seen[e.ID] = e
		}
	}
	if len(seen) == 0 {
		t.Fatal("five minutes with nothing alive")
	}
	r := do(t, w, bus.Command{Op: bus.RaiseLife, LifeKind: 1, State: physics.State{X: 100, Y: 100}})
	if r.Result != bus.Done {
		t.Fatalf("raised: %v", r.Result)
	}
	f := w.Latest()
	if e := f.Life[len(f.Life)-1]; e.ID>>63 != 1 || e.Kind != 1 || e.East != 100 || e.Start != f.Tick {
		t.Errorf("raised %+v", e)
	}
	if r := do(t, w, bus.Command{Op: bus.RaiseLife, LifeKind: 999}); r.Result != bus.NoBoat {
		t.Errorf("a kind of none raised: %v", r.Result)
	}
	plain := lifeWorld(t, 1, false)
	if r := do(t, plain, bus.Command{Op: bus.RaiseLife, LifeKind: 1}); r.Result != bus.NoBoat || len(plain.Latest().Life) != 0 {
		t.Errorf("raised in a sea with no life: %v", r.Result)
	}
}

// TestTickWithLifeAllocatesNothing: ticks of 64 boats with the sea's life,
// across its slots, allocate nothing.
func TestTickWithLifeAllocatesNothing(t *testing.T) {
	w := lifeWorld(t, 64, true)
	sail(w, 30*60, 2)
	if n := testing.AllocsPerRun(1000, w.Tick); n != 0 {
		t.Fatalf("a tick allocates %v times", n)
	}
}

// BenchmarkTickWithLife times a tick of 64 boats with the sea's life and
// without, across its slots.
func BenchmarkTickWithLife(b *testing.B) {
	for _, c := range []struct {
		name string
		life bool
	}{{"without", false}, {"with", true}} {
		b.Run(c.name, func(b *testing.B) {
			w := lifeWorld(b, 64, c.life)
			sail(w, 30*60, 2)
			b.ReportAllocs()
			for b.Loop() {
				w.Tick()
			}
		})
	}
}

// BenchmarkLifeSlot times drawing one slot of the catalog's life.
func BenchmarkLifeSlot(b *testing.B) {
	s := lifeSchedule(b)
	out := make([]bus.LifeEncounter, 0, bus.LifeRoom)
	sl := int64(30000)
	for b.Loop() {
		out = s.Slot(sl, nil, out[:0])
		sl++
	}
}
