// SPDX-License-Identifier: AGPL-3.0-only

// Package shipmates is shipmates: two people who have sailed together
// aboard one boat for five minutes or more, in the last 30 days, may
// become shipmates, one offering and the other accepting. Shipmates see
// when the other is in the game (unless they appear offline), knock on
// the other's boat without a link (its skipper still answers), and
// message each other anywhere in the game while both are in it; nothing
// is ever kept for later.
//
// Shipmates are made only within one age band, both adults or both 13 to
// 17. An offer between the bands is kept and shown to its sender as any
// offer waiting, and never reaches its receiver: nothing anyone sees says
// why, or says anything of an age. Machine sailors are never shipmates.
//
// Either shipmate ends it at any time, at once for both; the other is
// never told, and sees only the name gone from their list. Ending it is
// recorded nowhere but in the row's deletion, and an offer again needs
// the two to sail together again. A block ends it too.
package shipmates

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/chat"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/review"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Numbers.
const (
	// Sailed is how long ago two people may have sailed together to
	// offer.
	Sailed = 30 * 24 * time.Hour
	// Recent is how far back the list of recent crew reaches.
	Recent = 24 * time.Hour
	// Lookup is how long the store may take over one of the routes' asks.
	Lookup = 5 * time.Second
)

// Store is the store's side of shipmates.
type Store interface {
	Talker(ctx context.Context, id store.AccountID) (store.Talker, error)
	SailedWith(ctx context.Context, a, b store.AccountID) (store.Sailed, error)
	ShipmatesOf(ctx context.Context, id store.AccountID) ([]store.Mate, error)
	CountShipmates(ctx context.Context, id store.AccountID) (int, error)
	OffersTo(ctx context.Context, id store.AccountID, now time.Time) ([]store.Mate, error)
	CountOffersFrom(ctx context.Context, id store.AccountID, now time.Time) (int, error)
	OfferOf(ctx context.Context, from, to store.AccountID, now time.Time) (store.Offer, error)
	MakeOffer(ctx context.Context, from, to store.AccountID, silent bool, now time.Time) error
	DeclineOffer(ctx context.Context, from, to store.AccountID) error
	MakeShipmates(ctx context.Context, a, b store.AccountID) (bool, error)
	EndShipmates(ctx context.Context, a, b store.AccountID) (bool, error)
	RecentCrew(ctx context.Context, id store.AccountID, since, now time.Time) ([]store.Mate, error)
	SetAppearOffline(ctx context.Context, id store.AccountID, on bool) error
}

// World is the world sailed now, as shipmates reach it: where someone is
// in the game, who sits in a seat aboard, putting someone blocked ashore,
// and telling a connection its shipmates changed.
type World interface {
	Presence(a bus.Account) edge.Presence
	PersonAt(account bus.Account, seat uint32) (a bus.Account, machine, ok bool)
	PutAshoreBlocked(skipper, other bus.Account)
	Shipmates(a bus.Account)
}

// Config is what shipmates reach.
type Config struct {
	Store    Store
	Ties     *aboard.Ties
	Switches *aboard.Switches
	// World, Hub and Tally are the world sailed now's, nil between worlds.
	World func() World
	Hub   func() *chat.Hub
	Tally func() *Tally
	// Tie keeps a block, as the game connection's does; Report keeps a
	// report.
	Tie    func(ctx context.Context, account, other bus.Account, block, on bool) error
	Report func(ctx context.Context, in review.In) error
	// Look is an account's sailor's look code, as the world draws it.
	Look    func(a store.Account) uint32
	Log     *slog.Logger
	Metrics *obs.Metrics
	Now     func() time.Time
}

// Service is shipmates.
type Service struct{ cfg Config }

// New makes shipmates.
func New(cfg Config) *Service {
	if cfg.Log == nil {
		cfg.Log = slog.New(slog.DiscardHandler)
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.World == nil {
		cfg.World = func() World { return nil }
	}
	if cfg.Hub == nil {
		cfg.Hub = func() *chat.Hub { return nil }
	}
	if cfg.Tally == nil {
		cfg.Tally = func() *Tally { return nil }
	}
	if cfg.Look == nil {
		cfg.Look = func(store.Account) uint32 { return 0 }
	}
	return &Service{cfg: cfg}
}

// Errors.
var (
	// ErrNoOne is nobody the player may name here: not on their lists,
	// not aboard with them, a machine sailor, or themselves.
	ErrNoOne = errors.New("shipmates: nobody to name")
	// ErrGone is an offer that is no longer waiting.
	ErrGone = errors.New("shipmates: the offer is gone")
	// ErrFull is a player with as many shipmates as they may keep.
	ErrFull = errors.New("shipmates: as many shipmates as may be kept")
)

// What came of an offer.
const (
	// Offered: waiting for the other's answer (or, between the age bands,
	// lapsing unanswered: the sender cannot tell).
	Offered = "offered"
	// Made: the other had offered too.
	Made = "made"
	// NotYet: not sailed together long enough in the last 30 days.
	NotYet = "not-yet"
	// Full: the offerer has as many shipmates as they may keep.
	Full = "full"
	// Offers: as many of the offerer's offers wait as may.
	Offers = "offers"
	// Already: shipmates already.
	Already = "already"
)

// Target is whom an ask names: an account on the player's lists by its
// ID, or someone aboard the player's boat now by their seat.
type Target struct {
	ID     store.AccountID
	Seat   uint32
	BySeat bool
}

// resolve is the account a target names for me, a person.
func (s *Service) resolve(me store.AccountID, t Target) (store.AccountID, error) {
	if !t.BySeat {
		if t.ID == me {
			return t.ID, ErrNoOne
		}
		return t.ID, nil
	}
	w := s.cfg.World()
	if w == nil {
		return store.AccountID{}, ErrNoOne
	}
	a, machine, ok := w.PersonAt(bus.Account(me), t.Seat)
	if !ok || machine || store.AccountID(a) == me {
		return store.AccountID{}, ErrNoOne
	}
	return store.AccountID(a), nil
}

// person is a human's talker, and their band now; ErrNoOne for any other.
func (s *Service) person(ctx context.Context, id store.AccountID) (store.Talker, aboard.Band, error) {
	t, err := s.cfg.Store.Talker(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return t, aboard.Unknown, ErrNoOne
	}
	if err != nil {
		return t, aboard.Unknown, err
	}
	if t.Kind != store.Human {
		return t, aboard.Unknown, ErrNoOne
	}
	band := aboard.Unknown
	if b, ok := aboard.BornOf(t.Born); ok {
		band = aboard.BandOf(b, s.cfg.Now())
	}
	return t, band, nil
}

func (s *Service) count(what string) {
	if m := s.cfg.Metrics; m != nil {
		m.Shipmates.WithLabelValues(what).Inc()
	}
}

// tell tells each account's connection its shipmates changed.
func (s *Service) tell(accounts ...store.AccountID) {
	w := s.cfg.World()
	if w == nil {
		return
	}
	for _, a := range accounts {
		w.Shipmates(bus.Account(a))
	}
}

// Offer is me's offer to be shipmates with whom the target names: what
// came of it, one of Offered, Made, NotYet, Full, Offers and Already.
func (s *Service) Offer(ctx context.Context, me store.AccountID, t Target) (string, error) {
	other, err := s.resolve(me, t)
	if err != nil {
		return "", err
	}
	_, mine, err := s.person(ctx, me)
	if err != nil {
		return "", err
	}
	_, theirs, err := s.person(ctx, other)
	if err != nil {
		return "", err
	}
	if s.cfg.Ties.Shipmates(me, other) {
		return Already, nil
	}
	now := s.cfg.Now()
	sw, err := s.cfg.Store.SailedWith(ctx, me, other)
	switch {
	case errors.Is(err, store.ErrNotFound):
		return NotYet, nil
	case err != nil:
		return "", err
	case sw.Long.IsZero() || sw.Long.Before(now.Add(-Sailed)):
		return NotYet, nil
	}
	switch _, err := s.cfg.Store.OfferOf(ctx, me, other, now); {
	case err == nil:
		return Offered, nil
	case !errors.Is(err, store.ErrNotFound):
		return "", err
	}
	if n, err := s.cfg.Store.CountShipmates(ctx, me); err != nil {
		return "", err
	} else if n >= store.MaxShipmates {
		return Full, nil
	}
	if n, err := s.cfg.Store.CountOffersFrom(ctx, me, now); err != nil {
		return "", err
	} else if n >= store.MaxOffers {
		return Offers, nil
	}
	// Between the age bands, or with a block between the two, the offer
	// never reaches the other; its sender sees it waiting as any other.
	silent := !aboard.MayBeShipmates(mine, theirs) || s.cfg.Ties.Blocks(me, other)
	if !silent {
		back, err := s.cfg.Store.OfferOf(ctx, other, me, now)
		if err == nil && !back.Silent {
			// They offered too: shipmates.
			if made, err := s.make(ctx, me, other); err != nil {
				return "", err
			} else if made {
				return Made, nil
			}
		} else if err != nil && !errors.Is(err, store.ErrNotFound) {
			return "", err
		}
	}
	if err := s.cfg.Store.MakeOffer(ctx, me, other, silent, now); err != nil {
		return "", err
	}
	s.count("offered")
	if !silent {
		s.tell(other)
	}
	return Offered, nil
}

// make makes a and b shipmates if neither has as many as they may keep:
// false if one has.
func (s *Service) make(ctx context.Context, a, b store.AccountID) (bool, error) {
	for _, x := range []store.AccountID{a, b} {
		n, err := s.cfg.Store.CountShipmates(ctx, x)
		if err != nil {
			return false, err
		}
		if n >= store.MaxShipmates {
			return false, nil
		}
	}
	if _, err := s.cfg.Store.MakeShipmates(ctx, a, b); err != nil {
		return false, err
	}
	s.cfg.Ties.SetShipmates(a, b, true)
	s.count("made")
	s.tell(a, b)
	return true, nil
}

// Accept accepts from's offer to me: ErrGone for one not waiting (lapsed,
// declined, or no longer between two who may be shipmates), ErrFull for
// me with as many shipmates as I may keep.
func (s *Service) Accept(ctx context.Context, me, from store.AccountID) error {
	now := s.cfg.Now()
	o, err := s.cfg.Store.OfferOf(ctx, from, me, now)
	switch {
	case errors.Is(err, store.ErrNotFound):
		return ErrGone
	case err != nil:
		return err
	case o.Silent:
		return ErrGone
	}
	_, mine, err := s.person(ctx, me)
	if err != nil {
		return err
	}
	_, theirs, err := s.person(ctx, from)
	if errors.Is(err, ErrNoOne) {
		return ErrGone
	} else if err != nil {
		return err
	}
	if !aboard.MayBeShipmates(mine, theirs) || s.cfg.Ties.Blocks(me, from) {
		return ErrGone
	}
	if n, err := s.cfg.Store.CountShipmates(ctx, me); err != nil {
		return err
	} else if n >= store.MaxShipmates {
		return ErrFull
	}
	made, err := s.make(ctx, me, from)
	if err != nil {
		return err
	}
	if !made {
		return ErrGone
	}
	return nil
}

// Decline declines from's offer to me, silently: from sees it waiting
// until it lapses, as any other.
func (s *Service) Decline(ctx context.Context, me, from store.AccountID) error {
	return s.cfg.Store.DeclineOffer(ctx, from, me)
}

// End ends me's being shipmates with whom the target names, at once for
// both. The other is told nothing but that their list changed.
func (s *Service) End(ctx context.Context, me store.AccountID, t Target) error {
	other, err := s.resolve(me, t)
	if err != nil {
		return err
	}
	return s.Unship(ctx, me, other)
}

// Unship ends a's and b's being shipmates, and every offer between them:
// for No longer shipmates and for a block.
func (s *Service) Unship(ctx context.Context, a, b store.AccountID) error {
	ended, err := s.cfg.Store.EndShipmates(ctx, a, b)
	if err != nil {
		return err
	}
	s.cfg.Ties.SetShipmates(a, b, false)
	if t := s.cfg.Tally(); t != nil {
		t.Forget(bus.Account(a), bus.Account(b))
	}
	if ended {
		s.count("ended")
		s.tell(a, b)
	}
	return nil
}

// known reports whether other is on me's lists: a shipmate, someone they
// sailed with in the last 30 days (whose offer may wait), and the boat
// they were last aboard together.
func (s *Service) known(ctx context.Context, me, other store.AccountID) (shipmate bool, boat uint64, err error) {
	if me == other {
		return false, 0, ErrNoOne
	}
	if s.cfg.Ties.Shipmates(me, other) {
		return true, 0, nil
	}
	sw, err := s.cfg.Store.SailedWith(ctx, me, other)
	if errors.Is(err, store.ErrNotFound) {
		return false, 0, ErrNoOne
	}
	if err != nil {
		return false, 0, err
	}
	return false, sw.Boat, nil
}

// Block blocks other for me, from the lists: as a block aboard, it ends
// their being shipmates, and puts them ashore from me's boat.
func (s *Service) Block(ctx context.Context, me, other store.AccountID) error {
	if _, _, err := s.known(ctx, me, other); err != nil {
		return err
	}
	if s.cfg.Tie == nil {
		return ErrNoOne
	}
	if err := s.cfg.Tie(ctx, bus.Account(me), bus.Account(other), true, true); err != nil {
		return err
	}
	if w := s.cfg.World(); w != nil {
		w.PutAshoreBlocked(bus.Account(me), bus.Account(other))
	}
	return nil
}

// Report reports other, from the lists: a shipmate with the messages
// between the two the server still holds, someone of recent crew with
// what it holds of the boat they were last aboard together.
func (s *Service) Report(ctx context.Context, me, other store.AccountID, reason, note string) error {
	shipmate, boat, err := s.known(ctx, me, other)
	if err != nil {
		return err
	}
	if s.cfg.Report == nil {
		return ErrNoOne
	}
	return s.cfg.Report(ctx, review.In{Reporter: bus.Account(me), Reported: bus.Account(other), Boat: boat, Thread: shipmate, Reason: reason, Note: note})
}

// SetOffline sets whether me appears offline to their shipmates.
func (s *Service) SetOffline(ctx context.Context, me store.AccountID, on bool) error {
	if err := s.cfg.Store.SetAppearOffline(ctx, me, on); err != nil {
		return err
	}
	if h := s.cfg.Hub(); h != nil {
		h.Update(bus.Account(me), func(sp *aboard.Speaker) { sp.Offline = on })
	}
	return nil
}

// Row is someone on a player's lists, as the page shows them: their ID,
// name and look; a shipmate's presence ("game", "sea", or "" for nothing
// shown) and whether they skipper a boat at sea; recent crew's whether a
// shipmate, whether the player's offer waits, and whether the player may
// offer now.
type Row struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Look     uint32 `json:"look"`
	Presence string `json:"presence,omitempty"`
	Skipper  bool   `json:"skipper,omitempty"`
	Shipmate bool   `json:"shipmate,omitempty"`
	Offered  bool   `json:"offered,omitempty"`
	Can      bool   `json:"can,omitempty"`
}

// List is a player's shipmates, the offers to them, their recent crew,
// whether they appear offline, and whether shipmates' messages are on.
type List struct {
	Offline   bool  `json:"offline"`
	Messages  bool  `json:"messages"`
	Shipmates []Row `json:"shipmates"`
	Offers    []Row `json:"offers"`
	Recent    []Row `json:"recent"`
}

func (s *Service) row(m store.Mate) Row {
	return Row{ID: m.ID.String(), Name: m.Name, Look: s.cfg.Look(store.Account{ID: m.ID, Look: m.Look})}
}

// List is me's lists. Nobody else ever sees a player's shipmates or
// where they are.
func (s *Service) List(ctx context.Context, me store.AccountID) (List, error) {
	now := s.cfg.Now()
	t, err := s.cfg.Store.Talker(ctx, me)
	if err != nil {
		return List{}, err
	}
	out := List{Offline: t.Offline, Messages: s.cfg.Switches == nil || s.cfg.Switches.ShipmateMessages(),
		Shipmates: []Row{}, Offers: []Row{}, Recent: []Row{}}
	mates, err := s.cfg.Store.ShipmatesOf(ctx, me)
	if err != nil {
		return List{}, err
	}
	w := s.cfg.World()
	for _, m := range mates {
		r := s.row(m)
		if !m.Offline && w != nil {
			switch p := w.Presence(bus.Account(m.ID)); {
			case p.Sea:
				r.Presence, r.Skipper = "sea", p.Skipper
			case p.In:
				r.Presence = "game"
			}
		}
		out.Shipmates = append(out.Shipmates, r)
	}
	offers, err := s.cfg.Store.OffersTo(ctx, me, now)
	if err != nil {
		return List{}, err
	}
	for _, m := range offers {
		out.Offers = append(out.Offers, s.row(m))
	}
	recent, err := s.cfg.Store.RecentCrew(ctx, me, now.Add(-Recent), now)
	if err != nil {
		return List{}, err
	}
	for _, m := range recent {
		r := s.row(m)
		r.Shipmate, r.Offered = m.Shipmate, m.Offered
		r.Can = !m.Shipmate && !m.Offered && !m.Long.IsZero() && m.Long.After(now.Add(-Sailed))
		out.Recent = append(out.Recent, r)
	}
	return out, nil
}
