// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Session is the account a session names, and when the session was last
// seen.
type Session struct {
	Account
	LastSeen time.Time
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
		Account:  Account{ID: row.ID.Bytes, Kind: Kind(row.Kind), Saved: row.Saved, Name: row.Name, Look: row.Look},
		LastSeen: row.LastSeenAt,
	}, nil
}

// Touch records that the session whose token hashes to hash, and its
// account, were seen now.
func (s *Store) Touch(ctx context.Context, hash [32]byte) error {
	return s.q.TouchSession(ctx, hash[:])
}
