// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
)

// TestPrizesAfloat: a winner's boat flies her prizes to every boat in
// view, and to her own sailor; when they change (a race of hers written),
// both are told again; a sailor with none is told nothing.
func TestPrizesAfloat(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var mu sync.Mutex
		codes := map[bus.Account]uint32{}
		srv := NewServer(t, Config{Capacity: 8, Prizes: func(a bus.Account) uint32 {
			mu.Lock()
			defer mu.Unlock()
			return codes[a]
		}})
		annToken, ann := srv.Sailor("Ann")
		bobToken, _ := srv.Sailor("Bob")
		set := func(code uint32) {
			mu.Lock()
			codes[bus.Account(ann)] = code
			mu.Unlock()
		}
		// One pennant of the third colour, the racing burgee.
		set(1 | 2<<3 | 1<<18)
		sailor := dial(t, srv, annToken, client.Hello())
		sailor.welcomed()
		srv.Place(sailor.welcome.GetBoat(), physics.State{X: 50, Y: 20, Heading: 1})
		other := dial(t, srv, bobToken, client.Hello())
		other.welcomed()
		srv.Place(other.welcome.GetBoat(), physics.State{X: 80, Y: 20, Heading: 1})
		annIn := func() uint32 {
			for slot := range protocol.ViewSlots {
				if other.view.Has(slot) {
					return uint32(slot)
				}
			}
			return 1 << 30
		}
		flies := func(v *viewer, code uint32) func() bool {
			return func() bool {
				if v == sailor {
					return v.own.GetPrizes() == code
				}
				p, ok := v.prizes[annIn()]
				return ok && p.GetPrizes() == code
			}
		}
		if !sailor.read(2*time.Second, flies(sailor, 1|2<<3|1<<18)) {
			t.Fatalf("Ann told her own prizes %v", sailor.own)
		}
		if !other.read(2*time.Second, flies(other, 1|2<<3|1<<18)) {
			t.Fatalf("Bob told Ann's prizes %v", other.prizes)
		}
		if other.own != nil {
			t.Errorf("Bob, with none, told his own: %v", other.own)
		}
		// A second win.
		set(2 | 5<<3 | 2<<6 | 1<<18)
		if !sailor.read(2*time.Second, flies(sailor, 2|5<<3|2<<6|1<<18)) || !other.read(2*time.Second, flies(other, 2|5<<3|2<<6|1<<18)) {
			t.Fatalf("after a second win: Ann told %v, Bob %v", sailor.own, other.prizes)
		}
	})
}
