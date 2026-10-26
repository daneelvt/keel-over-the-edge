// SPDX-License-Identifier: AGPL-3.0-only

package accounts

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Finding an account. One box takes whatever the owner has: an account's
// ID; a token, an AI app's or a connection token, or a session's, as a
// player reported it or as it leaked, found by its hash; or a sailor's
// name, or part of it, compared by its key, so case, spacing and letters
// that look alike make no difference. Nothing typed lists every account.
// A machine sailor found is shown under its human. A token is never
// written to a log, and never echoed back.

// PageSize is how many human accounts a page of results holds.
const PageSize = 50

// What a search found by.
const (
	FoundAll     = "all"
	FoundName    = "name"
	FoundID      = "id"
	FoundToken   = "token"
	FoundSession = "session"
)

// Result is a page of a search's results.
type Result struct {
	Found string `json:"found"`
	// Note is said above the results: what a token is, or that nothing is
	// known of it.
	Note     string `json:"note"`
	Total    int64  `json:"total"`
	Page     int    `json:"page"`
	Pages    int    `json:"pages"`
	Sort     string `json:"sort"`
	Accounts []Row  `json:"accounts"`
}

// Row is a human account found, with its machine sailors.
type Row struct {
	ID           string       `json:"id"`
	Name         string       `json:"name"`
	Made         int64        `json:"made"`
	LastActive   string       `json:"lastActive"`
	LastActiveAt int64        `json:"lastActiveAt"`
	AtSea        bool         `json:"atSea"`
	Queued       bool         `json:"queued"`
	Tools        bool         `json:"tools"`
	Priority     bool         `json:"priority"`
	Stopped      bool         `json:"stopped"`
	Matched      bool         `json:"matched"`
	Machines     []MachineRow `json:"machines"`
}

// MachineRow is a machine sailor of a human account found. Stopped is
// true when it, or its human, is.
type MachineRow struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Made         int64  `json:"made"`
	LastActive   string `json:"lastActive"`
	LastActiveAt int64  `json:"lastActiveAt"`
	AtSea        bool   `json:"atSea"`
	Queued       bool   `json:"queued"`
	Priority     bool   `json:"priority"`
	Stopped      bool   `json:"stopped"`
	Matched      bool   `json:"matched"`
}

// Sorts are the sorts a search takes.
var Sorts = []string{store.SortActiveOld, store.SortActiveNew, store.SortMade, store.SortMachines}

// ErrSort is a sort not of Sorts.
var ErrSort = errors.New("sort is one of active-old, active-new, made or machines")

func ms(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

// likePattern is a LIKE pattern matching any text holding s, its own %, _
// and \ taken as themselves.
func likePattern(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + r.Replace(s) + "%"
}

// Search finds accounts by the text given, a page of them, sorted.
func (a *Accounts) Search(ctx context.Context, text, sort string, page int) (Result, error) {
	if sort == "" {
		sort = store.SortActiveNew
	}
	known := false
	for _, s := range Sorts {
		known = known || s == sort
	}
	if !known {
		return Result{}, ErrSort
	}
	page = max(0, page)
	res := Result{Sort: sort, Page: page, Accounts: []Row{}}
	text = strings.TrimSpace(text)
	sr := store.Search{Sort: sort, Limit: PageSize, Offset: page * PageSize}
	var one *store.AccountID // the account found by its ID or a token
	if kind, hash, ok := oauth.ParseToken(text); ok {
		res.Found = FoundToken
		t, err := a.cfg.Store.TokenGrant(ctx, hash)
		if errors.Is(err, store.ErrNotFound) {
			res.Note = "Nothing is known of this token: its rows are gone (an access token's a day after it expires, " +
				"a grant's 30 days after it ends), or it was never the game's."
			return res, nil
		}
		if err != nil {
			return Result{}, err
		}
		res.Note = a.tokenNote(kind, &t)
		one = &t.Account
	} else if hash, ok := auth.HashToken(text); ok {
		res.Found = FoundSession
		id, err := a.cfg.Store.SessionOf(ctx, hash)
		if errors.Is(err, store.ErrNotFound) {
			res.Note = "No session has this token: it was ended, deleted after 400 days unused, or was never the game's."
			return res, nil
		}
		if err != nil {
			return Result{}, err
		}
		res.Note = "A session's token, of the account below."
		one = &id
	} else if id, ok := store.ParseID(text); ok {
		res.Found = FoundID
		one = &id
	} else if text == "" {
		res.Found = FoundAll
		sr.Every = true
	} else {
		res.Found = FoundName
		sr.Key = moderation.Key(text)
		if sr.Key == "" {
			return res, nil
		}
		sr.Part, sr.Pattern = true, likePattern(sr.Key)
	}
	if one != nil {
		c, err := a.cfg.Store.Card(ctx, *one)
		if errors.Is(err, store.ErrNotFound) {
			if res.Note == "" {
				res.Note = "No account has this ID."
			}
			return res, nil
		}
		if err != nil {
			return Result{}, err
		}
		human := c.ID
		if c.Kind == store.AI {
			human = c.Owner
		}
		hc, err := a.cfg.Store.Card(ctx, human)
		if err != nil {
			return Result{}, storeErr(err)
		}
		found := []store.Found{{ID: hc.ID, Name: hc.Name, Created: hc.Created, LastSeen: hc.LastSeen, Tools: hc.Tools,
			Priority: hc.Priority, Stopped: !hc.Stopped.IsZero()}}
		rows, err := a.rows(ctx, found, func(id store.AccountID, _ string) bool { return id == c.ID })
		if err != nil {
			return Result{}, err
		}
		res.Accounts, res.Total, res.Pages = rows, 1, 1
		return res, nil
	}
	found, total, err := a.cfg.Store.SearchAccounts(ctx, sr)
	if err != nil {
		return Result{}, err
	}
	matched := func(store.AccountID, string) bool { return false }
	if !sr.Every {
		matched = func(_ store.AccountID, key string) bool { return strings.Contains(key, sr.Key) }
	}
	rows, err := a.rows(ctx, found, matched)
	if err != nil {
		return Result{}, err
	}
	res.Accounts, res.Total = rows, total
	res.Pages = int((total + PageSize - 1) / PageSize)
	return res, nil
}

// tokenNote says what a token found is, and whether it still works.
func (a *Accounts) tokenNote(kind string, t *store.TokenGrant) string {
	what := map[string]string{oauth.KindAccess: "An access token", oauth.KindRefresh: "A refresh token",
		oauth.KindConnection: "A connection token"}[kind]
	if t.GrantKind == store.GrantApp && t.ClientName != "" {
		what += " of " + t.ClientName
	}
	now := a.cfg.Now()
	day := func(at time.Time) string { return at.UTC().Format("2 January 2006") }
	ends := t.Approved.Add(a.cfg.Lifetime())
	switch {
	case !t.Revoked.IsZero():
		by := map[string]string{store.RevokedOwner: "by its player", store.RevokedReplaced: "replaced by a newer one",
			store.RevokedReuse: "for a token used twice", store.RevokedApp: "by the app", store.RevokedOperator: "by the game's operator"}[t.RevokedWhy]
		return what + ", for the machine sailor below: its grant was revoked " + by + " on " + day(t.Revoked) + "."
	case !now.Before(ends):
		return what + ", for the machine sailor below: its grant ended on " + day(ends) + "."
	case !t.Expires.IsZero() && !now.Before(t.Expires):
		return what + ", for the machine sailor below: it has expired; its grant lives until " + day(ends) + "."
	case t.Stopped:
		return what + ", for the machine sailor below, which is stopped."
	}
	return what + ", for the machine sailor below: it works until " + day(ends) + "."
}

// rows are the humans found with their machine sailors, as the results
// list them; matched says which accounts the search hit, by their keys.
func (a *Accounts) rows(ctx context.Context, found []store.Found, matched func(store.AccountID, string) bool) ([]Row, error) {
	owners := make([]store.AccountID, len(found))
	for i, f := range found {
		owners[i] = f.ID
	}
	machs, err := a.cfg.Store.MachinesOfOwners(ctx, owners)
	if err != nil {
		return nil, err
	}
	now := a.cfg.Now()
	w := a.world()
	where := func(id store.AccountID) (atSea, queued bool) {
		if w == nil {
			return false, false
		}
		s, ok := w.Sea(id)
		return ok && !s.Queued, ok && s.Queued
	}
	byOwner := map[store.AccountID][]MachineRow{}
	for _, m := range machs {
		atSea, queued := where(m.ID)
		r := MachineRow{
			ID: m.ID.String(), Name: m.Name, Made: ms(m.Created), LastActive: LastActive(m.LastSeen, m.Created, true, now),
			LastActiveAt: ms(m.LastSeen), AtSea: atSea, Queued: queued, Priority: m.Priority, Stopped: m.Stopped,
			Matched: matched(m.ID, m.NameKey),
		}
		if !m.LastSeen.After(m.Created) {
			r.LastActiveAt = 0
		}
		if atSea {
			r.LastActive = AtSeaNow
		}
		byOwner[m.Owner] = append(byOwner[m.Owner], r)
	}
	out := make([]Row, len(found))
	for i, f := range found {
		atSea, queued := where(f.ID)
		r := Row{
			ID: f.ID.String(), Name: f.Name, Made: ms(f.Created), LastActive: LastActive(f.LastSeen, f.Created, false, now),
			LastActiveAt: ms(f.LastSeen), AtSea: atSea, Queued: queued, Tools: f.Tools, Priority: f.Priority, Stopped: f.Stopped,
			Matched: matched(f.ID, moderation.Key(f.Name)), Machines: byOwner[f.ID],
		}
		if atSea {
			r.LastActive = AtSeaNow
		}
		if r.Machines == nil {
			r.Machines = []MachineRow{}
		}
		for j := range r.Machines {
			r.Machines[j].Stopped = r.Machines[j].Stopped || f.Stopped
		}
		out[i] = r
	}
	return out, nil
}
