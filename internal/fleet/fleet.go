// SPDX-License-Identifier: AGPL-3.0-only

// Package fleet is an account's fleet as its sailors sail it: the boats
// they may take, the one each takes to sea, a swap for another boat and a
// change of a boat's look, asked of the world sailed where it must be, in
// port, and kept in the store.
//
// A fleet is shared by a human account's sailors, the account's own and its
// machine sailors. Each boat is one sailor's at a time, the one who sails it
// or sailed it last and takes it again (store.Boat.Sailor). A boat is taken
// while that sailor is in the water, or waits for a boat, in the world
// sailed; otherwise it is free, and a sailor who takes it makes it theirs.
// A sailor with no boat of their own takes the first free boat of the kind
// each sailor brings to the fleet.
//
// A sailor ashore may take any free boat and change any boat's look. At
// sea, they may do either only in port: their boat is swapped where it
// lies, or given its new look in the world at once.
package fleet

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/looks"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Store is what the fleet keeps: internal/store's.
type Store interface {
	Boats(ctx context.Context, owner store.AccountID) ([]store.Boat, error)
	FleetOwner(ctx context.Context, id store.AccountID) (store.AccountID, error)
	GiveBoat(ctx context.Context, owner, sailor store.AccountID, boat store.BoatID) error
	SetBoatLook(ctx context.Context, owner store.AccountID, boat store.BoatID, l store.BoatLook) error
	BoatNumberFree(ctx context.Context, kind string, number int, except store.BoatID) (bool, error)
}

var _ Store = (*store.Store)(nil)

// Config is what a fleet needs.
type Config struct {
	Store   Store
	Catalog *catalog.Catalog
	// World is the world sailed's bus; nil between worlds, when every
	// sailor is ashore.
	World func() *bus.Bus
	Log   *slog.Logger
}

// Fleet answers for every account's fleet.
type Fleet struct {
	cfg   Config
	boats *looks.Boats
	kinds map[string]int // the catalog's boats' places, by id
	// sailors is the kind each sailor brings to the fleet, its place.
	sailors int
}

// New is the fleets of cfg's catalog's boats.
func New(cfg Config) *Fleet {
	f := &Fleet{cfg: cfg, boats: looks.NewBoats(cfg.Catalog), kinds: map[string]int{}}
	for i := range cfg.Catalog.Boats {
		f.kinds[string(cfg.Catalog.Boats[i].ID)] = i
	}
	for i := range cfg.Catalog.Boats {
		if cfg.Catalog.Boats[i].Fleet == catalog.FleetSailor {
			f.sailors = i
			break
		}
	}
	return f
}

// Looks are the catalog's boat looks.
func (f *Fleet) Looks() *looks.Boats { return f.boats }

// Errors of a change.
var (
	// ErrNoBoat is a boat the sailor's fleet does not have.
	ErrNoBoat = errors.New("fleet: no such boat in the fleet")
	// ErrTaken is a boat another sailor of the fleet has in the water.
	ErrTaken = errors.New("fleet: the boat is at sea with another sailor")
	// ErrPort is a change asked at sea out of port.
	ErrPort = errors.New("fleet: at sea out of port")
	// ErrRoom is a swap where the new boat would meet land, shoal water or
	// another boat.
	ErrRoom = errors.New("fleet: no room for the boat here")
	// ErrNumber is a sail number another boat of its kind has.
	ErrNumber = errors.New("fleet: the sail number is another boat's")
	// ErrLook is a paint or cloth not of the catalog's, or a sail number
	// out of its range.
	ErrLook = errors.New("fleet: not a look of the catalog's")
	// ErrBusy is the world not answering in time.
	ErrBusy = errors.New("fleet: the world did not answer")
)

// Boat is a fleet's boat as a sailor is told it.
type Boat struct {
	store.Boat
	// Kind is its kind's place in the catalog.
	Kind int
	// AtSea is whether its sailor is in the water, or waits for a boat.
	AtSea bool
	// Yours is whether it is the asking sailor's.
	Yours bool
}

// Taken is whether another sailor has it in the water.
func (b *Boat) Taken() bool { return b.Held && b.AtSea && !b.Yours }

// Code is its boat look code.
func (b *Boat) Code() uint32 {
	return looks.BoatLook{Paint: b.Paint, Cloth: b.Cloth, Number: b.Number}.Code()
}

// View is a fleet as a sailor sees it: its boats, in the catalog's order
// of kinds and then the order they were made, and which is the sailor's,
// or would be theirs at sea, its index; −1 for none.
type View struct {
	Boats []Boat
	Yours int
	// AtSea is whether the asking sailor is in the water, or waits for a
	// boat.
	AtSea bool
}

// afloat are the accounts with a boat in the world sailed or a place in
// its queue.
func (f *Fleet) afloat() map[store.AccountID]bool {
	out := map[store.AccountID]bool{}
	if f.cfg.World == nil {
		return out
	}
	b := f.cfg.World()
	if b == nil {
		return out
	}
	fr := b.Frames.Acquire()
	defer fr.Release()
	for _, s := range fr.Live {
		out[store.AccountID(fr.Owner[s])] = true
	}
	for i := range fr.Queue {
		out[store.AccountID(fr.Queue[i].Account)] = true
	}
	return out
}

// view is a fleet's boats as sailor sees them, at sea or not by afloat.
func (f *Fleet) view(boats []store.Boat, sailor store.AccountID, afloat map[store.AccountID]bool) View {
	v := View{Yours: -1, AtSea: afloat[sailor]}
	for kind := range f.cfg.Catalog.Boats {
		for _, b := range boats {
			if k, ok := f.kinds[b.Kind]; !ok || k != kind {
				continue
			}
			v.Boats = append(v.Boats, Boat{Boat: b, Kind: kind, AtSea: b.Held && afloat[b.Sailor], Yours: b.Held && b.Sailor == sailor})
		}
	}
	for i := range v.Boats {
		if v.Boats[i].Yours {
			v.Yours = i
		}
	}
	if v.Yours < 0 {
		v.Yours = f.firstFree(&v)
	}
	return v
}

// firstFree is the boat a sailor with none would take: the first free boat
// of the kind each sailor brings, one no sailor has before one whose sailor
// is ashore; −1 for none.
func (f *Fleet) firstFree(v *View) int {
	free := -1
	for i := range v.Boats {
		b := &v.Boats[i]
		if b.Kind != f.sailors || b.Taken() {
			continue
		}
		if !b.Held {
			return i
		}
		if free < 0 {
			free = i
		}
	}
	return free
}

// read is the fleet a sailor sails from, as they see it, and its owner.
func (f *Fleet) read(ctx context.Context, sailor store.AccountID) (View, store.AccountID, error) {
	owner, err := f.cfg.Store.FleetOwner(ctx, sailor)
	if err != nil {
		return View{}, owner, err
	}
	boats, err := f.cfg.Store.Boats(ctx, owner)
	if err != nil {
		return View{}, owner, err
	}
	return f.view(boats, sailor, f.afloat()), owner, nil
}

// Of is the fleet a sailor sails from, as they see it.
func (f *Fleet) Of(ctx context.Context, sailor store.AccountID) (View, error) {
	v, _, err := f.read(ctx, sailor)
	return v, err
}

// Join is a boat as a sailor takes it to sea: its kind's place in the
// catalog, its boat look code and its name.
type Join struct {
	Kind uint16
	Look uint32
	Name string
}

// ForJoin is the boat a sailor takes to sea as they join: their own, or
// the first free boat of the kind each sailor brings, which becomes theirs.
// With no fleet to read, or no free boat, the kind each sailor brings, of
// the first look, unnumbered: a sailor never stays ashore for want of one.
func (f *Fleet) ForJoin(ctx context.Context, sailor store.AccountID) Join {
	fallback := Join{Kind: uint16(f.sailors)}
	v, owner, err := f.read(ctx, sailor)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			f.cfg.Log.Warn("reading the fleet for a sailor's boat", "account", sailor.String(), "err", err)
		}
		return fallback
	}
	if v.Yours < 0 {
		return fallback
	}
	b := &v.Boats[v.Yours]
	if !b.Yours {
		if err := f.cfg.Store.GiveBoat(ctx, owner, sailor, b.ID); err != nil {
			f.cfg.Log.Warn("giving a sailor their boat", "account", sailor.String(), "err", err)
		}
	}
	return Join{Kind: uint16(b.Kind), Look: b.Code(), Name: b.Name}
}

// find is the boat of v with an id, or nil.
func find(v *View, id store.BoatID) *Boat {
	for i := range v.Boats {
		if v.Boats[i].ID == id {
			return &v.Boats[i]
		}
	}
	return nil
}

// Take makes a boat the sailor's: ashore, the boat they take to sea next;
// at sea in port, swapped for theirs where it lies. ErrNoBoat, ErrTaken,
// ErrPort, ErrRoom or ErrBusy if not.
func (f *Fleet) Take(ctx context.Context, sailor store.AccountID, id store.BoatID) (View, error) {
	v, owner, err := f.read(ctx, sailor)
	if err != nil {
		return View{}, err
	}
	b := find(&v, id)
	switch {
	case b == nil:
		return v, ErrNoBoat
	case b.Taken():
		return v, ErrTaken
	case b.Yours:
		return v, nil
	}
	if v.AtSea {
		r, err := f.ask(ctx, bus.Command{Op: bus.SetBoat, Account: bus.Account(sailor), BoatKind: uint16(b.Kind), BoatLook: b.Code(), BoatName: b.Name})
		if err != nil {
			return v, err
		}
		switch r.Result {
		case bus.Away:
			return v, ErrPort
		case bus.NoRoom:
			return v, ErrRoom
		}
	}
	if err := f.cfg.Store.GiveBoat(ctx, owner, sailor, id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return v, ErrNoBoat
		}
		return v, err
	}
	return f.Of(ctx, sailor)
}

// Change is a change of a boat's look: each field given changes, each nil
// stays as it is. Paint and Cloth are catalog ids; a Name of "" clears it.
type Change struct {
	Paint, Cloth *string
	Number       *int
	Name         *string
}

// SetLook changes the look of one of the sailor's fleet's boats: ashore, or
// at sea in port, where it is seen at once if it is the sailor's boat.
// ErrLook for a paint, cloth or number not the catalog's, a
// *moderation.Refusal for a name refused, ErrNoBoat, ErrTaken, ErrNumber,
// ErrPort or ErrBusy if not.
func (f *Fleet) SetLook(ctx context.Context, sailor store.AccountID, id store.BoatID, c Change) (View, error) {
	v, owner, err := f.read(ctx, sailor)
	if err != nil {
		return View{}, err
	}
	b := find(&v, id)
	if b == nil {
		return v, ErrNoBoat
	}
	l := b.BoatLook
	if c.Paint != nil {
		if l.Paint = f.boats.Paint(*c.Paint); l.Paint < 0 {
			return v, ErrLook
		}
	}
	if c.Cloth != nil {
		if l.Cloth = f.boats.Cloth(*c.Cloth); l.Cloth < 0 {
			return v, ErrLook
		}
	}
	if c.Number != nil {
		l.Number = *c.Number
		if l.Number < 1 || l.Number > f.boats.MaxNumber() {
			return v, ErrLook
		}
	}
	if c.Name != nil {
		l.Name = ""
		if *c.Name != "" {
			n, err := moderation.CheckBoatName(*c.Name)
			if err != nil {
				return v, err
			}
			l.Name = n.Display
		}
	}
	if b.Taken() {
		return v, ErrTaken
	}
	if l.Number != b.Number {
		free, err := f.cfg.Store.BoatNumberFree(ctx, b.Boat.Kind, l.Number, b.ID)
		if err != nil {
			return v, err
		}
		if !free {
			return v, ErrNumber
		}
	}
	if b.Yours && v.AtSea {
		code := looks.BoatLook{Paint: l.Paint, Cloth: l.Cloth, Number: l.Number}.Code()
		r, err := f.ask(ctx, bus.Command{Op: bus.SetBoatLook, Account: bus.Account(sailor), BoatLook: code, BoatName: l.Name})
		if err != nil {
			return v, err
		}
		if r.Result == bus.Away {
			return v, ErrPort
		}
	}
	switch err := f.cfg.Store.SetBoatLook(ctx, owner, id, l); {
	case errors.Is(err, store.ErrNumberTaken):
		return v, ErrNumber
	case errors.Is(err, store.ErrNotFound):
		return v, ErrNoBoat
	case err != nil:
		return v, err
	}
	return f.Of(ctx, sailor)
}

// Wait is the longest a change waits for the world's answer.
const Wait = 5 * time.Second

// ask sends the world sailed a command and waits for its answer; between
// worlds, the sailor is ashore (NoBoat).
func (f *Fleet) ask(ctx context.Context, c bus.Command) (bus.Reply, error) {
	if f.cfg.World == nil {
		return bus.Reply{Result: bus.NoBoat, Slot: -1}, nil
	}
	b := f.cfg.World()
	if b == nil {
		return bus.Reply{Result: bus.NoBoat, Slot: -1}, nil
	}
	reply := make(chan bus.Reply, 1)
	c.Reply = reply
	if err := b.Commands.Players().TrySend(c); err != nil {
		return bus.Reply{}, ErrBusy
	}
	ctx, cancel := context.WithTimeout(ctx, Wait)
	defer cancel()
	select {
	case r := <-reply:
		return r, nil
	case <-ctx.Done():
		return bus.Reply{}, ErrBusy
	}
}
