// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"crypto/rand"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/daneelvt/keel-over-the-edge/internal/store/db"
)

// The kinds of grant: an AI app approved, or a connection token.
const (
	GrantApp        = "app"
	GrantConnection = "connection"
)

// The kinds of token a grant holds.
const (
	TokenAccess     = "access"
	TokenRefresh    = "refresh"
	TokenConnection = "connection"
)

// Why a grant was revoked: by its owner on the account page, replaced by
// a new approval or connection token, a token of it used again, or by the
// app itself (RFC 7009).
const (
	RevokedOwner    = "owner"
	RevokedReplaced = "replaced"
	RevokedReuse    = "reuse"
	RevokedApp      = "app"
)

var (
	// ErrTokenTaken is a token whose hash another token, session or
	// client already has: the caller draws again.
	ErrTokenTaken = errors.New("store: the token is taken")
	// ErrTooManyGrants is an approval refused: the machine sailor has as
	// many approved apps as it may.
	ErrTooManyGrants = errors.New("store: the machine sailor has as many approved apps as it may")
	// ErrNoMachine is a machine sailor that is not the account's.
	ErrNoMachine = errors.New("store: no such machine sailor of the account")
	// ErrUnconfirmed is an approval whose request no passkey confirmed
	// for the account, or not lately enough.
	ErrUnconfirmed = errors.New("store: the request is not confirmed for the account")
	// ErrCodeUsed is an authorization code presented a second time; its
	// grant is revoked.
	ErrCodeUsed = errors.New("store: the code was used already")
	// ErrWrongClient is a refresh token presented by another client than
	// its own.
	ErrWrongClient = errors.New("store: the token is another client's")
	// ErrRefreshReused is a refresh token used again after the grace; its
	// grant is revoked.
	ErrRefreshReused = errors.New("store: the refresh token was used already")
)

// GrantEnded is a token whose grant has ended: revoked (Why says by what),
// or its lifetime up (Why is empty), at At.
type GrantEnded struct {
	At  time.Time
	Why string
}

func (e *GrantEnded) Error() string { return "store: the grant has ended" }

// Client is an AI app that registered itself: the client ID it was issued,
// its name, where its sign-ins return, and its metadata as it was kept.
type Client struct {
	ID           string
	Name         string
	RedirectURIs []string
	Metadata     []byte
}

// RegisterClient keeps a client registered: ErrTokenTaken if another has
// its ID.
func (s *Store) RegisterClient(ctx context.Context, c Client) error {
	err := s.q.InsertClient(ctx, db.InsertClientParams{ClientID: c.ID, Name: c.Name, RedirectUris: c.RedirectURIs, Metadata: c.Metadata})
	if uniqueViolation(err, "oauth_client_pkey") {
		return ErrTokenTaken
	}
	return err
}

// Client finds a client registered, or ErrNotFound.
func (s *Store) Client(ctx context.Context, id string) (Client, error) {
	r, err := s.q.ClientByID(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Client{}, ErrNotFound
	}
	if err != nil {
		return Client{}, err
	}
	return Client{ID: r.ClientID, Name: r.Name, RedirectURIs: r.RedirectUris}, nil
}

// ClientUsed records a client registered used now: it is kept while used.
func (s *Store) ClientUsed(ctx context.Context, id string) error { return s.q.ClientUsed(ctx, id) }

// AuthRequest is an authorization request waiting on the approval page.
type AuthRequest struct {
	// Hash is the SHA-256 of the handle its cookie carries.
	Hash          [32]byte
	ClientID      string
	ClientName    string
	Registered    bool
	RedirectURI   string
	State         string
	CodeChallenge string
	// Account and Passkey are the account whose passkey confirmed the
	// request, until ConfirmedUntil; Confirmed says whether one did.
	Account        AccountID
	Passkey        [16]byte
	Confirmed      bool
	ConfirmedUntil time.Time
	Expires        time.Time
}

// SaveRequest keeps an authorization request: ErrTokenTaken if another
// has its handle.
func (s *Store) SaveRequest(ctx context.Context, r AuthRequest) error {
	err := s.q.InsertRequest(ctx, db.InsertRequestParams{
		HandleHash: r.Hash[:], ClientID: r.ClientID, ClientName: r.ClientName, Registered: r.Registered,
		RedirectUri: r.RedirectURI, State: r.State, CodeChallenge: r.CodeChallenge, ExpiresAt: r.Expires,
	})
	if uniqueViolation(err, "oauth_request_pkey") {
		return ErrTokenTaken
	}
	return err
}

func requestOf(hash [32]byte, clientID, clientName string, registered bool, redirect, state, challenge string,
	account, passkey pgtype.UUID, until, expires time.Time) AuthRequest {
	return AuthRequest{
		Hash: hash, ClientID: clientID, ClientName: clientName, Registered: registered, RedirectURI: redirect,
		State: state, CodeChallenge: challenge, Account: account.Bytes, Passkey: passkey.Bytes, Confirmed: account.Valid,
		ConfirmedUntil: until, Expires: expires,
	}
}

// Request finds an authorization request by its handle's hash, or
// ErrNotFound. An expired one is found all the same: the caller tells it
// apart by Expires.
func (s *Store) Request(ctx context.Context, hash [32]byte) (AuthRequest, error) {
	r, err := s.q.RequestByHash(ctx, hash[:])
	if errors.Is(err, pgx.ErrNoRows) {
		return AuthRequest{}, ErrNotFound
	}
	if err != nil {
		return AuthRequest{}, err
	}
	return requestOf(hash, r.ClientID, r.ClientName, r.Registered, r.RedirectUri, r.State, r.CodeChallenge,
		r.AccountID, r.PasskeyID, r.ConfirmedUntil, r.ExpiresAt), nil
}

// ConfirmRequest marks a request confirmed by one of an account's
// passkeys until the time given, or returns ErrNotFound when it is gone or
// expired.
func (s *Store) ConfirmRequest(ctx context.Context, hash [32]byte, account AccountID, passkey [16]byte, until time.Time) error {
	n, err := s.q.ConfirmRequest(ctx, db.ConfirmRequestParams{
		AccountID: uuidOf(account), PasskeyID: pgtype.UUID{Bytes: passkey, Valid: true},
		ConfirmedUntil: pgtype.Timestamptz{Time: until, Valid: true}, HandleHash: hash[:],
	})
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// TakeRequest takes a request, denied, so it is used once, or
// ErrNotFound.
func (s *Store) TakeRequest(ctx context.Context, hash [32]byte) (AuthRequest, error) {
	r, err := s.q.TakeRequest(ctx, hash[:])
	if errors.Is(err, pgx.ErrNoRows) {
		return AuthRequest{}, ErrNotFound
	}
	if err != nil {
		return AuthRequest{}, err
	}
	return requestOf(hash, r.ClientID, r.ClientName, r.Registered, r.RedirectUri, r.State, r.CodeChallenge,
		r.AccountID, r.PasskeyID, r.ConfirmedUntil, r.ExpiresAt), nil
}

// AccountHeld reports whether an account has a session held to adding a
// passkey: its recovery code used, and no passkey added since.
func (s *Store) AccountHeld(ctx context.Context, id AccountID) (bool, error) {
	return s.q.AccountHeld(ctx, uuidOf(id))
}

// Approval is an authorization request approved: for one of the owner's
// machine sailors, or one made with it (Make, whose boat is of the kind
// Boat), the request's code given.
type Approval struct {
	// Request is the hash of the request's handle; Owner is the account
	// that must have confirmed it, and Now the time it must still be
	// confirmed at.
	Request [32]byte
	Owner   AccountID
	Now     time.Time
	Machine AccountID
	Make    *NewMachine
	Boat    string
	// Code is the hash of the code given, and CodeExpires when it expires.
	Code        [32]byte
	CodeExpires time.Time
	// Lifetime is how long a grant lasts, and MaxGrants how many of a
	// machine sailor's may be live at once.
	Lifetime  time.Duration
	MaxGrants int
}

// Approved is what an approval made: the grant, its machine sailor, the
// request approved, and the grants of the same app it replaced.
type Approved struct {
	Grant    [16]byte
	Machine  AccountID
	Request  AuthRequest
	Replaced [][16]byte
}

// Approve approves an authorization request in one transaction: the
// request taken, a machine sailor made if asked, the app's older grant for
// the machine sailor revoked, the grant made and the code given. Errors,
// on which nothing changes: ErrNotFound for a request gone; ErrNoMachine
// for a machine sailor not the owner's; ErrUnconfirmed; ErrCap and ErrNameTaken for a
// machine sailor to make; ErrTooManyGrants.
func (s *Store) Approve(ctx context.Context, a Approval) (Approved, error) {
	var out Approved
	err := s.inTx(ctx, func(q *db.Queries) error {
		r, err := q.TakeRequest(ctx, a.Request[:])
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		req := requestOf(a.Request, r.ClientID, r.ClientName, r.Registered, r.RedirectUri, r.State, r.CodeChallenge,
			r.AccountID, r.PasskeyID, r.ConfirmedUntil, r.ExpiresAt)
		if !req.Confirmed || req.Account != a.Owner || !a.Now.Before(req.ConfirmedUntil) || !a.Now.Before(req.Expires) {
			return ErrUnconfirmed
		}
		out.Request = req
		machine := a.Machine
		if a.Make != nil {
			if machine, err = createMachine(ctx, q, a.Owner, *a.Make, a.Boat); err != nil {
				return err
			}
		} else if _, err := q.MachineOf(ctx, db.MachineOfParams{ID: uuidOf(machine), OwnerID: uuidOf(a.Owner)}); errors.Is(err, pgx.ErrNoRows) {
			return ErrNoMachine
		} else if err != nil {
			return err
		}
		out.Machine = machine
		live, err := q.LiveGrantsOfMachine(ctx, db.LiveGrantsOfMachineParams{AccountID: uuidOf(machine), Kind: GrantApp})
		if err != nil {
			return err
		}
		others := 0
		for _, g := range live {
			switch {
			case g.ClientID == req.ClientID:
				if _, err := q.RevokeGrant(ctx, db.RevokeGrantParams{Why: text(RevokedReplaced), ID: g.ID}); err != nil {
					return err
				}
				out.Replaced = append(out.Replaced, g.ID.Bytes)
			case g.ApprovedAt.Add(a.Lifetime).After(a.Now):
				others++
			}
		}
		if others >= a.MaxGrants {
			return ErrTooManyGrants
		}
		g, err := q.InsertGrant(ctx, db.InsertGrantParams{
			AccountID: uuidOf(machine), Kind: GrantApp, ClientID: text(req.ClientID), ClientName: text(req.ClientName),
			RedirectUri: text(req.RedirectURI), ApprovedBy: uuidOf(a.Owner), PasskeyID: pgtype.UUID{Bytes: req.Passkey, Valid: true},
		})
		if err != nil {
			return err
		}
		out.Grant = g.ID.Bytes
		return q.InsertCode(ctx, db.InsertCodeParams{
			Hash: a.Code[:], GrantID: g.ID, ClientID: req.ClientID, RedirectUri: req.RedirectURI,
			CodeChallenge: req.CodeChallenge, ExpiresAt: a.CodeExpires,
		})
	})
	switch {
	case uniqueViolation(err, "sailor_name_key"):
		return Approved{}, ErrNameTaken
	case uniqueViolation(err, "oauth_code_pkey"):
		return Approved{}, ErrTokenTaken
	}
	return out, err
}

// CodeGrant is an authorization code exchanged: what it was given for, and
// its grant.
type CodeGrant struct {
	Grant         [16]byte
	Account       AccountID
	ClientID      string
	RedirectURI   string
	CodeChallenge string
	Expires       time.Time
	Approved      time.Time
	// Revoked is the grant revoked meanwhile.
	Revoked bool
}

// UseCode exchanges an authorization code, once: ErrNotFound for a code
// never given, or one gone; ErrCodeUsed for one used already, whose grant
// is then revoked, and returned.
func (s *Store) UseCode(ctx context.Context, hash [32]byte) (CodeGrant, error) {
	r, err := s.q.UseCode(ctx, hash[:])
	if err == nil {
		return CodeGrant{
			Grant: r.GrantID.Bytes, Account: r.AccountID.Bytes, ClientID: r.ClientID, RedirectURI: r.RedirectUri,
			CodeChallenge: r.CodeChallenge, Expires: r.ExpiresAt, Approved: r.ApprovedAt, Revoked: r.RevokedAt.After(time.Unix(0, 0)),
		}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return CodeGrant{}, err
	}
	grant, err := s.q.UsedCode(ctx, hash[:])
	if errors.Is(err, pgx.ErrNoRows) {
		return CodeGrant{}, ErrNotFound
	}
	if err != nil {
		return CodeGrant{}, err
	}
	account, err := s.q.RevokeGrant(ctx, db.RevokeGrantParams{Why: text(RevokedReuse), ID: grant})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return CodeGrant{}, err
	}
	return CodeGrant{Grant: grant.Bytes, Account: account.Bytes, Revoked: true}, ErrCodeUsed
}

// Pair is an access token and the refresh token issued with it, by their
// hashes.
type Pair struct {
	Access        [32]byte
	AccessExpires time.Time
	Refresh       [32]byte
}

func newPairID() pgtype.UUID {
	var id [16]byte
	_, _ = rand.Read(id[:]) // never fails (crypto/rand)
	return pgtype.UUID{Bytes: id, Valid: true}
}

func insertPair(ctx context.Context, q *db.Queries, grant pgtype.UUID, p Pair) (pgtype.UUID, error) {
	pair := newPairID()
	if err := q.InsertToken(ctx, db.InsertTokenParams{
		Hash: p.Access[:], GrantID: grant, Kind: TokenAccess, Pair: pair,
		ExpiresAt: pgtype.Timestamptz{Time: p.AccessExpires, Valid: true},
	}); err != nil {
		return pair, err
	}
	return pair, q.InsertToken(ctx, db.InsertTokenParams{Hash: p.Refresh[:], GrantID: grant, Kind: TokenRefresh, Pair: pair})
}

// IssuePair gives a grant its first tokens: ErrTokenTaken if either's
// hash is taken.
func (s *Store) IssuePair(ctx context.Context, grant [16]byte, p Pair) error {
	err := s.inTx(ctx, func(q *db.Queries) error {
		_, err := insertPair(ctx, q, pgtype.UUID{Bytes: grant, Valid: true}, p)
		return err
	})
	if uniqueViolation(err, "oauth_token_pkey") {
		return ErrTokenTaken
	}
	return err
}

// Refresh is a refresh token presented, by its hash, by a client, for the
// pair given.
type Refresh struct {
	Old      [32]byte
	ClientID string
	New      Pair
	// Now is the time; Lifetime how long a grant lasts; Grace how long
	// after a refresh token is used it may be used once more.
	Now      time.Time
	Lifetime time.Duration
	Grace    time.Duration
}

// Refreshed is a refresh done: its grant, the machine sailor, when the
// grant ends, and whether the token was used again within its grace.
type Refreshed struct {
	Grant     [16]byte
	Account   AccountID
	GrantEnds time.Time
	Grace     bool
}

// Refresh rotates a refresh token: it is marked used, and a new pair
// issued in its place. Presented again within the grace while the pair
// issued for it is unused, that pair ends and another is issued; presented
// again otherwise, its grant is revoked (ErrRefreshReused). Errors:
// ErrNotFound for a token unknown; ErrWrongClient; *GrantEnded;
// ErrTokenTaken.
func (s *Store) Refresh(ctx context.Context, r Refresh) (Refreshed, error) {
	var out Refreshed
	reused := false
	err := s.inTx(ctx, func(q *db.Queries) error {
		t, err := q.TokenForRefresh(ctx, r.Old[:])
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if t.ClientID != r.ClientID {
			return ErrWrongClient
		}
		out.Grant, out.Account, out.GrantEnds = t.GrantID.Bytes, t.AccountID.Bytes, t.ApprovedAt.Add(r.Lifetime)
		if t.RevokedAt.After(time.Unix(0, 0)) {
			return &GrantEnded{At: t.RevokedAt, Why: t.RevokedWhy}
		}
		if !r.Now.Before(out.GrantEnds) {
			return &GrantEnded{At: out.GrantEnds}
		}
		if t.UsedAt.After(time.Unix(0, 0)) {
			fresh := t.NextPair.Valid && r.Now.Sub(t.UsedAt) <= r.Grace
			if fresh {
				used, err := q.PairUsed(ctx, t.NextPair)
				if err != nil && !errors.Is(err, pgx.ErrNoRows) {
					return err
				}
				fresh = !used
			}
			if !fresh {
				if _, err := q.RevokeGrant(ctx, db.RevokeGrantParams{Why: text(RevokedReuse), ID: t.GrantID}); err != nil {
					return err
				}
				reused = true
				return nil
			}
			if _, err := q.DeletePair(ctx, t.NextPair); err != nil {
				return err
			}
			out.Grace = true
		}
		pair, err := insertPair(ctx, q, t.GrantID, r.New)
		if err != nil {
			return err
		}
		return q.RotateToken(ctx, db.RotateTokenParams{NextPair: pair, Hash: r.Old[:]})
	})
	if uniqueViolation(err, "oauth_token_pkey") {
		return Refreshed{}, ErrTokenTaken
	}
	if err == nil && reused {
		return out, ErrRefreshReused
	}
	return out, err
}

// TokenGrant is a token as the door checks it.
type TokenGrant struct {
	Kind  string
	Grant [16]byte
	// Expires is when an access token expires; zero for the others.
	Expires    time.Time
	GrantKind  string
	Approved   time.Time
	Revoked    time.Time
	RevokedWhy string
	ClientName string
	// Account is the machine sailor's, Name its name, and OwnerName its
	// owner's sailor's.
	Account   AccountID
	Name      string
	OwnerName string
}

// TokenGrant finds a token by its hash, with its grant and machine sailor,
// or ErrNotFound.
func (s *Store) TokenGrant(ctx context.Context, hash [32]byte) (TokenGrant, error) {
	r, err := s.q.TokenByHash(ctx, hash[:])
	if errors.Is(err, pgx.ErrNoRows) {
		return TokenGrant{}, ErrNotFound
	}
	if err != nil {
		return TokenGrant{}, err
	}
	t := TokenGrant{
		Kind: r.Kind, Grant: r.GrantID.Bytes, GrantKind: r.GrantKind, Approved: r.ApprovedAt, RevokedWhy: r.RevokedWhy,
		ClientName: r.ClientName, Account: r.AccountID.Bytes, Name: r.Name, OwnerName: r.OwnerName,
	}
	if r.ExpiresAt.After(time.Unix(0, 0)) {
		t.Expires = r.ExpiresAt
	}
	if r.RevokedAt.After(time.Unix(0, 0)) {
		t.Revoked = r.RevokedAt
	}
	return t, nil
}

// GrantUsed records a grant used at the time given.
func (s *Store) GrantUsed(ctx context.Context, grant [16]byte, at time.Time) error {
	return s.q.GrantUsed(ctx, db.GrantUsedParams{At: pgtype.Timestamptz{Time: at, Valid: true}, ID: pgtype.UUID{Bytes: grant, Valid: true}})
}

// Revoked is a token revoked: its grant, and its machine sailor; Grant is
// revoked whole unless only an access token ended.
type Revoked struct {
	Grant      [16]byte
	Account    AccountID
	WholeGrant bool
}

// RevokeToken revokes a token by its hash, as RFC 7009 asks: a refresh or
// connection token ends its grant, an access token itself. A token of
// another client than the one given (when given) is left alone, as is one
// unknown: ErrNotFound.
func (s *Store) RevokeToken(ctx context.Context, hash [32]byte, clientID string) (Revoked, error) {
	var out Revoked
	err := s.inTx(ctx, func(q *db.Queries) error {
		t, err := q.TokenKind(ctx, hash[:])
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if clientID != "" && t.ClientID != "" && t.ClientID != clientID {
			return ErrNotFound
		}
		out.Grant, out.Account = t.GrantID.Bytes, t.AccountID.Bytes
		if t.Kind == TokenAccess {
			_, err := q.DeleteToken(ctx, hash[:])
			return err
		}
		out.WholeGrant = true
		if _, err := q.RevokeGrant(ctx, db.RevokeGrantParams{Why: text(RevokedApp), ID: t.GrantID}); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		return nil
	})
	return out, err
}

// Grant is a grant as the account page lists it.
type Grant struct {
	ID          [16]byte
	Machine     AccountID
	Kind        string
	ClientID    string
	ClientName  string
	RedirectURI string
	Approved    time.Time
	// LastUsed and Revoked are zero for never.
	LastUsed   time.Time
	Revoked    time.Time
	RevokedWhy string
}

// Grants are the grants of a human account's machine sailors, unrevoked or
// revoked since the time given, the oldest first.
func (s *Store) Grants(ctx context.Context, owner AccountID, since time.Time) ([]Grant, error) {
	rows, err := s.q.GrantsOf(ctx, db.GrantsOfParams{OwnerID: uuidOf(owner), Since: pgtype.Timestamptz{Time: since, Valid: true}})
	if err != nil {
		return nil, err
	}
	epoch := time.Unix(0, 0)
	out := make([]Grant, len(rows))
	for i, r := range rows {
		g := Grant{
			ID: r.ID.Bytes, Machine: r.AccountID.Bytes, Kind: r.Kind, ClientID: r.ClientID, ClientName: r.ClientName,
			RedirectURI: r.RedirectUri, Approved: r.ApprovedAt, RevokedWhy: r.RevokedWhy,
		}
		if r.LastUsedAt.After(epoch) {
			g.LastUsed = r.LastUsedAt
		}
		if r.RevokedAt.After(epoch) {
			g.Revoked = r.RevokedAt
		}
		out[i] = g
	}
	return out, nil
}

// RevokeOwnedGrant revokes a grant of one of a human account's machine
// sailors, by its owner, and returns its machine sailor: ErrNotFound for
// a grant not the account's. One revoked already stays as it was.
func (s *Store) RevokeOwnedGrant(ctx context.Context, owner AccountID, grant [16]byte) (AccountID, error) {
	g, err := s.q.OwnedGrant(ctx, db.OwnedGrantParams{ID: pgtype.UUID{Bytes: grant, Valid: true}, OwnerID: uuidOf(owner)})
	if errors.Is(err, pgx.ErrNoRows) {
		return AccountID{}, ErrNotFound
	}
	if err != nil {
		return AccountID{}, err
	}
	if _, err := s.q.RevokeGrant(ctx, db.RevokeGrantParams{Why: text(RevokedOwner), ID: g.ID}); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return AccountID{}, err
	}
	return g.AccountID.Bytes, nil
}

// MakeConnection gives one of a human account's machine sailors a new
// connection token, by its hash, in place of any it had, whose grants are
// returned: ErrNoMachine for a machine sailor not the account's,
// ErrTokenTaken for a hash taken.
func (s *Store) MakeConnection(ctx context.Context, owner, machine AccountID, hash [32]byte) (grant [16]byte, replaced [][16]byte, err error) {
	err = s.inTx(ctx, func(q *db.Queries) error {
		var err error
		if replaced, err = revokeConnections(ctx, q, owner, machine, RevokedReplaced); err != nil {
			return err
		}
		g, err := q.InsertGrant(ctx, db.InsertGrantParams{AccountID: uuidOf(machine), Kind: GrantConnection, ApprovedBy: uuidOf(owner)})
		if err != nil {
			return err
		}
		grant = g.ID.Bytes
		return q.InsertToken(ctx, db.InsertTokenParams{Hash: hash[:], GrantID: g.ID, Kind: TokenConnection, Pair: newPairID()})
	})
	if uniqueViolation(err, "oauth_token_pkey") {
		return grant, nil, ErrTokenTaken
	}
	return grant, replaced, err
}

func revokeConnections(ctx context.Context, q *db.Queries, owner, machine AccountID, why string) ([][16]byte, error) {
	if _, err := q.MachineOf(ctx, db.MachineOfParams{ID: uuidOf(machine), OwnerID: uuidOf(owner)}); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNoMachine
	} else if err != nil {
		return nil, err
	}
	live, err := q.LiveGrantsOfMachine(ctx, db.LiveGrantsOfMachineParams{AccountID: uuidOf(machine), Kind: GrantConnection})
	if err != nil {
		return nil, err
	}
	var out [][16]byte
	for _, g := range live {
		if _, err := q.RevokeGrant(ctx, db.RevokeGrantParams{Why: text(why), ID: g.ID}); err != nil {
			return nil, err
		}
		out = append(out, g.ID.Bytes)
	}
	return out, nil
}

// RevokeConnection revokes a machine sailor's connection token, and
// returns its grants: ErrNoMachine for a machine sailor not the account's.
func (s *Store) RevokeConnection(ctx context.Context, owner, machine AccountID) ([][16]byte, error) {
	var out [][16]byte
	err := s.inTx(ctx, func(q *db.Queries) error {
		var err error
		out, err = revokeConnections(ctx, q, owner, machine, RevokedOwner)
		return err
	})
	return out, err
}

// GrantLifetime is how long a grant lasts from when it is made.
func (s *Store) GrantLifetime(ctx context.Context) (time.Duration, error) {
	us, err := s.q.GrantLifetime(ctx)
	return time.Duration(us) * time.Microsecond, err
}

// SetGrantLifetime sets how long a grant lasts, from a minute to 400 days.
func (s *Store) SetGrantLifetime(ctx context.Context, d time.Duration) error {
	_, err := s.q.SetGrantLifetime(ctx, d.Microseconds())
	return err
}

// GrantsEndedBy is how many unrevoked grants a lifetime would end at once.
func (s *Store) GrantsEndedBy(ctx context.Context, d time.Duration) (int64, error) {
	return s.q.GrantsEndedBy(ctx, d.Microseconds())
}

// OAuthCleanup is what DeleteOAuthLeftovers deleted.
type OAuthCleanup struct {
	Requests, Codes, AccessTokens, RefreshTokens, Grants, Clients int64
}

// The ages past which DeleteOAuthLeftovers deletes.
const (
	// RequestKeep is how long past its expiry a request or a code stays.
	RequestKeep = time.Hour
	// AccessKeep is how long past its expiry an access token stays.
	AccessKeep = 24 * time.Hour
	// EndedGrantKeep is how long an ended grant stays on the account page.
	EndedGrantKeep = 30 * 24 * time.Hour
	// ClientKeep is how long a client registered stays unused, with no
	// grant.
	ClientKeep = 30 * 24 * time.Hour
)

// OAuthBatch is how many rows one statement deletes.
const OAuthBatch = 1000

// DeleteOAuthLeftovers deletes what sign-in for AI apps no longer needs,
// as of now with grants lasting lifetime: requests and codes expired an
// hour ago, access tokens a day ago, used refresh tokens of ended grants,
// grants ended 30 days ago with their tokens, and clients registered with
// no grant left and unused for 30 days; OAuthBatch rows at a time.
func (s *Store) DeleteOAuthLeftovers(ctx context.Context, now time.Time, lifetime time.Duration) (OAuthCleanup, error) {
	var c OAuthCleanup
	us := lifetime.Microseconds()
	steps := []struct {
		n   *int64
		run func() (int64, error)
	}{
		{&c.Requests, func() (int64, error) {
			return s.q.DeleteExpiredRequests(ctx, db.DeleteExpiredRequestsParams{Before: now.Add(-RequestKeep), Lim: OAuthBatch})
		}},
		{&c.Codes, func() (int64, error) {
			return s.q.DeleteExpiredCodes(ctx, db.DeleteExpiredCodesParams{Before: now.Add(-RequestKeep), Lim: OAuthBatch})
		}},
		{&c.AccessTokens, func() (int64, error) {
			return s.q.DeleteExpiredAccessTokens(ctx, db.DeleteExpiredAccessTokensParams{Before: pgtype.Timestamptz{Time: now.Add(-AccessKeep), Valid: true}, Lim: OAuthBatch})
		}},
		{&c.RefreshTokens, func() (int64, error) {
			return s.q.DeleteEndedRefreshTokens(ctx, db.DeleteEndedRefreshTokensParams{Micros: us, Lim: OAuthBatch})
		}},
		{&c.Grants, func() (int64, error) {
			return s.q.DeleteEndedGrants(ctx, db.DeleteEndedGrantsParams{Micros: us, Before: pgtype.Timestamptz{Time: now.Add(-EndedGrantKeep), Valid: true}, Lim: OAuthBatch})
		}},
		{&c.Clients, func() (int64, error) {
			return s.q.DeleteUnusedClients(ctx, db.DeleteUnusedClientsParams{Before: now.Add(-ClientKeep), Lim: OAuthBatch})
		}},
	}
	for _, st := range steps {
		for {
			n, err := st.run()
			*st.n += n
			if err != nil {
				return c, err
			}
			if n < OAuthBatch {
				break
			}
		}
	}
	return c, nil
}
