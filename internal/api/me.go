// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// me is the player's own account, what the page asks first: whether to go
// to sea, to the start screen (with its machine sailors, when it has
// any), or, after the recovery code, to adding a passkey; and the kinds of notice its sailor has switched off, which
// follow the account from device to device.
type me struct {
	Name string `json:"name"`
	lookShown
	Kind       string   `json:"kind"`
	NoticesOff []string `json:"noticesOff"`
	// AddPasskey is a session held to adding a passkey.
	AddPasskey bool `json:"addPasskey,omitempty"`
	// Machines is how many machine sailors the account has: a player with
	// any is shown them on the start screen before going to sea.
	Machines int `json:"machines,omitempty"`
	// Spectators is whether others may watch the sailor this voyage, or
	// the next boat's while none is in the water: "no" or "voyage"; AtSea whether the account's own boat is in
	// the water, which watching would take out.
	Spectators string `json:"spectators,omitempty"`
	AtSea      bool   `json:"atSea,omitempty"`
	// WatchCode and FleetCode are the codes of the human's own links to
	// watch: their boat's, and their fleet's of machine sailors. Shown to
	// the account alone, to share.
	WatchCode string `json:"watchCode,omitempty"`
	FleetCode string `json:"fleetCode,omitempty"`
	// Born is whether the player has said when they were born, and Rules
	// whether they have accepted the Rules of the sea: until both, they
	// sail alone. When is never told.
	Born  bool `json:"born"`
	Rules bool `json:"rules"`
}

// me answers GET /api/me, behind auth.Signed: a session held to adding a
// passkey is answered too, so the page knows to ask for one.
func (a *api) me(w http.ResponseWriter, r *http.Request) {
	cur, _ := auth.SessionFromContext(r.Context())
	m := a.meOf(cur.Account)
	m.AddPasskey = cur.Held
	if a.cfg.Machines != nil && cur.Kind == store.Human && !cur.Held {
		list, err := a.cfg.Machines.Machines(r.Context(), cur.ID)
		if err != nil {
			a.unavailable(w, r, "listing machine sailors", err)
			return
		}
		m.Machines = len(list)
	}
	if a.cfg.Watch != nil && cur.Kind == store.Human {
		m.Spectators = a.cfg.Watch.Spectators(cur.ID)
		m.AtSea = a.cfg.Watch.AtSea(cur.ID)
		if !cur.Held {
			codes, err := a.cfg.Watch.Codes(r.Context(), cur.ID)
			if err != nil {
				a.unavailable(w, r, "reading the links to watch", err)
				return
			}
			m.WatchCode, m.FleetCode = codes.Sailor, codes.Fleet
		}
	}
	writeJSON(w, http.StatusOK, m)
}

func (a *api) meOf(acc store.Account) me {
	off := acc.NoticesOff
	if off == nil {
		off = []string{}
	}
	return me{Name: acc.Name, lookShown: a.shown(acc.ID, acc.Look), Kind: string(acc.Kind), NoticesOff: off, Born: acc.Born != 0, Rules: acc.Rules}
}

// Notices sets an account's notices switched off: the store.
type Notices interface {
	SetNoticesOff(ctx context.Context, id store.AccountID, off []string) error
}

// noticesBody is POST /api/me/notices's body: the kinds switched off.
type noticesBody struct {
	Off []string `json:"off"`
}

// setNotices answers POST /api/me/notices, behind auth.Required: the kinds
// of notice the sailor has switched off, each one the catalog lets be,
// kept on the account. A browser's request from another origin never
// reaches it (Handler's cross-origin protection).
func (a *api) setNotices(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	var body noticesBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "body")
		return
	}
	off := []string{}
	for _, k := range body.Off {
		if !slices.Contains(a.cfg.NoticeKinds, k) {
			writeError(w, http.StatusBadRequest, "notice")
			return
		}
		if !slices.Contains(off, k) {
			off = append(off, k)
		}
	}
	slices.Sort(off)
	if err := a.cfg.Notices.SetNoticesOff(r.Context(), acc.ID, off); err != nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable")
		return
	}
	a.cfg.Sessions.ForgetAccount(acc.ID)
	acc.NoticesOff = off
	writeJSON(w, http.StatusOK, a.meOf(acc))
}
