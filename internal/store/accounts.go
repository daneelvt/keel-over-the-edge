// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
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

// NewAccount is what makes a human's account, all at once: its sailor, its
// first passkey, its recovery code's hash and its first session's token
// hash.
type NewAccount struct {
	// Name is the sailor's name in its display form, and NameKey the key
	// names are compared by: two sailors cannot share a key.
	Name, NameKey string
	Look          string
	// UserHandle is the WebAuthn user handle its passkeys carry.
	UserHandle   []byte
	Passkey      Passkey
	RecoveryHash [32]byte
	TokenHash    [32]byte
	// Boat is the kind of its fleet's first boat, the catalog's; none
	// when empty.
	Boat string
}

var (
	// ErrNameTaken is a name whose key another sailor has.
	ErrNameTaken = errors.New("store: the name is taken")
	// ErrNotFound is a row that is not there.
	ErrNotFound = errors.New("store: not found")
	// ErrPasskeyTaken is a passkey whose credential ID is already an
	// account's.
	ErrPasskeyTaken = errors.New("store: the passkey is already an account's")
	// ErrLastPasskey is the one passkey an account has left, which stays.
	ErrLastPasskey = errors.New("store: an account's last passkey stays")
)

func uuidOf(id AccountID) pgtype.UUID { return pgtype.UUID{Bytes: id, Valid: true} }

// ParseID reads an account's or a grant's ID, a UUID, with its dashes or
// without.
func ParseID(s string) (AccountID, bool) {
	var id AccountID
	raw := strings.ReplaceAll(s, "-", "")
	if len(raw) != 32 {
		return id, false
	}
	_, err := hex.Decode(id[:], []byte(raw))
	return id, err == nil
}

// sessionTokenKey is the constraint that keeps two sessions from sharing a
// token's hash.
const sessionTokenKey = "session_token_hash_key"

// CreateAccount makes a human's account with its sailor, passkey, recovery
// code, session and first boat, all or nothing: there is never an account
// without a passkey. ErrTokenTaken if the session's token hash is taken.
func (s *Store) CreateAccount(ctx context.Context, a NewAccount) (AccountID, error) {
	var id AccountID
	err := s.inTx(ctx, func(q *db.Queries) error {
		u, err := q.CreateAccount(ctx, db.CreateAccountParams{UserHandle: a.UserHandle, RecoveryHash: a.RecoveryHash[:]})
		if err != nil {
			return err
		}
		id = u.Bytes
		if err := q.CreateSailor(ctx, db.CreateSailorParams{AccountID: u, Name: a.Name, NameKey: a.NameKey, Look: a.Look}); err != nil {
			return err
		}
		if err := q.CreatePasskey(ctx, passkeyParams(u, &a.Passkey)); err != nil {
			return err
		}
		if a.Boat != "" {
			if err := fillFleet(ctx, q, id, a.Boat, 1); err != nil {
				return err
			}
		}
		return q.CreateSession(ctx, db.CreateSessionParams{AccountID: u, TokenHash: a.TokenHash[:]})
	})
	switch {
	case uniqueViolation(err, "sailor_name_key"):
		return AccountID{}, ErrNameTaken
	case uniqueViolation(err, "passkey_credential_id"):
		return AccountID{}, ErrPasskeyTaken
	case uniqueViolation(err, sessionTokenKey):
		return AccountID{}, ErrTokenTaken
	case err != nil:
		return AccountID{}, err
	}
	return id, nil
}

// NameFree reports whether no sailor has the name key.
func (s *Store) NameFree(ctx context.Context, key string) (bool, error) {
	taken, err := s.q.NameTaken(ctx, key)
	return !taken, err
}

// Holder is a human account with the user handle its passkeys carry and
// the passkeys themselves.
type Holder struct {
	Account
	UserHandle []byte
	Passkeys   []Passkey
}

// AccountByUserHandle finds the account a passkey's user handle names,
// with its passkeys, or ErrNotFound.
func (s *Store) AccountByUserHandle(ctx context.Context, handle []byte) (Holder, error) {
	row, err := s.q.AccountByUserHandle(ctx, handle)
	if errors.Is(err, pgx.ErrNoRows) {
		return Holder{}, ErrNotFound
	}
	if err != nil {
		return Holder{}, err
	}
	keys, err := s.Passkeys(ctx, row.ID.Bytes)
	if err != nil {
		return Holder{}, err
	}
	return Holder{
		Account:    Account{ID: row.ID.Bytes, Kind: Kind(row.Kind), Name: row.Name, Look: row.Look, Tools: row.Tools, NoticesOff: row.NoticesOff},
		UserHandle: row.UserHandle, Passkeys: keys,
	}, nil
}

// Profile is what the account page shows of an account.
type Profile struct {
	Holder
	Created time.Time
	// RecoveryMade is when its recovery code was made; zero if it has none.
	RecoveryMade time.Time
}

// Profile is a human account's page, or ErrNotFound.
func (s *Store) Profile(ctx context.Context, id AccountID) (Profile, error) {
	row, err := s.q.AccountByID(ctx, uuidOf(id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Profile{}, ErrNotFound
	}
	if err != nil {
		return Profile{}, err
	}
	keys, err := s.Passkeys(ctx, id)
	if err != nil {
		return Profile{}, err
	}
	p := Profile{
		Holder: Holder{
			Account:    Account{ID: row.ID.Bytes, Kind: Kind(row.Kind), Name: row.Name, Look: row.Look, Tools: row.Tools, NoticesOff: row.NoticesOff},
			UserHandle: row.UserHandle, Passkeys: keys,
		},
		Created: row.CreatedAt,
	}
	if row.HasRecovery && row.RecoveryMadeAt.Valid {
		p.RecoveryMade = row.RecoveryMadeAt.Time
	}
	return p, nil
}

// SetRecoveryCode gives an account a new recovery code, by its hash, in
// place of any it had.
func (s *Store) SetRecoveryCode(ctx context.Context, id AccountID, hash [32]byte) error {
	n, err := s.q.SetRecoveryCode(ctx, db.SetRecoveryCodeParams{RecoveryHash: hash[:], ID: uuidOf(id)})
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// Recover spends the recovery code whose hash is code: every session of
// its account ends, and a new one, whose token hashes to token, is made
// held to adding a passkey. It returns the account, or ErrNotFound when no
// account has the code.
func (s *Store) Recover(ctx context.Context, code, token [32]byte) (Account, error) {
	var id AccountID
	err := s.inTx(ctx, func(q *db.Queries) error {
		u, err := q.SpendRecoveryCode(ctx, code[:])
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		id = u.Bytes
		if _, err := q.DeleteAccountSessions(ctx, u); err != nil {
			return err
		}
		return q.CreateSession(ctx, db.CreateSessionParams{AccountID: u, TokenHash: token[:], Held: true})
	})
	if uniqueViolation(err, sessionTokenKey) {
		return Account{}, ErrTokenTaken
	}
	if err != nil {
		return Account{}, err
	}
	p, err := s.Profile(ctx, id)
	return p.Account, err
}

// SignIn makes a session for an account signed in, whose token hashes to
// token, and takes the notice of a recovery code used since the last
// sign-in: when it was used, or zero.
func (s *Store) SignIn(ctx context.Context, id AccountID, token [32]byte) (recovered time.Time, err error) {
	err = s.inTx(ctx, func(q *db.Queries) error {
		if err := q.CreateSession(ctx, db.CreateSessionParams{AccountID: uuidOf(id), TokenHash: token[:]}); err != nil {
			return err
		}
		at, err := q.TakeRecoveryNotice(ctx, uuidOf(id))
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if at.Valid {
			recovered = at.Time
		}
		return nil
	})
	if uniqueViolation(err, sessionTokenKey) {
		return time.Time{}, ErrTokenTaken
	}
	return recovered, err
}

// DeleteAccount deletes a human account with its sailor, passkeys,
// sessions, ceremonies and fleet, and its machine sailors first, with
// their grants and tokens, freeing every name; it returns the machine
// sailors deleted. What its sailors charted keeps its place under no name.
// ErrNotFound if there is no such account.
func (s *Store) DeleteAccount(ctx context.Context, id AccountID) ([]AccountID, error) {
	var machines []AccountID
	err := s.inTx(ctx, func(q *db.Queries) error {
		ids, err := q.MachineIDsOf(ctx, uuidOf(id))
		if err != nil {
			return err
		}
		for _, m := range ids {
			if err := q.ForgetCredits(ctx, m); err != nil {
				return err
			}
			machines = append(machines, m.Bytes)
		}
		if _, err := q.DeleteMachinesOf(ctx, uuidOf(id)); err != nil {
			return err
		}
		if err := q.ForgetCredits(ctx, uuidOf(id)); err != nil {
			return err
		}
		n, err := q.DeleteAccount(ctx, uuidOf(id))
		if err != nil {
			return err
		}
		if n == 0 {
			return ErrNotFound
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return machines, nil
}

// AccountCounts is how many human accounts there are, how many were made
// in the last week and how many were seen in the last day.
type AccountCounts struct {
	Total, Week, Today int64
}

// AccountCounts counts the human accounts.
func (s *Store) AccountCounts(ctx context.Context) (AccountCounts, error) {
	r, err := s.q.AccountCounts(ctx)
	return AccountCounts{Total: r.Total, Week: r.Week, Today: r.Today}, err
}

// SetTools sets or clears the owner's flag of a human account, or returns
// ErrNotFound: no such account, or an AI's, which never carries it.
func (s *Store) SetTools(ctx context.Context, id AccountID, on bool) error {
	n, err := s.q.SetAccountTools(ctx, db.SetAccountToolsParams{Tools: on, ID: uuidOf(id)})
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
		out[r.ID.Bytes] = Account{ID: r.ID.Bytes, Kind: Kind(r.Kind), Name: r.Name, Tools: r.Tools}
	}
	return out, nil
}
