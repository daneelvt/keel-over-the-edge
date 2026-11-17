// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// TestNoticesSwitched: a sailor's notices switched off are kept on the
// account and read back with it, on any device; a kind the catalog does
// not let be switched off is refused, as is a request from another site.
func TestNoticesSwitched(t *testing.T) {
	st, _ := storetest.Store(t, store.Options{})
	srv := newTestServer(t, st, func(c *Config) {
		c.Notices, c.NoticeKinds = st, []string{"great-discoveries", "own-charting"}
	})
	c := http.DefaultClient
	_, cookie := makeSailor(t, srv, "Ann Bonny")
	put := func(body string, site string) (int, string) {
		t.Helper()
		req, _ := http.NewRequest("POST", srv.URL+"/api/me/notices", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if site != "" {
			req.Header.Set("Sec-Fetch-Site", site)
		}
		req.AddCookie(cookie)
		res, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, strings.TrimSpace(string(b))
	}
	if status, body := put(`{"off":["great-discoveries"]}`, "same-origin"); status != 200 || !strings.Contains(body, `"noticesOff":["great-discoveries"]`) {
		t.Fatalf("switched off: %d %s", status, body)
	}
	if status, body := get(t, c, srv.URL+"/api/me", cookie); status != 200 || !strings.Contains(body, `"noticesOff":["great-discoveries"]`) {
		t.Fatalf("read back: %d %s", status, body)
	}
	if status, _ := put(`{"off":["no-such-kind"]}`, "same-origin"); status != 400 {
		t.Errorf("a kind not switchable: %d", status)
	}
	if status, body := put(`{"off":[]}`, "cross-site"); status != 403 || !strings.Contains(body, "cross-origin") {
		t.Errorf("from another site: %d %s", status, body)
	}
	if _, body := get(t, c, srv.URL+"/api/me", cookie); !strings.Contains(body, `"noticesOff":["great-discoveries"]`) {
		t.Errorf("changed by the refused requests: %s", body)
	}
}

// noticeDesk keeps the notices sent from outside, and nothing else of
// chat's.
type noticeDesk struct {
	Chatting
	mu   sync.Mutex
	kept int
}

func (d *noticeDesk) Notice(context.Context, store.Notice) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.kept++
	return nil
}

// TestNoticesAnHour: the notice form takes five notices an hour from one
// address, as Cloudflare names it, and refuses the sixth as too often,
// keeping nothing; another address is not held by the first's count.
func TestNoticesAnHour(t *testing.T) {
	desk := &noticeDesk{}
	srv := newTestServer(t, noDatabase{}, func(c *Config) { c.Chat = desk })
	send := func(addr string) (int, string) {
		t.Helper()
		req, _ := http.NewRequest("POST", srv.URL+"/api/notice",
			strings.NewReader(`{"who":"A parent","contact":"parent@example.com","reason":"bullying","what":"Unkind words at sea"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		req.Header.Set("CF-Connecting-IP", addr)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, strings.TrimSpace(string(b))
	}
	for i := range NoticesAnHour {
		if status, body := send("198.51.100.7"); status != http.StatusNoContent {
			t.Fatalf("notice %d: %d %s", i+1, status, body)
		}
	}
	if status, body := send("198.51.100.7"); status != http.StatusTooManyRequests || body != `{"error":"often"}` {
		t.Fatalf("the sixth from one address: %d %s", status, body)
	}
	if status, _ := send("203.0.113.9"); status != http.StatusNoContent {
		t.Fatalf("from another address: %d", status)
	}
	if desk.kept != NoticesAnHour+1 {
		t.Fatalf("%d notices kept", desk.kept)
	}
}
