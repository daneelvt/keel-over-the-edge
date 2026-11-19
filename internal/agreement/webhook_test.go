// SPDX-License-Identifier: AGPL-3.0-only

package agreement

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

func sign(secret, body string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(body))
	return "sha256=" + hex.EncodeToString(m.Sum(nil))
}

func TestWebhook(t *testing.T) {
	const secret = "s3cret"
	c := &Checker{}
	var results []string
	h := &Webhook{Secret: []byte(secret), Checker: c, Result: func(r string) { results = append(results, r) }}
	opened := `{"action":"opened","number":5,"repository":{"full_name":"o/r"}}`
	deliver := func(method, event, id, sig, body string) int {
		req := httptest.NewRequest(method, "/agreement/webhook", strings.NewReader(body))
		req.Header.Set("X-GitHub-Event", event)
		req.Header.Set("X-GitHub-Delivery", id)
		if sig != "" {
			req.Header.Set("X-Hub-Signature-256", sig)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}
	for _, c := range []struct {
		name                   string
		method, event, id, sig string
		body                   string
		status                 int
		result                 string
	}{
		{"good", "POST", "pull_request", "d1", sign(secret, opened), opened, 202, "ok"},
		{"replayed", "POST", "pull_request", "d1", sign(secret, opened), opened, 200, "duplicate"},
		{"bad signature", "POST", "pull_request", "d2", sign("other", opened), opened, 401, "bad_signature"},
		{"no signature", "POST", "pull_request", "d3", "", opened, 401, "bad_signature"},
		{"not hex", "POST", "pull_request", "d4", "sha256=zz", opened, 401, "bad_signature"},
		{"sha1", "POST", "pull_request", "d5", "sha1=" + strings.Repeat("0", 40), opened, 401, "bad_signature"},
		{"oversized", "POST", "pull_request", "d6", "", strings.Repeat("x", MaxDelivery+1), 413, "too_large"},
		{"ping", "POST", "ping", "d7", sign(secret, `{}`), `{}`, 200, "ignored"},
		{"a comment", "POST", "pull_request", "d8", sign(secret, `{"action":"assigned","number":5,"repository":{"full_name":"o/r"}}`),
			`{"action":"assigned","number":5,"repository":{"full_name":"o/r"}}`, 200, "ignored"},
		{"a strange repository", "POST", "pull_request", "d9", sign(secret, `{"action":"opened","number":5,"repository":{"full_name":"../x"}}`),
			`{"action":"opened","number":5,"repository":{"full_name":"../x"}}`, 400, "bad_request"},
		{"a GET", "GET", "pull_request", "d10", "", "", 405, "bad_request"},
	} {
		results = nil
		if got := deliver(c.method, c.event, c.id, c.sig, c.body); got != c.status || len(results) != 1 || results[0] != c.result {
			t.Errorf("%s: %d %v, want %d %s", c.name, got, results, c.status, c.result)
		}
	}
	if len(c.pending) != 1 || c.pending[0] != (store.PullRef{Repo: "o/r", Number: 5}) {
		t.Errorf("queued: %v", c.pending)
	}
	if Verify(nil, []byte(opened), sign("", opened)) {
		t.Error("an empty secret verified a delivery")
	}
}

func TestWebhookForgets(t *testing.T) {
	h := &Webhook{}
	for i := range rememberDeliveries + 1 {
		if !h.first("d" + string(rune('a'+i%26)) + strings.Repeat("x", i/26)) {
			t.Fatalf("delivery %d seen twice", i)
		}
	}
	if len(h.seen) != rememberDeliveries || len(h.ring) != rememberDeliveries {
		t.Errorf("remembers %d, %d", len(h.seen), len(h.ring))
	}
	_ = http.StatusOK
}

func TestValidRepo(t *testing.T) {
	for s, want := range map[string]bool{
		"daneelvt/keel-over-the-edge": true, "o/r.js": true, "o/r_1": true,
		"o": false, "/r": false, "o/": false, "o/r/x": false, "o/..": false, "o/r?x": false, "o/r#": false, "o r/x": false,
	} {
		if validRepo(s) != want {
			t.Errorf("validRepo(%q) = %v", s, !want)
		}
	}
}
