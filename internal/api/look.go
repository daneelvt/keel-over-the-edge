// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"net/http"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// A sailor's look is changed only at Port Royal: ashore, before setting
// sail (every voyage starts in Port Royal's roads), or at sea in Port
// Royal's harbour, where the change is seen at once.

// LookPlace is where a sailor is as their look is changed.
type LookPlace uint8

const (
	// Ashore: the account has no boat in the water, nor waits for one.
	Ashore LookPlace = iota
	// InHarbour: the account's boat is in Port Royal's harbour, and its
	// look changed in the world.
	InHarbour
	// Away: the account's boat is at sea beyond Port Royal's harbour, and
	// its look stays.
	Away
)

// LookSeat changes a sailor's look in the world sailed, where it may be.
type LookSeat interface {
	// ChangeLook changes the look of an account's boat to the look code,
	// if its boat is in Port Royal's harbour, or of its place in the queue;
	// and says where it is. An error if the world could not be asked.
	ChangeLook(ctx context.Context, id store.AccountID, code uint32) (LookPlace, error)
}

// setLook answers POST /api/sailor/look, behind auth.Required: the
// player's sailor's look, chosen, kept, and seen in the world at once if
// its boat is in Port Royal's harbour. Choosing the look the game drew is
// choosing it too.
//
//	200 me             the look changed
//	400 {"error"}      malformed, or a look not made of the catalog's choices
//	409 {"error":"port-royal"}  the boat is at sea beyond Port Royal's harbour
//	503                the world or the database could not be asked
func (a *api) setLook(w http.ResponseWriter, r *http.Request) {
	cur, _ := auth.SessionFromContext(r.Context())
	var req lookRequest
	if !readJSON(w, r, &req) {
		return
	}
	l := req.look()
	if cur.Kind != store.Human || l.Look == store.MachineLook || !a.cfg.Looks.Valid(l) {
		writeError(w, http.StatusBadRequest, "look")
		return
	}
	if seat := a.cfg.LookSeat; seat != nil {
		place, err := seat.ChangeLook(r.Context(), cur.ID, a.cfg.Looks.Code(l))
		if err != nil {
			a.unavailable(w, r, "changing a look at sea", err)
			return
		}
		if place == Away {
			writeError(w, http.StatusConflict, "port-royal")
			return
		}
	}
	if err := a.cfg.Accounts.SetLook(r.Context(), cur.ID, l); err != nil {
		a.unavailable(w, r, "keeping a look", err)
		return
	}
	a.cfg.Sessions.ForgetAccount(cur.ID)
	acc := cur.Account
	acc.Look = l
	m := a.meOf(acc)
	if a.cfg.Watch != nil {
		m.Spectators = a.cfg.Watch.Spectators(cur.ID)
		m.AtSea = a.cfg.Watch.AtSea(cur.ID)
	}
	writeJSON(w, http.StatusOK, m)
}
