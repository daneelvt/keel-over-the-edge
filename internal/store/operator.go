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

// The operator's hand on accounts: an account stopped and started again,
// its machine sailors' grants revoked, and deleted; each in one
// transaction with the account's row locked, so that two actions on one
// account run one after the other, and each written in the record of
// actions with its reason.

// The operator's actions, as the record names them.
const (
	ActionStop       = "stop"
	ActionStart      = "start"
	ActionRevoke     = "revoke"
	ActionDelete     = "delete"
	ActionFlag       = "flag"
	ActionUnflag     = "unflag"
	ActionPriority   = "priority"
	ActionUnpriority = "unpriority"
	ActionCap        = "cap"
	ActionLifetime   = "lifetime"
)

// Where an action came from: the world page, or the command.
const (
	SourcePage    = "page"
	SourceCommand = "command"
)

// ActionKeep is how long the record keeps an action.
const ActionKeep = 2 * 365 * 24 * time.Hour

// MaxReason is the longest a stop's reason may be, in characters.
const MaxReason = 500

var (
	// ErrNotStopped is a start of an account that is not stopped.
	ErrNotStopped = errors.New("store: the account is not stopped")
)

// Action is an entry of the record of what the operator did: to an
// account (Account, its Kind and its sailor's Name as they were), or to
// none (the grant lifetime). Detail is the reason given or the value set;
// Source says where it came from, and From the address.
type Action struct {
	At         time.Time
	Action     string
	Account    AccountID
	HasAccount bool
	Kind       Kind
	Name       string
	Detail     string
	Source     string
	From       string
}

func insertAction(ctx context.Context, q *db.Queries, a Action) error {
	p := db.InsertActionParams{Action: a.Action, Name: a.Name, Detail: a.Detail, Source: a.Source, FromAddr: a.From}
	if a.HasAccount {
		p.AccountID = uuidOf(a.Account)
		p.Kind = text(string(a.Kind))
	}
	if len(p.Name) > 80 {
		p.Name = p.Name[:80]
	}
	if len(p.FromAddr) > 100 {
		p.FromAddr = p.FromAddr[:100]
	}
	return q.InsertAction(ctx, p)
}

// RecordAction writes an action in the record.
func (s *Store) RecordAction(ctx context.Context, a Action) error { return insertAction(ctx, s.q, a) }

// Actions are the record's latest actions, the newest first: of one
// account, or of every one when account is nil.
func (s *Store) Actions(ctx context.Context, account *AccountID, limit int) ([]Action, error) {
	var rows []db.ActionsOfRow
	if account != nil {
		var err error
		if rows, err = s.q.ActionsOf(ctx, db.ActionsOfParams{AccountID: uuidOf(*account), Lim: int32(limit)}); err != nil {
			return nil, err
		}
	} else {
		latest, err := s.q.LatestActions(ctx, int32(limit))
		if err != nil {
			return nil, err
		}
		for _, r := range latest {
			rows = append(rows, db.ActionsOfRow(r))
		}
	}
	out := make([]Action, len(rows))
	for i, r := range rows {
		out[i] = Action{
			At: r.At, Action: r.Action, Account: r.AccountID.Bytes, HasAccount: r.AccountID.Valid, Kind: Kind(r.Kind),
			Name: r.Name, Detail: r.Detail, Source: r.Source, From: r.FromAddr,
		}
	}
	return out, nil
}

// ActionBatch is how many actions one statement deletes.
const ActionBatch = 1000

// DeleteActions deletes the actions recorded before the time given,
// ActionBatch at a time, and returns how many it deleted.
func (s *Store) DeleteActions(ctx context.Context, before time.Time) (int64, error) {
	var total int64
	for {
		n, err := s.q.DeleteOldActions(ctx, db.DeleteOldActionsParams{Before: before, Lim: ActionBatch})
		total += n
		if err != nil || n < ActionBatch {
			return total, err
		}
	}
}

// Stopped are the accounts stopped, by their kinds: those stopped
// themselves, and the machine sailors of a human stopped.
func (s *Store) Stopped(ctx context.Context) (map[AccountID]Kind, error) {
	rows, err := s.q.StoppedAccounts(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[AccountID]Kind, len(rows))
	for _, r := range rows {
		out[r.ID.Bytes] = Kind(r.Kind)
	}
	return out, nil
}

// Target is an account the operator acts on, as it stood as the action
// began.
type Target struct {
	ID   AccountID
	Kind Kind
	Name string
	// Owner is an AI account's human.
	Owner AccountID
	// Tools: the account carries the owner's flag; OwnerTools, its human
	// does.
	Tools, OwnerTools bool
	// Stopped: stopped itself; OwnerStopped: its human is.
	Stopped, OwnerStopped bool
	// Machines are a human's machine sailors.
	Machines []AccountID
}

// Operation is an action of the operator's on an account: the action as
// it is to be recorded (its Account the account acted on), and, for those
// that revoke grants, the lifetime grants live within. With Check, it is
// only counted: nothing changes and nothing is recorded.
type Operation struct {
	Action
	Lifetime time.Duration
	Check    bool
}

// Operated is what an action did, or with Check would do: the account as
// it stood, the sessions ended, the grants revoked (or, checked, how many
// would be), and the accounts it stops no more.
type Operated struct {
	Target
	Sessions int64
	Grants   int64
	Revoked  [][16]byte
	Freed    []AccountID
}

// operate runs fn on the account of op, locked, in one transaction, and
// records the action unless op is a check; ErrNotFound if there is none.
func (s *Store) operate(ctx context.Context, op Operation, fn func(q *db.Queries, out *Operated) error) (Operated, error) {
	var out Operated
	err := s.inTx(ctx, func(q *db.Queries) error {
		out = Operated{}
		r, err := q.AccountForAction(ctx, uuidOf(op.Account))
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		t := &out.Target
		t.ID, t.Kind, t.Name, t.Owner = r.ID.Bytes, Kind(r.Kind), r.Name, r.OwnerID.Bytes
		t.Tools, t.OwnerTools, t.Stopped, t.OwnerStopped = r.Tools, r.OwnerTools, r.Stopped, r.OwnerStopped
		if t.Kind == Human {
			ids, err := q.MachineIDsOf(ctx, r.ID)
			if err != nil {
				return err
			}
			for _, m := range ids {
				t.Machines = append(t.Machines, m.Bytes)
			}
		}
		if out.Sessions, err = q.CountSessions(ctx, r.ID); err != nil {
			return err
		}
		if err := fn(q, &out); err != nil {
			return err
		}
		if op.Check {
			return nil
		}
		a := op.Action
		a.HasAccount, a.Kind, a.Name = true, t.Kind, t.Name
		return insertAction(ctx, q, a)
	})
	return out, err
}

// grantHolders are the accounts whose grants an action on t revokes: a
// human's machine sailors, or the machine sailor itself.
func (t *Target) grantHolders() []pgtype.UUID {
	if t.Kind == AI {
		return []pgtype.UUID{uuidOf(t.ID)}
	}
	out := make([]pgtype.UUID, len(t.Machines))
	for i, m := range t.Machines {
		out[i] = uuidOf(m)
	}
	return out
}

// revokeGrants revokes, or with check counts, the live grants of the
// accounts an action on out's account reaches.
func revokeGrants(ctx context.Context, q *db.Queries, out *Operated, lifetime time.Duration, check bool) error {
	ids := out.grantHolders()
	if check {
		n, err := q.CountLiveGrantsOf(ctx, db.CountLiveGrantsOfParams{Ids: ids, Micros: lifetime.Microseconds()})
		out.Grants = n
		return err
	}
	revoked, err := q.RevokeGrantsOf(ctx, db.RevokeGrantsOfParams{Ids: ids, Micros: lifetime.Microseconds()})
	if err != nil {
		return err
	}
	for _, g := range revoked {
		out.Revoked = append(out.Revoked, g.Bytes)
	}
	out.Grants = int64(len(revoked))
	return nil
}

// Stop stops an account, its reason op's Detail: every session of it
// ends, and every live grant of the machine sailors it stops (its own,
// or a human's machine sailors') is revoked by the operator, for good.
// ErrNotFound; ErrStopped for an account stopped already.
func (s *Store) Stop(ctx context.Context, op Operation) (Operated, error) {
	return s.operate(ctx, op, func(q *db.Queries, out *Operated) error {
		if out.Stopped {
			return ErrStopped
		}
		if op.Check {
			return revokeGrants(ctx, q, out, op.Lifetime, true)
		}
		if _, err := q.StopAccount(ctx, db.StopAccountParams{Reason: text(op.Detail), ID: uuidOf(out.ID)}); err != nil {
			return err
		}
		if _, err := q.DeleteAccountSessions(ctx, uuidOf(out.ID)); err != nil {
			return err
		}
		return revokeGrants(ctx, q, out, op.Lifetime, false)
	})
}

// Start starts a stopped account again: what it revoked stays revoked,
// and its sessions ended stay ended. Freed are the accounts no longer
// stopped: the account, unless its human is stopped, and a human's
// machine sailors not stopped on their own. ErrNotFound; ErrNotStopped.
func (s *Store) Start(ctx context.Context, op Operation) (Operated, error) {
	return s.operate(ctx, op, func(q *db.Queries, out *Operated) error {
		if !out.Stopped {
			return ErrNotStopped
		}
		if !out.OwnerStopped {
			out.Freed = append(out.Freed, out.ID)
		}
		if out.Kind == Human {
			ms, err := q.MachinesOf(ctx, uuidOf(out.ID))
			if err != nil {
				return err
			}
			for _, m := range ms {
				if notEpoch(m.StoppedAt).IsZero() {
					out.Freed = append(out.Freed, m.ID.Bytes)
				}
			}
		}
		if op.Check {
			return nil
		}
		_, err := q.StartAccount(ctx, uuidOf(out.ID))
		return err
	})
}

// Revoke revokes every live grant of an AI account, or of each of a
// human's machine sailors, by the operator: nothing is stopped, and its
// player may approve its apps again. ErrNotFound.
func (s *Store) Revoke(ctx context.Context, op Operation) (Operated, error) {
	return s.operate(ctx, op, func(q *db.Queries, out *Operated) error {
		return revokeGrants(ctx, q, out, op.Lifetime, op.Check)
	})
}

// Delete deletes an account as its player would: a human with its
// machine sailors first, every name freed and what they charted kept
// under no name; or one machine sailor. Checked, it counts the grants
// the deletion would end. ErrNotFound.
func (s *Store) Delete(ctx context.Context, op Operation) (Operated, error) {
	return s.operate(ctx, op, func(q *db.Queries, out *Operated) error {
		if err := revokeGrants(ctx, q, out, op.Lifetime, true); err != nil || op.Check {
			return err
		}
		if out.Kind == AI {
			return deleteMachine(ctx, q, out.Owner, out.ID)
		}
		return deleteHuman(ctx, q, out.ID)
	})
}

// Found is a human account a search found.
type Found struct {
	ID          AccountID
	Name        string
	Created     time.Time
	LastSeen    time.Time
	Tools       bool
	Priority    bool
	Stopped     bool
	Exact       bool
	MachineSeen time.Time
}

// The sorts of a search.
const (
	SortActiveOld = "active-old"
	SortActiveNew = "active-new"
	SortMade      = "made"
	SortMachines  = "machines"
)

// Search is what to look for: with Every, every human account; or the
// human accounts whose sailor or machine sailor has the name key Key, or,
// with Part, a key matching the LIKE pattern Pattern. Sort is one of the
// sorts; Limit and Offset the page.
type Search struct {
	Every         bool
	Key           string
	Part          bool
	Pattern       string
	Sort          string
	Limit, Offset int
}

// SearchAccounts finds human accounts, a page of them, and how many there
// are in all.
func (s *Store) SearchAccounts(ctx context.Context, sr Search) ([]Found, int64, error) {
	if sr.Every && (sr.Sort == SortActiveOld || sr.Sort == SortActiveNew) {
		// Every account by when it was last active: by its index, a page
		// at a time, however many there are.
		var rows []db.HumansByActiveOldestRow
		p := db.HumansByActiveOldestParams{Lim: int32(sr.Limit), Off: int32(sr.Offset)}
		if sr.Sort == SortActiveOld {
			var err error
			if rows, err = s.q.HumansByActiveOldest(ctx, p); err != nil {
				return nil, 0, err
			}
		} else {
			newest, err := s.q.HumansByActiveNewest(ctx, db.HumansByActiveNewestParams(p))
			if err != nil {
				return nil, 0, err
			}
			for _, r := range newest {
				rows = append(rows, db.HumansByActiveOldestRow(r))
			}
		}
		n, err := s.q.AccountCounts(ctx)
		if err != nil {
			return nil, 0, err
		}
		out := make([]Found, len(rows))
		for i, r := range rows {
			out[i] = Found{ID: r.ID.Bytes, Name: r.Name, Created: r.CreatedAt, LastSeen: r.LastSeenAt, Tools: r.Tools,
				Priority: r.Priority, Stopped: r.Stopped}
		}
		return out, n.Total, nil
	}
	rows, err := s.q.SearchAccounts(ctx, db.SearchAccountsParams{
		Sort: sr.Sort, Off: int32(sr.Offset), Lim: int32(sr.Limit), Key: sr.Key, Every: sr.Every, Part: sr.Part, Pattern: sr.Pattern,
	})
	if err != nil {
		return nil, 0, err
	}
	var total int64
	out := make([]Found, len(rows))
	for i, r := range rows {
		total = r.Total
		out[i] = Found{ID: r.ID.Bytes, Name: r.Name, Created: r.CreatedAt, LastSeen: r.LastSeenAt, Tools: r.Tools,
			Priority: r.Priority, Stopped: r.Stopped, Exact: r.Exact, MachineSeen: notEpoch(r.MachinesSeen)}
	}
	if len(rows) == 0 && sr.Offset > 0 {
		// A page past the end: how many there are all the same.
		if _, n, err := s.SearchAccounts(ctx, Search{Every: sr.Every, Key: sr.Key, Part: sr.Part, Pattern: sr.Pattern, Sort: sr.Sort, Limit: 1}); err == nil {
			total = n
		}
	}
	return out, total, nil
}

// FoundMachine is a machine sailor of a human account found.
type FoundMachine struct {
	ID       AccountID
	Owner    AccountID
	Name     string
	NameKey  string
	Created  time.Time
	LastSeen time.Time
	Priority bool
	// Stopped is stopped on its own.
	Stopped bool
}

// MachinesOfOwners are the machine sailors of the human accounts given,
// the oldest first.
func (s *Store) MachinesOfOwners(ctx context.Context, owners []AccountID) ([]FoundMachine, error) {
	ids := make([]pgtype.UUID, len(owners))
	for i, o := range owners {
		ids[i] = uuidOf(o)
	}
	rows, err := s.q.MachinesOfMany(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make([]FoundMachine, len(rows))
	for i, r := range rows {
		out[i] = FoundMachine{ID: r.ID.Bytes, Owner: r.OwnerID.Bytes, Name: r.Name, NameKey: r.NameKey, Created: r.CreatedAt,
			LastSeen: r.LastSeenAt, Priority: r.Priority, Stopped: r.Stopped}
	}
	return out, nil
}

// SessionOf is the account a session's token hash names, stopped or not,
// or ErrNotFound.
func (s *Store) SessionOf(ctx context.Context, hash [32]byte) (AccountID, error) {
	u, err := s.q.SessionOf(ctx, hash[:])
	if errors.Is(err, pgx.ErrNoRows) {
		return AccountID{}, ErrNotFound
	}
	return u.Bytes, err
}

// Card is what the world page's card shows of an account: a human's or a
// machine sailor's.
type Card struct {
	ID    AccountID
	Kind  Kind
	Owner AccountID
	Name  string
	Look  string
	// Version, Finish and Colour are a machine sailor's look.
	Version, Finish, Colour string
	Created                 time.Time
	LastSeen                time.Time
	Tools, Priority         bool
	Cap                     int
	// Stopped is when it was stopped, zero if it is not, and StopReason
	// why.
	Stopped    time.Time
	StopReason string
	// RecoveryMade is when its recovery code was made: zero for none.
	RecoveryMade time.Time
	// OwnerName, OwnerTools and OwnerStopped are a machine sailor's
	// human's.
	OwnerName    string
	OwnerTools   bool
	OwnerStopped time.Time
	// Sessions is how many it has, and SessionSeen when the latest was
	// last seen.
	Sessions    int64
	SessionSeen time.Time
}

// Card reads an account's card, or ErrNotFound.
func (s *Store) Card(ctx context.Context, id AccountID) (Card, error) {
	r, err := s.q.AccountCard(ctx, uuidOf(id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Card{}, ErrNotFound
	}
	if err != nil {
		return Card{}, err
	}
	c := Card{
		ID: r.ID.Bytes, Kind: Kind(r.Kind), Owner: r.OwnerID.Bytes, Name: r.Name, Look: r.Look,
		Version: r.Version, Finish: r.Finish, Colour: r.Colour, Created: r.CreatedAt, LastSeen: r.LastSeenAt,
		Tools: r.Tools, Priority: r.Priority, Cap: int(r.MachineCap), Stopped: notEpoch(r.StoppedAt), StopReason: r.StopReason,
		OwnerName: r.OwnerName, OwnerTools: r.OwnerTools, OwnerStopped: notEpoch(r.OwnerStoppedAt),
	}
	if r.HasRecovery {
		c.RecoveryMade = notEpoch(r.RecoveryMadeAt)
	}
	seen, err := s.q.SessionsSeen(ctx, uuidOf(id))
	if err != nil {
		return Card{}, err
	}
	c.Sessions, c.SessionSeen = seen.Sessions, notEpoch(seen.Latest)
	return c, nil
}
