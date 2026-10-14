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
				if _, err := Encounter(ctx, cfg, situation); !errors.Is(err, ErrNoPlayer) {
					t.Fatalf("with no player: %v", err)
				}
				// The player: a boat sailed through a connection, let to
				// settle on its course.
				reply := make(chan bus.Reply, 1)
				w.Bus().Commands.Players().TrySend(bus.Command{Op: bus.Join, Account: bus.Account{1}, Conn: 7, Reply: reply})
				player := <-reply
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
						w.Bus().Controls.Store(player.Slot, bus.Pack(seq, uint16(math.Round((helm+1)*bus.Steps/2)), uint16(460), player.Gen))
					}
				})
				time.Sleep(15 * time.Second)
				staged, err := Encounter(ctx, cfg, situation)
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
