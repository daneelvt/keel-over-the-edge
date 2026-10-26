// SPDX-License-Identifier: AGPL-3.0-only

package accounts

import (
	"context"

	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The card: what the game keeps of an account, and nothing it does not.
// No addresses, devices or history of sessions are kept, so none are
// shown: a passkey's device and browser are what its player's account
// page shows too.

// Card is an account's card: a human's, with its machine sailors' cards,
// or a machine sailor's.
type Card struct {
	ID           string     `json:"id"`
	Kind         store.Kind `json:"kind"`
	Name         string     `json:"name"`
	Look         string     `json:"look"`
	Made         int64      `json:"made"`
	LastActive   string     `json:"lastActive"`
	LastActiveAt int64      `json:"lastActiveAt"`
	Tools        bool       `json:"tools"`
	Priority     bool       `json:"priority"`
	Stopped      *Stopped   `json:"stopped"`
	Sea          *SeaCard   `json:"sea"`
	Queue        *QueueCard `json:"queue"`
	Own          bool       `json:"own"`
	// Watching is the sailor whose boat the account watches, if it does.
	Watching string `json:"watching,omitempty"`

	// A human's.
	Passkeys     []PasskeyCard  `json:"passkeys,omitempty"`
	RecoveryMade int64          `json:"recoveryMade"`
	Sessions     *SessionsCard  `json:"sessions,omitempty"`
	Fleet        map[string]int `json:"fleet,omitempty"`
	Cap          int            `json:"cap"`
	Machines     []Card         `json:"machines,omitempty"`

	// A machine sailor's.
	Owner     *OwnerCard       `json:"owner,omitempty"`
	LookWords string           `json:"lookWords,omitempty"`
	Apps      []oauth.AppItem  `json:"apps,omitempty"`
	Token     *oauth.TokenItem `json:"token,omitempty"`

	Actions []ActionCard `json:"actions,omitempty"`
}

// Stopped is when an account was stopped and why; ByOwner, for a machine
// sailor stopped only because its human is.
type Stopped struct {
	At      int64  `json:"at"`
	Reason  string `json:"reason"`
	ByOwner bool   `json:"byOwner"`
}

// SeaCard is an account's boat at sea.
type SeaCard struct {
	Boat      uint64  `json:"boat"`
	East      float64 `json:"east"`
	North     float64 `json:"north"`
	Connected bool    `json:"connected"`
	Grace     float64 `json:"grace"`
}

// QueueCard is an account's place in the queue, among those of its kind.
type QueueCard struct {
	Position int `json:"position"`
}

// PasskeyCard is a passkey as the card lists it.
type PasskeyCard struct {
	MadeOn       string `json:"madeOn"`
	Made         int64  `json:"made"`
	LastUsed     int64  `json:"lastUsed"`
	Synced       bool   `json:"synced"`
	CloneWarning bool   `json:"cloneWarning"`
}

// SessionsCard is how many sessions an account has, and when the latest
// was last seen.
type SessionsCard struct {
	Count  int64 `json:"count"`
	Latest int64 `json:"latest"`
}

// OwnerCard is a machine sailor's human.
type OwnerCard struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ActionCard is an entry of the record.
type ActionCard struct {
	At      int64      `json:"at"`
	Action  string     `json:"action"`
	Account string     `json:"account"`
	Kind    store.Kind `json:"kind"`
	Name    string     `json:"name"`
	Detail  string     `json:"detail"`
	Source  string     `json:"source"`
	From    string     `json:"from"`
}

// ActionsShown is how many actions the card and the record list.
const ActionsShown = 100

// Actions are the record's latest actions: of one account, or of all
// when account is nil.
func (a *Accounts) Actions(ctx context.Context, account *store.AccountID) ([]ActionCard, error) {
	acts, err := a.cfg.Store.Actions(ctx, account, ActionsShown)
	if err != nil {
		return nil, err
	}
	out := make([]ActionCard, len(acts))
	for i, x := range acts {
		out[i] = ActionCard{At: ms(x.At), Action: x.Action, Kind: x.Kind, Name: x.Name, Detail: x.Detail, Source: x.Source, From: x.From}
		if x.HasAccount {
			out[i].Account = x.Account.String()
		}
	}
	return out, nil
}

// Card reads an account's card, with the record of its actions.
func (a *Accounts) Card(ctx context.Context, id store.AccountID) (Card, error) {
	c, err := a.cfg.Store.Card(ctx, id)
	if err != nil {
		return Card{}, storeErr(err)
	}
	var out Card
	if c.Kind == store.AI {
		owner, err := a.cfg.Store.Card(ctx, c.Owner)
		if err != nil {
			return Card{}, storeErr(err)
		}
		items, err := a.listMachines(ctx, owner.ID)
		if err != nil {
			return Card{}, err
		}
		out = a.machineCard(&owner, &c, items)
	} else if out, err = a.humanCard(ctx, &c); err != nil {
		return Card{}, err
	}
	if out.Actions, err = a.Actions(ctx, &id); err != nil {
		return Card{}, err
	}
	return out, nil
}

// base is what every card shows.
func (a *Accounts) base(c *store.Card) Card {
	now := a.cfg.Now()
	machine := c.Kind == store.AI
	out := Card{
		ID: c.ID.String(), Kind: c.Kind, Name: c.Name, Look: c.Look, Made: ms(c.Created),
		LastActive: LastActive(c.LastSeen, c.Created, machine, now), LastActiveAt: ms(c.LastSeen),
		Tools: c.Tools, Priority: c.Priority, Own: c.Tools || c.OwnerTools,
	}
	if machine && !c.LastSeen.After(c.Created) {
		out.LastActiveAt = 0
	}
	switch {
	case !c.Stopped.IsZero():
		out.Stopped = &Stopped{At: ms(c.Stopped), Reason: c.StopReason}
	case !c.OwnerStopped.IsZero():
		out.Stopped = &Stopped{At: ms(c.OwnerStopped), ByOwner: true}
	}
	if w := a.world(); w != nil {
		if s, ok := w.Sea(c.ID); ok {
			if s.Queued {
				out.Queue = &QueueCard{Position: s.Position}
			} else {
				out.Sea = &SeaCard{Boat: s.Boat, East: s.East, North: s.North, Connected: s.Connected, Grace: s.Grace}
				out.LastActive = AtSeaNow
			}
		}
		out.Watching, _ = w.Watching(c.ID)
	}
	return out
}

func (a *Accounts) humanCard(ctx context.Context, c *store.Card) (Card, error) {
	out := a.base(c)
	keys, err := a.cfg.Store.Passkeys(ctx, c.ID)
	if err != nil {
		return Card{}, err
	}
	out.Passkeys = make([]PasskeyCard, len(keys))
	for i, k := range keys {
		out.Passkeys[i] = PasskeyCard{MadeOn: k.MadeOn, Made: ms(k.Created), LastUsed: ms(k.LastUsed), Synced: k.BackupState, CloneWarning: k.CloneWarning}
	}
	out.RecoveryMade = ms(c.RecoveryMade)
	out.Sessions = &SessionsCard{Count: c.Sessions, Latest: ms(c.SessionSeen)}
	if out.Fleet, err = a.cfg.Store.Fleet(ctx, c.ID); err != nil {
		return Card{}, err
	}
	out.Cap = c.Cap
	items, err := a.listMachines(ctx, c.ID)
	if err != nil {
		return Card{}, err
	}
	out.Machines = make([]Card, 0, len(items))
	for i := range items {
		id, _ := store.ParseID(items[i].ID)
		mc, err := a.cfg.Store.Card(ctx, id)
		if err != nil {
			return Card{}, storeErr(err)
		}
		out.Machines = append(out.Machines, a.machineCard(c, &mc, items))
	}
	return out, nil
}

// listMachines lists a human's machine sailors with their apps and
// connection tokens, as its account page does.
func (a *Accounts) listMachines(ctx context.Context, owner store.AccountID) ([]oauth.MachineItem, error) {
	return oauth.ListMachines(ctx, a.cfg.Store, owner, a.cfg.Looks, a.cfg.Lifetime(), a.cfg.Now(), nil)
}

// machineCard is a machine sailor's card, given its human's card and its
// human's machine sailors as listed.
func (a *Accounts) machineCard(owner, c *store.Card, items []oauth.MachineItem) Card {
	out := a.base(c)
	out.Owner = &OwnerCard{ID: owner.ID.String(), Name: owner.Name}
	out.LookWords = a.cfg.Looks.LookOf(c.Version, c.Finish, c.Colour).Words
	out.Apps = []oauth.AppItem{}
	for _, it := range items {
		if it.ID == out.ID {
			out.Apps, out.Token = it.Apps, it.Token
		}
	}
	return out
}
