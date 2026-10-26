// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/watch"
)

// Watching is a world's watching: the list of sailors a player may watch,
// and the setting that lets others watch a human: internal/watch.
type Watching interface {
	List(ctx context.Context, viewer store.AccountID, q string, page int) (watch.Page, error)
	Spectators(id store.AccountID) string
	SetSpectators(ctx context.Context, id store.AccountID, allow string) error
	Watchers(id store.AccountID) int
	AtSea(id store.AccountID) bool
}

var _ Watching = (*watch.Service)(nil)

// watchList answers GET /api/watch?q=&page=, behind auth.Required: a page
// of the sailors the player may watch now. Only a human watches.
//
//	200 {"sailors": [{"name", "machine", "mine", "kind", "watchers"}], "more"}
//	403 {"error":"ai-account"}
func (a *api) watchList(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	if acc.Kind != store.Human {
		writeError(w, http.StatusForbidden, "ai-account")
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	q := r.URL.Query().Get("q")
	if len(q) > 80 {
		q = q[:80]
	}
	p, err := a.cfg.Watch.List(r.Context(), acc.ID, q, page)
	if err != nil {
		a.unavailable(w, r, "listing sailors to watch", err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// spectatorsBody is POST /api/me/spectators's body: whether anyone may
// watch the sailor, "no", for this "voyage", or "always".
type spectatorsBody struct {
	Allow string `json:"allow"`
}

// setSpectators answers POST /api/me/spectators, behind auth.Required:
// the human's choice of who may watch them. Turned off, every watch of
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
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusUnauthorized, "session")
		return
	case err != nil:
		a.unavailable(w, r, "setting spectators", err)
		return
	}
	a.me(w, r)
}
