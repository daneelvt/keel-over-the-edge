// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/daneelvt/keel-over-the-edge/internal/store/db"
)

// AgreementConns is the agreement's pool: it answers a few webhooks and
// page views a day.
const AgreementConns = 2

// column32 fits a version or a pull request's number to its integer
// column, refusing one out of range.
func column32(n int) (int32, error) {
	if n < 0 || n > math.MaxInt32 {
		return 0, fmt.Errorf("store: %d does not fit the column", n)
	}
	return int32(n), nil
}

// Agreements is the contributor agreement's two tables, reached by the
// keeper of the agreement, a process of its own, as the role agreement,
// which may reach nothing else.
type Agreements struct {
	pool *pgxpool.Pool
	q    *db.Queries
}

// OpenAgreements opens a small pool on the database at url and waits until
// it answers, as Open does.
func OpenAgreements(ctx context.Context, url string, opt Options) (*Agreements, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrConfig, err)
	}
	cfg.MaxConns = AgreementConns
	cfg.MinConns = 0
	cfg.ConnConfig.RuntimeParams["application_name"] = "keel agreement"
	if opt.QueryDuration != nil || opt.QueryErrors != nil {
		cfg.ConnConfig.Tracer = newTracer(opt.QueryDuration, opt.QueryErrors)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := waitUp(ctx, pool, cfg.ConnConfig, opt); err != nil {
		pool.Close()
		return nil, err
	}
	return &Agreements{pool: pool, q: db.New(pool)}, nil
}

// Close closes the pool.
func (a *Agreements) Close() { a.pool.Close() }

// Ready reports whether the tables can be read: the role exists, may log
// in, and has been granted them.
func (a *Agreements) Ready(ctx context.Context) error {
	_, err := a.q.AgreementReady(ctx)
	return err
}

// Signature is one signature of the contributor agreement.
type Signature struct {
	ID AccountID // a signature's own ID, a UUID as accounts' are
	// GitHubID is the GitHub account's number; Login its name at signing.
	GitHubID int64
	Login    string
	// Name is the full name the signer gave.
	Name string
	// Version is the agreement's version; TextSHA256 its text's SHA-256.
	Version    int
	TextSHA256 string
	SignedAt   time.Time
	// How is SignedOnPage or SignedByOwner.
	How string
	// Guardian and GuardianEmail are a minor's parent's or guardian's, for
	// a signature the owner entered.
	Guardian, GuardianEmail string
	// Note is the owner's, for a signature they entered.
	Note string
	// Voided is when it was voided, zero if it stands; VoidReason why.
	Voided     time.Time
	VoidReason string
}

// How a signature was made.
const (
	SignedOnPage  = "page"
	SignedByOwner = "owner"
)

// Signed reports which of these accounts have a standing signature of
// version.
func (a *Agreements) Signed(ctx context.Context, ids []int64, version int) (map[int64]bool, error) {
	v, err := column32(version)
	if err != nil {
		return nil, err
	}
	got, err := a.q.AgreementSigned(ctx, db.AgreementSignedParams{GithubIds: ids, Version: v})
	if err != nil {
		return nil, err
	}
	out := make(map[int64]bool, len(got))
	for _, id := range got {
		out[id] = true
	}
	return out, nil
}

// Sign records a signature. It reports false, and changes nothing, when
// the account already has a standing signature of that version.
func (a *Agreements) Sign(ctx context.Context, s Signature) (bool, error) {
	v, err := column32(s.Version)
	if err != nil {
		return false, err
	}
	_, err = a.q.AgreementSign(ctx, db.AgreementSignParams{
		GithubID: s.GitHubID, Login: s.Login, Name: s.Name, Version: v,
		TextSha256: s.TextSHA256, How: s.How, Guardian: s.Guardian, GuardianEmail: s.GuardianEmail, Note: s.Note,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// SignaturesOf is an account's standing signatures, newest version first.
func (a *Agreements) SignaturesOf(ctx context.Context, githubID int64) ([]Signature, error) {
	rows, err := a.q.AgreementSignaturesOf(ctx, githubID)
	if err != nil {
		return nil, err
	}
	return signatures(rows), nil
}

// Signatures is every signature, voided ones too, oldest first.
func (a *Agreements) Signatures(ctx context.Context) ([]Signature, error) {
	rows, err := a.q.AgreementSignatures(ctx)
	if err != nil {
		return nil, err
	}
	return signatures(rows), nil
}

func signatures(rows []db.AgreementSignature) []Signature {
	out := make([]Signature, len(rows))
	for i, r := range rows {
		out[i] = Signature{
			ID: r.ID.Bytes, GitHubID: r.GithubID, Login: r.Login, Name: r.Name, Version: int(r.Version),
			TextSHA256: r.TextSha256, SignedAt: r.SignedAt, How: r.How, Guardian: r.Guardian,
			GuardianEmail: r.GuardianEmail, Note: r.Note, VoidReason: r.VoidReason,
		}
		if r.VoidedAt.Valid {
			out[i].Voided = r.VoidedAt.Time
		}
	}
	return out
}

// Void voids a standing signature, with its reason, and answers whose it
// was; ErrNotFound if there is no such standing signature.
func (a *Agreements) Void(ctx context.Context, id AccountID, reason string) (int64, error) {
	gid, err := a.q.AgreementVoid(ctx, db.AgreementVoidParams{ID: uuidOf(id), Reason: reason})
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	return gid, err
}

// PullRef names a pull request: its repository, owner/name, and number.
type PullRef struct {
	Repo   string
	Number int
}

// WaitingFor is the open pull requests waiting for an account to sign.
func (a *Agreements) WaitingFor(ctx context.Context, githubID int64) ([]PullRef, error) {
	rows, err := a.q.AgreementWaitingFor(ctx, githubID)
	if err != nil {
		return nil, err
	}
	out := make([]PullRef, len(rows))
	for i, r := range rows {
		out[i] = PullRef{Repo: r.Repo, Number: int(r.Number)}
	}
	return out, nil
}

// Waiting is every pull request waiting for anyone.
func (a *Agreements) Waiting(ctx context.Context) ([]PullRef, error) {
	rows, err := a.q.AgreementWaitingAll(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]PullRef, len(rows))
	for i, r := range rows {
		out[i] = PullRef{Repo: r.Repo, Number: int(r.Number)}
	}
	return out, nil
}

// SetWaiting replaces whom a pull request waits for, at its head commit:
// nobody, when ids is empty.
func (a *Agreements) SetWaiting(ctx context.Context, pr PullRef, headSHA string, ids []int64) error {
	number, err := column32(pr.Number)
	if err != nil {
		return err
	}
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := a.q.WithTx(tx)
	if err := q.AgreementPullClear(ctx, db.AgreementPullClearParams{Repo: pr.Repo, Number: number}); err != nil {
		return err
	}
	for _, id := range ids {
		if err := q.AgreementPullWait(ctx, db.AgreementPullWaitParams{Repo: pr.Repo, Number: number, GithubID: id, HeadSha: headSHA}); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// agreementGrants are what the role agreement may do: read and add
// signatures and void them, and keep the waiting pull requests. Nothing
// else in the database.
const agreementGrants = `
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agreement') THEN
    GRANT SELECT, INSERT, UPDATE ON agreement_signature TO agreement;
    GRANT SELECT, INSERT, UPDATE, DELETE ON agreement_pull TO agreement;
  END IF;
END
$$`

// GrantRoles grants the roles made beside the database what they may reach,
// once each exists: the agreement's keeper its two tables. It is run after
// the migrations, on every run, as the role is made by the database's
// operator, not by a migration, and may appear after them. Granting again
// changes nothing.
func GrantRoles(ctx context.Context, url string) error {
	cc, err := pgx.ParseConfig(url)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrConfig, err)
	}
	cc.RuntimeParams["application_name"] = "keel migrate"
	conn, err := pgx.ConnectConfig(ctx, cc)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, agreementGrants)
	return err
}
