// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"fmt"
	"math"
	"math/bits"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
)

// frames keeps every even tick's boats, by slot, as the server had them:
// what the clients' views are checked against.
type frames struct {
	mu    sync.Mutex
	ticks map[int64][]kept
}

type kept struct {
	slot  int32
	boat  uint64
	owner bus.Account
	kind  uint16
	sail  uint8
	state physics.State
}

func newFrames() *frames { return &frames{ticks: map[int64][]kept{}} }

func (fs *frames) Record(f *bus.Frame) {
	if f.Tick%2 != 0 {
		return
	}
	boats := make([]kept, 0, len(f.Live))
	for _, s := range f.Live {
		boats = append(boats, kept{slot: s, boat: f.Boat[s], owner: f.Owner[s], kind: f.Kind[s], sail: f.Sail[s], state: f.State[s]})
	}
	fs.mu.Lock()
	fs.ticks[f.Tick] = boats
	fs.mu.Unlock()
}

// check checks a client's view after a snapshot against the server's frame
// of its tick: each boat sampled is a boat of the frame, other than the
// client's own, quantised; and every boat of the frame within ViewEnter of
// the client's is in view. It returns the boats, by their owner, in view.
func (fs *frames) check(t *testing.T, own bus.Account, ev *client.Event) map[bus.Account]protocol.Boat {
	t.Helper()
	fs.mu.Lock()
	boats := fs.ticks[ev.Snapshot.Tick]
	fs.mu.Unlock()
	if boats == nil {
		t.Fatalf("no frame of tick %d", ev.Snapshot.Tick)
	}
	var me physics.State
	for _, b := range boats {
		if b.owner == own {
			me = b.state
		}
	}
	seen := map[bus.Account]protocol.Boat{}
	v := ev.View
	for slot := range protocol.ViewSlots {
		if !v.Has(slot) {
			continue
		}
		q := v.Boats[slot]
		found := false
		for _, b := range boats {
			var want protocol.Boat
			protocol.Quantise(&b.state, b.kind, b.sail, q.Far(), &want)
			if want == q {
				if b.owner == own {
					t.Fatalf("tick %d: the client's own boat is in its view", ev.Snapshot.Tick)
				}
				seen[b.owner] = q
				found = true
			}
		}
		if !found && ev.Sampled&(1<<slot) != 0 {
			t.Fatalf("tick %d: view slot %d, sampled, is no boat of the frame: %+v", ev.Snapshot.Tick, slot, q)
		}
	}
	for _, b := range boats {
		if b.owner != own && math.Hypot(b.state.X-me.X, b.state.Y-me.Y) <= 690 {
			if _, ok := seen[b.owner]; !ok && v.Len() < protocol.ViewSlots {
				// A far boat not sampled shows where it last was.
				if near := math.Hypot(b.state.X-me.X, b.state.Y-me.Y) <= 290; near || ev.Snapshot.Flags&protocol.FarSampled != 0 {
					t.Fatalf("tick %d: a boat %.0f m off is not in view", ev.Snapshot.Tick, math.Hypot(b.state.X-me.X, b.state.Y-me.Y))
				}
			}
		}
	}
	return seen
}

// TestTwoSeeEachOther: two players sail; each sees the other's boat, at
// every snapshot as the server's frame has it, quantised; and their own
// predictions are still exact.
func TestTwoSeeEachOther(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		fs := newFrames()
		srv := NewServer(t, Config{Record: fs})
		var sailors []*client.Sailor
		var accounts []bus.Account
		var mu sync.Mutex
		saw := make([]int, 2)
		for i, name := range []string{"Ann", "Bob"} {
			token, id := srv.Guest(name)
			s := srv.NewSailor(DialOptions{Cookie: token}, recorded(t))
			sailors = append(sailors, s)
			accounts = append(accounts, bus.Account(id))
			s.OnView = func(ev *client.Event) {
				seen := fs.check(t, accounts[i], ev)
				mu.Lock()
				if _, ok := seen[accounts[1-i]]; ok {
					saw[i]++
				}
				mu.Unlock()
			}
		}
		sailAll(t, sailors, time.Minute)
		for i, s := range sailors {
			if s.Stats.Corrections != 0 || saw[i] < s.Stats.Snapshots-2 || s.Stats.Snapshots < 880 {
				t.Fatalf("sailor %d: %d corrections; saw the other in %d of %d snapshots", i, s.Stats.Corrections, saw[i], s.Stats.Snapshots)
			}
		}
	})
}

// sailAll sails every sailor for d at once, and drops them.
func sailAll(t *testing.T, sailors []*client.Sailor, d time.Duration) {
	t.Helper()
	var wg sync.WaitGroup
	errs := make([]error, len(sailors))
	for i, s := range sailors {
		if err := s.Connect(t.Context()); err != nil {
			t.Fatal(err)
		}
		wg.Go(func() { errs[i] = s.Sail(t.Context(), d) })
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("sailor %d: %v", i, err)
		}
	}
	for _, s := range sailors {
		s.Drop()
	}
}

// TestGoneAfterGrace: a player whose connection ends stays in the other's
// view through the grace, and leaves it, with a leave, when it ends.
func TestGoneAfterGrace(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{})
		ann, _ := srv.Guest("Ann")
		bob, _ := srv.Guest("Bob")
		a := srv.NewSailor(DialOptions{Cookie: ann}, recorded(t))
		b := srv.NewSailor(DialOptions{Cookie: bob}, recorded(t))
		var lastSeen, leftAt time.Duration
		start := time.Now()
		b.OnView = func(ev *client.Event) {
			if ev.View.Len() > 0 {
				lastSeen = time.Since(start)
			}
			if ev.Changes.Left != 0 {
				leftAt = time.Since(start)
			}
		}
		for _, s := range []*client.Sailor{a, b} {
			if err := s.Connect(t.Context()); err != nil {
				t.Fatal(err)
			}
		}
		go a.Sail(t.Context(), 5*time.Second)
		if err := b.Sail(t.Context(), 5*time.Second); err != nil {
			t.Fatal(err)
		}
		a.Drop()
		if err := b.Sail(t.Context(), 70*time.Second); err != nil {
			t.Fatal(err)
		}
		b.Drop()
		grace := time.Duration(srv.World.Grace()) * time.Second / 30
		if lastSeen < 5*time.Second+grace-time.Second || leftAt == 0 || leftAt < lastSeen {
			t.Fatalf("seen until %v, left at %v; the grace is %v", lastSeen, leftAt, grace)
		}
	})
}

// TestQueue: with the limit at 2, a third player waits, told its place,
// and goes to sea when one of the first two's grace ends.
func TestQueue(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{Limit: 2})
		var sailors []*client.Sailor
		for _, name := range []string{"Ann", "Bob", "Cat"} {
			token, _ := srv.Guest(name)
			sailors = append(sailors, srv.NewSailor(DialOptions{Cookie: token}, recorded(t)))
		}
		for _, s := range sailors {
			if err := s.Connect(t.Context()); err != nil {
				t.Fatal(err)
			}
			time.Sleep(100 * time.Millisecond)
		}
		var wg sync.WaitGroup
		for _, s := range sailors[1:] {
			wg.Go(func() { s.Sail(t.Context(), 80*time.Second) })
		}
		if err := sailors[0].Sail(t.Context(), 5*time.Second); err != nil {
			t.Fatal(err)
		}
		sailors[0].Drop()
		wg.Wait()
		c := sailors[2]
		if len(c.Places) == 0 || c.Places[0] != (client.Place{Position: 1, Waiting: 1}) {
			t.Fatalf("places %+v", c.Places)
		}
		if len(c.Welcomes) != 1 || c.Stats.Snapshots == 0 || c.Stats.Corrections != 0 {
			t.Fatalf("welcomes %+v, %d snapshots, %d corrections", c.Welcomes, c.Stats.Snapshots, c.Stats.Corrections)
		}
		// Welcomed when the grace of Ann's boat ended, about 65 s in.
		sails := c.Stats.Snapshots
		if want := 15 * 15; sails < want-30 || sails > want+30 {
			t.Fatalf("%d snapshots after the welcome, want about %d", sails, want)
		}
	})
}

// TestBytes measures what a player receives: alone, with 10 boats near,
// 10 far, and 64 near, without lag and at 100 ms each way with 2% loss over
// ten seeds.
func TestBytes(t *testing.T) {
	d := time.Minute
	seeds := uint64(10)
	if testing.Short() {
		d, seeds = 20*time.Second, 2
	}
	for _, crowd := range []struct {
		name   string
		n      int
		radius float64
	}{{"alone", 0, 0}, {"10 near", 10, 150}, {"10 far", 10, 500}, {"64 near", 64, 200}} {
		for _, lag := range []client.Lag{{}, {Delay: 100 * time.Millisecond, Loss: 0.02}} {
			var all client.Stats
			n := uint64(1)
			if lag.Loss > 0 {
				n = seeds
			}
			for seed := range n {
				lag.Seed = seed + 1
				all = addStats(all, sailCrowd(t, crowd.n, crowd.radius, lag, d))
			}
			secs := d.Seconds() * float64(n)
			t.Logf("%s, %s: %.0f B/s payload, %.0f B/s with WebSocket framing, %.0f B/s up; %.1f boats in view, %.1f near; %.2f entries a snapshot; %d dropped, %d resyncs, %d corrections over the snap thresholds",
				crowd.name, lagName(lag), float64(all.BytesIn)/secs, float64(all.FramesIn)/secs, float64(all.FramesOut)/secs,
				float64(all.Others)/float64(all.Views), float64(all.Near)/float64(all.Views),
				float64(all.Enters+all.Updates+all.Leaves)/float64(all.Views), all.Dropped, all.Resyncs, all.Over)
			if all.Dropped != 0 || all.Over != 0 {
				t.Errorf("%s, %s: %d snapshots lacked their base; %d corrections over the snap thresholds", crowd.name, lagName(lag), all.Dropped, all.Over)
			}
			// The player sails on, and leaves some of a far ring behind.
			if seen := float64(all.Others) / float64(all.Views); seen < float64(crowd.n)*0.75 {
				t.Errorf("%s: %.1f boats in view", crowd.name, seen)
			}
		}
	}
}

func lagName(l client.Lag) string {
	if l == (client.Lag{}) || l.Delay == 0 {
		return "no lag"
	}
	return fmt.Sprintf("%v each way, %g%% lost", l.Delay, l.Loss*100)
}

func addStats(a, b client.Stats) client.Stats {
	a.Snapshots += b.Snapshots
	a.Views += b.Views
	a.BytesIn += b.BytesIn
	a.BytesOut += b.BytesOut
	a.FramesIn += b.FramesIn
	a.FramesOut += b.FramesOut
	a.Others += b.Others
	a.Near += b.Near
	a.Enters += b.Enters
	a.Updates += b.Updates
	a.Leaves += b.Leaves
	a.Dropped += b.Dropped
	a.Resyncs += b.Resyncs
	a.Over += b.Over
	a.Corrections += b.Corrections
	return a
}

// sailCrowd sails a player among n scripted-free boats in a ring of radius
// about where it starts, which sail in circles.
func sailCrowd(t *testing.T, n int, radius float64, lag client.Lag, d time.Duration) client.Stats {
	var stats client.Stats
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{Capacity: 128})
		token, _ := srv.Guest("Ann")
		o := DialOptions{Cookie: token}
		if lag.Delay > 0 {
			o.Wrap = lag.Wrap
		}
		s := srv.NewSailor(o, recorded(t))
		if err := s.Connect(t.Context()); err != nil {
			t.Fatal(err)
		}
		// The player's boat first, in the start grid's first place, which
		// the crowd is placed about.
		time.Sleep(time.Second)
		if n > 0 {
			srv.Crowd(t, n, func(i int) physics.State {
				a := 2 * math.Pi * float64(i) / float64(n)
				r := radius * (0.8 + 0.4*float64(i%5)/4)
				return physics.State{X: -640 + r*math.Sin(a), Y: -20 + r*math.Cos(a), Heading: a + math.Pi/2, Surge: 2, SheetLimit: 0.6}
			})
			// The crowd sails: its helms are put over now and then.
			go steerCrowd(t, srv, d)
		}
		if err := s.Sail(t.Context(), d); err != nil {
			t.Fatal(err)
		}
		s.Drop()
		stats = s.Stats
	})
	return stats
}

// steerCrowd steers the boats without a connection at random, as scripted
// sailors do.
func steerCrowd(t *testing.T, srv *Server, d time.Duration) {
	end := time.Now().Add(d)
	n := 0
	for time.Now().Before(end) {
		time.Sleep(500 * time.Millisecond)
		f := srv.World.Bus().Frames.Acquire()
		for i, s := range f.Live {
			if f.Conn[s] == 0 && (i+n)%3 == 0 {
				helm := uint16(300 + (i*97+n*31)%424)
				srv.World.Bus().Controls.Store(s, bus.Pack(uint32(f.Tick+1), helm, uint16(400+bits.OnesCount(uint(i+n))*40), f.Gen[s]))
			}
		}
		f.Release()
		n++
	}
}
