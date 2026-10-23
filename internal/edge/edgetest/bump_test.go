// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"math"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// boatOf is the boat account sails, from the latest frame.
func boatOf(s *Server, account bus.Account) uint64 {
	f := s.World.Bus().Frames.Acquire()
	defer f.Release()
	for _, slot := range f.Live {
		if f.Owner[slot] == account {
			return f.Boat[slot]
		}
	}
	return 0
}

// letGo holds the helm amidships and lets the sheet fly.
func letGo(int) client.Input { return client.Hand(bus.Steps/2, bus.Steps) }

// sailFor sails every sailor for d at once.
func sailFor(t *testing.T, sailors []*client.Sailor, d time.Duration) {
	t.Helper()
	var wg sync.WaitGroup
	errs := make([]error, len(sailors))
	for i, s := range sailors {
		wg.Go(func() { errs[i] = s.Sail(t.Context(), d) })
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("sailor %d: %v", i, err)
		}
	}
}

// TestBumpTold: a boat sailing into another's side bumps it; each of the two
// sailors is told once, with the verdict, the one at fault "yours" and the
// other "theirs"; a sailor near them is told once, without it; and the
// sailor who reconnects is not told it again.
func TestBumpTold(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{})
		var sailors []*client.Sailor
		var accounts []bus.Account
		for _, name := range []string{"Ann", "Bob", "Cid"} {
			token, id := srv.Sailor(name)
			s := srv.NewSailor(DialOptions{Cookie: token}, letGo)
			if err := s.Connect(t.Context()); err != nil {
				t.Fatal(err)
			}
			sailors = append(sailors, s)
			accounts = append(accounts, bus.Account(id))
		}
		sailFor(t, sailors, time.Second)
		// Ann sails into Bob's starboard side; Cid lies 20 m off.
		srv.Place(boatOf(srv, accounts[0]), physics.State{X: 495, Y: 500, Heading: math.Pi / 2, Surge: 3, SheetLimit: 1.6})
		srv.Place(boatOf(srv, accounts[1]), physics.State{X: 500, Y: 500, SheetLimit: 1.6})
		srv.Place(boatOf(srv, accounts[2]), physics.State{X: 500, Y: 520, SheetLimit: 1.6})
		sailFor(t, sailors, 5*time.Second)

		parts := map[pb.BumpPart]int{}
		var tick int64
		for i, s := range sailors {
			if len(s.Bumps) == 0 {
				t.Fatalf("sailor %d was told of no bump", i)
			}
			seen := map[int64]bool{}
			for _, b := range s.Bumps {
				if seen[b.GetTick()] {
					t.Errorf("sailor %d was told of the bump at tick %d twice", i, b.GetTick())
				}
				seen[b.GetTick()] = true
			}
			first := s.Bumps[0]
			if tick == 0 {
				tick = first.GetTick()
			}
			if first.GetTick() != tick || math.Abs(float64(first.GetX())-50000) > 300 || math.Abs(float64(first.GetY())-50000) > 300 || first.GetClosing() < 100 {
				t.Errorf("sailor %d was told %v", i, first)
			}
			if i < 2 {
				if first.GetArticle() == "" {
					t.Errorf("sailor %d, one of the two, was told no Article", i)
				}
				parts[first.GetPart()]++
			} else if first.GetArticle() != "" || first.GetPart() != pb.BumpPart_BUMP_PART_UNSPECIFIED {
				t.Errorf("a sailor near was told the verdict: %v", first)
			}
		}
		if parts[pb.BumpPart_BUMP_PART_YOURS] != 1 || parts[pb.BumpPart_BUMP_PART_THEIRS] != 1 {
			t.Errorf("the two were told %v", parts)
		}

		// Ann reconnects: she is not told again.
		ann := sailors[0]
		told := len(ann.Bumps)
		ann.Drop()
		if err := ann.Connect(t.Context()); err != nil {
			t.Fatal(err)
		}
		if err := ann.Sail(t.Context(), 2*time.Second); err != nil {
			t.Fatal(err)
		}
		for _, b := range ann.Bumps[told:] {
			if b.GetTick() <= tick {
				t.Errorf("after reconnecting Ann was told of the bump at tick %d again", b.GetTick())
			}
		}
		for _, s := range sailors {
			s.Drop()
		}
	})
}

// TestDrawnOverlap measures how far the drawn hulls go into each other
// before a bump shows, at 40 ms and 200 ms round trips, head on and
// ramming a boat at rest: collisions are not predicted, so the player's
// own boat, predicted ahead, sails on into the other, drawn four ticks
// behind its newest sample, until the server's correction comes. Each
// sailor's own predicted boat is held against the other as drawn: its
// sample two snapshots back.
func TestDrawnOverlap(t *testing.T) {
	for _, rtt := range []time.Duration{40 * time.Millisecond, 200 * time.Millisecond} {
		for _, c := range []struct {
			name string
			bob  physics.State
		}{
			{"head on, 2.5 m/s each", physics.State{X: 512, Y: 500.3, Heading: -math.Pi / 2, Surge: 2.5, SheetLimit: 1.6}},
			{"ramming a boat at rest", physics.State{X: 508, Y: 500.3, Heading: 0, SheetLimit: 1.6}},
		} {
			synctest.Test(t, func(t *testing.T) {
				srv := NewServer(t, Config{})
				var sailors []*client.Sailor
				var accounts []bus.Account
				deepest := make([]float64, 2)
				kind := &srv.Kinds[0]
				for i, name := range []string{"Ann", "Bob"} {
					// Each sailor's views come on its own goroutine.
					var h physics.Hulls
					token, id := srv.Sailor(name)
					o := DialOptions{Cookie: token, Wrap: client.Lag{Delay: rtt / 2, Seed: uint64(i + 1)}.Wrap}
					s := srv.NewSailor(o, letGo)
					var past [3]*protocol.Boat
					s.OnView = func(ev *client.Event) {
						for slot := range protocol.ViewSlots {
							if ev.View.Has(slot) && !ev.View.Boats[slot].Far() {
								b := ev.View.Boats[slot]
								past[0], past[1], past[2] = past[1], past[2], &b
								break
							}
						}
						if past[0] == nil {
							return
						}
						other := physics.State{
							X: float64(past[0].X) * protocol.PositionStep, Y: float64(past[0].Y) * protocol.PositionStep,
							Heading: float64(int16(past[0].Heading)) * protocol.AngleStep,
						}
						var ct physics.Contact
						own := s.Predictor.State
						if h.Touch(&own, &other, kind, kind, &ct) {
							deepest[i] = max(deepest[i], ct.Depth)
						}
					}
					if err := s.Connect(t.Context()); err != nil {
						t.Fatal(err)
					}
					sailors = append(sailors, s)
					accounts = append(accounts, bus.Account(id))
				}
				sailFor(t, sailors, time.Second)
				srv.Place(boatOf(srv, accounts[0]), physics.State{X: 500, Y: 500, Heading: math.Pi / 2, Surge: 2.5, SheetLimit: 1.6})
				srv.Place(boatOf(srv, accounts[1]), c.bob)
				sailFor(t, sailors, 6*time.Second)
				for _, s := range sailors {
					s.Drop()
				}
				t.Logf("%v round trip, %s: Ann's boat drawn %.2f m into Bob's at most, Bob's %.2f m into Ann's; %d and %d bumps told",
					rtt, c.name, deepest[0], deepest[1], len(sailors[0].Bumps), len(sailors[1].Bumps))
				if len(sailors[0].Bumps) == 0 {
					t.Errorf("%v, %s: no bump", rtt, c.name)
				}
			})
		}
	}
}
