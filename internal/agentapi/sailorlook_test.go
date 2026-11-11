// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"context"
	"log/slog"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// A machine sailor's look, told and changed through boat's sailor_look in
// seed 1's world: ashore, at sea beyond Port Royal's harbour, and in it.

// lookSea is seed 1's world ticking in the test's bubble, sailed by a core
// that keeps the looks it is given in kept, and counts the accounts it has
// the door forget.
type lookSea struct {
	sc     *scene
	core   *Core
	kept   map[store.AccountID]store.Look
	forgot []store.AccountID
}

func newLookSea(t *testing.T) *lookSea {
	t.Helper()
	sc := newSceneOf(t, 8, 8, 0)
	ls := &lookSea{sc: sc, kept: map[store.AccountID]store.Look{}}
	ls.core = NewCore(CoreConfig{
		Silence: time.Minute, Log: slog.New(slog.DiscardHandler),
		SetLook: func(_ context.Context, id store.AccountID, l store.Look) error {
			ls.kept[id] = l
			return nil
		},
		Forget: func(ids ...store.AccountID) { ls.forgot = append(ls.forgot, ids...) },
	})
	sc.core = ls.core
	sc.w.Record(ls.core.Open(sc.sea))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		go ls.core.Run(ctx)
		for {
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Second / physics.StepsPerSecond):
				sc.w.Tick()
			}
		}
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return ls
}

// call calls a tool as a, and logs the call and its answer.
func (ls *lookSea) call(t *testing.T, a *oauth.Accepted, tool string, args map[string]any) (string, bool) {
	t.Helper()
	text, refused := callCore(t, t.Context(), ls.core, a, tool, args)
	t.Logf("%s %v → refused %v:\n%s", tool, args, refused, text)
	return text, refused
}

// slotOf is the slot of a's boat, and its look code.
func (ls *lookSea) slotOf(t *testing.T, a *oauth.Accepted) (int32, uint32) {
	t.Helper()
	f := ls.sc.w.Bus().Frames.Acquire()
	defer f.Release()
	for _, s := range f.Live {
		if f.Owner[s] == bus.Account(a.Account) {
			return s, f.Look[s]
		}
	}
	t.Fatal("no boat")
	return 0, 0
}

// place moves a's boat to (x, y), at rest, and waits a tick past it; the
// agent's orders' budget is full again by then.
func (ls *lookSea) place(t *testing.T, a *oauth.Accepted, x, y float64) {
	t.Helper()
	time.Sleep(3 * time.Second)
	sl, _ := ls.slotOf(t, a)
	f := ls.sc.w.Bus().Frames.Acquire()
	boat := f.Boat[sl]
	f.Release()
	reply := make(chan bus.Reply, 1)
	if err := ls.sc.w.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.Place, Boat: boat, State: physics.State{X: x, Y: y}, Reply: reply}); err != nil {
		t.Fatal(err)
	}
	if r := <-reply; r.Result != bus.Done {
		t.Fatalf("placed: %+v", r)
	}
	time.Sleep(time.Second / 10)
}

func TestSailorLook(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ls := newLookSea(t)
		book := ls.sc.sea.Looks
		harbour, ok := ls.sc.sea.Bundle.Harbour()
		if !ok {
			t.Fatal("seed 1 has no harbour")
		}
		a := sailor(1, "Iron Mary")
		a.Look = store.Look{Look: store.MachineLook, Version: "male", Finish: "brass", Colour: "sea-green", Chosen: true}

		// Told, with its choices.
		text, refused := ls.call(t, a, "boat", map[string]any{"action": "sailor_look"})
		for _, want := range []string{"You are a machine sailor: male, brass, in sea green.", "version (female or male)",
			"finish (brass, copper, bronze or iron)", "or undyed linen)", lookWhere} {
			if refused || !strings.Contains(text, want) {
				t.Fatalf("told: %v %q, without %q", refused, text, want)
			}
		}
		// The boat's own look is another action's.
		if text, _ := ls.call(t, a, "boat", map[string]any{"action": "look"}); strings.Contains(text, "machine sailor:") {
			t.Fatalf("the boat's look: %q", text)
		}

		// Bad choices, refused with the choices.
		text, refused = ls.call(t, a, "boat", map[string]any{"action": "sailor_look", "colour": "plaid"})
		if !refused || text != `No colour called "plaid": a machine sailor's colour is black, indigo navy, madder red, sea green, weld yellow, sky blue, madder orange or undyed linen. Nothing was changed.` {
			t.Fatalf("a bad colour: %v %q", refused, text)
		}
		if text, refused = ls.call(t, a, "boat", map[string]any{"action": "sailor_look", "version": "robot", "colour": "black"}); !refused || !strings.Contains(text, "female or male") {
			t.Fatalf("a bad version: %v %q", refused, text)
		}
		if len(ls.kept) != 0 {
			t.Fatalf("kept after a refusal: %+v", ls.kept)
		}

		// Ashore: kept, by name in any case; the rest stay.
		text, refused = ls.call(t, a, "boat", map[string]any{"action": "sailor_look", "colour": "Madder Red"})
		if refused || text != lookAshore+"You are a machine sailor: male, brass, in madder red." {
			t.Fatalf("ashore: %v %q", refused, text)
		}
		want := store.Look{Look: store.MachineLook, Version: "male", Finish: "brass", Colour: "madder-red", Chosen: true}
		if ls.kept[a.Account] != want || len(ls.forgot) != 1 || ls.forgot[0] != a.Account {
			t.Fatalf("kept %+v, forgot %v", ls.kept, ls.forgot)
		}
		// The door reads the token's grant again, with the look.
		a.Look = ls.kept[a.Account]
		if text, _ := ls.call(t, a, "handbook", map[string]any{"topic": "start"}); !strings.Contains(text, "You are a machine sailor: male, brass, in madder red.") {
			t.Fatalf("the handbook's start: %q", text)
		}

		// At sea in it.
		if text, _ := ls.call(t, a, "observe", nil); !strings.Contains(text, "At sea") {
			t.Fatalf("observe: %q", text)
		}
		if _, code := ls.slotOf(t, a); code != book.Code(want) {
			t.Fatalf("at sea in %#x, not %#x", code, book.Code(want))
		}

		// Beyond the harbour: refused, the look kept in the world and the
		// store.
		x, y := harbour.X+1500, harbour.Y-1500
		if physics.InHarbour(&harbour, x, y) {
			t.Fatal("open water in the harbour")
		}
		ls.place(t, a, x, y)
		text, refused = ls.call(t, a, "boat", map[string]any{"action": "sailor_look", "finish": "iron"})
		if !refused || text != "Only at Port Royal: change your look before you sail, or in its harbour." {
			t.Fatalf("beyond the harbour: %v %q", refused, text)
		}
		time.Sleep(time.Second / 10)
		if _, code := ls.slotOf(t, a); code != book.Code(want) || ls.kept[a.Account] != want {
			t.Fatalf("changed beyond the harbour: %#x, %+v", code, ls.kept[a.Account])
		}

		// In the harbour's basin: changed in the world for all to see, and
		// kept.
		basin := ls.sc.start()
		if !physics.InHarbour(&harbour, basin.X, basin.Y) {
			t.Fatal("the first mooring is not in the harbour")
		}
		ls.place(t, a, basin.X, basin.Y)
		text, refused = ls.call(t, a, "boat", map[string]any{"action": "sailor_look", "version": "FEMALE", "finish": "iron"})
		if refused || text != lookInHarbour+"You are a machine sailor: female, iron, in madder red." {
			t.Fatalf("in the harbour: %v %q", refused, text)
		}
		time.Sleep(time.Second / 10)
		want = store.Look{Look: store.MachineLook, Version: "female", Finish: "iron", Colour: "madder-red", Chosen: true}
		if _, code := ls.slotOf(t, a); code != book.Code(want) || ls.kept[a.Account] != want {
			t.Fatalf("in the harbour: %#x, %+v", code, ls.kept[a.Account])
		}
		// A choice with no action is sailor_look's too, by id.
		a.Look = want
		if text, refused = ls.call(t, a, "boat", map[string]any{"colour": "sky-blue"}); refused || !strings.Contains(text, "female, iron, in sky blue") {
			t.Fatalf("by id: %v %q", refused, text)
		}
	})
}
