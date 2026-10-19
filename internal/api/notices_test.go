// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"io"
	"net/http"
	"strings"
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
	_, _, res := post(t, c, srv.URL+"/guest", "application/json", `{"name":"Ann Bonny","look":"figure"}`)
	cookie := sessionCookie(res)
	put := func(body string, site string) (int, string) {
		t.Helper()
		req, _ := http.NewRequest("PUT", srv.URL+"/api/me/notices", strings.NewReader(body))
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
