// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"encoding/hex"
	"errors"

	"github.com/jackc/pgx/v5/pgtype"

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
	// Tools is the owner's flag: the account's sailor has the owner's
	// tools in the game. Only a human account carries it.
	Tools bool
	// NoticesOff are the kinds of notice its sailor has switched off, by
	// the catalog's ids.
	NoticesOff []string
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

// SetTools sets or clears the owner's flag of a human account, or returns
// ErrNotFound: no such account, or an AI's, which never carries it.
func (s *Store) SetTools(ctx context.Context, id AccountID, on bool) error {
	n, err := s.q.SetAccountTools(ctx, db.SetAccountToolsParams{Tools: on, ID: pgtype.UUID{Bytes: id, Valid: true}})
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// Accounts finds the accounts of ids, with their sailors' names, by ID;
// those not found are left out. An AI account has no sailor of its own:
// its name is empty.
func (s *Store) Accounts(ctx context.Context, ids []AccountID) (map[AccountID]Account, error) {
	us := make([]pgtype.UUID, len(ids))
	for i, id := range ids {
		us[i] = pgtype.UUID{Bytes: id, Valid: true}
	}
	rows, err := s.q.AccountsByID(ctx, us)
	if err != nil {
		return nil, err
	}
	out := make(map[AccountID]Account, len(rows))
	for _, r := range rows {
		out[r.ID.Bytes] = Account{ID: r.ID.Bytes, Kind: Kind(r.Kind), Saved: r.Saved, Name: r.Name, Tools: r.Tools}
	}
	return out, nil
}
