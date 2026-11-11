// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/review"
	"github.com/daneelvt/keel-over-the-edge/internal/shipmates"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Shipmates, the account's side: its list (shipmates and where they are,
// offers waiting for its answer, recent crew), offering, accepting,
// declining, ending, blocking and reporting from it, and appearing
// offline. Messages and knocking without a link are the game
// connection's. Only a person has shipmates.

// Shipmating is shipmates as the routes reach them.
type Shipmating interface {
	List(ctx context.Context, me store.AccountID) (shipmates.List, error)
	Offer(ctx context.Context, me store.AccountID, t shipmates.Target) (string, error)
	Accept(ctx context.Context, me, from store.AccountID) error
	Decline(ctx context.Context, me, from store.AccountID) error
	End(ctx context.Context, me store.AccountID, t shipmates.Target) error
	Block(ctx context.Context, me, other store.AccountID) error
	Report(ctx context.Context, me, other store.AccountID, reason, note string) error
	SetOffline(ctx context.Context, me store.AccountID, on bool) error
}

func (a *api) registerShipmates(mux *http.ServeMux, required func(http.HandlerFunc) http.Handler) {
	if a.cfg.Shipmates == nil {
		return
	}
	mux.Handle("GET /api/shipmates", required(a.person(a.shipmatesList)))
	mux.Handle("POST /api/shipmates/offer", required(a.person(a.shipmateOffer)))
	mux.Handle("POST /api/shipmates/accept", required(a.person(a.shipmateAccept)))
	mux.Handle("POST /api/shipmates/decline", required(a.person(a.shipmateDecline)))
	mux.Handle("POST /api/shipmates/end", required(a.person(a.shipmateEnd)))
	mux.Handle("POST /api/shipmates/block", required(a.person(a.shipmateBlock)))
	mux.Handle("POST /api/shipmates/report", required(a.person(a.shipmateReport)))
	mux.Handle("POST /api/me/offline", required(a.person(a.setOffline)))
}

// person refuses an account that is not a person's, which has no
// shipmates.
func (a *api) person(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if acc, _ := auth.FromContext(r.Context()); acc.Kind != store.Human {
			writeError(w, http.StatusForbidden, "human")
			return
		}
		h(w, r)
	}
}

// shipmateError answers an error of shipmates'.
func (a *api) shipmateError(w http.ResponseWriter, r *http.Request, what string, err error) {
	switch {
	case errors.Is(err, shipmates.ErrNoOne), errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "no-one")
	case errors.Is(err, shipmates.ErrGone):
		writeError(w, http.StatusConflict, "gone")
	case errors.Is(err, shipmates.ErrFull):
		writeError(w, http.StatusConflict, "full")
	case errors.Is(err, review.ErrReason):
		writeError(w, http.StatusBadRequest, "reason")
	case errors.Is(err, review.ErrNote):
		writeError(w, http.StatusBadRequest, "note")
	default:
		a.unavailable(w, r, what, err)
	}
}

// shipmatesList answers GET /api/shipmates.
func (a *api) shipmatesList(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	list, err := a.cfg.Shipmates.List(r.Context(), acc.ID)
	if err != nil {
		a.shipmateError(w, r, "reading shipmates", err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, list)
}

// target reads whom a body names: {"id"} or {"seat"}; false, answered,
// for neither.
func target(w http.ResponseWriter, r *http.Request) (shipmates.Target, bool) {
	var in struct {
		ID   string  `json:"id"`
		Seat *uint32 `json:"seat"`
	}
	if !readJSON(w, r, &in) {
		return shipmates.Target{}, false
	}
	if in.Seat != nil {
		return shipmates.Target{Seat: *in.Seat, BySeat: true}, true
	}
	id, err := store.ParseAccountID(in.ID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "id")
		return shipmates.Target{}, false
	}
	return shipmates.Target{ID: id}, true
}

// idOf reads {"id"}; false, answered, for none.
func idOf(w http.ResponseWriter, r *http.Request) (store.AccountID, bool) {
	t, ok := target(w, r)
	if ok && t.BySeat {
		writeError(w, http.StatusBadRequest, "id")
		return t.ID, false
	}
	return t.ID, ok
}

// shipmateOffer answers POST /api/shipmates/offer {"id"} or {"seat"}.
func (a *api) shipmateOffer(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	t, ok := target(w, r)
	if !ok {
		return
	}
	result, err := a.cfg.Shipmates.Offer(r.Context(), acc.ID, t)
	if err != nil {
		a.shipmateError(w, r, "offering to be shipmates", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"result": result})
}

// shipmateAccept answers POST /api/shipmates/accept {"id"}.
func (a *api) shipmateAccept(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	id, ok := idOf(w, r)
	if !ok {
		return
	}
	if err := a.cfg.Shipmates.Accept(r.Context(), acc.ID, id); err != nil {
		a.shipmateError(w, r, "accepting shipmates", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"result": shipmates.Made})
}

// shipmateDecline answers POST /api/shipmates/decline {"id"}.
func (a *api) shipmateDecline(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	id, ok := idOf(w, r)
	if !ok {
		return
	}
	if err := a.cfg.Shipmates.Decline(r.Context(), acc.ID, id); err != nil {
		a.shipmateError(w, r, "declining shipmates", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// shipmateEnd answers POST /api/shipmates/end {"id"} or {"seat"}.
func (a *api) shipmateEnd(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	t, ok := target(w, r)
	if !ok {
		return
	}
	if err := a.cfg.Shipmates.End(r.Context(), acc.ID, t); err != nil {
		a.shipmateError(w, r, "ending shipmates", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// shipmateBlock answers POST /api/shipmates/block {"id"}.
func (a *api) shipmateBlock(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	id, ok := idOf(w, r)
	if !ok {
		return
	}
	if err := a.cfg.Shipmates.Block(r.Context(), acc.ID, id); err != nil {
		if errors.Is(err, store.ErrTooManyTies) {
			writeError(w, http.StatusConflict, "too-many")
			return
		}
		a.shipmateError(w, r, "blocking from the shipmates list", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// shipmateReport answers POST /api/shipmates/report {"id", "reason",
// "note"}.
func (a *api) shipmateReport(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	var in struct {
		ID     string `json:"id"`
		Reason string `json:"reason"`
		Note   string `json:"note"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	id, err := store.ParseAccountID(in.ID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "id")
		return
	}
	if err := a.cfg.Shipmates.Report(r.Context(), acc.ID, id, in.Reason, in.Note); err != nil {
		a.shipmateError(w, r, "reporting from the shipmates list", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// setOffline answers POST /api/me/offline {"on"}: Appear offline.
func (a *api) setOffline(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	var in struct {
		On *bool `json:"on"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if in.On == nil {
		writeError(w, http.StatusBadRequest, "on")
		return
	}
	if err := a.cfg.Shipmates.SetOffline(r.Context(), acc.ID, *in.On); err != nil {
		a.shipmateError(w, r, "setting appear offline", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
