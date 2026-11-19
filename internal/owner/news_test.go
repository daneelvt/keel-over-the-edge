// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/news"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// fakeNews is a day's news with one story, which the owner strikes.
type fakeNews struct {
	struck map[[16]byte]bool
}

func (f *fakeNews) ParseDay(text string) (time.Time, error) {
	if text == "" {
		return time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC), nil
	}
	return time.Time{}, news.ErrNoEdition
}

func (f *fakeNews) ForOwner(context.Context, time.Time) (news.Edition, error) {
	return news.Edition{Day: "2026-11-12", Stories: []news.Story{{ID: hex.EncodeToString(make([]byte, 16)), Head: "KEYHOLE ROCK",
		Struck: f.struck[[16]byte{}]}}}, nil
}

func (f *fakeNews) Strike(_ context.Context, id [16]byte, struck bool) (store.Struck, error) {
	if id != ([16]byte{}) {
		return store.Struck{}, store.ErrNotFound
	}
	f.struck[id] = struck
	return store.Struck{Title: "Keyhole Rock", Story: store.StoryGreat}, nil
}

// TestStrikeNews: the owner reads the day's news, strikes a story and puts
// it back; a story not in the world's news, a day with no edition and a
// malformed id are refused.
func TestStrikeNews(t *testing.T) {
	r := newRig(t, 4)
	f := &fakeNews{struck: map[[16]byte]bool{}}
	r.o.cfg.News = f
	id := hex.EncodeToString(make([]byte, 16))
	if code, body := r.do(t, "POST", "/owner/api/news/strike", StrikeRequest{ID: id, Struck: true}); code != 200 || !f.struck[[16]byte{}] {
		t.Fatalf("struck: %d %s", code, body)
	}
	code, body := r.do(t, "GET", "/owner/api/news.json", nil)
	var e news.Edition
	if code != 200 || json.Unmarshal(body, &e) != nil || len(e.Stories) != 1 || !e.Stories[0].Struck {
		t.Fatalf("the news: %d %s", code, body)
	}
	if code, _ := r.do(t, "POST", "/owner/api/news/strike", StrikeRequest{ID: id}); code != 200 || f.struck[[16]byte{}] {
		t.Errorf("put back: %d", code)
	}
	for _, c := range []struct {
		method, path string
		body         any
		code         int
	}{
		{"POST", "/owner/api/news/strike", StrikeRequest{ID: "zz", Struck: true}, 400},
		{"POST", "/owner/api/news/strike", StrikeRequest{ID: hex.EncodeToString([]byte("0123456789abcdef")), Struck: true}, 404},
		{"GET", "/owner/api/news.json?day=yesterday", nil, 400},
	} {
		if code, body := r.do(t, c.method, c.path, c.body); code != c.code {
			t.Errorf("%s %s: %d %s", c.method, c.path, code, body)
		}
	}
}
