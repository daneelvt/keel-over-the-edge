// SPDX-License-Identifier: AGPL-3.0-only

// Package accounts is the one place an account is searched for, shown,
// stopped, started again, has its tokens revoked, or is deleted: by the
// owner's world page, by keel admin through the page's own routes, and, for
// a deletion, by its player. Each action reaches the database, the
// sessions' cache, the machine sailors' door and their helms, the stopped
// set, and the world sailed (its game connections and its chart), so it is
// written here once, and the three cannot differ.
package accounts

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Store is where accounts are kept: the store.
type Store interface {
	Stop(ctx context.Context, op store.Operation) (store.Operated, error)
	Start(ctx context.Context, op store.Operation) (store.Operated, error)
	Revoke(ctx context.Context, op store.Operation) (store.Operated, error)
	Delete(ctx context.Context, op store.Operation) (store.Operated, error)
	RecordAction(ctx context.Context, a store.Action) error
	Actions(ctx context.Context, account *store.AccountID, limit int) ([]store.Action, error)
	Stopped(ctx context.Context) (map[store.AccountID]store.Kind, error)
	SearchAccounts(ctx context.Context, s store.Search) ([]store.Found, int64, error)
	MachinesOfOwners(ctx context.Context, owners []store.AccountID) ([]store.FoundMachine, error)
	SessionOf(ctx context.Context, hash [32]byte) (store.AccountID, error)
	TokenGrant(ctx context.Context, hash [32]byte) (store.TokenGrant, error)
	Card(ctx context.Context, id store.AccountID) (store.Card, error)
	Passkeys(ctx context.Context, id store.AccountID) ([]store.Passkey, error)
	Fleet(ctx context.Context, owner store.AccountID) (map[string]int, error)
	oauth.Machines
	DeleteAccount(ctx context.Context, id store.AccountID) ([]store.AccountID, error)
	DeleteMachine(ctx context.Context, owner, id store.AccountID) error
}

// Sessions are the sessions' cache: it forgets an account at once.
type Sessions interface {
	ForgetAccount(id store.AccountID)
}

// Door is the machine sailors' door's cache of tokens: it forgets a
// machine sailor's tokens, or a grant's, at once.
type Door interface {
	ForgetAccounts(ids ...store.AccountID)
	ForgetGrants(ids ...[16]byte)
}

// Agents are the machine sailors' helms.
type Agents interface {
	// Stop ends a machine sailor's wait with the words given, takes its
	// boat or its place in the queue out, and forgets its helm.
	Stop(id store.AccountID, words string)
	// Revoked ends a machine sailor's wait with the words given and sends
	// its boat into its grace: an app approved again within it keeps the
	// boat.
	Revoked(id store.AccountID, words string)
}

// Sea is where an account's boat is in the world sailed: at sea, or
// waiting in the queue.
type Sea struct {
	Boat        uint64
	East, North float64
	Connected   bool
	Grace       float64 // seconds of its grace left, 0 while connected
	Queued      bool
	Position    int // its place among those of its kind, 1 for the head
	Machine     bool
}

// World is the world sailed, as an action reaches it.
type World interface {
	// Stopped takes a stopped account out of the game: its connection
	// closed with its reason, its boat out of the water at once, its
	// place in the queue given up.
	Stopped(id store.AccountID)
	// Deleted does the same for an account deleted, and its credits on
	// the chart lose its name.
	Deleted(id store.AccountID)
	// Sea is where the account's boat is, if it has one at sea or waits.
	Sea(id store.AccountID) (Sea, bool)
}

// Config is what the accounts' actions reach.
type Config struct {
	Store    Store
	Sessions Sessions
	// Door and Agents are nil without sign-in for AI apps.
	Door   Door
	Agents Agents
	// World is the world sailed now, nil between worlds.
	World func() World
	// Lifetime is the grant lifetime now.
	Lifetime func() time.Duration
	// Looks are the machine sailors' looks, as the card names them.
	Looks oauth.MachineLooks
	// Stopped is the set loaded as keel started.
	Stopped *Set
	Log     *slog.Logger
	Metrics *obs.Metrics
	// Now is the clock, time.Now unless set.
	Now func() time.Time
}

// Accounts is the operator's hand on accounts.
type Accounts struct {
	cfg Config
}

// New makes the accounts' actions.
func New(cfg Config) *Accounts {
	if cfg.Log == nil {
		cfg.Log = slog.New(slog.DiscardHandler)
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Stopped == nil {
		cfg.Stopped = NewSet(nil)
	}
	if cfg.Lifetime == nil {
		cfg.Lifetime = func() time.Duration { return oauth.DefaultLifetime }
	}
	return &Accounts{cfg: cfg}
}

// Load reads the accounts stopped from the store, as keel starts.
func Load(ctx context.Context, st interface {
	Stopped(ctx context.Context) (map[store.AccountID]store.Kind, error)
}) (*Set, error) {
	m, err := st.Stopped(ctx)
	if err != nil {
		return nil, err
	}
	return NewSet(m), nil
}

// Stopped is the set of accounts stopped.
func (a *Accounts) Stopped() *Set { return a.cfg.Stopped }

// The words a stopped account is refused with: its player's on the
// game connection's close, and its agent's.
const (
	// AgentStopped ends a stopped machine sailor's waiting call.
	AgentStopped = oauth.WordsStopped
	// AgentDeleted ends a deleted machine sailor's waiting call.
	AgentDeleted = "This machine sailor has been deleted: its tokens no longer work."
	// AgentRevoked ends a waiting call whose grants the operator revoked.
	AgentRevoked = "This approval of Keel Over the Edge was revoked by the game's operator. " +
		"Approve the app again, or make a new connection token, with your passkey."
)

// The errors of the actions, each with words for the owner.
var (
	ErrNotFound       = errors.New("no account of that id")
	ErrReason         = fmt.Errorf("a reason is required: 1 to %d characters", store.MaxReason)
	ErrName           = errors.New("the name typed is not the sailor's")
	ErrFlagged        = errors.New("a flagged account is not deleted: clear its flag first")
	ErrAlreadyStopped = errors.New("the account is stopped already")
	ErrNotStopped     = errors.New("the account is not stopped")
)

// Request is an action asked for: on an account, with its reason (and,
// to delete, its sailor's name typed again), from the page or the command
// (Source) at an address (From). With Check, nothing is done: the answer
// says what would be.
type Request struct {
	Account store.AccountID
	Reason  string
	Name    string
	Check   bool
	Source  string
	From    string
}

// Effects are what an action does, in numbers: the machine sailors it
// reaches, the sessions it ends, the grants it revokes and the boats that
// leave the water (or, revoked, go into their grace).
type Effects struct {
	Machines int   `json:"machines"`
	Sessions int64 `json:"sessions"`
	Grants   int64 `json:"grants"`
	Boats    int   `json:"boats"`
}

// Done is what an action did, or with a check would do, and its words.
type Done struct {
	Account string  `json:"account"`
	Action  string  `json:"action"`
	Done    bool    `json:"done"`
	Words   string  `json:"words"`
	Own     bool    `json:"own"`
	Effects Effects `json:"effects"`
}

// reason checks a reason's length; optional ones may be empty.
func reason(r string, required bool) (string, error) {
	r = strings.TrimSpace(r)
	n := utf8.RuneCountInString(r)
	if (required && n == 0) || n > store.MaxReason {
		return "", ErrReason
	}
	return r, nil
}

func (a *Accounts) operation(req Request, action, detail string) store.Operation {
	return store.Operation{
		Action: store.Action{
			Action: action, Account: req.Account, HasAccount: true, Detail: detail, Source: source(req.Source), From: req.From,
		},
		Lifetime: a.cfg.Lifetime(), Check: req.Check,
	}
}

func source(s string) string {
	if s == store.SourceCommand {
		return s
	}
	return store.SourcePage
}

// storeErr is a store's error as the actions name it.
func storeErr(err error) error {
	switch {
	case errors.Is(err, store.ErrNotFound):
		return ErrNotFound
	case errors.Is(err, store.ErrStopped):
		return ErrAlreadyStopped
	case errors.Is(err, store.ErrNotStopped):
		return ErrNotStopped
	}
	return err
}

// reached are the accounts an action on t reaches: the account, and a
// human's machine sailors.
func reached(t *store.Target) []store.AccountID {
	return append([]store.AccountID{t.ID}, t.Machines...)
}

// machines are the machine sailors an action on t reaches: a human's, or
// the machine sailor itself.
func machines(t *store.Target) []store.AccountID {
	if t.Kind == store.AI {
		return []store.AccountID{t.ID}
	}
	return t.Machines
}

// boats counts the boats at sea of the accounts given.
func (a *Accounts) boats(ids []store.AccountID) int {
	w := a.world()
	if w == nil {
		return 0
	}
	n := 0
	for _, id := range ids {
		if s, ok := w.Sea(id); ok && !s.Queued {
			n++
		}
	}
	return n
}

func (a *Accounts) world() World {
	if a.cfg.World == nil {
		return nil
	}
	return a.cfg.World()
}

func (a *Accounts) done(req Request, action string, t *store.Target, e Effects, words string) Done {
	own := t.Tools || t.OwnerTools
	if own {
		words += " This is one of your own accounts."
	}
	return Done{Account: t.ID.String(), Action: action, Done: !req.Check, Words: words, Own: own, Effects: e}
}

// Stop stops an account: it cannot sign in, its sessions end, its boat
// leaves the water and its connection closes, its machine sailors' grants
// are revoked, and a human's machine sailors stop with it. A reason is
// required.
func (a *Accounts) Stop(ctx context.Context, req Request) (Done, error) {
	why, err := reason(req.Reason, true)
	if err != nil {
		return Done{}, err
	}
	out, err := a.cfg.Store.Stop(ctx, a.operation(req, store.ActionStop, why))
	if err != nil {
		return Done{}, storeErr(err)
	}
	t := &out.Target
	ids := reached(t)
	e := Effects{Machines: len(t.Machines), Sessions: out.Sessions, Grants: out.Grants, Boats: a.boats(ids)}
	words := fmt.Sprintf("%s%s %s; %s %s; %s %s revoked; %s %s the water.", t.Name, andMachines(t),
		verb(len(ids), "stops", "stop"), plural(int(out.Sessions), "session"), verb(int(out.Sessions), "ends", "end"),
		plural(int(out.Grants), "grant"), verb(int(out.Grants), "is", "are"), plural(e.Boats, "boat"), verb(e.Boats, "leaves", "leave"))
	if req.Check {
		return a.done(req, store.ActionStop, t, e, words), nil
	}
	// The set first, so that a connection that claims its account from
	// now on is refused; then every cache forgets, so that nothing waits
	// out its time; then the world, and the helms.
	a.cfg.Stopped.add(t.Kind, t.ID)
	a.cfg.Stopped.add(store.AI, t.Machines...)
	a.cfg.Sessions.ForgetAccount(t.ID)
	if a.cfg.Door != nil {
		a.cfg.Door.ForgetAccounts(ids...)
		a.cfg.Door.ForgetGrants(out.Revoked...)
	}
	if w := a.world(); w != nil {
		for _, id := range ids {
			w.Stopped(id)
		}
	}
	if a.cfg.Agents != nil {
		for _, id := range machines(t) {
			a.cfg.Agents.Stop(id, AgentStopped)
		}
	}
	a.cfg.Log.Info("owner: an account stopped", "action", store.ActionStop, "account", t.ID.String(), "kind", string(t.Kind),
		"machines", len(t.Machines), "sessions", out.Sessions, "grants", out.Grants, "reason", why, "source", source(req.Source), "from", req.From)
	return a.done(req, store.ActionStop, t, e, words), nil
}

// Start starts a stopped account again: it may sign in, with its passkey
// or its recovery code, and its player approves their apps again; what the
// stop revoked stays revoked. A human's machine sailors start with it,
// but for those stopped on their own. A reason is optional.
func (a *Accounts) Start(ctx context.Context, req Request) (Done, error) {
	why, err := reason(req.Reason, false)
	if err != nil {
		return Done{}, err
	}
	out, err := a.cfg.Store.Start(ctx, a.operation(req, store.ActionStart, why))
	if err != nil {
		return Done{}, storeErr(err)
	}
	t := &out.Target
	freed := len(out.Freed)
	words := fmt.Sprintf("%s %s again; revoked grants stay revoked, and its player signs in again with a passkey or the recovery code.",
		t.Name, verb(1, "starts", "start"))
	if t.Kind == store.Human && freed > 1 {
		words = fmt.Sprintf("%s and %s start again; revoked grants stay revoked, and its player signs in again with a passkey or the recovery code.",
			t.Name, plural(freed-1, "machine sailor"))
	}
	if t.OwnerStopped {
		words += " Its human is stopped: it stays stopped until its human starts again."
	}
	e := Effects{Machines: max(0, freed-1)}
	if req.Check {
		return a.done(req, store.ActionStart, t, e, words), nil
	}
	a.cfg.Stopped.remove(out.Freed...)
	a.cfg.Sessions.ForgetAccount(t.ID)
	if a.cfg.Door != nil {
		a.cfg.Door.ForgetAccounts(reached(t)...)
	}
	a.cfg.Log.Info("owner: an account started again", "action", store.ActionStart, "account", t.ID.String(), "kind", string(t.Kind),
		"freed", freed, "reason", why, "source", source(req.Source), "from", req.From)
	return a.done(req, store.ActionStart, t, e, words), nil
}

// Revoke revokes an AI account's grants, or each of a human's machine
// sailors': its apps and its connection token end, and each machine
// sailor's boat goes into its grace. Nothing is stopped: its player
// approves again, or makes a new token, with their passkey, and an agent
// that does so within the grace keeps the boat. A reason is required.
func (a *Accounts) Revoke(ctx context.Context, req Request) (Done, error) {
	why, err := reason(req.Reason, true)
	if err != nil {
		return Done{}, err
	}
	out, err := a.cfg.Store.Revoke(ctx, a.operation(req, store.ActionRevoke, why))
	if err != nil {
		return Done{}, storeErr(err)
	}
	t := &out.Target
	ms := machines(t)
	e := Effects{Machines: len(t.Machines), Grants: out.Grants, Boats: a.boats(ms)}
	of := t.Name
	if t.Kind == store.Human {
		of = fmt.Sprintf("%s's %s", t.Name, plural(len(ms), "machine sailor"))
	}
	words := fmt.Sprintf("%s of %s %s revoked; %s %s into %s grace. Nothing is stopped: its player approves again with a passkey.",
		plural(int(out.Grants), "grant"), of, verb(int(out.Grants), "is", "are"), plural(e.Boats, "boat"), verb(e.Boats, "goes", "go"),
		map[bool]string{true: "its", false: "their"}[e.Boats == 1])
	if req.Check {
		return a.done(req, store.ActionRevoke, t, e, words), nil
	}
	if a.cfg.Door != nil {
		a.cfg.Door.ForgetGrants(out.Revoked...)
	}
	if a.cfg.Agents != nil {
		for _, id := range ms {
			a.cfg.Agents.Revoked(id, AgentRevoked)
		}
	}
	a.cfg.Log.Info("owner: an account's tokens revoked", "action", store.ActionRevoke, "account", t.ID.String(), "kind", string(t.Kind),
		"grants", out.Grants, "reason", why, "source", source(req.Source), "from", req.From)
	return a.done(req, store.ActionRevoke, t, e, words), nil
}

// Delete deletes an account as its player would, its sailor's name typed
// again and a reason given: a human with its machine sailors, or one
// machine sailor. An account carrying the owner's flag is refused until
// the flag is cleared.
func (a *Accounts) Delete(ctx context.Context, req Request) (Done, error) {
	why, err := reason(req.Reason, true)
	if err != nil {
		return Done{}, err
	}
	c, err := a.cfg.Store.Card(ctx, req.Account)
	if err != nil {
		return Done{}, storeErr(err)
	}
	if moderation.Key(req.Name) != moderation.Key(c.Name) {
		return Done{}, ErrName
	}
	if c.Tools {
		return Done{}, ErrFlagged
	}
	check := req
	check.Check = true
	out, err := a.cfg.Store.Delete(ctx, a.operation(check, store.ActionDelete, why))
	if err != nil {
		return Done{}, storeErr(err)
	}
	t := &out.Target
	ids := reached(t)
	e := Effects{Machines: len(t.Machines), Sessions: out.Sessions, Grants: out.Grants, Boats: a.boats(ids)}
	words := fmt.Sprintf("%s%s %s deleted, with %s and %s; %s %s the water. Every name is free again; what they charted reads \"a former sailor\".",
		t.Name, andMachines(t), verb(len(ids), "is", "are"), plural(int(out.Sessions), "session"), plural(int(out.Grants), "live grant"),
		plural(e.Boats, "boat"), verb(e.Boats, "leaves", "leave"))
	if req.Check {
		return a.done(req, store.ActionDelete, t, e, words), nil
	}
	if out, err = a.cfg.Store.Delete(ctx, a.operation(req, store.ActionDelete, why)); err != nil {
		return Done{}, storeErr(err)
	}
	t = &out.Target
	a.deleted(t.ID, t.Kind, t.Machines, "owner")
	a.cfg.Log.Info("owner: an account deleted", "action", store.ActionDelete, "account", t.ID.String(), "kind", string(t.Kind),
		"machines", len(t.Machines), "reason", why, "source", source(req.Source), "from", req.From)
	return a.done(req, store.ActionDelete, t, e, words), nil
}

// DeleteByPlayer deletes a human account at its player's word, with its
// machine sailors, as Delete does. ErrNotFound if it is gone already.
func (a *Accounts) DeleteByPlayer(ctx context.Context, id store.AccountID) error {
	ms, err := a.cfg.Store.DeleteAccount(ctx, id)
	if err != nil {
		return storeErr(err)
	}
	a.deleted(id, store.Human, ms, "player")
	return nil
}

// DeleteMachineByPlayer deletes one of a human account's machine sailors
// at its player's word. ErrNotFound if the account has no such machine
// sailor.
func (a *Accounts) DeleteMachineByPlayer(ctx context.Context, owner, id store.AccountID) error {
	if err := a.cfg.Store.DeleteMachine(ctx, owner, id); err != nil {
		return storeErr(err)
	}
	a.deleted(id, store.AI, nil, "player")
	return nil
}

// deleted is what follows an account deleted, by its player or the
// owner: the caches forget it, its boat leaves the water and its
// connection closes, its credits on the chart lose its name, its machine
// sailors' helms end, and it is counted.
func (a *Accounts) deleted(id store.AccountID, kind store.Kind, ms []store.AccountID, by string) {
	ids := append([]store.AccountID{id}, ms...)
	a.cfg.Stopped.remove(ids...)
	a.cfg.Sessions.ForgetAccount(id)
	if a.cfg.Door != nil {
		a.cfg.Door.ForgetAccounts(ids...)
	}
	if w := a.world(); w != nil {
		for _, d := range ids {
			w.Deleted(d)
		}
	}
	gone := ms
	if kind == store.AI {
		gone = ids
	}
	if a.cfg.Agents != nil {
		for _, d := range gone {
			a.cfg.Agents.Stop(d, AgentDeleted)
		}
	}
	if m := a.cfg.Metrics; m != nil {
		if kind == store.Human {
			m.AccountsDeleted.WithLabelValues(by).Inc()
		}
		m.MachinesDeleted.WithLabelValues(by).Add(float64(len(gone)))
	}
}

// Record writes an action of the owner's other controls in the record:
// the flag, priority, the machine sailors allowed, the grant lifetime. A
// failure is logged: the control has acted.
func (a *Accounts) Record(ctx context.Context, act store.Action) {
	act.Source = source(act.Source)
	if act.HasAccount && (act.Name == "" || act.Kind == "") {
		if c, err := a.cfg.Store.Card(ctx, act.Account); err == nil {
			act.Name, act.Kind = c.Name, c.Kind
		}
	}
	if err := a.cfg.Store.RecordAction(ctx, act); err != nil {
		a.cfg.Log.Warn("recording an owner's action", "action", act.Action, "err", err)
	}
}

// andMachines is " and 2 machine sailors" for a human that has any.
func andMachines(t *store.Target) string {
	if t.Kind != store.Human || len(t.Machines) == 0 {
		return ""
	}
	return " and " + plural(len(t.Machines), "machine sailor")
}

// plural is a count and its noun: "1 grant", "3 grants".
func plural(n int, one string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %ss", n, one)
}

// verb is a verb agreeing with a count.
func verb(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}
