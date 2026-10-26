// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"context"
	"errors"
	"net/http"

	"github.com/daneelvt/keel-over-the-edge/internal/accounts"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The Accounts tab: every account found by its sailor's name or part of
// it, its ID, or a token pasted; its card; and the owner's hand on it:
// stop, start again, revoke its tokens, delete. Each action is written in
// the record with its reason, logged and counted. A search's text may be
// a token: it comes in a POST's body, never a URL, and is never logged.
// keel admin calls these same routes, saying so in SourceHeader.

// SourceHeader names the command as a request's source; without it, the
// page is.
const SourceHeader = "Keel-Source"

// sourceOf is where a request came from: the command, or the page.
func sourceOf(r *http.Request) string {
	if r.Header.Get(SourceHeader) == store.SourceCommand {
		return store.SourceCommand
	}
	return store.SourcePage
}

// SearchRequest is a search: text as typed or pasted, a sort, a page.
type SearchRequest struct {
	Text string `json:"text"`
	Sort string `json:"sort,omitempty"`
	Page int    `json:"page,omitempty"`
}

// ActionRequest is an action on an account: stop, start, revoke or
// delete; Name is the sailor's name typed again, to delete. With Check,
// the answer says what it would do, and nothing is done.
type ActionRequest struct {
	Account string `json:"account"`
	Reason  string `json:"reason,omitempty"`
	Name    string `json:"name,omitempty"`
	Check   bool   `json:"check,omitempty"`
}

// searchAccounts finds accounts.
//
//	POST /owner/api/accounts/search {"text": "ann", "sort": "active-new", "page": 0}
func (o *Owner) searchAccounts(w http.ResponseWriter, r *http.Request) {
	var req SearchRequest
	if !readBody(w, r, &req) {
		return
	}
	if o.cfg.Hand == nil {
		o.refuse(w, "search", http.StatusServiceUnavailable, "the accounts are not reached from here")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), dbTimeout)
	defer cancel()
	res, err := o.cfg.Hand.Search(ctx, req.Text, req.Sort, req.Page)
	if errors.Is(err, accounts.ErrSort) {
		o.refuse(w, "search", http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	o.count("search")
	writeJSON(w, res)
}

// accountCard serves an account's card.
//
//	GET /owner/api/account.json?id=…
func (o *Owner) accountCard(w http.ResponseWriter, r *http.Request) {
	id, ok := parseAccount(r.URL.Query().Get("id"))
	if !ok {
		o.refuse(w, "card", http.StatusBadRequest, "id is not an account's id")
		return
	}
	if o.cfg.Hand == nil {
		o.refuse(w, "card", http.StatusServiceUnavailable, "the accounts are not reached from here")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), dbTimeout)
	defer cancel()
	c, err := o.cfg.Hand.Card(ctx, id)
	if errors.Is(err, accounts.ErrNotFound) {
		o.refuse(w, "card", http.StatusNotFound, err.Error())
		return
	}
	if err != nil {
		http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	o.count("card")
	writeJSON(w, c)
}

// actions serves the record: the latest actions, or an account's.
//
//	GET /owner/api/actions.json[?account=…]
func (o *Owner) actions(w http.ResponseWriter, r *http.Request) {
	var account *store.AccountID
	if s := r.URL.Query().Get("account"); s != "" {
		id, ok := parseAccount(s)
		if !ok {
			http.Error(w, "account is not an account's id", http.StatusBadRequest)
			return
		}
		account = &id
	}
	if o.cfg.Hand == nil {
		http.Error(w, "the accounts are not reached from here", http.StatusServiceUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), dbTimeout)
	defer cancel()
	acts, err := o.cfg.Hand.Actions(ctx, account)
	if err != nil {
		http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, map[string]any{"actions": acts})
}

// act is one of the actions on an account: stop, start, revoke, delete.
//
//	POST /owner/api/accounts/stop   {"account": "…", "reason": "…", "check": true}
//	POST /owner/api/accounts/start  {"account": "…", "reason": "…"}
//	POST /owner/api/accounts/revoke {"account": "…", "reason": "…", "check": true}
//	POST /owner/api/accounts/delete {"account": "…", "name": "…", "reason": "…", "check": true}
func (o *Owner) act(action string, do func(*accounts.Accounts, context.Context, accounts.Request) (accounts.Done, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req ActionRequest
		if !readBody(w, r, &req) {
			return
		}
		id, ok := parseAccount(req.Account)
		if !ok {
			o.refuse(w, action, http.StatusBadRequest, "account is not an account's id")
			return
		}
		if o.cfg.Hand == nil {
			o.refuse(w, action, http.StatusServiceUnavailable, "the accounts are not reached from here")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), dbTimeout)
		defer cancel()
		done, err := do(o.cfg.Hand, ctx, accounts.Request{
			Account: id, Reason: req.Reason, Name: req.Name, Check: req.Check, Source: sourceOf(r), From: r.RemoteAddr,
		})
		switch {
		case errors.Is(err, accounts.ErrNotFound):
			o.refuse(w, action, http.StatusNotFound, err.Error())
			return
		case errors.Is(err, accounts.ErrReason):
			o.refuse(w, action, http.StatusBadRequest, err.Error())
			return
		case errors.Is(err, accounts.ErrName):
			o.refuse(w, action, http.StatusUnprocessableEntity, err.Error())
			return
		case errors.Is(err, accounts.ErrFlagged), errors.Is(err, accounts.ErrAlreadyStopped), errors.Is(err, accounts.ErrNotStopped):
			o.refuse(w, action, http.StatusConflict, err.Error())
			return
		case err != nil:
			http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
			return
		}
		if !req.Check {
			o.count(action)
			o.b.forget(id)
		}
		writeJSON(w, done)
	}
}

// record writes one of the owner's other controls in the record of
// actions.
func (o *Owner) record(r *http.Request, action string, id *store.AccountID, detail string) {
	if o.cfg.Hand == nil {
		return
	}
	a := store.Action{Action: action, Detail: detail, Source: sourceOf(r), From: r.RemoteAddr}
	if id != nil {
		a.Account, a.HasAccount = *id, true
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), dbTimeout)
	defer cancel()
	o.cfg.Hand.Record(ctx, a)
}

// stoppedJSON is accounts.json's accounts stopped, by kind.
type stoppedJSON struct {
	Human int `json:"human"`
	AI    int `json:"ai"`
}
