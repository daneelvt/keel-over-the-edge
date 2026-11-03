// SPDX-License-Identifier: AGPL-3.0-only

package scripted

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
)

// TestEncounters: each situation puts the staged boat where it says, and
// ends in a bump between it and the player's boat whose Article is the
// situation's, in the steady wind of a world with no weather of its own.
func TestEncounters(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	waves, kinds := cat.Prepare()
	for _, situation := range SituationNames() {
		t.Run(situation, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				w, err := sim.New(sim.Config{Capacity: 8, Kinds: kinds[:1], Waves: waves, Workers: 1, Encounters: cat.PrepareEncounters()})
				if err != nil {
					t.Fatal(err)
				}
				defer w.Close()
				ctx, cancel := context.WithCancel(t.Context())
				var wg sync.WaitGroup
				defer wg.Wait()
				defer cancel()
				wg.Go(func() {
					for ctx.Err() == nil {
						time.Sleep(time.Second / 30)
						w.Tick()
					}
				})
				cfg := EncounterConfig{Bus: w.Bus(), Weather: w.Timeline().Prepared(), Length: cat.Boats[0].LengthOverall, Log: slog.New(slog.DiscardHandler)}
				if _, err := Encounter(ctx, cfg, situation, 0); !errors.Is(err, ErrNoPlayer) {
					t.Fatalf("with no player: %v", err)
				}
				// Another player first, the first sailing: the encounter is
				// staged for the player's boat asked for.
				reply := make(chan bus.Reply, 1)
				w.Bus().Commands.Players().TrySend(bus.Command{Op: bus.Join, Account: bus.Account{2}, Conn: 8, Reply: reply})
				first := <-reply
				// The player: a boat sailed through a connection, let to
				// settle on its course.
				w.Bus().Commands.Players().TrySend(bus.Command{Op: bus.Join, Account: bus.Account{1}, Conn: 7, Reply: reply})
				player := <-reply
				if first.Slot > player.Slot {
					t.Fatalf("the other player in slot %d, after the player's %d", first.Slot, player.Slot)
				}
				// The player holds a beam reach east in the north wind, as a
				// sailor on a phone would hold a course.
				wg.Go(func() {
					for ctx.Err() == nil {
						time.Sleep(time.Second / 30)
						f := w.Bus().Frames.Acquire()
						s := f.State[player.Slot]
						seq := uint32(f.Tick + 1)
						f.Release()
						helm := hold(math.Pi/2, &s)
						w.Bus().Controls.StoreHand(player.Slot, bus.Pack(seq, uint16(math.Round((helm+1)*bus.Steps/2)), uint16(460), player.Gen))
					}
				})
				time.Sleep(15 * time.Second)
				if _, err := Encounter(ctx, cfg, situation, player.Boat+1000); !errors.Is(err, ErrNoPlayer) {
					t.Fatalf("for a boat not sailing: %v", err)
				}
				staged, err := Encounter(ctx, cfg, situation, player.Boat)
				if err != nil {
					t.Fatal(err)
				}
				if staged.Player != player.Boat || staged.Article != Situations[situation] {
					t.Fatalf("staged %+v for the player's boat %d", staged, player.Boat)
				}
				var found *bus.Bump
				for range 15 * 30 {
					time.Sleep(time.Second / 30)
					f := w.Bus().Frames.Acquire()
					for i := range f.Bumps {
						b := f.Bumps[i]
						if (b.BoatA == staged.Boat || b.BoatB == staged.Boat) && found == nil {
							found = &b
						}
					}
					f.Release()
					if found != nil {
						break
					}
				}
				if found == nil {
					t.Fatalf("no bump within 15 s of staging %+v", staged)
				}
				if got := protocol.ArticleName(found.Article); got != staged.Article {
					t.Errorf("the bump was judged by Article %s, not %s: %+v", got, staged.Article, *found)
				}
				// The staged boat sails on until it leaves, or the test ends.
				cancel()
				wg.Wait()
				time.Sleep(time.Second)
			})
		})
	}
}

// TestEncounterStagedAgain stages twice, 20 seconds apart: the second sails
// the first's boat, which stays when the first's HoldFor ends, and leaves
// when the second's does.
func TestEncounterStagedAgain(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	waves, kinds := cat.Prepare()
	synctest.Test(t, func(t *testing.T) {
		w, err := sim.New(sim.Config{Capacity: 8, Kinds: kinds[:1], Waves: waves, Workers: 1, Encounters: cat.PrepareEncounters()})
		if err != nil {
			t.Fatal(err)
		}
		defer w.Close()
		ctx, cancel := context.WithCancel(t.Context())
		var wg sync.WaitGroup
		defer wg.Wait()
		defer cancel()
		wg.Go(func() {
			for ctx.Err() == nil {
				time.Sleep(time.Second / 30)
				w.Tick()
			}
		})
		cfg := EncounterConfig{Bus: w.Bus(), Weather: w.Timeline().Prepared(), Length: cat.Boats[0].LengthOverall, Log: slog.New(slog.DiscardHandler)}
		reply := make(chan bus.Reply, 1)
		w.Bus().Commands.Players().TrySend(bus.Command{Op: bus.Join, Account: bus.Account{1}, Conn: 7, Reply: reply})
		<-reply
		time.Sleep(time.Second)
		in := func(boat uint64) bool {
			f := w.Bus().Frames.Acquire()
			defer f.Release()
			for _, s := range f.Live {
				if f.Boat[s] == boat {
					return true
				}
			}
			return false
		}
		first, err := Encounter(ctx, cfg, "capsized", 0)
		if err != nil {
			t.Fatal(err)
		}
		time.Sleep(20 * time.Second)
		second, err := Encounter(ctx, cfg, "capsized", 0)
		if err != nil {
			t.Fatal(err)
		}
		if second.Boat != first.Boat {
			t.Fatalf("staged again with boat %d, not the first's %d", second.Boat, first.Boat)
		}
		time.Sleep(HoldFor - 20*time.Second + 2*time.Second)
		if !in(second.Boat) {
			t.Fatal("the boat left when the first staging's time was up")
		}
		time.Sleep(20 * time.Second)
		if in(second.Boat) {
			t.Fatal("the boat stayed after the second staging's time was up")
		}
	})
}

// hold is a sailor's heading-hold: the helm toward target, damped by the
// yaw rate.
func hold(target float64, s *physics.State) float64 {
	off := math.Remainder(target-s.Heading, 2*math.Pi)
	return max(-1, min(1, 2*off-0.8*s.YawRate))
}

// TestCrowdBumps counts the bumps a second among a thousand scripted
// sailors where they joined, 20 m apart: the load bot's start, and the
// event table's rows a second it brings.
func TestCrowdBumps(t *testing.T) {
	if testing.Short() {
		t.Skip("a minute of a thousand boats")
	}
	synctest.Test(t, func(t *testing.T) {
		cat, err := catalog.Load()
		if err != nil {
			t.Fatal(err)
		}
		waves, kinds := cat.Prepare()
		w, err := sim.New(sim.Config{Kinds: kinds[:1], Waves: waves, Workers: 4, Encounters: cat.PrepareEncounters()})
		if err != nil {
			t.Fatal(err)
		}
		bumps, ticks := 0, 0
		sail(t, w, 1000, 2*time.Minute, func(f *bus.Frame) {
			ticks++
			for _, b := range f.Bumps {
				if b.Tick == f.Tick {
					bumps++
				}
			}
		})
		t.Logf("a thousand scripted sailors on the spawn grid: %d bumps in %d s, %.1f a second", bumps, ticks/30, float64(bumps)*30/float64(ticks))
	})
}
