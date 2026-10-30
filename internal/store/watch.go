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
// kind and its owner, zero for a human's own.
type Sailor struct {
	Name  string
	Kind  Kind
	Owner AccountID
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
		out[r.ID.Bytes] = Sailor{Name: r.Name, Kind: Kind(r.Kind), Owner: r.OwnerID.Bytes}
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
