// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"encoding/hex"
	"errors"

	"github.com/daneelvt/keel-over-the-edge/internal/store/db"
)

// AccountID is an account's key: a UUID, version 7.
type AccountID [16]byte

// String writes the ID in the UUID's usual form.
func (id AccountID) String() string {
	var b [36]byte
	hex.Encode(b[0:8], id[0:4])
	b[8] = '-'
	hex.Encode(b[9:13], id[4:6])
	b[13] = '-'
	hex.Encode(b[14:18], id[6:8])
	b[18] = '-'
	hex.Encode(b[19:23], id[8:10])
	b[23] = '-'
	hex.Encode(b[24:], id[10:])
	return string(b[:])
}

// Kind is who plays an account: a human or an AI agent. It never changes.
type Kind string

const (
	Human Kind = "human"
	AI    Kind = "ai"
)

// Account is an account and its sailor.
type Account struct {
	ID   AccountID
	Kind Kind
	// Saved is false for a guest, kept only by its browser's cookie.
	Saved bool
	// Name is the sailor's name as shown, and Look the catalog sailor they
	// look like.
	Name string
	Look string
}

// Guest is what makes a guest: a sailor, and the first session's token
// hash.
type Guest struct {
	// Name is the sailor's name in its display form, and NameKey the key
	// names are compared by: two sailors cannot share a key.
	Name, NameKey string
	Look          string
	TokenHash     [32]byte
}

var (
	// ErrNameTaken is a name whose key another sailor has.
	ErrNameTaken = errors.New("store: the name is taken")
	// ErrNotFound is a row that is not there.
	ErrNotFound = errors.New("store: not found")
)

// CreateGuest makes a guest account, its sailor and its session, all or
// nothing.
func (s *Store) CreateGuest(ctx context.Context, g Guest) (AccountID, error) {
	var id AccountID
	err := s.inTx(ctx, func(q *db.Queries) error {
		u, err := q.CreateGuestAccount(ctx)
		if err != nil {
			return err
		}
		id = u.Bytes
		if err := q.CreateSailor(ctx, db.CreateSailorParams{AccountID: u, Name: g.Name, NameKey: g.NameKey, Look: g.Look}); err != nil {
			return err
		}
		return q.CreateSession(ctx, db.CreateSessionParams{AccountID: u, TokenHash: g.TokenHash[:]})
	})
	if uniqueViolation(err, "sailor_name_key") {
		return AccountID{}, ErrNameTaken
	}
	if err != nil {
		return AccountID{}, err
	}
	return id, nil
}
