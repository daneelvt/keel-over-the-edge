// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/news"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The news: GET /api/news, a day's edition as the reader reads it, behind
// a session like every other read: the news is read only in the game. Its
// names follow the naming rule for each reader, so no cache but the
// reader's own keeps it; the news's own keeps the day's stories 5 s.

// NewsSource is the world's news: news.Service.
type NewsSource interface {
	ParseDay(text string) (time.Time, error)
	Edition(ctx context.Context, reader store.AccountID, day time.Time) (news.Edition, error)
	About(ctx context.Context, reader store.AccountID, name string, limit int) ([]news.Story, error)
	AboutAccount(ctx context.Context, reader, id store.AccountID, limit int) ([]news.Story, error)
}

var _ NewsSource = (*news.Service)(nil)

// newsRoute is the news's route.
const newsRoute = "GET /api/news"

// newsAbout is how many stories about one sailor are given.
const newsAbout = 5

// aboutPage is the stories naming a sailor.
type aboutPage struct {
	Stories []news.Story `json:"stories"`
}

// writeNews answers with v, kept by the reader's own browser 5 s.
func writeNews(w http.ResponseWriter, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		panic(err) // the news always marshals
	}
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", "private, max-age=5")
	h.Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(append(body, '\n'))
}

// newsEdition answers GET /api/news?day=, behind auth.Required: the
// edition of a day of the world sailed (2006-01-02, by the world's
// schedule), today's by default; or GET /api/news?name=, the stories this
// world naming the sailor of the name, the newest first, if the reader
// may name them (none otherwise, and none for no such sailor).
//
//	200 the edition (news.Edition), or {"stories": […]}
//	404 {"error":"not-found"}   no edition of that day
func (a *api) newsEdition(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	q := r.URL.Query()
	if q.Has("name") {
		name := clip(q.Get("name"), maxName)
		stories, err := a.cfg.News.About(r.Context(), acc.ID, name, newsAbout)
		if err != nil {
			a.unavailable(w, r, "reading the news about a sailor", err)
			return
		}
		writeNews(w, aboutPage{Stories: stories})
		return
	}
	day, err := a.cfg.News.ParseDay(clip(q.Get("day"), 10))
	if err != nil {
		w.Header().Set("Cache-Control", "private, no-store")
		writeError(w, http.StatusNotFound, "not-found")
		return
	}
	e, err := a.cfg.News.Edition(r.Context(), acc.ID, day)
	switch {
	case errors.Is(err, news.ErrNoEdition):
		w.Header().Set("Cache-Control", "private, no-store")
		writeError(w, http.StatusNotFound, "not-found")
	case err != nil:
		a.unavailable(w, r, "reading the news", err)
	default:
		writeNews(w, e)
	}
}
