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

// Session is the account a session names, and when the session was last
// seen.
type Session struct {
	Account
	LastSeen time.Time
	// Held is a session made by the recovery code, which may only add a
	// passkey until it has.
	Held bool
	// ConfirmedUntil is when the passkey last confirmed on it stops
	// allowing what cannot be undone.
	ConfirmedUntil time.Time
}

// Session finds the session whose token hashes to hash, or ErrNotFound.
func (s *Store) Session(ctx context.Context, hash [32]byte) (Session, error) {
	row, err := s.q.SessionAccount(ctx, hash[:])
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrNotFound
	}
	if err != nil {
		return Session{}, err
	}
	return Session{
		Account:  Account{ID: row.ID.Bytes, Kind: Kind(row.Kind), Name: row.Name, Look: row.Look, Tools: row.Tools, NoticesOff: row.NoticesOff},
		LastSeen: row.LastSeenAt, Held: row.Held, ConfirmedUntil: row.ConfirmedUntil,
	}, nil
}

// Touch records that the session whose token hashes to hash, and its
// account, were seen now.
func (s *Store) Touch(ctx context.Context, hash [32]byte) error {
	return s.q.TouchSession(ctx, hash[:])
}

// EndSession ends the session whose token hashes to hash.
func (s *Store) EndSession(ctx context.Context, hash [32]byte) error {
	_, err := s.q.DeleteSession(ctx, hash[:])
	return err
}

// EndOtherSessions ends every session of an account but the one whose
// token hashes to keep, and returns how many it ended.
func (s *Store) EndOtherSessions(ctx context.Context, id AccountID, keep [32]byte) (int64, error) {
	return s.q.DeleteOtherSessions(ctx, db.DeleteOtherSessionsParams{AccountID: uuidOf(id), Keep: keep[:]})
}

// ConfirmSession marks an account's session confirmed until the time
// given, or returns ErrNotFound.
func (s *Store) ConfirmSession(ctx context.Context, id AccountID, hash [32]byte, until time.Time) error {
	n, err := s.q.ConfirmSession(ctx, db.ConfirmSessionParams{Until: pgtype.Timestamptz{Time: until, Valid: true}, TokenHash: hash[:], AccountID: uuidOf(id)})
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
