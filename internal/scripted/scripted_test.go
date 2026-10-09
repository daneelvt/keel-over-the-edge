// SPDX-License-Identifier: AGPL-3.0-only

package scripted

import (
	"context"
	"log/slog"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
)

func world(t *testing.T, capacity int) *sim.World { return limited(t, capacity, 0) }

func limited(t *testing.T, capacity, limit int) *sim.World {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	p := catalog.PhysicsParams(&cat.Boats[0])
	var k physics.Prepared
	physics.Prepare(&p, &k)
	w, err := sim.New(sim.Config{Capacity: capacity, Kinds: []physics.Prepared{k}, Workers: 2, Limit: limit})
	if err != nil {
		t.Fatal(err)
	}
	return w
}

// sail runs n sailors on w for d, ticking it 30 times a second, and calls
// check after every tick.
func sail(t *testing.T, w *sim.World, n int, d time.Duration, check func(*bus.Frame)) {
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, Config{N: n, Bus: w.Bus(), Seed: 9, Log: slog.New(slog.DiscardHandler)})
	}()
	for range int(d / (time.Second / 30)) {
		time.Sleep(time.Second / 30)
		w.Tick()
		check(w.Latest())
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	w.Close()
}

func TestSailorsSail(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		const n = 50
		w := world(t, 64)
		seq := map[int32]uint32{}
		changes := 0
		sail(t, w, n, time.Minute, func(f *bus.Frame) {
			for _, c := range f.Changed {
				// Each word is stamped for the tick after the latest, so it
				// is applied in order, and never before its tick.
				if c.Word.Seq() <= seq[c.Slot] || c.Word.Seq() > uint32(f.Tick) {
					t.Fatalf("slot %d: a word for tick %d after %d, applied at %d", c.Slot, c.Word.Seq(), seq[c.Slot], f.Tick)
				}
				seq[c.Slot] = c.Word.Seq()
				if h, s := c.Word.Helm(), c.Word.Sheet(); h < -1 || h > 1 || s < 0 || s > 1 {
					t.Fatalf("helm %v, sheet %v", h, s)
				}
				if c.Word.Gen() != f.Gen[c.Slot] {
					t.Fatalf("a word for generation %d in a slot of generation %d", c.Word.Gen(), f.Gen[c.Slot])
				}
				changes++
			}
		})
		f := w.Latest()
		if len(f.Live) != n {
			t.Fatalf("%d boats", len(f.Live))
		}
		for i, s := range f.Live {
			if f.Owner[s] != Account(i) || f.Conn[s] != 0 {
				t.Fatalf("slot %d is account %s's, connection %d", s, f.Owner[s], f.Conn[s])
			}
		}
		// Each sailor moves every 0.2 to 3 s: about 37 moves a minute each.
		if changes < n*20 || changes > n*60 || len(seq) != n {
			t.Fatalf("%d changes by %d sailors in a minute", changes, len(seq))
		}
	})
}

func TestAccounts(t *testing.T) {
	if got := Account(0x0102030405).String(); got != "ffffffff-ffff-7fff-bfff-000102030405" {
		t.Fatal(got)
	}
	if Account(1) == Account(2) {
		t.Fatal("two sailors share an account")
	}
}

// TestMoreSailorsThanSlots: sailors beyond the world's limit are left
// ashore, and none waits in its queue, where nothing could give it a boat.
func TestMoreSailorsThanSlots(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		w := limited(t, 16, 8)
		sail(t, w, 12, 5*time.Second, func(*bus.Frame) {})
		if f := w.Latest(); len(f.Live) != 8 || len(f.Queue) != 0 {
			t.Fatalf("%d boats under a limit of 8, %d waiting", len(f.Live), len(f.Queue))
		}
	})
}

func TestBusyQueue(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		// More sailors than the command queue holds join over several ticks.
		w := world(t, sim.Capacity)
		sail(t, w, bus.QueueSize+100, 2*time.Second, func(*bus.Frame) {})
		if n := len(w.Latest().Live); n != sim.Capacity {
			t.Fatalf("%d boats", n)
		}
	})
}
