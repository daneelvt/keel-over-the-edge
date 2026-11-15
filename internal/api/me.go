// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"time"

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

// TakingOut takes an account's boat out of the water at once, with no grace,
// reporting whether it had one, once the world no longer holds it: the
// game connection (edge.Edge). A connection sailing it on another screen
// goes to its own start screen, told why; those aboard go ashore at the
// nearest port.
type TakingOut interface {
	TakeOut(ctx context.Context, id store.AccountID) (bool, error)
}

// TakeOutWait is how long POST /api/me/ashore waits for the boat to leave
// the water.
const TakeOutWait = 5 * time.Second

// takenOut is POST /api/me/ashore's answer: whether a boat was in the
// water and is out of it now.
type takenOut struct {
	Out bool `json:"out"`
}

// takeOut answers POST /api/me/ashore, behind auth.Required: the human's
// boat taken out of the water from the start screen, before a change of
// boat or look, a watch, or a new start; answered once it is out, so that
// GET /api/me then says it is not at sea. With no boat in the water,
// nothing is done. A browser's request from another origin never reaches
// it (Handler's cross-origin protection).
//
//	200 {"out": true|false}
//	403 {"error":"ai-account"}
//	503 {"error":"unavailable"}   the boat did not leave in time
func (a *api) takeOut(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	if acc.Kind != store.Human {
		writeError(w, http.StatusForbidden, "ai-account")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), TakeOutWait)
	defer cancel()
	out, err := a.cfg.Ashore.TakeOut(ctx, acc.ID)
	if err != nil {
		a.unavailable(w, r, "taking a boat out of the water", err)
		return
	}
	writeJSON(w, http.StatusOK, takenOut{Out: out})
}
