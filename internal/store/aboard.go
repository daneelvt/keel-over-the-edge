// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/daneelvt/keel-over-the-edge/internal/store/db"
)

// Sailing together: a player's month of birth, given once, and the Rules
// of the sea, accepted once; a skipper's "sail with me" link, kept by its
// token's hash, one live at a time; and the owner's switches for everyone.

// The owner's switches, as the record names them.
const (
	ActionLinkLifetime = "link-lifetime"
	ActionLinks        = "links"
	ActionBoarding     = "boarding"
	// ActionYoung is an account stopped by the game itself: its player
	// said they are under 13. The owner reviews it.
	ActionYoung = "young"
)

// SourceGame is what the game itself records, with no one's hand on it.
const SourceGame = "game"

var (
	// ErrAnswered is a month of birth given for an account that has one.
	ErrAnswered = errors.New("store: the month of birth is given already")
	// ErrNotHuman is a link or an answer for an account that is no
	// human's.
	ErrNotHuman = errors.New("store: not a human's account")
)

func bornOf(code int32) pgtype.Int4 { return pgtype.Int4{Int32: code, Valid: code != 0} }

func lookOfRow(look, version, skin, hair, colour, finish string, chosen bool) Look {
	return Look{Look: look, Version: version, Skin: skin, Hair: hair, Colour: colour, Finish: finish, Chosen: chosen}
}

// SailLink is a link and its skipper as a knock finds them: the skipper's
// account and sailor (its name, its look as kept, which the caller codes
// as the world does), when the link was made and set to expire, and
// whether it was ended. Whether it still works depends on the lifetime in
// force too: aboard.Live.
type SailLink struct {
	Skipper AccountID
	// Owner is a machine sailor skipper's human; zero for a human's link.
	Owner   AccountID
	Name    string
	Look    Look
	Kind    Kind
	Made    time.Time
	Expires time.Time
	Ended   bool
}

// SailLink finds a link by its token's hash: ErrNotFound for none.
func (s *Store) SailLink(ctx context.Context, hash [32]byte) (SailLink, error) {
	r, err := s.q.SailLinkByHash(ctx, hash[:])
	if errors.Is(err, pgx.ErrNoRows) {
		return SailLink{}, ErrNotFound
	}
	if err != nil {
		return SailLink{}, err
	}
	return SailLink{
		Skipper: r.SkipperID.Bytes, Owner: r.OwnerID.Bytes, Name: r.Name, Kind: Kind(r.Kind), Made: r.MadeAt, Expires: r.ExpiresAt, Ended: r.Ended,
		Look: lookOfRow(r.Look, r.Version, r.Skin, r.Hair, r.Colour, r.Finish, r.LookChosen),
	}, nil
}

// Knocker is an account as a knock shows it: its sailor's name and look
// as kept, its kind, its month of birth (year × 100 + month, 0 for not
// given) and whether it has accepted the Rules of the sea.
type Knocker struct {
	Name  string
	Look  Look
	Kind  Kind
	Born  int32
	Rules bool
}

// Knocker finds an account as a knock shows it: ErrNotFound for none.
func (s *Store) Knocker(ctx context.Context, id AccountID) (Knocker, error) {
	r, err := s.q.KnockerOf(ctx, uuidOf(id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Knocker{}, ErrNotFound
	}
	if err != nil {
		return Knocker{}, err
	}
	return Knocker{
		Name: r.Name, Kind: Kind(r.Kind), Born: r.Born, Rules: r.Rules,
		Look: lookOfRow(r.Look, r.Version, r.Skin, r.Hair, r.Colour, r.Finish, r.LookChosen),
	}, nil
}

// MakeSailLink keeps a new link of a human skipper's, by its token's hash,
// made and set to expire at the times given, and ends the skipper's live
// one in the same transaction. ErrNotHuman for an account that is not a
// human's (or none); ErrTokenTaken if another link has the hash.
func (s *Store) MakeSailLink(ctx context.Context, skipper AccountID, hash [32]byte, made, expires time.Time) error {
	err := s.inTx(ctx, func(q *db.Queries) error {
		if _, err := q.EndLiveSailLink(ctx, uuidOf(skipper)); err != nil {
			return err
		}
		n, err := q.InsertSailLink(ctx, db.InsertSailLinkParams{Hash: hash[:], MadeAt: made, ExpiresAt: expires, SkipperID: uuidOf(skipper)})
		if err != nil {
			return err
		}
		if n == 0 {
			return ErrNotHuman
		}
		return nil
	})
	if uniqueViolation(err, "sail_link_hash_key") {
		return ErrTokenTaken
	}
	return err
}

// MakeMachineSailLink keeps a new link of a machine sailor's, made by its
// owner, as MakeSailLink does a human's: ErrNotFound for a machine sailor
// that is not the owner's (or none).
func (s *Store) MakeMachineSailLink(ctx context.Context, owner, machine AccountID, hash [32]byte, made, expires time.Time) error {
	err := s.inTx(ctx, func(q *db.Queries) error {
		mine, err := q.OwnsMachine(ctx, db.OwnsMachineParams{ID: uuidOf(machine), OwnerID: uuidOf(owner)})
		if err != nil {
			return err
		}
		if !mine {
			return ErrNotFound
		}
		if _, err := q.EndLiveSailLink(ctx, uuidOf(machine)); err != nil {
			return err
		}
		n, err := q.InsertMachineSailLink(ctx, db.InsertMachineSailLinkParams{Hash: hash[:], MadeAt: made, ExpiresAt: expires,
			SkipperID: uuidOf(machine), OwnerID: uuidOf(owner)})
		if err != nil {
			return err
		}
		if n == 0 {
			return ErrNotFound
		}
		return nil
	})
	if uniqueViolation(err, "sail_link_hash_key") {
		return ErrTokenTaken
	}
	return err
}

// OwnsMachine reports whether machine is one of owner's machine sailors.
func (s *Store) OwnsMachine(ctx context.Context, owner, machine AccountID) (bool, error) {
	return s.q.OwnsMachine(ctx, db.OwnsMachineParams{ID: uuidOf(machine), OwnerID: uuidOf(owner)})
}

// EndSailLink ends the skipper's live link, and reports whether it had
// one.
func (s *Store) EndSailLink(ctx context.Context, skipper AccountID) (bool, error) {
	n, err := s.q.EndLiveSailLink(ctx, uuidOf(skipper))
	return n > 0, err
}

// EndAllSailLinks ends every live link, and returns how many it ended.
func (s *Store) EndAllSailLinks(ctx context.Context) (int64, error) {
	return s.q.EndAllSailLinks(ctx)
}

// LiveSailLink is the skipper's link not ended, if it has one: when it was
// made and set to expire. It may have expired, or stopped under the
// lifetime in force: aboard.Live says.
func (s *Store) LiveSailLink(ctx context.Context, skipper AccountID) (made, expires time.Time, ok bool, err error) {
	r, err := s.q.LiveSailLink(ctx, uuidOf(skipper))
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, time.Time{}, false, nil
	}
	if err != nil {
		return time.Time{}, time.Time{}, false, err
	}
	return r.MadeAt, r.ExpiresAt, true, nil
}

// CountLiveSailLinks counts the links that work now under the lifetime
// given.
func (s *Store) CountLiveSailLinks(ctx context.Context, lifetime time.Duration) (int64, error) {
	return s.q.CountLiveSailLinks(ctx, lifetime.Microseconds())
}

// SailLinksEndedBy is how many links that work under the lifetime now a
// new lifetime d would stop at once.
func (s *Store) SailLinksEndedBy(ctx context.Context, now, d time.Duration) (int64, error) {
	return s.q.SailLinksEndedBy(ctx, db.SailLinksEndedByParams{NowMicros: now.Microseconds(), Micros: d.Microseconds()})
}

// LinkBatch is how many links one statement deletes.
const LinkBatch = 1000

// DeleteSailLinks deletes the links that stopped working before the time
// given, ended, expired or past the lifetime given, LinkBatch at a time,
// and returns how many it deleted.
func (s *Store) DeleteSailLinks(ctx context.Context, before time.Time, lifetime time.Duration) (int64, error) {
	var total int64
	for {
		n, err := s.q.DeleteStoppedSailLinks(ctx, db.DeleteStoppedSailLinksParams{Before: before, Micros: lifetime.Microseconds(), Lim: LinkBatch})
		total += n
		if err != nil || n < LinkBatch {
			return total, err
		}
	}
}

// SetBorn keeps a human's month of birth, year × 100 + month, once:
// ErrAnswered for one given already, ErrNotFound for no such account,
// ErrNotHuman for a machine sailor's.
func (s *Store) SetBorn(ctx context.Context, id AccountID, born int32) error {
	return s.inTx(ctx, func(q *db.Queries) error {
		n, err := q.SetBorn(ctx, db.SetBornParams{Born: bornOf(born), ID: uuidOf(id)})
		if err != nil || n > 0 {
			return err
		}
		r, err := q.AccountBorn(ctx, uuidOf(id))
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			return ErrNotFound
		case err != nil:
			return err
		case Kind(r.Kind) != Human:
			return ErrNotHuman
		}
		return ErrAnswered
	})
}

// AcceptRules records that a human accepted the Rules of the sea; again
// changes nothing. ErrNotFound for no human's account of the id.
func (s *Store) AcceptRules(ctx context.Context, id AccountID) error {
	n, err := s.q.AcceptRules(ctx, uuidOf(id))
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// SailSettings are the owner's switches as kept: how long a link lasts,
// whether links work and whether anyone may come aboard.
func (s *Store) SailSettings(ctx context.Context) (lifetime time.Duration, links, boarding bool, err error) {
	r, err := s.q.SailSettings(ctx)
	if err != nil {
		return 0, false, false, err
	}
	return time.Duration(r.Micros) * time.Microsecond, r.Links, r.Boarding, nil
}

// setting writes one of the owner's switches and its entry in the record,
// in one transaction.
func (s *Store) setting(ctx context.Context, a Action, set func(q *db.Queries) error) error {
	a.HasAccount = false
	return s.inTx(ctx, func(q *db.Queries) error {
		if err := set(q); err != nil {
			return err
		}
		return insertAction(ctx, q, a)
	})
}

// SetLinkLifetime sets how long a link lasts from when it is made, from 5
// minutes to 7 days, and records a's action with it.
func (s *Store) SetLinkLifetime(ctx context.Context, d time.Duration, a Action) error {
	a.Action = ActionLinkLifetime
	return s.setting(ctx, a, func(q *db.Queries) error {
		_, err := q.SetLinkLifetime(ctx, d.Microseconds())
		return err
	})
}

// SetLinks switches links on or off for everyone, and records a's action
// with it. Off, every live link ends in the same transaction: ended is how
// many.
func (s *Store) SetLinks(ctx context.Context, on bool, a Action) (ended int64, err error) {
	a.Action = ActionLinks
	err = s.setting(ctx, a, func(q *db.Queries) error {
		if _, err := q.SetLinks(ctx, on); err != nil {
			return err
		}
		if !on {
			var err error
			ended, err = q.EndAllSailLinks(ctx)
			return err
		}
		return nil
	})
	return ended, err
}

// SetBoarding switches coming aboard on or off for everyone, and records
// a's action with it.
func (s *Store) SetBoarding(ctx context.Context, on bool, a Action) error {
	a.Action = ActionBoarding
	return s.setting(ctx, a, func(q *db.Queries) error {
		_, err := q.SetBoarding(ctx, on)
		return err
	})
}
