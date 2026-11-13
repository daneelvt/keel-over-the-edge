// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/logbook"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Logs are the sailors' logs: internal/logbook. Every log is read behind a
// session, by a sailor of the game; a log that is not there and one the
// reader may not read are refused alike.
type Logs interface {
	Own(ctx context.Context, reader store.AccountID, world int) (logbook.Log, error)
	ByName(ctx context.Context, reader store.AccountID, name string, world int) (logbook.Log, error)
	Machine(ctx context.Context, owner, machine store.AccountID, world int) (logbook.Log, error)
	SetShown(ctx context.Context, id store.AccountID, shown string) error
}

var _ Logs = (*logbook.Service)(nil)

// registerLogs adds the logs' routes, each behind a session.
func (a *api) registerLogs(mux *http.ServeMux, required func(http.HandlerFunc) http.Handler) {
	if a.cfg.Logs == nil {
		return
	}
	mux.Handle("GET /api/me/log", required(a.ownLog))
	mux.Handle("PUT /api/me/log", required(a.setLogShown))
	mux.Handle("GET /api/log", required(a.sailorLog))
	mux.Handle("GET /api/machines/log", required(a.machineLog))
}

// writeLog answers with a log, kept by no cache but the reader's own
// browser's, and not even there.
func writeLog(w http.ResponseWriter, l logbook.Log) {
	body, err := json.Marshal(l)
	if err != nil {
		panic(err) // a log always marshals
	}
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", "private, no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(append(body, '\n'))
}

// refuseLog answers a log not there, or not the reader's to read: the same
// 404 for both.
func refuseLog(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "private, no-store")
	writeError(w, http.StatusNotFound, "not-found")
}

// worldOf is the ?world= asked for: a world's number, 0 for the newest.
func worldOf(r *http.Request) (int, bool) {
	s := r.URL.Query().Get("world")
	if s == "" {
		return 0, true
	}
	n, err := strconv.Atoi(s)
	return n, err == nil && n > 0 && n < 1<<30
}

// human is the account of a session, if a human's; an AI app's agent
// reads its log through its tools.
func human(w http.ResponseWriter, r *http.Request) (store.Account, bool) {
	acc, _ := auth.FromContext(r.Context())
	if acc.Kind != store.Human {
		writeError(w, http.StatusForbidden, "ai-account")
		return acc, false
	}
	return acc, true
}

// answerLog answers what reading a log came to.
func (a *api) answerLog(w http.ResponseWriter, r *http.Request, l logbook.Log, err error) {
	switch {
	case errors.Is(err, logbook.ErrNotFound):
		refuseLog(w)
	case err != nil:
		a.unavailable(w, r, "reading a log", err)
	default:
		writeLog(w, l)
	}
}

// ownLog answers GET /api/me/log?world=, behind auth.Required: the
// player's own sailor's log, with its days of the world asked for, the
// newest by default.
//
//	200 the log (logbook.Log)
//	400 {"error":"world"}
//	404 {"error":"not-found"}   no sailor
//	403 {"error":"ai-account"}
func (a *api) ownLog(w http.ResponseWriter, r *http.Request) {
	acc, ok := human(w, r)
	if !ok {
		return
	}
	world, ok := worldOf(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "world")
		return
	}
	l, err := a.cfg.Logs.Own(r.Context(), acc.ID, world)
	a.answerLog(w, r, l, err)
}

// sailorLog answers GET /api/log?name=&world=, behind auth.Required: the
// log of the sailor of the name, as the player may read it. No such
// sailor, and one whose log the player may not read, are refused alike.
//
//	200 the log (logbook.Log)
//	400 {"error":"world"}
//	404 {"error":"not-found"}
//	403 {"error":"ai-account"}
func (a *api) sailorLog(w http.ResponseWriter, r *http.Request) {
	acc, ok := human(w, r)
	if !ok {
		return
	}
	world, ok := worldOf(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "world")
		return
	}
	name := clip(r.URL.Query().Get("name"), maxName)
	if name == "" {
		refuseLog(w)
		return
	}
	l, err := a.cfg.Logs.ByName(r.Context(), acc.ID, name, world)
	a.answerLog(w, r, l, err)
}

// machineLog answers GET /api/machines/log?id=&world=, behind
// auth.Required: the log of one of the player's machine sailors, by its
// ID, as the machine sailors' panel lists them.
//
//	200 the log (logbook.Log)
//	400 {"error":"world"}
//	404 {"error":"not-found"}   not the player's machine sailor
//	403 {"error":"ai-account"}
func (a *api) machineLog(w http.ResponseWriter, r *http.Request) {
	acc, ok := human(w, r)
	if !ok {
		return
	}
	world, ok := worldOf(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "world")
		return
	}
	id, ok := store.ParseID(r.URL.Query().Get("id"))
	if !ok {
		refuseLog(w)
		return
	}
	l, err := a.cfg.Logs.Machine(r.Context(), acc.ID, id, world)
	a.answerLog(w, r, l, err)
}

// logShown is PUT /api/me/log's body and answer: who may read the log,
// sailors or me.
type logShown struct {
	Shown string `json:"shown"`
}

// setLogShown answers PUT /api/me/log, behind auth.Required: who may read
// the player's own log, every sailor in the game or the player alone.
//
//	200 {"shown"}
//	400 {"error":"shown"}
//	404 {"error":"not-found"}
//	403 {"error":"ai-account"}
func (a *api) setLogShown(w http.ResponseWriter, r *http.Request) {
	acc, ok := human(w, r)
	if !ok {
		return
	}
	var req logShown
	if !readJSON(w, r, &req) {
		return
	}
	err := a.cfg.Logs.SetShown(r.Context(), acc.ID, req.Shown)
	switch {
	case errors.Is(err, logbook.ErrShown):
		writeError(w, http.StatusBadRequest, "shown")
	case errors.Is(err, logbook.ErrNotFound):
		refuseLog(w)
	case err != nil:
		a.unavailable(w, r, "setting who reads a log", err)
	default:
		writeJSON(w, http.StatusOK, req)
	}
}
