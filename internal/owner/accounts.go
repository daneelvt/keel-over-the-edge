// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"context"
	"encoding/json"
	"net/http"
)

// accountsJSON is accounts.json: the players' accounts, how many there
// are, how many were made in the last seven days and how many were seen in
// the last day.
type accountsJSON struct {
	Total int64 `json:"total"`
	Week  int64 `json:"week"`
	Today int64 `json:"today"`
}

// accounts serves accounts.json, counted now, never cached.
func (o *Owner) accounts(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), dbTimeout)
	defer cancel()
	n, err := o.cfg.Accounts.AccountCounts(ctx)
	if err != nil {
		http.Error(w, "the database could not be asked", http.StatusServiceUnavailable)
		return
	}
	body, _ := json.Marshal(accountsJSON{Total: n.Total, Week: n.Week, Today: n.Today})
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", "no-store")
	_, _ = w.Write(body)
}
