// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"net/http"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
)

// me is the player's own account, what the page asks first: whether to go
// to sea or to the start screen.
type me struct {
	Name  string `json:"name"`
	Look  string `json:"look"`
	Kind  string `json:"kind"`
	Saved bool   `json:"saved"`
}

// me answers GET /api/me, behind auth.Required.
func (a *api) me(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	writeJSON(w, http.StatusOK, me{Name: acc.Name, Look: acc.Look, Kind: string(acc.Kind), Saved: acc.Saved})
}
