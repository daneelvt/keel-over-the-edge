// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"context"
	"encoding/hex"
	"errors"
	"net/http"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/news"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// News is the world's news as the owner reads it: news.Service. A sheet
// that names players and boats needs a hand on it: the owner strikes a
// story, which hides it for everyone, or puts it back.
type News interface {
	ParseDay(text string) (time.Time, error)
	ForOwner(ctx context.Context, day time.Time) (news.Edition, error)
	Strike(ctx context.Context, id [16]byte, struck bool) (store.Struck, error)
}

var _ News = (*news.Service)(nil)

// newsDay serves a day's edition as the owner reads it: every name shown,
// and the day's stories struck, marked.
//
//	GET /owner/api/news.json[?day=2006-01-02]
func (o *Owner) newsDay(w http.ResponseWriter, r *http.Request) {
	if o.cfg.News == nil {
		o.refuse(w, "news", http.StatusServiceUnavailable, "the news is not reached from here")
		return
	}
	day, err := o.cfg.News.ParseDay(r.URL.Query().Get("day"))
	if err != nil {
		o.refuse(w, "news", http.StatusBadRequest, "day is a date, 2006-01-02")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), dbTimeout)
	defer cancel()
	e, err := o.cfg.News.ForOwner(ctx, day)
	if errors.Is(err, news.ErrNoEdition) {
		o.refuse(w, "news", http.StatusNotFound, "the world has no edition of that day")
		return
	}
	if err != nil {
		http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	o.count("news")
	writeJSON(w, e)
}

// StrikeRequest strikes a story from the news, by its id, or puts it back.
type StrikeRequest struct {
	ID     string `json:"id"`
	Struck bool   `json:"struck"`
}

// strike strikes a story from the news for everyone, or puts it back, and
// writes it in the record.
//
//	POST /owner/api/news/strike {"id", "struck"}
func (o *Owner) strike(w http.ResponseWriter, r *http.Request) {
	var req StrikeRequest
	if !readBody(w, r, &req) {
		return
	}
	var id [16]byte
	if b, err := hex.DecodeString(req.ID); err != nil || len(b) != 16 {
		o.refuse(w, "strike", http.StatusBadRequest, "id is a story's")
		return
	} else {
		copy(id[:], b)
	}
	if o.cfg.News == nil {
		o.refuse(w, "strike", http.StatusServiceUnavailable, "the news is not reached from here")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), dbTimeout)
	defer cancel()
	st, err := o.cfg.News.Strike(ctx, id, req.Struck)
	if errors.Is(err, store.ErrNotFound) {
		o.refuse(w, "strike", http.StatusNotFound, "no such story in the world's news")
		return
	}
	if err != nil {
		http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	action := store.ActionStrike
	if !req.Struck {
		action = store.ActionUnstrike
	}
	o.count(action)
	var about *store.AccountID
	if st.Account != (store.AccountID{}) {
		about = &st.Account
	}
	o.record(r, action, about, st.Story+": "+st.Title)
	// What is logged is what the database answered of the story, never the
	// request's own words.
	o.cfg.Log.Info("owner: a story of the news "+action, "action", action, "story", st.Story, "account", st.Account.String(), "from", r.RemoteAddr)
	writeJSON(w, map[string]any{"id": req.ID, "struck": req.Struck})
}
