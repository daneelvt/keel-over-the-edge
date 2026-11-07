// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"log/slog"
	"math"
	"slices"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// lifeConn is a connection to be sent the sea's life, each kind's reach
// 1,500 m and the margin 200.
func lifeConn() *conn {
	e := &Edge{cfg: Config{Life: &LifeReach{Reach: []float64{1500, 1500}, Drop: 200}, Log: slog.New(slog.DiscardHandler)},
		m: newMetrics(obs.NewMetrics("test", "test"))}
	return &conn{e: e, queue: make(chan outgoing, 64)}
}

// lifeFrame is a frame of two boats, 1 and 2, in slots 0 and 1, with
// the encounters given.
func lifeFrame(enc ...bus.LifeEncounter) *bus.Frame {
	f := bus.NewFrame(4)
	f.Live = append(f.Live, 0, 1)
	f.Occupied[0], f.Occupied[1] = true, true
	f.Boat[0], f.Boat[1] = 1, 2
	f.State[1] = physics.State{X: 3000, Y: 0}
	f.Life = append(f.Life, enc...)
	return f
}

// lifeSeen is what the connection was sent of the sea's life since last
// asked: the encounters by id and revision, and the ids dropped.
func lifeSeen(t *testing.T, c *conn) (got []*pb.LifeEncounter, dropped []uint64) {
	t.Helper()
	for _, m := range sent(t, c) {
		if l := m.GetLife(); l != nil {
			got = append(got, l.Encounters...)
			dropped = append(dropped, l.Drop...)
		}
	}
	return got, dropped
}

// TestLifeByReach: an encounter reaches a connection once its eye is within
// its reach, once; is sent again on a new revision; and is dropped only
// beyond its reach and the margin, sent again once the eye comes back.
func TestLifeByReach(t *testing.T) {
	c := lifeConn()
	e := bus.LifeEncounter{ID: 7, Kind: 1, Start: 100, End: 9000, East: 5000, North: 0, Heading: 1, Speed: 10, Count: 3, Seed: 99, Slot: -1}
	var v connView
	var events []string
	for _, x := range []float64{0, 3400, 3600, 3700, 5000, 6400, 6600, 6800, 6600, 5000} {
		f := lifeFrame(e)
		if !c.life(f, &v, 0, x, 0) {
			t.Fatal("the connection went bad")
		}
		got, dropped := lifeSeen(t, c)
		for _, g := range got {
			if g.Id != 7 || g.Kind != 1 || g.East != 500_000 || g.Count != 3 || g.Seed != 99 || g.With != lifeFree {
				t.Errorf("at %v: sent %v", x, g)
			}
			events = append(events, "sent")
		}
		for range dropped {
			events = append(events, "dropped")
		}
		if d := math.Abs(x - 5000); d <= 1500 && len(c.lifeSent.sent) != 1 || d > 1700 && len(c.lifeSent.sent) != 0 {
			t.Errorf("at %v m from it, %d sent", d, len(c.lifeSent.sent))
		}
	}
	if !slices.Equal(events, []string{"sent", "dropped", "sent"}) {
		t.Errorf("the encounter was %v", events)
	}
	// A new revision goes again; the same does not.
	e.Rev = 1
	e.End = 4000
	c.life(lifeFrame(e), &v, 0, 5000, 0)
	if got, _ := lifeSeen(t, c); len(got) != 1 || got[0].Rev != 1 || got[0].End != 4000 {
		t.Errorf("the new revision sent as %v", got)
	}
	c.life(lifeFrame(e), &v, 0, 5000, 0)
	if got, _ := lifeSeen(t, c); len(got) != 0 {
		t.Errorf("sent again unchanged: %v", got)
	}
	// Ended, it is let go with no word.
	c.life(lifeFrame(), &v, 0, 5000, 0)
	if got, dropped := lifeSeen(t, c); len(got)+len(dropped) != 0 || len(c.lifeSent.sent) != 0 {
		t.Errorf("an encounter ended: sent %v, dropped %v, kept %v", got, dropped, c.lifeSent.sent)
	}
}

// TestLifeWithABoat: an encounter with a boat goes by that boat's place,
// and as the connection sees the boat: its own, a view slot's, or one it
// does not see; told again when that changes. A spectator's eye is the
// watched boat's, and that boat is its own.
func TestLifeWithABoat(t *testing.T) {
	c := lifeConn()
	e := bus.LifeEncounter{ID: 8, Start: 100, End: 9000, East: -9000, North: 0, Speed: 10, Count: 2, Boat: 2, Slot: 1}
	var v connView
	// From boat 1 at the centre, 3 km from boat 2: out of reach.
	c.life(lifeFrame(e), &v, 0, 0, 0)
	if got, _ := lifeSeen(t, c); len(got) != 0 {
		t.Fatalf("sent from 3 km: %v", got)
	}
	// Nearer, boat 2 unseen, then in view slot 5.
	c.life(lifeFrame(e), &v, 0, 2000, 0)
	got, _ := lifeSeen(t, c)
	if len(got) != 1 || got[0].With != lifeUnseen {
		t.Fatalf("sent as %v", got)
	}
	v.view.Used, v.boat[5] = 1<<5, 2
	c.life(lifeFrame(e), &v, 0, 2000, 0)
	if got, _ := lifeSeen(t, c); len(got) != 1 || got[0].With != lifeSlot+5 {
		t.Errorf("seen in view slot 5, sent as %v", got)
	}
	// A spectator of boat 2 has it as its own.
	w := lifeConn()
	w.life(lifeFrame(e), &connView{}, 1, 3000, 0)
	if got, _ := lifeSeen(t, w); len(got) != 1 || got[0].With != lifeOwn {
		t.Errorf("a spectator of the boat was sent %v", got)
	}
}

// TestLifeAllocatesNothing: once sent, looking again allocates nothing.
func TestLifeAllocatesNothing(t *testing.T) {
	c := lifeConn()
	f := lifeFrame(bus.LifeEncounter{ID: 9, Start: 0, End: 9000, East: 100, Slot: -1}, bus.LifeEncounter{ID: 10, Start: 0, End: 9000, East: 9000, Slot: -1})
	var v connView
	c.life(f, &v, 0, 0, 0)
	lifeSeen(t, c)
	if n := testing.AllocsPerRun(50, func() { c.life(f, &v, 0, 0, 0) }); n != 0 {
		t.Errorf("%v allocations a look", n)
	}
}
