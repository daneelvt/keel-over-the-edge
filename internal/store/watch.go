// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/daneelvt/keel-over-the-edge/internal/store/db"
)

// WatchTarget is a sailor someone asks to watch: its account, its kind,
// its owner (a machine sailor's human, zero for a human's own sailor), its
// name, and whether it, or its owner, is stopped.
type WatchTarget struct {
	ID      AccountID
	Kind    Kind
	Owner   AccountID
	Name    string
	Stopped bool
}

// WatchTarget is the sailor whose name has key, moderation.Key's; ErrNotFound
// if there is none.
func (s *Store) WatchTarget(ctx context.Context, key string) (WatchTarget, error) {
	r, err := s.q.WatchTarget(ctx, key)
	if errors.Is(err, pgx.ErrNoRows) {
		return WatchTarget{}, ErrNotFound
	}
	if err != nil {
		return WatchTarget{}, err
	}
	return WatchTarget{ID: r.ID.Bytes, Kind: Kind(r.Kind), Owner: r.OwnerID.Bytes, Name: r.Name, Stopped: r.Stopped}, nil
}

// Sailor is an account's sailor as a list of boats shows it: its name, its
// kind and its owner, zero for a human's own; and, from SailorsByID, the
// code of its link to watch, which only a machine sailor's card shows.
type Sailor struct {
	Name  string
	Kind  Kind
	Owner AccountID
	Code  string
}

// SailorsByID are the sailors of ids, by account; those not found are left
// out.
func (s *Store) SailorsByID(ctx context.Context, ids []AccountID) (map[AccountID]Sailor, error) {
	us := make([]pgtype.UUID, len(ids))
	for i, id := range ids {
		us[i] = uuidOf(id)
	}
	rows, err := s.q.SailorsByID(ctx, us)
	if err != nil {
		return nil, err
	}
	out := make(map[AccountID]Sailor, len(rows))
	for _, r := range rows {
		out[r.ID.Bytes] = Sailor{Name: r.Name, Kind: Kind(r.Kind), Owner: r.OwnerID.Bytes, Code: r.WatchCode}
	}
	return out, nil
}

// Followed is a sailor an account follows: its account, and the sailor.
type Followed struct {
	ID AccountID
	Sailor
}

// Follows are the sailors an account follows.
func (s *Store) Follows(ctx context.Context, follower AccountID) ([]Followed, error) {
	rows, err := s.q.Follows(ctx, uuidOf(follower))
	if err != nil {
		return nil, err
	}
	out := make([]Followed, len(rows))
	for i, r := range rows {
		out[i] = Followed{ID: r.ID.Bytes, Sailor: Sailor{Name: r.Name, Kind: Kind(r.Kind), Owner: r.OwnerID.Bytes}}
	}
	return out, nil
}

// Follow has follower follow followed's sailor; following it again
// changes nothing.
func (s *Store) Follow(ctx context.Context, follower, followed AccountID) error {
	return s.q.Follow(ctx, db.FollowParams{FollowerID: uuidOf(follower), FollowedID: uuidOf(followed)})
}

// Unfollow has follower stop following followed's sailor.
func (s *Store) Unfollow(ctx context.Context, follower, followed AccountID) error {
	return s.q.Unfollow(ctx, db.UnfollowParams{FollowerID: uuidOf(follower), FollowedID: uuidOf(followed)})
}

// LinkCodes are the codes of an account's links to watch: its sailor's,
// and a human's fleet's of machine sailors, "" for a machine sailor's
// account. A code is short and random, never a name, and lasts until its
// account is deleted or a new one is made.
type LinkCodes struct {
	Sailor string
	Fleet  string
}

// LinkCodes are account id's codes; ErrNotFound for no such account.
func (s *Store) LinkCodes(ctx context.Context, id AccountID) (LinkCodes, error) {
	r, err := s.q.LinkCodes(ctx, uuidOf(id))
	if errors.Is(err, pgx.ErrNoRows) {
		return LinkCodes{}, ErrNotFound
	}
	if err != nil {
		return LinkCodes{}, err
	}
	return LinkCodes{Sailor: r.WatchCode, Fleet: r.FleetCode}, nil
}

// LinkTarget is the sailor whose link to watch has code, as WatchTarget
// has it; ErrNotFound if none has.
func (s *Store) LinkTarget(ctx context.Context, code string) (WatchTarget, error) {
	r, err := s.q.LinkTarget(ctx, code)
	if errors.Is(err, pgx.ErrNoRows) {
		return WatchTarget{}, ErrNotFound
	}
	if err != nil {
		return WatchTarget{}, err
	}
	return WatchTarget{ID: r.ID.Bytes, Kind: Kind(r.Kind), Owner: r.OwnerID.Bytes, Name: r.Name, Stopped: r.Stopped}, nil
}

// FleetLinkOwner is the human account whose fleet's link has code;
// ErrNotFound if none has.
func (s *Store) FleetLinkOwner(ctx context.Context, code string) (AccountID, error) {
	id, err := s.q.FleetLinkOwner(ctx, pgtype.Text{String: code, Valid: true})
	if errors.Is(err, pgx.ErrNoRows) {
		return AccountID{}, ErrNotFound
	}
	if err != nil {
		return AccountID{}, err
	}
	return id.Bytes, nil
}

// NewWatchCode gives the sailor of account id a new code for its link to
// watch, and returns it: owner's own sailor, with id owner, or one of
// owner's machine sailors. The old code stops working. ErrNotFound if id
// is neither.
func (s *Store) NewWatchCode(ctx context.Context, owner, id AccountID) (string, error) {
	code, err := s.q.NewWatchCode(ctx, db.NewWatchCodeParams{ID: uuidOf(id), Owner: uuidOf(owner)})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return code, err
}

// NewFleetCode gives a human account a new code for its fleet's link, and
// returns it. The old code stops working. ErrNotFound for no such human.
func (s *Store) NewFleetCode(ctx context.Context, id AccountID) (string, error) {
	code, err := s.q.NewFleetCode(ctx, uuidOf(id))
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return code.String, nil
}
