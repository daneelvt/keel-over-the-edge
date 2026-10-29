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
	Spectators(id store.AccountID) string
	SetSpectators(ctx context.Context, id store.AccountID, allow string) error
	Watchers(id store.AccountID) int
	AtSea(id store.AccountID) bool
}

var _ Watching = (*watch.Service)(nil)

// The longest part of a name the list is asked for, and the longest name.
const (
	maxQuery = 80
	maxName  = 80
)

// watchList answers GET /api/watch?q=&page=&sort=&who=, behind
// auth.Required: a page of the sailors the player may watch now, in the
// order and by the filter asked for; or GET /api/watch?names=a,b,… the
// rows of those sailors that may be watched now, in no order. Only a
// human watches.
//
//	200 {"sailors": [{"name", "machine", "mine", "kind", "watchers", "sky",
//	     "night", "force", "knots", "state", "followed", "edgeNM", "lively",
//	     "gone"}], "more", "atSea", "withheld"}
//	403 {"error":"ai-account"}
func (a *api) watchList(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	if acc.Kind != store.Human {
		writeError(w, http.StatusForbidden, "ai-account")
		return
	}
	v := r.URL.Query()
	page, _ := strconv.Atoi(v.Get("page"))
	q := watch.Query{Q: clip(v.Get("q"), maxQuery), Page: page, Sort: v.Get("sort"), Who: v.Get("who")}
	if v.Has("names") {
		q.Names = []string{}
		for _, n := range strings.Split(v.Get("names"), ",") {
			if n = strings.TrimSpace(n); n != "" && len(q.Names) < watch.MaxNames {
				q.Names = append(q.Names, clip(n, maxName))
			}
		}
	}
	p, err := a.cfg.Watch.List(r.Context(), acc.ID, q)
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

// followBody is POST /api/watch/follow's body: the sailor, and whether to
// follow it or stop.
type followBody struct {
	Name string `json:"name"`
	On   bool   `json:"on"`
}

// watchFollow answers POST /api/watch/follow, behind auth.Required: the
// player follows a sailor they may watch now, or stops following one.
// The sailor is never told.
//
//	200 {"following": n}
//	404 {"error":"not-at-sea"} | {"error":"cannot"}
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
	n, err := a.cfg.Watch.Follow(r.Context(), acc.ID, clip(body.Name, maxName), body.On)
	if errors.Is(err, watch.ErrTooMany) {
		writeError(w, http.StatusConflict, "too-many")
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
