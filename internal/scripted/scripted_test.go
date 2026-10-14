// SPDX-License-Identifier: AGPL-3.0-only

package scripted

import (
	"context"
	"log/slog"
	"math"
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
	waves, kinds := cat.Prepare()
	w, err := sim.New(sim.Config{Capacity: capacity, Kinds: kinds[:1], Waves: waves, Workers: 2, Limit: limit})
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
		// Each sailor trims every 0.2 to 3 s: about 37 times a minute each.
		if changes < n*20 || changes > n*60 || len(seq) != n {
			t.Fatalf("%d changes by %d sailors in a minute", changes, len(seq))
		}
	})
}

// TestSailorsOnTheAutopilot: in a trade spell, scripted sailors stay
// upright for five minutes, hold their angles to the mean wind once
// settled, and end on the other tack after each tack or gybe they draw.
func TestSailorsOnTheAutopilot(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		const n = 12
		w := world(t, 16)
		reply := make(chan bus.Reply, 1)
		w.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.SetWeather, Weather: bus.Weather{Mode: bus.WeatherHeld, Regime: 1}, Reply: reply})
		w.Tick()
		<-reply
		ctx, cancel := context.WithCancel(t.Context())
		done := make(chan error, 1)
		go func() {
			done <- Run(ctx, Config{N: n, Bus: w.Bus(), Seed: 4, Log: slog.New(slog.DiscardHandler), MinTurn: 40 * time.Second, MaxTurn: 90 * time.Second})
		}()
		// Since when each slot's pilot word has been as it is: a new
		// order, or the first word, is given 30 s to settle.
		since := map[int32]int64{}
		orders := map[int32]uint8{}
		turns, worst, checked := 0, 0.0, 0
		for range 5 * 60 * 30 {
			time.Sleep(time.Second / 30)
			w.Tick()
			f := w.Latest()
			for _, c := range f.Changed {
				if _, ok := since[c.Slot]; !ok || c.Pilot.Order() != orders[c.Slot] {
					if ok {
						turns++
					}
					since[c.Slot], orders[c.Slot] = f.Tick, c.Pilot.Order()
				}
			}
			for _, s := range f.Live {
				st := &f.State[s]
				if st.SailorMode != physics.Sailing {
					t.Fatalf("tick %d: slot %d capsized, holding %d with the sheet at %v", f.Tick, s, f.Pilot[s].Target(), f.Control[s].Sheet())
				}
				from, ok := since[s]
				if !ok || f.Tick-from < 30*30 {
					continue
				}
				target := float64(int16(f.Pilot[s].Target())) * 2 * math.Pi / physics.TurnSteps
				off := math.Remainder(f.Wind[s].MeanFrom-st.Heading-target, 2*math.Pi)
				worst = max(worst, math.Abs(off))
				checked++
			}
		}
		cancel()
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		w.Close()
		t.Logf("%d sailors, five minutes of a trade spell: %d tacks and gybes, at most %.2f° off their angles once settled", n, turns, worst*180/math.Pi)
		if turns < n || worst > 5*math.Pi/180 || checked == 0 {
			t.Errorf("%d tacks and gybes, %.2f° off at most over %d checks", turns, worst*180/math.Pi, checked)
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
