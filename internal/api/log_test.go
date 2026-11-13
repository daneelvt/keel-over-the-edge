// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/logbook"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// TestLogRoutes: every log is read behind a session; one's own always, a
// sailor's by name as its setting lets, an unknown sailor and a log kept
// from the reader answered with the same 404; the setting is the
// player's; nothing is kept by a cache.
func TestLogRoutes(t *testing.T) {
	srv := newAboardServer(t, func(c *Config) {
		c.Logs = logbook.NewService(logbook.ServiceConfig{Store: c.Sailing.(*sailing).Store, Key: moderation.Key})
	})
	// Without a session, none answers.
	for _, r := range [][2]string{{"GET", "/api/me/log"}, {"PUT", "/api/me/log"}, {"GET", "/api/log?name=Ann+Bonny"}, {"GET", "/api/machines/log?id=x"}} {
		req, _ := http.NewRequest(r[0], srv.URL+r[1], nil)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s %s without a session: %d", r[0], r[1], res.StatusCode)
		}
	}
	ann, _ := makeSailor(t, srv.testServer, "Ann Bonny")
	bob, _ := makeSailor(t, srv.testServer, "Bob Read")

	status, body := ann.do("GET", "/api/me/log", "")
	var l logbook.Log
	if status != 200 || json.Unmarshal([]byte(body), &l) != nil {
		t.Fatalf("Ann's own log: %d %s", status, body)
	}
	// An adult's is read by sailors, by default.
	if l.Name != "Ann Bonny" || !l.Own || l.Shown != store.LogShownSailors || l.Chosen || l.World != nil || len(l.Abstract) < 2 || len(l.Groups) != 8 {
		t.Errorf("Ann's own log: %+v", l)
	}
	if status, body := bob.do("GET", "/api/log?name=Ann+Bonny", ""); status != 200 {
		t.Errorf("Ann's log to Bob: %d %s", status, body)
	}
	if status, body := ann.do("PUT", "/api/me/log", `{"shown":"me"}`); status != 200 || body != `{"shown":"me"}` {
		t.Fatalf("keeping the log: %d %s", status, body)
	}
	refused, unknown := func() (int, string) { return bob.do("GET", "/api/log?name=Ann+Bonny", "") }, func() (int, string) {
		return bob.do("GET", "/api/log?name=Nobody+At+All", "")
	}
	s1, b1 := refused()
	s2, b2 := unknown()
	if s1 != 404 || s2 != 404 || b1 != b2 || b1 != `{"error":"not-found"}` {
		t.Errorf("refused %d %s; unknown %d %s", s1, b1, s2, b2)
	}
	if status, body := ann.do("PUT", "/api/me/log", `{"shown":"sailors"}`); status != 200 || body != `{"shown":"sailors"}` {
		t.Fatalf("opening the log: %d %s", status, body)
	}
	var other logbook.Log
	if status, body := bob.do("GET", "/api/log?name=ann+bonny", ""); status != 200 || json.Unmarshal([]byte(body), &other) != nil || other.Own || other.Shown != "" {
		t.Errorf("Ann's log, opened, to Bob: %d %s", status, body)
	}
	for _, c := range []struct {
		method, path, body string
		status             int
		want               string
	}{
		{"PUT", "/api/me/log", `{"shown":"everyone"}`, 400, `{"error":"shown"}`},
		{"PUT", "/api/me/log", `{"shown":"me","x":1}`, 400, `{"error":"malformed"}`},
		{"GET", "/api/me/log?world=-1", "", 400, `{"error":"world"}`},
		{"GET", "/api/log?name=", "", 404, `{"error":"not-found"}`},
		{"GET", "/api/machines/log?id=nobody", "", 404, `{"error":"not-found"}`},
		{"GET", "/api/machines/log?id=" + store.AccountID{9}.String(), "", 404, `{"error":"not-found"}`},
	} {
		if status, body := bob.do(c.method, c.path, c.body); status != c.status || body != c.want {
			t.Errorf("%s %s %s: %d %s", c.method, c.path, c.body, status, body)
		}
	}
	// Kept by no cache.
	req, _ := http.NewRequest("GET", srv.URL+"/api/me/log", nil)
	req.AddCookie(ann.session())
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 || res.Header.Get("Cache-Control") != "private, no-store" {
		t.Errorf("a log's answer: %d, Cache-Control %q", res.StatusCode, res.Header.Get("Cache-Control"))
	}
}
