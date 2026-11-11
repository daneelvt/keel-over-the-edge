// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/watch"
)

// Watching is a world's watching: the list of sailors a player may
// watch, the card about one, following, and the choice that lets others
// watch a human for a voyage: internal/watch.
type Watching interface {
	List(ctx context.Context, viewer store.AccountID, q watch.Query) (watch.Page, error)
	Card(ctx context.Context, viewer store.AccountID, name string) (watch.SailorCard, error)
	Follow(ctx context.Context, viewer store.AccountID, name string, on bool) (int, error)
	Link(ctx context.Context, viewer store.AccountID, code string) (watch.Target, error)
	Fleet(ctx context.Context, viewer store.AccountID, code string) ([]watch.Item, error)
	FollowLink(ctx context.Context, viewer store.AccountID, code string, on bool) (int, error)
	Codes(ctx context.Context, id store.AccountID) (store.LinkCodes, error)
	NewCode(ctx context.Context, owner store.AccountID, which string, machine store.AccountID) (string, error)
	Spectators(id store.AccountID) string
	SetSpectators(ctx context.Context, id store.AccountID, allow string) error
	Watchers(id store.AccountID) int
	AtSea(id store.AccountID) bool
}

var _ Watching = (*watch.Service)(nil)

// The longest part of a name the list is asked for, the longest name,
// and the longest code of a link read.
const (
	maxQuery = 80
	maxName  = 80
	maxCode  = 32
)

// watchList answers GET /api/watch?q=&page=&sort=&who=&fleet=, behind
// auth.Required: a page of the sailors the player may watch now, in the
// order and by the filter asked for, and with fleet, the code of a
// fleet's link, only that fleet's; or GET /api/watch?names=a,b,… the
// rows of those sailors that may be watched now, in no order. Only a
// human watches.
//
//	200 {"sailors": [{"name", "machine", "mine", "kind", "watchers", "sky",
//	     "night", "force", "knots", "state", "followed", "edgeNM", "lively",
//	     "gone"}], "more", "atSea", "withheld"}
//	404 {"error":"no-link"}   a fleet's code no account has
//	403 {"error":"ai-account"}
func (a *api) watchList(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	if acc.Kind != store.Human {
		writeError(w, http.StatusForbidden, "ai-account")
		return
	}
	v := r.URL.Query()
	page, _ := strconv.Atoi(v.Get("page"))
	q := watch.Query{Q: clip(v.Get("q"), maxQuery), Page: page, Sort: v.Get("sort"), Who: v.Get("who"), Fleet: clip(v.Get("fleet"), maxCode)}
	if v.Has("names") {
		q.Names = []string{}
		for _, n := range strings.Split(v.Get("names"), ",") {
			if n = strings.TrimSpace(n); n != "" && len(q.Names) < watch.MaxNames {
				q.Names = append(q.Names, clip(n, maxName))
			}
		}
	}
	p, err := a.cfg.Watch.List(r.Context(), acc.ID, q)
	if errors.Is(err, watch.ErrNoLink) {
		writeError(w, http.StatusNotFound, "no-link")
		return
	}
	if err != nil {
		a.unavailable(w, r, "listing sailors to watch", err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// watchSailor answers GET /api/watch/sailor?name=, behind auth.Required:
// the card about a sailor the player may watch now. A sailor who may not
// be watched is refused as a watch is: not at sea for a machine sailor,
// cannot for anyone else, whatever the reason.
//
//	200 the row, with "weather", "where", "voyage" and "agent"
//	404 {"error":"not-at-sea"} | {"error":"cannot"}
//	403 {"error":"ai-account"}
func (a *api) watchSailor(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	if acc.Kind != store.Human {
		writeError(w, http.StatusForbidden, "ai-account")
		return
	}
	c, err := a.cfg.Watch.Card(r.Context(), acc.ID, clip(r.URL.Query().Get("name"), maxName))
	if a.refusedWatch(w, r, err, "reading a sailor's card") {
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// linkFound is GET /api/watch/link's answer for a sailor's link: the
// sailor to watch by name, or why it cannot be watched now.
type linkFound struct {
	Name    string `json:"name"`
	Machine bool   `json:"machine"`
	Error   string `json:"error,omitempty"`
}

// watchLink answers GET /api/watch/link?w=<code> or ?f=<code>, behind
// auth.Required: what a link to watch opens. A sailor's link answers the
// sailor to watch by name, or, refused, the sailor and why, a human
// alike whatever the reason; a fleet's answers its machine sailors the
// player may watch now, liveliest first, none if none, and never says
// whose they are. A code is answered only to a signed-in human, so that
// no one looks codes up without a sailor of their own.
//
//	200 {"name", "machine"} | {"sailors": [rows as GET /api/watch]}
//	404 {"error":"cannot"|"not-at-sea"|"own", "name", "machine"}
//	404 {"error":"no-link"}   no account has the code
//	400 {"error":"link"}      neither code
//	403 {"error":"ai-account"}
func (a *api) watchLink(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	if acc.Kind != store.Human {
		writeError(w, http.StatusForbidden, "ai-account")
		return
	}
	v := r.URL.Query()
	if code := clip(v.Get("f"), maxCode); code != "" {
		rows, err := a.cfg.Watch.Fleet(r.Context(), acc.ID, code)
		switch {
		case errors.Is(err, watch.ErrNoLink):
			writeError(w, http.StatusNotFound, "no-link")
		case err != nil:
			a.unavailable(w, r, "opening a fleet's link", err)
		default:
			if rows == nil {
				rows = []watch.Item{}
			}
			writeJSON(w, http.StatusOK, map[string][]watch.Item{"sailors": rows})
		}
		return
	}
	code := clip(v.Get("w"), maxCode)
	if code == "" {
		writeError(w, http.StatusBadRequest, "link")
		return
	}
	t, err := a.cfg.Watch.Link(r.Context(), acc.ID, code)
	found := linkFound{Name: t.Name, Machine: t.Machine()}
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, found)
		return
	case errors.Is(err, watch.ErrNoLink):
		writeError(w, http.StatusNotFound, "no-link")
		return
	case errors.Is(err, watch.ErrOwn):
		found.Error = "own"
	case errors.Is(err, watch.ErrNotAtSea):
		found.Error = "not-at-sea"
	case errors.Is(err, watch.ErrCannot):
		found.Error = "cannot"
	default:
		a.unavailable(w, r, "opening a sailor's link", err)
		return
	}
	writeJSON(w, http.StatusNotFound, found)
}

// followBody is POST /api/watch/follow's body: the sailor, by name or by
// its link's code, and whether to follow it or stop.
type followBody struct {
	Name string `json:"name"`
	Code string `json:"code"`
	On   bool   `json:"on"`
}

// watchFollow answers POST /api/watch/follow, behind auth.Required: the
// player follows a sailor they may watch now, or stops following one. By
// a link's code, the sailor is followed whatever their state, with the
// same answer. The sailor is never told.
//
//	200 {"following": n}
//	404 {"error":"not-at-sea"} | {"error":"cannot"}
//	404 {"error":"no-link"} | {"error":"own"}   by a code
//	409 {"error":"too-many"}
//	403 {"error":"ai-account"}
func (a *api) watchFollow(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	if acc.Kind != store.Human {
		writeError(w, http.StatusForbidden, "ai-account")
		return
	}
	var body followBody
	if !readJSON(w, r, &body) {
		return
	}
	var n int
	var err error
	if body.Code != "" {
		n, err = a.cfg.Watch.FollowLink(r.Context(), acc.ID, clip(body.Code, maxCode), body.On)
	} else {
		n, err = a.cfg.Watch.Follow(r.Context(), acc.ID, clip(body.Name, maxName), body.On)
	}
	switch {
	case errors.Is(err, watch.ErrTooMany):
		writeError(w, http.StatusConflict, "too-many")
		return
	case errors.Is(err, watch.ErrNoLink):
		writeError(w, http.StatusNotFound, "no-link")
		return
	case errors.Is(err, watch.ErrOwn):
		writeError(w, http.StatusNotFound, "own")
		return
	}
	if a.refusedWatch(w, r, err, "following a sailor") {
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"following": n})
}

// refusedWatch answers a sailor who may not be watched, or a failure,
// and reports whether it did.
func (a *api) refusedWatch(w http.ResponseWriter, r *http.Request, err error, doing string) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, watch.ErrNotAtSea):
		writeError(w, http.StatusNotFound, "not-at-sea")
	case errors.Is(err, watch.ErrCannot):
		writeError(w, http.StatusNotFound, "cannot")
	default:
		a.unavailable(w, r, doing, err)
	}
	return true
}

// clip is s cut to at most n bytes, on a rune's boundary.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// spectatorsBody is POST /api/me/spectators's body: whether anyone may
// watch the sailor this voyage, "no" or "voyage".
type spectatorsBody struct {
	Allow string `json:"allow"`
}

// setSpectators answers POST /api/me/spectators, behind auth.Required:
// the human's choice of whether anyone may watch them this voyage, or,
// with no boat in the water, the next boat's. Turned off, every watch of
// their boat ends at once.
//
//	200 the account, as GET /api/me
//	400 {"error":"allow"}       not one of the choices
//	403 {"error":"ai-account"}  a machine sailor is always watchable
func (a *api) setSpectators(w http.ResponseWriter, r *http.Request) {
	cur, _ := auth.SessionFromContext(r.Context())
	if cur.Kind != store.Human {
		writeError(w, http.StatusForbidden, "ai-account")
		return
	}
	var body spectatorsBody
	if !readJSON(w, r, &body) {
		return
	}
	err := a.cfg.Watch.SetSpectators(r.Context(), cur.ID, body.Allow)
	switch {
	case errors.Is(err, watch.ErrAllow):
		writeError(w, http.StatusBadRequest, "allow")
		return
	case err != nil:
		a.unavailable(w, r, "setting spectators", err)
		return
	}
	a.me(w, r)
}

// newLinkBody is POST /api/me/link/new's body: which link to make anew,
// "me", "fleet" or "machine", and for a machine sailor's, its account.
type newLinkBody struct {
	Which   string `json:"which"`
	Machine string `json:"machine"`
}

// newLink answers POST /api/me/link/new, behind auth.Required: one of the
// human's links to watch made anew, its own, its fleet's or one of its
// machine sailors'. The old link stops working.
//
//	200 {"code"}
//	400 {"error":"which"}       none of the links
//	404 {"error":"machine"}     not one of the account's machine sailors
//	403 {"error":"ai-account"}
func (a *api) newLink(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	if acc.Kind != store.Human {
		writeError(w, http.StatusForbidden, "ai-account")
		return
	}
	var body newLinkBody
	if !readJSON(w, r, &body) {
		return
	}
	var machine store.AccountID
	if body.Which == watch.LinkMachine {
		id, ok := store.ParseID(body.Machine)
		if !ok {
			writeError(w, http.StatusNotFound, "machine")
			return
		}
		machine = id
	}
	code, err := a.cfg.Watch.NewCode(r.Context(), acc.ID, body.Which, machine)
	switch {
	case errors.Is(err, watch.ErrWhich):
		writeError(w, http.StatusBadRequest, "which")
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "machine")
	case err != nil:
		a.unavailable(w, r, "making a link anew", err)
	default:
		writeJSON(w, http.StatusOK, map[string]string{"code": code})
	}
}
