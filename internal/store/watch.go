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
// name, whether it lets anyone watch it always, and whether it, or its
// owner, is stopped.
type WatchTarget struct {
	ID      AccountID
	Kind    Kind
	Owner   AccountID
	Name    string
	Always  bool
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
	return WatchTarget{ID: r.ID.Bytes, Kind: Kind(r.Kind), Owner: r.OwnerID.Bytes, Name: r.Name, Always: r.Spectators, Stopped: r.Stopped}, nil
}

// SetSpectators sets whether a human account lets anyone watch it always;
// ErrNotFound if there is no such human account.
func (s *Store) SetSpectators(ctx context.Context, id AccountID, on bool) error {
	n, err := s.q.SetSpectators(ctx, db.SetSpectatorsParams{Spectators: on, ID: uuidOf(id)})
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// SpectatorsAllowed is the accounts that let anyone watch them always.
func (s *Store) SpectatorsAllowed(ctx context.Context) ([]AccountID, error) {
	rows, err := s.q.SpectatorsAllowed(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]AccountID, len(rows))
	for i, r := range rows {
		out[i] = r.Bytes
	}
	return out, nil
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
