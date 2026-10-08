// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"errors"
	"mime"
	"net/http"

	jsonv2 "encoding/json/v2"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// guestRequest is POST /guest's body.
type guestRequest struct {
	Name string `json:"name"`
	Look string `json:"look"`
}

// guestResponse is the sailor made: the name as it will be shown.
type guestResponse struct {
	Name string `json:"name"`
	Look string `json:"look"`
}

// guest answers POST /guest: a sailor's name and look make a guest account
// and its session, whose cookie the answer sets. A browser that already has
// a session is refused, so a second guest is never made by accident.
//
//	201 {"name", "look"}    made; the session cookie is set
//	400 {"error"}           malformed, an unknown member, or a look not in the catalog
//	409 {"error":"session"} the request already has a session
//	413                     the body is too large
//	415                     not application/json
//	422 {"error": reason}   the name is refused: short, long, characters,
//	                        scripts, words or taken
//	503                     the database could not be asked
func (a *api) guest(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.FromContext(r.Context()); ok {
		writeError(w, http.StatusConflict, "session")
		return
	}
	if mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mt != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "content-type")
		return
	}
	// JSON as encoding/json/v2 reads it: valid UTF-8, no duplicate or
	// unknown members, nothing after the object.
	var req guestRequest
	if err := jsonv2.UnmarshalRead(r.Body, &req, jsonv2.RejectUnknownMembers(true)); err != nil {
		if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
			writeError(w, http.StatusRequestEntityTooLarge, "too-large")
			return
		}
		writeError(w, http.StatusBadRequest, "malformed")
		return
	}
	if !a.looks[req.Look] {
		writeError(w, http.StatusBadRequest, "look")
		return
	}
	name, err := moderation.CheckName(req.Name)
	if err != nil {
		reason := moderation.Characters
		if ref, ok := errors.AsType[*moderation.Refusal](err); ok {
			reason = ref.Reason
		}
		a.refuse(w, string(reason))
		return
	}
	token, hash := auth.NewToken()
	id, err := a.cfg.Guests.CreateGuest(r.Context(), store.Guest{Name: name.Display, NameKey: name.Key, Look: req.Look, TokenHash: hash})
	if errors.Is(err, store.ErrNameTaken) {
		a.refuse(w, "taken")
		return
	}
	if err != nil {
		a.cfg.Log.Warn("making a guest", "request_id", obs.RequestID(r.Context()), "err", err)
		writeError(w, http.StatusServiceUnavailable, "unavailable")
		return
	}
	a.cfg.Metrics.GuestsCreated.Inc()
	obs.SetAccount(r.Context(), id.String())
	a.cfg.Sessions.Add(hash, store.Account{ID: id, Kind: store.Human, Name: name.Display, Look: req.Look})
	http.SetCookie(w, auth.SessionCookie(token))
	writeJSON(w, http.StatusCreated, guestResponse{Name: name.Display, Look: req.Look})
}

func (a *api) refuse(w http.ResponseWriter, reason string) {
	a.cfg.Metrics.GuestsRefused.WithLabelValues(reason).Inc()
	writeError(w, http.StatusUnprocessableEntity, reason)
}
