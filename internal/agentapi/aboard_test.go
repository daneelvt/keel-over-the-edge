// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
)

// deck stands in for the edge's side of sailing together: one offer of
// the controls at a time, told to the machine sailor's helm, and taken
// through the simulation.
type deck struct {
	h     *harness
	mu    sync.Mutex
	offer map[uint64]bus.Account
}

func (d *deck) send(t *testing.T, c bus.Command) {
	for d.h.w.Bus().Commands.Players().TrySend(c) != nil {
		time.Sleep(time.Second / 30)
	}
}

func (d *deck) Hand(boat uint64, from, to bus.Account) bool {
	d.mu.Lock()
	d.offer[boat] = to
	d.mu.Unlock()
	d.h.core.Handed(to, machineNames[from[2]], false)
	return true
}

func (d *deck) Take(boat uint64, account bus.Account) bool {
	f := d.h.w.Bus().Frames.Acquire()
	skipper := false
	for _, s := range f.Live {
		if f.Boat[s] == boat {
			skipper = f.Owner[s] == account
		}
	}
	f.Release()
	d.mu.Lock()
	offered := d.offer[boat] == account
	delete(d.offer, boat)
	d.mu.Unlock()
	switch {
	case skipper:
		d.send(nil, bus.Command{Op: bus.SetHolder, Boat: boat})
	case offered:
		d.send(nil, bus.Command{Op: bus.SetHolder, Boat: boat, Account: account})
	default:
		return false
	}
	time.Sleep(time.Second / 10)
	return true
}

func (d *deck) PutAshore(boat uint64, _, who bus.Account) bool {
	d.send(nil, bus.Command{Op: bus.Ashore, Account: who, Boat: boat, Why: bus.AshorePut})
	return true
}

// aboardMary is a harness with chat and the deck, Iron Mary at sea and Rover
// aboard her boat as crew, let aboard by her owner.
func aboardMary(t *testing.T) (*harness, *oauth.Accepted, *oauth.Accepted, uint64) {
	t.Helper()
	h := newHarness(t, 8, 12, 0)
	h.withChat(t)
	h.sea.Deck = &deck{h: h, offer: map[uint64]bus.Account{}}
	mary, rover := sailor(1, "Iron Mary"), sailor(2, "Rover")
	h.call(t, mary, "observe", nil)
	h.call(t, rover, "observe", nil)
	boat := h.boatOf(mary)
	r, err := h.core.Board(t.Context(), bus.Account(rover.Account), boat)
	if err != nil || r.Result != bus.Crewed {
		t.Fatalf("Rover aboard: %v %v", r.Result, err)
	}
	time.Sleep(time.Second / 10)
	return h, mary, rover, boat
}

// pilotTarget is the autopilot's target written on boat.
func (h *harness) pilotTarget(boat uint64) uint16 {
	f := h.w.Bus().Frames.Acquire()
	defer f.Release()
	for _, s := range f.Live {
		if f.Boat[s] == boat {
			return uint16(f.Pilot[s].Target())
		}
	}
	return 0
}

// TestTwoAgentsHandTheControls: Rover, aboard Iron Mary's boat, steers
// nothing until she hands it the controls and it takes them; then its
// orders steer and hers are refused, until she takes them back at once.
func TestTwoAgentsHandTheControls(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h, mary, rover, boat := aboardMary(t)
		if h.boatOf(rover) != 0 {
			t.Fatal("Rover's own boat is still in the water")
		}
		text, _ := h.call(t, rover, "observe", nil)
		if !strings.Contains(text, "you came aboard «Iron Mary»'s boat as crew, seat 1") ||
			!strings.Contains(text, "Aboard: «Iron Mary» (machine, skipper, holds the controls) · you (seat 1)") ||
			!strings.Contains(text, "you don't hold the controls") {
			t.Fatalf("Rover's report aboard: %q", text)
		}
		if text, refused := h.call(t, rover, "steer", map[string]any{"wind_angle": 120}); !refused || !strings.Contains(text, "You don't hold the controls: «Iron Mary», the skipper, does") {
			t.Fatalf("crew steering: %v %q", refused, text)
		}
		if text, _ := h.call(t, mary, "observe", nil); !strings.Contains(text, "«Rover» came aboard") {
			t.Fatalf("Iron Mary not told: %q", text)
		}
		if text, refused := h.call(t, mary, "boat", map[string]any{"action": "hand", "sailor": "rover"}); refused || !strings.Contains(text, "You offered the controls to «Rover»") {
			t.Fatalf("handed: %v %q", refused, text)
		}
		// Told at once, and a wait under way would have woken.
		if text, _ := h.call(t, rover, "observe", map[string]any{"wait": 10}); !strings.Contains(text, "«Iron Mary» offers you the controls") {
			t.Fatalf("the offer: %q", text)
		}
		if text, refused := h.call(t, rover, "boat", map[string]any{"action": "take"}); refused || !strings.Contains(text, "You hold the controls") {
			t.Fatalf("taken: %v %q", refused, text)
		}
		if text, refused := h.call(t, mary, "steer", map[string]any{"wind_angle": 60}); !refused || !strings.Contains(text, "«Rover» does") {
			t.Fatalf("the skipper steering without the controls: %v %q", refused, text)
		}
		if text, refused := h.call(t, rover, "steer", map[string]any{"wind_angle": 120}); refused {
			t.Fatalf("the holder's order: %q", text)
		}
		time.Sleep(time.Second / 5)
		if got := h.pilotTarget(boat); got == 0 {
			t.Fatal("the holder's order did not reach the boat")
		}
		held := h.pilotTarget(boat)
		// Taken back at once.
		if text, refused := h.call(t, mary, "boat", map[string]any{"action": "take"}); refused || !strings.Contains(text, "took the controls back") {
			t.Fatalf("taken back: %v %q", refused, text)
		}
		time.Sleep(time.Second / 5)
		if text, refused := h.call(t, rover, "steer", map[string]any{"wind_angle": 150}); !refused || !strings.Contains(text, "You don't hold the controls") {
			t.Fatalf("the former holder's order: %v %q", refused, text)
		}
		if got := h.pilotTarget(boat); got != held {
			t.Fatalf("the boat's target moved after the controls were taken back: %d, was %d", got, held)
		}
		if text, refused := h.call(t, mary, "steer", map[string]any{"wind_angle": 70}); refused {
			t.Fatalf("the skipper's order after taking back: %q", text)
		}
		// Ashore: Rover's own boat back in the water.
		if text, refused := h.call(t, rover, "boat", map[string]any{"action": "ashore"}); refused || !strings.Contains(text, "You went ashore") {
			t.Fatalf("ashore: %v %q", refused, text)
		}
		time.Sleep(time.Second / 5)
		if h.boatOf(rover) == 0 {
			t.Fatal("Rover's own boat is not in the water")
		}
	})
}

// TestASilentCrewGoesAshore: Rover's agent falls silent aboard; after its
// silence it goes ashore, its own boat in the water, which leaves at the
// end of its grace; Iron Mary sails on.
func TestASilentCrewGoesAshore(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h, mary, rover, boat := aboardMary(t)
		told := false
		for range 9 {
			// Iron Mary's agent calls; Rover's says nothing.
			text, _ := h.call(t, mary, "observe", map[string]any{"wait": 10, "wake_on": []string{"pilot"}})
			told = told || strings.Contains(text, "«Rover» went ashore")
		}
		f := h.w.Bus().Frames.Acquire()
		aboard := f.Aboard(bus.Account(rover.Account))
		f.Release()
		if aboard >= 0 {
			t.Fatal("a silent crew is still aboard")
		}
		if h.boatOf(mary) != boat {
			t.Fatal("Iron Mary's boat left the water")
		}
		if !told {
			t.Fatal("Iron Mary was not told Rover went ashore")
		}
		// Its own boat, put in the water as it went ashore, leaves it at
		// the end of its grace.
		if h.boatOf(rover) == 0 {
			t.Fatal("Rover's own boat was not put in the water")
		}
		for range 9 {
			h.call(t, mary, "observe", map[string]any{"wait": 10, "wake_on": []string{"pilot"}})
		}
		if h.boatOf(rover) != 0 {
			t.Fatal("Rover's boat is still in the water after its grace")
		}
		// Its agent back, it is told why and sails again.
		if text, _ := h.call(t, rover, "observe", nil); !strings.Contains(text, "went ashore") {
			t.Fatalf("Rover's agent back: %q", text)
		}
	})
}
