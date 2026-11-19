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
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
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

// TestPendantsAboard: Ann skippers her keelboat with Cyd aboard, each
// wearing the pendant of a certificate, Cyd the cockade too. Bob, near,
// is told each one's pendant in her crew, and her boat's prizes carry
// hers; Ann, aboard, is told them in her own; when Cyd earns another,
// both are told again.
func TestPendantsAboard(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var mu sync.Mutex
		codes := map[bus.Account]uint32{}
		set := func(a bus.Account, code uint32) {
			mu.Lock()
			codes[a] = code
			mu.Unlock()
		}
		srv := NewServer(t, Config{BoatOf: keelboats(t), Prizes: func(a bus.Account) uint32 {
			mu.Lock()
			defer mu.Unlock()
			return codes[a]
		}})
		annToken, ann := srv.Sailor("Ann Bonny")
		bobToken, _ := srv.Sailor("Bob Read")
		var cyd bus.Account
		cyd[15] = 0xc1
		// Ann the Skipper's pendant; Cyd the Deckhand's and a win.
		set(bus.Account(ann), 3<<23)
		set(cyd, 1|1<<23)
		a := dial(t, srv, annToken, client.Hello())
		a.welcomed()
		srv.Place(a.welcome.GetBoat(), physics.State{X: 50, Y: 20, Heading: 1})
		b := dial(t, srv, bobToken, client.Hello())
		b.welcomed()
		srv.Place(b.welcome.GetBoat(), physics.State{X: 90, Y: 20, Heading: 1})
		annSlot := func() int {
			for slot := range protocol.ViewSlots {
				if b.view.Has(slot) {
					return slot
				}
			}
			return -1
		}
		if err := srv.World.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.Board, Boat: a.welcome.GetBoat(), Account: cyd,
			Conn: 9001, Name: "Cyd", Look: 7}); err != nil {
			t.Fatal(err)
		}
		wear := func(people []*pb.Person, cyds uint32) bool {
			return len(people) == 2 && people[0].GetPendant() == 3 && !people[0].GetCockade() &&
				people[1].GetPendant() == cyds && people[1].GetCockade()
		}
		inView := func(cyds uint32) func() bool {
			return func() bool { return annSlot() >= 0 && wear(b.crews[uint32(annSlot())].GetPeople(), cyds) }
		}
		aboard := func(cyds uint32) func() bool {
			return func() bool { return wear(a.crew.GetPeople(), cyds) }
		}
		if !b.read(3*time.Second, inView(1)) {
			t.Fatalf("Bob was not told the pendants aboard Ann's boat: %v", b.crews)
		}
		if p, ok := b.prizes[uint32(annSlot())]; !ok || p.GetPrizes()>>23&7 != 3 {
			t.Fatalf("Ann's boat's prizes as Bob is told them: %v", b.prizes)
		}
		if !a.read(3*time.Second, aboard(1)) {
			t.Fatalf("Ann was not told the pendants aboard: %v", a.crew)
		}
		// Cyd's Helm earned.
		set(cyd, 1|2<<23)
		if !b.read(3*time.Second, inView(2)) || !a.read(3*time.Second, aboard(2)) {
			t.Fatalf("after Cyd's earning: Bob told %v, Ann %v", b.crews, a.crew)
		}
	})
}
