// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"errors"
	"net/http"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/fleet"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The player's fleet: the boats they may take, the one they take to sea,
// and each boat's look, changed ashore or in port.

// fleetBoat is a boat of the fleet as the player is told it.
type fleetBoat struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Number int    `json:"number"`
	Name   string `json:"name"`
	Paint  string `json:"paint"`
	Cloth  string `json:"cloth"`
	// Sailor is the sailor whose boat it is, "" for none; Machine whether
	// they are a machine sailor; AtSea whether they are in the water in
	// it; Yours whether it is the player's.
	Sailor  string `json:"sailor"`
	Machine bool   `json:"machine"`
	AtSea   bool   `json:"atSea"`
	Yours   bool   `json:"yours"`
}

// fleetJSON is GET /api/fleet's answer: the boats, and the one the player
// sails, or takes on setting sail; "" for none.
type fleetJSON struct {
	Boat  string      `json:"boat"`
	Boats []fleetBoat `json:"boats"`
}

func (a *api) fleetOf(v fleet.View) fleetJSON {
	bl := a.cfg.Fleet.Looks()
	out := fleetJSON{Boats: make([]fleetBoat, len(v.Boats))}
	for i := range v.Boats {
		b := &v.Boats[i]
		out.Boats[i] = fleetBoat{ID: store.AccountID(b.ID).String(), Kind: b.Boat.Kind, Number: b.Number, Name: b.Name,
			Paint: bl.PaintID(b.Paint), Cloth: bl.ClothID(b.Cloth), Sailor: b.SailorName, Machine: b.Machine && b.Held,
			AtSea: b.AtSea, Yours: b.Yours}
		if !b.Held {
			out.Boats[i].Sailor = ""
		}
	}
	if v.Yours >= 0 {
		out.Boat = out.Boats[v.Yours].ID
	}
	return out
}

// fleet answers GET /api/fleet, behind auth.Required.
//
//	200 {"boat", "boats": [...]}
//	503                the database could not be asked
func (a *api) fleet(w http.ResponseWriter, r *http.Request) {
	cur, _ := auth.SessionFromContext(r.Context())
	v, err := a.cfg.Fleet.Of(r.Context(), cur.ID)
	if err != nil {
		a.unavailable(w, r, "reading a fleet", err)
		return
	}
	writeJSON(w, http.StatusOK, a.fleetOf(v))
}

// takeRequest is POST /api/boat's body.
type takeRequest struct {
	Boat string `json:"boat"`
}

// takeBoat answers POST /api/boat, behind auth.Required: a boat of the
// fleet the player's, ashore for their next voyage, or at sea in port
// swapped for theirs where it lies.
//
//	200 the fleet
//	400 {"error"}             malformed
//	404 {"error":"boat"}      not a boat of the player's fleet
//	409 {"error":"taken"}     at sea with another of the fleet's sailors
//	409 {"error":"port"}      the player is at sea out of port
//	409 {"error":"room"}      no room for that boat where theirs lies
//	503                       the world or the database could not be asked
func (a *api) takeBoat(w http.ResponseWriter, r *http.Request) {
	cur, _ := auth.SessionFromContext(r.Context())
	var req takeRequest
	if !readJSON(w, r, &req) {
		return
	}
	id, ok := store.ParseID(req.Boat)
	if !ok {
		writeError(w, http.StatusNotFound, "boat")
		return
	}
	v, err := a.cfg.Fleet.Take(r.Context(), cur.ID, store.BoatID(id))
	if a.fleetRefused(w, r, err, "taking a boat") {
		return
	}
	writeJSON(w, http.StatusOK, a.fleetOf(v))
}

// boatLookRequest is POST /api/boat/look's body: each field given changes.
type boatLookRequest struct {
	Boat   string  `json:"boat"`
	Paint  *string `json:"paint,omitempty"`
	Cloth  *string `json:"cloth,omitempty"`
	Number *int    `json:"number,omitempty"`
	Name   *string `json:"name,omitempty"`
}

// setBoatLook answers POST /api/boat/look, behind auth.Required: a boat's
// paint, cloth, sail number or name, changed ashore or in port. A name of
// "" clears it.
//
//	200 the fleet
//	400 {"error":"look"}      a paint or cloth not the catalog's, or a number out of 1 … the highest
//	404 {"error":"boat"}      not a boat of the player's fleet
//	409 {"error":"taken"}     at sea with another of the fleet's sailors
//	409 {"error":"port"}      the boat is at sea with the player out of port
//	409 {"error":"number"}    the sail number is another boat's of its kind
//	422 {"error": reason}     the name is refused: short, long, characters, scripts or words
//	503                       the world or the database could not be asked
func (a *api) setBoatLook(w http.ResponseWriter, r *http.Request) {
	cur, _ := auth.SessionFromContext(r.Context())
	var req boatLookRequest
	if !readJSON(w, r, &req) {
		return
	}
	id, ok := store.ParseID(req.Boat)
	if !ok {
		writeError(w, http.StatusNotFound, "boat")
		return
	}
	v, err := a.cfg.Fleet.SetLook(r.Context(), cur.ID, store.BoatID(id),
		fleet.Change{Paint: req.Paint, Cloth: req.Cloth, Number: req.Number, Name: req.Name})
	if a.fleetRefused(w, r, err, "changing a boat's look") {
		return
	}
	writeJSON(w, http.StatusOK, a.fleetOf(v))
}

// fleetRefused answers a change of the fleet refused, and reports whether
// it was.
func (a *api) fleetRefused(w http.ResponseWriter, r *http.Request, err error, doing string) bool {
	if err == nil {
		return false
	}
	if ref, ok := errors.AsType[*moderation.Refusal](err); ok {
		writeError(w, http.StatusUnprocessableEntity, string(ref.Reason))
		return true
	}
	for _, e := range []struct {
		err    error
		status int
		code   string
	}{
		{fleet.ErrNoBoat, http.StatusNotFound, "boat"},
		{fleet.ErrTaken, http.StatusConflict, "taken"},
		{fleet.ErrPort, http.StatusConflict, "port"},
		{fleet.ErrRoom, http.StatusConflict, "room"},
		{fleet.ErrNumber, http.StatusConflict, "number"},
		{fleet.ErrLook, http.StatusBadRequest, "look"},
	} {
		if errors.Is(err, e.err) {
			writeError(w, e.status, e.code)
			return true
		}
	}
	a.unavailable(w, r, doing, err)
	return true
}
