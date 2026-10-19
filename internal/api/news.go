// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The news: GET /api/news?before=<id>, the world's items written before
// the item of that id (the newest, without it), the newest first, a page
// at a time. It is the
// same for everyone, so it needs no session and is kept 5 s by the edge's
// cache and by the server's own.

// NewsSource reads the world's news: the store, for the world sailed.
type NewsSource interface {
	News(ctx context.Context, before *[16]byte, limit int) ([]store.News, error)
}

// newsRoute is the news's route.
const newsRoute = "GET /api/news"

// newsKeep is how long a page of the news is kept.
const newsKeep = 5 * time.Second

// newsItem is an item as the page reads it.
type newsItem struct {
	ID      string       `json:"id"`
	Column  string       `json:"column"`
	At      int64        `json:"at"` // ms of UTC since 1970
	By      string       `json:"by"`
	AI      bool         `json:"ai"`
	Subject string       `json:"subject"`
	Number  int32        `json:"number"`
	Title   string       `json:"title"`
	What    string       `json:"what"`
	Worth   float64      `json:"worth"`
	East    float64      `json:"east"`
	North   float64      `json:"north"`
	Also    []newsFolded `json:"also"`
	// EndsAt is, for an item about the world itself, the world's end it
	// tells of, ms of UTC since 1970: each reader shows it in their own
	// time.
	EndsAt int64 `json:"endsAt,omitempty"`
}

type newsFolded struct {
	Subject string `json:"subject"`
	Number  int32  `json:"number"`
	Title   string `json:"title"`
}

// newsPage is a page of the news.
type newsPage struct {
	Items []newsItem `json:"items"`
	// More says there may be older items: ask again with before the last's id.
	More bool `json:"more"`
}

// news serves the news, a page of limit items.
type news struct {
	src   NewsSource
	limit int

	mu    sync.Mutex
	kept  map[string]keptPage
	clock func() time.Time
}

type keptPage struct {
	page newsPage
	at   time.Time
}

func newNews(src NewsSource, limit int) *news {
	if limit <= 0 {
		limit = 40
	}
	return &news{src: src, limit: limit, kept: map[string]keptPage{}, clock: time.Now}
}

func (n *news) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	before := r.URL.Query().Get("before")
	if before != "" {
		if b, err := hex.DecodeString(before); err != nil || len(b) != 16 {
			writeError(w, http.StatusBadRequest, "before")
			return
		}
	}
	page, err := n.page(r.Context(), before)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable")
		return
	}
	body, err := json.Marshal(page)
	if err != nil {
		panic(err) // a page always marshals
	}
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", "public, max-age=5")
	h.Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(append(body, '\n'))
}

// page is the page before the item before, "" for the newest, kept
// newsKeep.
func (n *news) page(ctx context.Context, before string) (newsPage, error) {
	now := n.clock()
	n.mu.Lock()
	if k, ok := n.kept[before]; ok && now.Sub(k.at) < newsKeep {
		n.mu.Unlock()
		return k.page, nil
	}
	n.mu.Unlock()
	var id *[16]byte
	if before != "" {
		var b [16]byte
		if _, err := hex.Decode(b[:], []byte(before)); err != nil {
			return newsPage{}, err
		}
		id = &b
	}
	items, err := n.src.News(ctx, id, n.limit)
	if err != nil {
		return newsPage{}, err
	}
	page := newsPage{Items: make([]newsItem, 0, len(items)), More: len(items) == n.limit}
	for _, it := range items {
		ni := newsItem{
			ID: hex.EncodeToString(it.ID[:]), Column: it.Column, At: it.At.UnixMilli(), By: it.Sailor, AI: it.AccountKind == string(store.AI),
			Subject: it.Subject, Number: it.Number, Title: it.Title, What: it.What, Worth: it.Worth, East: it.X, North: it.Y,
			Also: make([]newsFolded, 0, len(it.Also)),
		}
		if !it.EndsAt.IsZero() {
			ni.EndsAt = it.EndsAt.UnixMilli()
		}
		if ni.By == "" && it.Subject != store.SubjectWorld {
			ni.By = "a sailor"
		}
		for _, f := range it.Also {
			ni.Also = append(ni.Also, newsFolded(f))
		}
		page.Items = append(page.Items, ni)
	}
	n.mu.Lock()
	// The pages kept are few: each is let go once it is old.
	for k, v := range n.kept {
		if now.Sub(v.at) >= newsKeep {
			delete(n.kept, k)
		}
	}
	if len(n.kept) < 256 {
		n.kept[before] = keptPage{page: page, at: now}
	}
	n.mu.Unlock()
	return page, nil
}
