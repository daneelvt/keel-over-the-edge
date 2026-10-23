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

// Passkey is a passkey of an account: the credential record a WebAuthn
// relying party keeps (Level 3, section 4), and where it was made.
type Passkey struct {
	// ID is the row's, which the account page names a passkey by.
	ID           [16]byte
	CredentialID []byte
	// PublicKey is the credential's public key, COSE-encoded, and
	// Algorithm its COSE algorithm.
	PublicKey []byte
	Algorithm int32
	SignCount uint32
	// CloneWarning is set once a sign-in's count did not go up.
	CloneWarning bool
	// Flags is the authenticator data's flags byte as last seen;
	// BackupEligible never changes, BackupState may.
	Flags                       byte
	BackupEligible, BackupState bool
	AAGUID                      []byte
	Transports                  []string
	AttestationFormat           string
	Attachment                  string
	// MadeOn is the device and browser it was made on: "iPhone · Safari".
	MadeOn            string
	Created, LastUsed time.Time
}

func passkeyParams(account pgtype.UUID, p *Passkey) db.CreatePasskeyParams {
	transports := p.Transports
	if transports == nil {
		transports = []string{}
	}
	aaguid := p.AAGUID
	if aaguid == nil {
		aaguid = []byte{}
	}
	return db.CreatePasskeyParams{
		AccountID: account, CredentialID: p.CredentialID, PublicKey: p.PublicKey, Algorithm: p.Algorithm,
		SignCount: int64(p.SignCount), Flags: int16(p.Flags), BackupEligible: p.BackupEligible, BackupState: p.BackupState,
		Aaguid: aaguid, Transports: transports, AttestationFormat: p.AttestationFormat, Attachment: p.Attachment, MadeOn: p.MadeOn,
	}
}

// Passkeys are an account's passkeys, the oldest first.
func (s *Store) Passkeys(ctx context.Context, id AccountID) ([]Passkey, error) {
	rows, err := s.q.PasskeysOf(ctx, uuidOf(id))
	if err != nil {
		return nil, err
	}
	out := make([]Passkey, len(rows))
	for i, r := range rows {
		out[i] = Passkey{
			ID: r.ID.Bytes, CredentialID: r.CredentialID, PublicKey: r.PublicKey, Algorithm: r.Algorithm,
			SignCount: uint32(r.SignCount), CloneWarning: r.CloneWarning, Flags: byte(r.Flags),
			BackupEligible: r.BackupEligible, BackupState: r.BackupState, AAGUID: r.Aaguid, Transports: r.Transports,
			AttestationFormat: r.AttestationFormat, Attachment: r.Attachment, MadeOn: r.MadeOn,
			Created: r.CreatedAt, LastUsed: r.LastUsedAt,
		}
	}
	return out, nil
}

// AddPasskey gives an account another passkey. When release is set, the
// session whose token hashes to it, held to adding a passkey, is let go,
// and recovery, if set, is the account's new recovery code's hash: what
// follows a recovery. ErrPasskeyTaken if the passkey is already an
// account's.
func (s *Store) AddPasskey(ctx context.Context, id AccountID, p Passkey, release *[32]byte, recovery *[32]byte) error {
	err := s.inTx(ctx, func(q *db.Queries) error {
		if err := q.CreatePasskey(ctx, passkeyParams(uuidOf(id), &p)); err != nil {
			return err
		}
		if release != nil {
			if _, err := q.ReleaseSession(ctx, db.ReleaseSessionParams{TokenHash: release[:], AccountID: uuidOf(id)}); err != nil {
				return err
			}
		}
		if recovery != nil {
			if _, err := q.SetRecoveryCode(ctx, db.SetRecoveryCodeParams{RecoveryHash: recovery[:], ID: uuidOf(id)}); err != nil {
				return err
			}
		}
		return nil
	})
	if uniqueViolation(err, "passkey_credential_id") {
		return ErrPasskeyTaken
	}
	return err
}

// PasskeyUsed writes back what a sign-in learnt of one of an account's
// passkeys: its count, any clone warning, its flags and its backup state.
func (s *Store) PasskeyUsed(ctx context.Context, id AccountID, p Passkey) error {
	n, err := s.q.PasskeyUsed(ctx, db.PasskeyUsedParams{
		SignCount: int64(p.SignCount), CloneWarning: p.CloneWarning, Flags: int16(p.Flags), BackupState: p.BackupState,
		CredentialID: p.CredentialID, AccountID: uuidOf(id),
	})
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// RemovePasskey removes one of an account's passkeys while another
// remains: ErrLastPasskey for its last, ErrNotFound for one it does not
// have. The account's row is locked, so two removals at once cannot take
// the last two.
func (s *Store) RemovePasskey(ctx context.Context, id AccountID, passkey [16]byte) error {
	return s.inTx(ctx, func(q *db.Queries) error {
		if _, err := q.LockAccount(ctx, uuidOf(id)); errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		deleted, err := q.DeletePasskey(ctx, db.DeletePasskeyParams{ID: pgtype.UUID{Bytes: passkey, Valid: true}, AccountID: uuidOf(id)})
		if err != nil {
			return err
		}
		if deleted == 0 {
			return ErrNotFound
		}
		left, err := q.CountPasskeys(ctx, uuidOf(id))
		if err != nil {
			return err
		}
		if left == 0 {
			return ErrLastPasskey // rolled back
		}
		return nil
	})
}

// The kinds of ceremony.
const (
	CeremonyCreate  = "create"
	CeremonySignIn  = "signin"
	CeremonyAdd     = "add"
	CeremonyConfirm = "confirm"
)

// Ceremony is a ceremony with the browser's passkey prompt, begun and not
// yet finished.
type Ceremony struct {
	// Hash is the SHA-256 of the handle its cookie carries.
	Hash [32]byte
	Kind string
	// Account is the account adding or confirming a passkey.
	Account    AccountID
	HasAccount bool
	// The sailor an account is being made for, and its user handle.
	Name, NameKey, Look string
	UserHandle          []byte
	// Session is go-webauthn's SessionData as JSON, and Build the build
	// that wrote it.
	Session []byte
	Build   string
	Expires time.Time
}

func text(s string) pgtype.Text { return pgtype.Text{String: s, Valid: s != ""} }

// SaveCeremony keeps a ceremony begun.
func (s *Store) SaveCeremony(ctx context.Context, c Ceremony) error {
	p := db.InsertCeremonyParams{
		HandleHash: c.Hash[:], Kind: c.Kind, Name: text(c.Name), NameKey: text(c.NameKey), Look: text(c.Look),
		UserHandle: c.UserHandle, Session: c.Session, Build: c.Build, ExpiresAt: c.Expires,
	}
	if c.HasAccount {
		p.AccountID = uuidOf(c.Account)
	}
	return s.q.InsertCeremony(ctx, p)
}

// TakeCeremony takes a ceremony of a kind to finish it, so it is used
// once, or ErrNotFound. An expired one is taken all the same: the caller
// tells it apart by Expires.
func (s *Store) TakeCeremony(ctx context.Context, hash [32]byte, kind string) (Ceremony, error) {
	r, err := s.q.TakeCeremony(ctx, db.TakeCeremonyParams{HandleHash: hash[:], Kind: kind})
	if errors.Is(err, pgx.ErrNoRows) {
		return Ceremony{}, ErrNotFound
	}
	if err != nil {
		return Ceremony{}, err
	}
	return Ceremony{
		Hash: hash, Kind: kind, Account: r.AccountID.Bytes, HasAccount: r.AccountID.Valid,
		Name: r.Name.String, NameKey: r.NameKey.String, Look: r.Look.String, UserHandle: r.UserHandle,
		Session: r.Session, Build: r.Build, Expires: r.ExpiresAt,
	}, nil
}

// CeremonyBatch is how many ceremonies one statement deletes.
const CeremonyBatch = 1000

// DeleteCeremonies deletes the ceremonies that expired before the time
// given, CeremonyBatch at a time; it returns how many it deleted.
func (s *Store) DeleteCeremonies(ctx context.Context, before time.Time) (int64, error) {
	var total int64
	for {
		n, err := s.q.DeleteExpiredCeremonies(ctx, db.DeleteExpiredCeremoniesParams{Before: before, Lim: CeremonyBatch})
		total += n
		if err != nil || n < CeremonyBatch {
			return total, err
		}
	}
}
