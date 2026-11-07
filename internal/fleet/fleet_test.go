// SPDX-License-Identifier: AGPL-3.0-only

package fleet

import (
	"context"
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/fleet/fleettest"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

func id(n byte) store.AccountID { return store.AccountID{15: n} }

// TestFleet: a sailor takes the first free boat of the kind each sailor
// brings to sea, which is theirs from then on; a boat another sailor has in
// the water is taken; ashore a sailor takes any free boat and changes any
// boat's look, checked against the catalog; at sea only in port, where the
// world swaps the boat or changes its look at once.
func TestFleet(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	keel := -1
	for i := range cat.Boats {
		if cat.Boats[i].Fleet == catalog.FleetAccount {
			keel = i
		}
	}
	if keel < 0 {
		t.Fatal("no boat an account shares")
	}
	ann, mary := id(1), id(2) // a human, and her machine sailor
	ms := &fleettest.Store{
		Owners: map[store.AccountID]store.AccountID{ann: ann, mary: ann},
		Names:  map[store.AccountID]string{ann: "Ann Bonny", mary: "Iron Mary"},
		Fleet: []store.Boat{
			{ID: store.BoatID{1}, Kind: string(cat.Boats[0].ID), BoatLook: store.BoatLook{Number: 1}},
			{ID: store.BoatID{2}, Kind: string(cat.Boats[0].ID), BoatLook: store.BoatLook{Number: 2}},
			{ID: store.BoatID{3}, Kind: string(cat.Boats[keel].ID), BoatLook: store.BoatLook{Number: 7, Paint: 2, Name: "Saltpeter"}},
		},
	}
	waves, kinds := cat.Prepare()
	w, err := sim.New(sim.Config{Capacity: 4, Kinds: kinds, Waves: waves, Workers: 1, Tick: 100,
		Terrain: &sim.Terrain{Ports: []sim.Disc{{X: 1000, Y: 0, R: 200}}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	stop := make(chan struct{})
	ticked := make(chan struct{})
	go func() {
		defer close(ticked)
		for {
			select {
			case <-stop:
				return
			case <-time.After(time.Millisecond):
				w.Tick()
			}
		}
	}()
	t.Cleanup(func() { close(stop); <-ticked })
	f := New(Config{Store: ms, Catalog: cat, World: w.Bus, Log: slog.New(slog.DiscardHandler)})
	ctx := context.Background()

	// Ann's first voyage: the first Jolly boat, hers from then on.
	v, err := f.Of(ctx, ann)
	if err != nil || len(v.Boats) != 3 || v.Yours != 0 || v.Boats[0].Yours {
		t.Fatalf("Ann's fleet before she sails: %+v %v", v, err)
	}
	if j := f.ForJoin(ctx, ann); j.Kind != 0 || j.Look != 1<<8 {
		t.Fatalf("Ann's boat: %+v", j)
	}
	// Mary takes the keelboat ashore, and sails it.
	if v, err = f.Take(ctx, mary, store.BoatID{3}); err != nil || !v.Boats[v.Yours].Yours || v.Boats[v.Yours].ID != (store.BoatID{3}) {
		t.Fatalf("Mary takes the keelboat: %+v %v", v, err)
	}
	j := f.ForJoin(ctx, mary)
	if j.Kind != uint16(keel) || j.Name != "Saltpeter" || j.Look != (7<<8|2) {
		t.Fatalf("Mary's boat: %+v", j)
	}
	join(t, w, mary, j)
	// Ann may neither take it nor change it while Mary sails it.
	if _, err := f.Take(ctx, ann, store.BoatID{3}); !errors.Is(err, ErrTaken) {
		t.Fatalf("Ann takes Mary's keelboat: %v", err)
	}
	red := "red-ochre"
	if _, err := f.SetLook(ctx, ann, store.BoatID{3}, Change{Paint: &red}); !errors.Is(err, ErrTaken) {
		t.Fatalf("Ann paints Mary's keelboat: %v", err)
	}
	if v, _ := f.Of(ctx, ann); !v.Boats[2].Taken() || v.Boats[2].SailorName != "Iron Mary" {
		t.Fatalf("the keelboat as Ann sees it: %+v", v.Boats[2])
	}

	// Ann's own Jolly boat ashore: looks checked, then kept.
	bad, long, two := "puce", "abcdefghijklmnopqrstu", "Jo"
	for _, c := range []Change{{Paint: &bad}, {Cloth: &bad}, {Number: new(0)}, {Number: new(10000)}} {
		if _, err := f.SetLook(ctx, ann, store.BoatID{1}, c); !errors.Is(err, ErrLook) {
			t.Errorf("%+v: %v", c, err)
		}
	}
	if _, err := f.SetLook(ctx, ann, store.BoatID{1}, Change{Name: &long}); !isRefusal(err, moderation.Long) {
		t.Errorf("a long name: %v", err)
	}
	if _, err := f.SetLook(ctx, ann, store.BoatID{1}, Change{Number: new(2)}); !errors.Is(err, ErrNumber) {
		t.Errorf("another boat's number: %v", err)
	}
	if _, err := f.SetLook(ctx, ann, store.BoatID{9}, Change{}); !errors.Is(err, ErrNoBoat) {
		t.Errorf("no such boat: %v", err)
	}
	v, err = f.SetLook(ctx, ann, store.BoatID{1}, Change{Paint: &red, Number: new(12), Name: &two})
	if b := v.Boats[0]; err != nil || b.Paint != 3 || b.Number != 12 || b.Name != "Jo" {
		t.Fatalf("Ann's look ashore: %+v %v", b, err)
	}

	// At sea out of port: refused; in port: changed in the world.
	s := join(t, w, ann, f.ForJoin(ctx, ann))
	place(t, w, s, 0, 0)
	if _, err := f.SetLook(ctx, ann, store.BoatID{1}, Change{Name: new("")}); !errors.Is(err, ErrPort) {
		t.Fatalf("a look at sea: %v", err)
	}
	if _, err := f.Take(ctx, ann, store.BoatID{2}); !errors.Is(err, ErrPort) {
		t.Fatalf("a swap at sea: %v", err)
	}
	place(t, w, s, 1000, 0)
	if v, err := f.SetLook(ctx, ann, store.BoatID{1}, Change{Name: new("")}); err != nil || v.Boats[0].Name != "" {
		t.Fatalf("a look in port: %+v %v", v.Boats[0], err)
	}
	if look, name := lookOf(w, s); name != "" || look != 12<<8|3 {
		t.Fatalf("in the world: %#x %q", look, name)
	}
	// A swap in port: the boat in the water is the second Jolly boat.
	if v, err := f.Take(ctx, ann, store.BoatID{2}); err != nil || v.Boats[v.Yours].ID != (store.BoatID{2}) || v.Boats[0].Held {
		t.Fatalf("a swap in port: %+v %v", v, err)
	}
	if look, _ := lookOf(w, s); look != 2<<8 {
		t.Fatalf("the swapped boat in the world: %#x", look)
	}
	// A sailor of no account is ashore with the first kind.
	if j := f.ForJoin(ctx, id(9)); j != (Join{}) {
		t.Fatalf("a sailor with no fleet: %+v", j)
	}
}

func isRefusal(err error, r moderation.Reason) bool {
	ref, ok := errors.AsType[*moderation.Refusal](err)
	return ok && ref.Reason == r
}

// join puts a sailor's boat in the water as it would join, and returns its
// slot.
func join(t *testing.T, w *sim.World, a store.AccountID, j Join) int32 {
	t.Helper()
	r := ask(t, w, bus.Command{Op: bus.Join, Account: bus.Account(a), Conn: 1, BoatKind: j.Kind, BoatLook: j.Look, BoatName: j.Name})
	if r.Result != bus.Joined {
		t.Fatalf("joined: %+v", r)
	}
	return r.Slot
}

func place(t *testing.T, w *sim.World, s int32, x, y float64) {
	t.Helper()
	fr := w.Bus().Frames.Acquire()
	boat := fr.Boat[s]
	fr.Release()
	if r := ask(t, w, bus.Command{Op: bus.Place, Boat: boat, State: physics.State{X: x, Y: y}}); r.Result != bus.Done {
		t.Fatalf("placed: %+v", r)
	}
}

// lookOf is the look and name of the boat in slot s, as the world's
// latest frame has them.
func lookOf(w *sim.World, s int32) (uint32, string) {
	// A change the world answered is in the frame after its tick's.
	fr := w.Bus().Frames.Acquire()
	after := fr.Tick + 1
	fr.Release()
	for {
		fr = w.Bus().Frames.Acquire()
		if fr.Tick >= after {
			break
		}
		fr.Release()
		time.Sleep(time.Millisecond)
	}
	defer fr.Release()
	return fr.BoatLook[s], fr.BoatName[s]
}

func ask(t *testing.T, w *sim.World, c bus.Command) bus.Reply {
	t.Helper()
	reply := make(chan bus.Reply, 1)
	c.Reply = reply
	if err := w.Bus().Commands.Developer().TrySend(c); err != nil {
		t.Fatal(err)
	}
	select {
	case r := <-reply:
		// The frame of the tick that applied it is published after it.
		for {
			fr := w.Bus().Frames.Acquire()
			tick := fr.Tick
			fr.Release()
			if tick >= r.Tick {
				return r
			}
			time.Sleep(time.Millisecond)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("no answer to %s", c.Op)
		return bus.Reply{}
	}
}
