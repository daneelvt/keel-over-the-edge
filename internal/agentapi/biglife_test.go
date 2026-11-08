// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/life"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The lookout names the big and the rare: a whale by its blow, and heard
// blowing close by; a shark's fin; a booby flying in to the boat and
// perched on it; a flying fish landed on its deck.
func TestBigLifeInSight(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarnessOf(t, 8, 12, 0, quietLife)
		a := sailor(1, "Iron Mary")
		h.call(t, a, "observe", nil)
		_, st := h.own(t)
		kinds := h.sea.Life.Kinds()
		whale := lifeKind(t, h.sea, func(k *life.Kind) bool {
			return k.Form == catalog.LifeFormWhale && k.Path == life.PathPass && k.Collective == ""
		})
		fin := lifeKind(t, h.sea, func(k *life.Kind) bool { return k.Form == catalog.LifeFormFin })
		booby := lifeKind(t, h.sea, (*life.Kind).Perches)
		ew := h.raise(t, whale, st.X+250, st.Y)
		ef := h.raise(t, fin, st.X, st.Y-120)
		eb := h.raise(t, booby, st.X+300, st.Y)
		if eb.Boat == 0 {
			t.Fatalf("the booby took no boat: %+v", eb)
		}
		wantWhale := groupWords(&kinds[whale], &ew) + " blowing to the "
		wantFin := "the fin of " + groupWords(&kinds[fin], &ef) + " cutting the water to the "
		wantPerch := groupWords(&kinds[booby], &eb) + " perched on your boat"
		wantHeard := "a " + lifeName(kinds[whale].Name) + " blowing to the "
		text := h.waitFor(t, a, 1200, wantWhale, wantFin, wantPerch, wantHeard)
		for _, w := range []string{wantWhale, wantFin, wantPerch} {
			if !strings.Contains(text, w) {
				t.Errorf("no %q in\n%s", w, text)
			}
		}
		if heard := lineOf(text, "Hear:"); !strings.Contains(heard, wantHeard) {
			t.Errorf("no %q heard in\n%s", wantHeard, text)
		}
		// A fish landed on the deck.
		reply := make(chan bus.Reply, 1)
		if err := h.w.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.RaiseLife, LifeKind: bus.LifeAboard, State: physics.State{X: st.X, Y: st.Y}, Reply: reply}); err != nil {
			t.Fatal(err)
		}
		if r := <-reply; r.Result != bus.Done {
			t.Fatalf("no fish landed: %v", r.Result)
		}
		time.Sleep(time.Second)
		if text, _ = h.call(t, a, "observe", nil); !strings.Contains(text, "a flying fish landed on your deck") {
			t.Errorf("no fish on the deck in\n%s", text)
		}
	})
}
