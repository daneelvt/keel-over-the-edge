// SPDX-License-Identifier: AGPL-3.0-only

package protocol

import (
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// A ship's yards go in her enter and her updates, the fore yards' only
// while they differ from the after yards'; a boat with no rig sails at the
// sizes it did: the same state with no yards enters 4 bytes shorter (the
// jib's 2 and the yards' 2), and an update of its heading alone costs the
// ship nothing more. Logged: her enter and her updates' sizes.
func TestTheYardsOnTheWire(t *testing.T) {
	st := physics.State{X: 1234.5, Y: -987.6, Heading: 1.2, Heel: 0.1, Boom: 0.4, Rudder: 0.05,
		Jib: 0.3, Yards: 0.7, ForeYards: 0.7}
	plain := st
	plain.Jib, plain.Yards, plain.ForeYards = 0, 0, 0
	var ship, dinghy Boat
	Quantise(&st, 2, 0x15, false, &ship)
	Quantise(&plain, 0, 0x15, false, &dinghy)
	ship.BoatLook, dinghy.BoatLook = 0x3300, 0x3300
	enter := func(q *Boat) []byte { return AppendEntry(nil, &Entry{Slot: 5, Op: OpEnter, Boat: *q}) }
	if a, b := len(enter(&ship)), len(enter(&dinghy)); a != b+4 {
		t.Errorf("her enter %d bytes, a boat with no rig's %d", a, b)
	}
	if ship.Fore != 0 {
		t.Errorf("the fore yards with the after: %d", ship.Fore)
	}
	update := func(base, next *Boat) []byte {
		var v0, v1 View
		v0.Put(5, base)
		v1.Put(5, next)
		b, n := AppendEntries(nil, &v0, &v1, 0, 1<<5)
		if n != 1 {
			t.Fatalf("%d entries", n)
		}
		return b
	}
	// Her heading alone, as a dinghy's.
	turned, dturned := st, plain
	turned.Heading, dturned.Heading = 1.25, 1.25
	var q, dq Boat
	Quantise(&turned, 2, 0x15, false, &q)
	Quantise(&dturned, 0, 0x15, false, &dq)
	q.BoatLook, dq.BoatLook = ship.BoatLook, dinghy.BoatLook
	heading := update(&ship, &q)
	if len(heading) != len(update(&dinghy, &dq)) || heading[0]>>6 != OpUpdate {
		t.Errorf("her heading's update %x, a dinghy's %x", heading, update(&dinghy, &dq))
	}
	// The after yards hauled round in a tack, the fore yards held: the
	// yards and the fore yards' difference.
	hauled := st
	hauled.Yards = -0.7
	Quantise(&hauled, 2, 0x15, false, &q)
	q.BoatLook = ship.BoatLook
	haul := update(&ship, &q)
	if haul[0]>>6 != OpUpdateRig || haul[2] != (ChangeYards|ChangeFore)>>8 {
		t.Errorf("the haul's update %x", haul)
	}
	// The fore yards let go and hauled after them: the fore yards' alone.
	hauled.ForeYards = -0.7
	var after Boat
	Quantise(&hauled, 2, 0x15, false, &after)
	after.BoatLook = ship.BoatLook
	letGo := update(&q, &after)
	if letGo[0]>>6 != OpUpdateRig || letGo[2] != ChangeFore>>8 || after.Fore != 0 {
		t.Errorf("the let go's update %x, fore %d", letGo, after.Fore)
	}
	t.Logf("her enter %d bytes (a boat with no rig's %d); her heading's update %d, the mainsail haul's %d, the let go's %d",
		len(enter(&ship)), len(enter(&dinghy)), len(heading), len(haul), len(letGo))
}

// A skiff's gennaker goes in her enter and her updates while it is
// hoisted at all: its hoist a byte and its clew two, 3 bytes more than the
// same skiff with it in its bag, which sails at a dinghy's sizes; its clew
// is not sent in the bag, wherever it swings. Hoisting, the hoist alone
// changes, the rig's second mask byte with one byte after it.
func TestTheGennakerOnTheWire(t *testing.T) {
	st := physics.State{X: 400, Y: 300, Heading: 2.4, Boom: -1.0, Jib: -0.3, Hoist: 0.5, HoistTarget: 1, Kite: -1.1}
	bagged := st
	bagged.Hoist, bagged.HoistTarget = 0, 0
	var set, bag Boat
	Quantise(&st, 3, 0x15, false, &set)
	Quantise(&bagged, 3, 0x15, false, &bag)
	if bag.Kite != 0 || bag.Hoist != 0 {
		t.Errorf("in its bag the gennaker is sent: clew %d, hoist %d", bag.Kite, bag.Hoist)
	}
	enter := func(q *Boat) []byte { return AppendEntry(nil, &Entry{Slot: 7, Op: OpEnter, Boat: *q}) }
	if a, b := len(enter(&set)), len(enter(&bag)); a != b+3 {
		t.Errorf("her enter under the gennaker %d bytes, with it in its bag %d", a, b)
	}
	var v0, v1 View
	v0.Put(7, &set)
	up := st
	up.Hoist = 0.75
	var q Boat
	Quantise(&up, 3, 0x15, false, &q)
	v1.Put(7, &q)
	b, n := AppendEntries(nil, &v0, &v1, 0, 1<<7)
	if n != 1 || b[0]>>6 != OpUpdateRig || b[1] != 0 || b[2] != ChangeHoist>>8 || len(b) != 4 {
		t.Errorf("the hoist's update %x", b)
	}
	var e Entry
	if _, err := ReadEntry(enter(&set), &e); err != nil || e.Boat.Kite != set.Kite || e.Boat.Hoist != set.Hoist || e.Boat.Kind != 3 {
		t.Errorf("her enter read back as %+v, %v", e.Boat, err)
	}
}
