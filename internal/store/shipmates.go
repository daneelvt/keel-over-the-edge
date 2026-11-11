// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"bytes"
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/daneelvt/keel-over-the-edge/internal/store/db"
)

// Shipmates. Who sailed with whom (a pair once, kept 30 days), offers to
// be shipmates (lapsing after 7 days) and the shipmates made, and a
// player's choice to appear offline to them. The rules for offering and
// accepting are the shipmates service's; these are its rows. No message
// between shipmates is ever written here.

// Limits.
const (
	// MaxShipmates is the most shipmates an account keeps; MaxOffers the
	// most of its offers that wait at once.
	MaxShipmates = 200
	MaxOffers    = 20
	// OfferLapse is how long an offer waits for its answer.
	OfferLapse = 7 * 24 * time.Hour
	// SailedKeep is how long who sailed with whom is kept.
	SailedKeep = 30 * 24 * time.Hour
)

// pair is a and b the lesser first, as the tables keep pairs.
func pair(a, b AccountID) (AccountID, AccountID) {
	if bytes.Compare(a[:], b[:]) > 0 {
		return b, a
	}
	return a, b
}

// AllShipmates are every pair of shipmates, to be held in memory.
func (s *Store) AllShipmates(ctx context.Context) ([]Tie, error) {
	rows, err := s.q.AllShipmates(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Tie, len(rows))
	for i, r := range rows {
		out[i] = Tie{r.AID.Bytes, r.BID.Bytes}
	}
	return out, nil
}

// SawTogether records that a and b are aboard boat together at at; with
// sailed, that they have been for five minutes or more.
func (s *Store) SawTogether(ctx context.Context, a, b AccountID, at time.Time, boat uint64, sailed bool) error {
	a, b = pair(a, b)
	return s.q.SawTogether(ctx, db.SawTogetherParams{AID: uuidOf(a), BID: uuidOf(b), At: at, Sailed: sailed, Boat: int64(boat)})
}

// Sailed is what is kept of two people's sailing together: the last time
// they were aboard together, the last time they had been for five
// minutes or more (zero for never, or not since they were last
// shipmates), and the boat they were last aboard.
type Sailed struct {
	Seen, Long time.Time
	Boat       uint64
}

// SailedWith is what is kept of a's and b's sailing together:
// ErrNotFound for nothing.
func (s *Store) SailedWith(ctx context.Context, a, b AccountID) (Sailed, error) {
	a, b = pair(a, b)
	r, err := s.q.SailedWith(ctx, db.SailedWithParams{AID: uuidOf(a), BID: uuidOf(b)})
	if errors.Is(err, pgx.ErrNoRows) {
		return Sailed{}, ErrNotFound
	}
	if err != nil {
		return Sailed{}, err
	}
	return Sailed{Seen: r.SeenAt, Long: timeOf(r.SailedAt), Boat: uint64(r.Boat)}, nil
}

// Mate is someone on a player's lists of shipmates, offers or recent
// crew.
type Mate struct {
	ID   AccountID
	Name string
	Look Look
	// Offline: a shipmate who appears offline.
	Offline bool
	// Recent crew's: the last time aboard together, the last time five
	// minutes or more, the boat, whether shipmates, and whether the
	// player's own offer waits.
	Seen, Long time.Time
	Boat       uint64
	Shipmate   bool
	Offered    bool
}

// ShipmatesOf are an account's shipmates, by name.
func (s *Store) ShipmatesOf(ctx context.Context, id AccountID) ([]Mate, error) {
	rows, err := s.q.ShipmatesOf(ctx, uuidOf(id))
	if err != nil {
		return nil, err
	}
	out := make([]Mate, len(rows))
	for i, r := range rows {
		out[i] = Mate{ID: r.ID.Bytes, Name: r.Name, Offline: r.AppearOffline,
			Look: lookOfRow(r.Look, r.Version, r.Skin, r.Hair, r.Colour, r.Finish, r.LookChosen)}
	}
	return out, nil
}

// CountShipmates is how many shipmates an account has.
func (s *Store) CountShipmates(ctx context.Context, id AccountID) (int, error) {
	n, err := s.q.CountShipmates(ctx, uuidOf(id))
	return int(n), err
}

// OffersTo are the offers made to an account that reach it, waiting, at
// now, the oldest first.
func (s *Store) OffersTo(ctx context.Context, id AccountID, now time.Time) ([]Mate, error) {
	rows, err := s.q.OffersTo(ctx, db.OffersToParams{ID: uuidOf(id), Since: now.Add(-OfferLapse)})
	if err != nil {
		return nil, err
	}
	out := make([]Mate, len(rows))
	for i, r := range rows {
		out[i] = Mate{ID: r.FromID.Bytes, Name: r.Name, Look: lookOfRow(r.Look, r.Version, r.Skin, r.Hair, r.Colour, r.Finish, r.LookChosen)}
	}
	return out, nil
}

// CountOffersFrom is how many of an account's offers wait at now.
func (s *Store) CountOffersFrom(ctx context.Context, id AccountID, now time.Time) (int, error) {
	n, err := s.q.CountOffersFrom(ctx, db.CountOffersFromParams{ID: uuidOf(id), Since: now.Add(-OfferLapse)})
	return int(n), err
}

// Offer is an offer waiting: whether it reaches its receiver.
type Offer struct {
	Silent bool
	Made   time.Time
}

// OfferOf is from's offer to to, waiting at now: ErrNotFound for none.
func (s *Store) OfferOf(ctx context.Context, from, to AccountID, now time.Time) (Offer, error) {
	r, err := s.q.OfferOf(ctx, db.OfferOfParams{FromID: uuidOf(from), ToID: uuidOf(to), Since: now.Add(-OfferLapse)})
	if errors.Is(err, pgx.ErrNoRows) {
		return Offer{}, ErrNotFound
	}
	if err != nil {
		return Offer{}, err
	}
	return Offer{Silent: r.Silent, Made: r.MadeAt}, nil
}

// MakeOffer keeps from's offer to to; silent, it never reaches to. An
// offer waiting already is kept as it is; a lapsed one is made anew.
func (s *Store) MakeOffer(ctx context.Context, from, to AccountID, silent bool, now time.Time) error {
	return s.q.InsertOffer(ctx, db.InsertOfferParams{FromID: uuidOf(from), ToID: uuidOf(to), Silent: silent, Since: now.Add(-OfferLapse)})
}

// DeclineOffer silences from's offer to to: it reaches to no more, and
// from sees it waiting until it lapses.
func (s *Store) DeclineOffer(ctx context.Context, from, to AccountID) error {
	_, err := s.q.SilenceOffer(ctx, db.SilenceOfferParams{FromID: uuidOf(from), ToID: uuidOf(to)})
	return err
}

// MakeShipmates makes a and b shipmates, and their offers go: false if
// they were already.
func (s *Store) MakeShipmates(ctx context.Context, a, b AccountID) (bool, error) {
	a, b = pair(a, b)
	var made bool
	err := s.inTx(ctx, func(q *db.Queries) error {
		n, err := q.InsertShipmate(ctx, db.InsertShipmateParams{AID: uuidOf(a), BID: uuidOf(b)})
		if err != nil {
			return err
		}
		made = n > 0
		return q.DeleteOffers(ctx, db.DeleteOffersParams{AID: uuidOf(a), BID: uuidOf(b)})
	})
	return made, err
}

// EndShipmates ends a's and b's being shipmates, if they are, and every
// offer between them; and what they sailed together counts no more, so
// that an offer again needs them to sail together again. It reports
// whether they were shipmates. Nothing records it but the row's going.
func (s *Store) EndShipmates(ctx context.Context, a, b AccountID) (bool, error) {
	a, b = pair(a, b)
	var ended bool
	err := s.inTx(ctx, func(q *db.Queries) error {
		n, err := q.DeleteShipmate(ctx, db.DeleteShipmateParams{AID: uuidOf(a), BID: uuidOf(b)})
		if err != nil {
			return err
		}
		ended = n > 0
		if err := q.DeleteOffers(ctx, db.DeleteOffersParams{AID: uuidOf(a), BID: uuidOf(b)}); err != nil {
			return err
		}
		return q.ForgetSailed(ctx, db.ForgetSailedParams{AID: uuidOf(a), BID: uuidOf(b)})
	})
	return ended, err
}

// RecentCrew are those an account was aboard with since since, the
// latest first, at most 50; offers waiting at now.
func (s *Store) RecentCrew(ctx context.Context, id AccountID, since, now time.Time) ([]Mate, error) {
	rows, err := s.q.RecentCrew(ctx, db.RecentCrewParams{ID: uuidOf(id), Since: since, OffersSince: now.Add(-OfferLapse)})
	if err != nil {
		return nil, err
	}
	out := make([]Mate, len(rows))
	for i, r := range rows {
		out[i] = Mate{ID: r.ID.Bytes, Name: r.Name, Look: lookOfRow(r.Look, r.Version, r.Skin, r.Hair, r.Colour, r.Finish, r.LookChosen),
			Seen: r.SeenAt, Long: timeOf(r.SailedAt), Boat: uint64(r.Boat), Shipmate: r.Shipmate, Offered: r.Offered}
	}
	return out, nil
}

// SetAppearOffline sets whether a human appears offline to their
// shipmates: ErrNotHuman for any other.
func (s *Store) SetAppearOffline(ctx context.Context, id AccountID, on bool) error {
	n, err := s.q.SetAppearOffline(ctx, db.SetAppearOfflineParams{ID: uuidOf(id), AppearOffline: on})
	if err == nil && n == 0 {
		return ErrNotHuman
	}
	return err
}

// DeleteSailedAndOffers deletes who sailed with whom kept past SailedKeep,
// and the offers lapsed, at now.
func (s *Store) DeleteSailedAndOffers(ctx context.Context, now time.Time) (int64, error) {
	n, err := s.q.DeleteSailedBefore(ctx, now.Add(-SailedKeep))
	if err != nil {
		return n, err
	}
	m, err := s.q.DeleteOffersBefore(ctx, now.Add(-OfferLapse))
	return n + m, err
}
