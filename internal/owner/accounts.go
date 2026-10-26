// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// accountsJSON is accounts.json: the players' accounts, how many there
// are, how many were made in the last seven days and how many were seen in
// the last day; and, with sign-in for AI apps, the machine sailors, the
// grants live and their lifetime.
type accountsJSON struct {
	Total    int64         `json:"total"`
	Week     int64         `json:"week"`
	Today    int64         `json:"today"`
	Machines *machinesJSON `json:"machines,omitempty"`
	// Stopped are the accounts stopped, by kind.
	Stopped *stoppedJSON `json:"stopped,omitempty"`
}

// machinesJSON is accounts.json's machine sailors: how many, how many made
// in the last seven days, the grants live by kind, and the grant lifetime,
// s.
type machinesJSON struct {
	Total    int64            `json:"total"`
	Week     int64            `json:"week"`
	Grants   map[string]int64 `json:"grants"`
	Lifetime int64            `json:"lifetime"`
}

// AISailors is the owner's hand on machine sailors and the grants of AI
// apps: the store.
type AISailors interface {
	MachineCounts(ctx context.Context, lifetime time.Duration) (store.MachineCounts, error)
	GrantsEndedBy(ctx context.Context, now, d time.Duration) (int64, error)
	SetGrantLifetime(ctx context.Context, d time.Duration) error
	SetMachineCap(ctx context.Context, id store.AccountID, limit int) error
}

// Lifetime is the grant lifetime kept in memory, which every check of a
// grant reads.
type Lifetime interface {
	Get() time.Duration
	Set(d time.Duration)
}

// accounts serves accounts.json, counted now, never cached.
func (o *Owner) accounts(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), dbTimeout)
	defer cancel()
	n, err := o.cfg.Accounts.AccountCounts(ctx)
	if err != nil {
		http.Error(w, "the database could not be asked", http.StatusServiceUnavailable)
		return
	}
	out := accountsJSON{Total: n.Total, Week: n.Week, Today: n.Today}
	if h := o.cfg.Hand; h != nil {
		out.Stopped = &stoppedJSON{Human: h.Stopped().Count(store.Human), AI: h.Stopped().Count(store.AI)}
	}
	if o.cfg.Machines != nil && o.cfg.Lifetime != nil {
		life := o.cfg.Lifetime.Get()
		m, err := o.cfg.Machines.MachineCounts(ctx, life)
		if err != nil {
			http.Error(w, "the database could not be asked", http.StatusServiceUnavailable)
			return
		}
		out.Machines = &machinesJSON{Total: m.Total, Week: m.Week, Grants: m.Grants, Lifetime: int64(life / time.Second)}
	}
	body, _ := json.Marshal(out)
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", "no-store")
	_, _ = w.Write(body)
}

// The grant lifetime's bounds.
const (
	MinLifetime = time.Minute
	MaxLifetime = 400 * 24 * time.Hour
)

// LifetimeRequest sets the grant lifetime, in seconds; with Check, it only
// counts the grants it would end at once.
type LifetimeRequest struct {
	Seconds int64 `json:"seconds"`
	Check   bool  `json:"check,omitempty"`
}

// lifetime sets the grant lifetime: the database first, then the memory
// every check reads, so a shorter one ends older grants at once and the
// apps' next calls are refused. It answers how many unrevoked grants it
// ends (or, checked, would end).
//
//	POST /owner/api/lifetime {"seconds": 60, "check": true}
func (o *Owner) lifetime(w http.ResponseWriter, r *http.Request) {
	var req LifetimeRequest
	if !readBody(w, r, &req) {
		return
	}
	if o.cfg.Machines == nil || o.cfg.Lifetime == nil {
		o.refuse(w, "lifetime", http.StatusServiceUnavailable, "sign-in for AI apps is not running")
		return
	}
	d := time.Duration(req.Seconds) * time.Second
	if d < MinLifetime || d > MaxLifetime {
		o.refuse(w, "lifetime", http.StatusBadRequest, "the lifetime is from a minute to 400 days")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), dbTimeout)
	defer cancel()
	ended, err := o.cfg.Machines.GrantsEndedBy(ctx, o.cfg.Lifetime.Get(), d)
	if err != nil {
		http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	if req.Check {
		writeJSON(w, map[string]any{"seconds": req.Seconds, "ends": ended, "set": false})
		return
	}
	if err := o.cfg.Machines.SetGrantLifetime(ctx, d); err != nil {
		http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	was := o.cfg.Lifetime.Get()
	o.cfg.Lifetime.Set(d)
	if o.cfg.LifetimeChanged != nil {
		o.cfg.LifetimeChanged()
	}
	o.count("lifetime")
	o.record(r, store.ActionLifetime, nil, d.String())
	o.cfg.Log.Info("owner: the grant lifetime set", "action", "lifetime", "was", was.String(), "now", d.String(), "ended", ended, "from", r.RemoteAddr)
	writeJSON(w, map[string]any{"seconds": req.Seconds, "ends": ended, "set": true})
}

// MachinesRequest sets how many machine sailors a human account may have.
type MachinesRequest struct {
	Account string `json:"account"`
	Cap     int    `json:"cap"`
}

// machineCap sets how many machine sailors a human account may have, from
// 0 to store.MaxMachineCap; those it has already stay.
//
//	POST /owner/api/machines {"account": "…", "cap": 3}
func (o *Owner) machineCap(w http.ResponseWriter, r *http.Request) {
	var req MachinesRequest
	if !readBody(w, r, &req) {
		return
	}
	if o.cfg.Machines == nil {
		o.refuse(w, "cap", http.StatusServiceUnavailable, "sign-in for AI apps is not running")
		return
	}
	id, ok := parseAccount(req.Account)
	if !ok {
		o.refuse(w, "cap", http.StatusBadRequest, "account is not an account's id")
		return
	}
	if req.Cap < 0 || req.Cap > store.MaxMachineCap {
		o.refuse(w, "cap", http.StatusBadRequest, "the cap is from 0 to 50")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), dbTimeout)
	defer cancel()
	err := o.cfg.Machines.SetMachineCap(ctx, id, req.Cap)
	switch {
	case errors.Is(err, store.ErrNotFound):
		o.refuse(w, "cap", http.StatusNotFound, "no human account of that id: only a human account makes machine sailors")
		return
	case err != nil:
		http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	o.count("cap")
	o.record(r, store.ActionCap, &id, strconv.Itoa(req.Cap))
	o.cfg.Log.Info("owner: an account's machine sailors allowed", "action", "cap", "account", id.String(), "cap", req.Cap, "from", r.RemoteAddr)
	writeJSON(w, map[string]any{"account": id.String(), "cap": req.Cap})
}
