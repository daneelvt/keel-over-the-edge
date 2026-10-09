// SPDX-License-Identifier: AGPL-3.0-only

package loop

import (
	"log/slog"
	"math/rand/v2"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/replay"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
)

// TestFullTickAllocatesNothing runs whole ticks as the server does, with a
// thousand boats, a third of them changing controls, a join and a leave
// every tick, the metrics updated and the input log recording, and requires
// that none allocates. CI runs it with the race detector too, which is why
// nothing in the tick uses sync.Pool: the detector makes a pool drop entries
// at random. (With the flight recorder on, the runtime's tracer allocates on
// its own goroutine, which AllocsPerRun would count; sim's tests check the
// tick's trace regions allocate nothing while it runs.)
// acct is a test's account n.
func acct(n uint64) bus.Account {
	var a bus.Account
	for k := range 8 {
		a[15-k] = byte(n >> (8 * k))
	}
	return a
}

func TestFullTickAllocatesNothing(t *testing.T) {
	w, err := sim.New(sim.Config{Kinds: kinds(t), Workers: 4})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	log := replay.New(replay.Config{
		Frames: w.Bus().Frames,
		Header: replay.Header{Build: "test", Capacity: w.Capacity(), Epoch: bubbleEpoch},
		Log:    slog.New(slog.DiscardHandler),
	})
	w.Record(log)
	done := make(chan error, 1)
	go func() { done <- log.Run() }()
	l := New(Config{
		World: w, Epoch: bubbleEpoch, Log: slog.New(slog.DiscardHandler),
		Metrics: obs.NewMetrics("b", "c"), Health: obs.NewHealth(), Overrun: func(int64) {},
	})
	l.start(time.Now())

	q := w.Bus().Commands.Developer()
	for i := range 1000 {
		q.TrySend(bus.Command{Op: bus.Join, Account: acct(uint64(i + 1)), Conn: uint64(i + 1)})
	}
	rng := rand.New(rand.NewPCG(4, 4))
	account := uint64(1 << 20)
	reply := make(chan bus.Reply, 1)
	tick := func() {
		f := w.Latest()
		for i, s := range f.Live {
			if i%3 == 0 {
				w.Bus().Controls.Store(s, bus.Pack(uint32(f.Tick), uint16(rng.IntN(bus.Steps+1)), uint16(rng.IntN(bus.Steps+1)), f.Gen[s]))
			}
		}
		if len(f.Live) > 0 {
			q.TrySend(bus.Command{Op: bus.Leave, Boat: f.Boat[f.Live[rng.IntN(len(f.Live))]]})
		}
		q.TrySend(bus.Command{Op: bus.Join, Account: acct(account), Conn: account, Reply: reply})
		if len(f.Live) > 0 {
			s := f.Live[rng.IntN(len(f.Live))]
			q.TrySend(bus.Command{Op: bus.Disconnect, Boat: f.Boat[s], Conn: f.Conn[s]})
		}
		account++
		l.tick(w.Now()+1, false)
		<-reply
	}
	// Warm up: a segment's snapshot, every recycled buffer, a full pool.
	for range replay.SegmentTicks + replay.Backlog {
		tick()
	}
	if n := testing.AllocsPerRun(300, tick); n != 0 {
		t.Errorf("a tick allocates %v times", n)
	}
	if n := w.Bus().Frames.Allocated(); n != 0 {
		t.Logf("the frame pool grew by %d during warm-up", n)
	}
	if log.Dropped() != 0 {
		t.Logf("%d input log records dropped", log.Dropped())
	}
	log.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
