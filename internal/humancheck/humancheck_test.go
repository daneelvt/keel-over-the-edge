// SPDX-License-Identifier: AGPL-3.0-only

package humancheck

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	host   = "play.example.com"
	secret = "the-widgets-secret"
	token  = "a-token-from-the-page"
)

// siteverify stands in for Cloudflare's: each request kept, answered by
// answer in turn.
type siteverify struct {
	mu      sync.Mutex
	asked   []url.Values
	answers []func(w http.ResponseWriter)
}

func (s *siteverify) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	s.mu.Lock()
	n := len(s.asked)
	s.asked = append(s.asked, r.PostForm)
	answer := s.answers[min(n, len(s.answers)-1)]
	s.mu.Unlock()
	answer(w)
}

func says(body string) func(w http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}
}

func status(code int) func(w http.ResponseWriter) {
	return func(w http.ResponseWriter) { w.WriteHeader(code) }
}

func serve(t *testing.T, answers ...func(w http.ResponseWriter)) (*siteverify, *Checker) {
	t.Helper()
	sv := &siteverify{answers: answers}
	srv := httptest.NewServer(sv)
	t.Cleanup(srv.Close)
	return sv, New(Config{Secret: secret, VerifyURL: srv.URL, Hostname: host, Timeout: 2 * time.Second})
}

const passed = `{"success":true,"challenge_ts":"2026-11-17T00:00:00Z","hostname":"play.example.com","action":"new-sailor","error-codes":[]}`

func TestPassed(t *testing.T) {
	sv, c := serve(t, says(passed))
	if got := c.Check(context.Background(), token, "203.0.113.7"); got != Passed {
		t.Fatalf("Check = %s", got)
	}
	f := sv.asked[0]
	if f.Get("secret") != secret || f.Get("response") != token || f.Get("remoteip") != "203.0.113.7" {
		t.Errorf("asked %v", f)
	}
	if !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(f.Get("idempotency_key")) {
		t.Errorf("idempotency key %q is not a UUID", f.Get("idempotency_key"))
	}
}

// TestNoToken: a missing token, or one longer than Cloudflare makes, is
// refused without a call.
func TestNoToken(t *testing.T) {
	sv, c := serve(t, says(passed))
	for _, tok := range []string{"", strings.Repeat("x", MaxToken+1)} {
		if got := c.Check(context.Background(), tok, ""); got != Refused {
			t.Errorf("Check(%d characters) = %s", len(tok), got)
		}
	}
	if len(sv.asked) != 0 {
		t.Errorf("Cloudflare asked %d times", len(sv.asked))
	}
	if got := c.Check(context.Background(), strings.Repeat("x", MaxToken), ""); got != Passed || len(sv.asked) != 1 {
		t.Errorf("a token of %d characters: %s, asked %d", MaxToken, got, len(sv.asked))
	}
}

func TestAnswers(t *testing.T) {
	for name, tc := range map[string]struct {
		body string
		want Result
	}{
		"refused":        {`{"success":false,"error-codes":["invalid-input-response"]}`, Refused},
		"missing":        {`{"success":false,"error-codes":["missing-input-response"]}`, Refused},
		"spent":          {`{"success":false,"error-codes":["timeout-or-duplicate"]}`, Spent},
		"wrong hostname": {`{"success":true,"hostname":"evil.example","action":"new-sailor"}`, Refused},
		"wrong action":   {`{"success":true,"hostname":"play.example.com","action":"sign-in"}`, Refused},
		"no action":      {`{"success":true,"hostname":"play.example.com"}`, Refused},
		"bad secret":     {`{"success":false,"error-codes":["invalid-input-secret"]}`, Unavailable},
		"internal error": {`{"success":false,"error-codes":["internal-error"]}`, Unavailable},
		"not json":       {`<html>`, Unavailable},
		"no success":     {`{"hostname":"play.example.com","action":"new-sailor"}`, Unavailable},
	} {
		t.Run(name, func(t *testing.T) {
			sv, c := serve(t, says(tc.body))
			if got := c.Check(context.Background(), token, ""); got != tc.want {
				t.Errorf("Check = %s, want %s", got, tc.want)
			}
			if len(sv.asked) != 1 {
				t.Errorf("asked %d times", len(sv.asked))
			}
			if _, ok := sv.asked[0]["remoteip"]; ok {
				t.Error("remoteip sent for an unknown address")
			}
		})
	}
}

// TestRetry: one more try after a 5xx, with the same idempotency key, and
// none after that.
func TestRetry(t *testing.T) {
	sv, c := serve(t, status(502), says(passed))
	if got := c.Check(context.Background(), token, ""); got != Passed {
		t.Fatalf("Check = %s", got)
	}
	if len(sv.asked) != 2 || sv.asked[0].Get("idempotency_key") != sv.asked[1].Get("idempotency_key") {
		t.Fatalf("asked %v", sv.asked)
	}
	sv, c = serve(t, status(503))
	if got := c.Check(context.Background(), token, ""); got != Unavailable || len(sv.asked) != 2 {
		t.Errorf("Cloudflare down: %s, asked %d times", got, len(sv.asked))
	}
	// A 4xx is no fault a retry mends.
	sv, c = serve(t, status(400))
	if got := c.Check(context.Background(), token, ""); got != Unavailable || len(sv.asked) != 1 {
		t.Errorf("a 400: %s, asked %d times", got, len(sv.asked))
	}
	// Two checks never share a key.
	_, c = serve(t, says(passed))
	sv2, c2 := serve(t, says(passed))
	c.Check(context.Background(), token, "")
	c2.Check(context.Background(), token, "")
	c2.Check(context.Background(), token, "")
	if sv2.asked[0].Get("idempotency_key") == sv2.asked[1].Get("idempotency_key") {
		t.Error("two checks shared an idempotency key")
	}
}

// TestUnreachable: a refused connection is tried twice, then unavailable.
func TestUnreachable(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	addr := srv.URL
	srv.Close()
	c := New(Config{Secret: secret, VerifyURL: addr, Hostname: host, Timeout: time.Second})
	if got := c.Check(context.Background(), token, ""); got != Unavailable {
		t.Errorf("Check = %s", got)
	}
}

// TestSlow: Cloudflare slower than the timeout is unavailable, within it.
func TestSlow(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(release) })
	c := New(Config{Secret: secret, VerifyURL: srv.URL, Hostname: host, Timeout: 300 * time.Millisecond})
	start := time.Now()
	if got := c.Check(context.Background(), token, ""); got != Unavailable {
		t.Errorf("Check = %s", got)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("took %v", d)
	}
}

// TestTestSecrets: Cloudflare's test secrets answer example.com and no
// action, which a check with one expects; a real secret never does.
func TestTestSecrets(t *testing.T) {
	dummy := `{"success":true,"hostname":"example.com","error-codes":[]}`
	for _, s := range []string{"1x0000000000000000000000000000000AA", "2x0000000000000000000000000000000AA", "3x0000000000000000000000000000000AA"} {
		if !testSecret(s) {
			t.Errorf("%s is a test secret", s)
		}
	}
	for _, s := range []string{"", secret, "1x0000000000000000000000000000000AB", "4x0000000000000000000000000000000AA", "1x000000000000000000000000000000AA"} {
		if testSecret(s) {
			t.Errorf("%s is not a test secret", s)
		}
	}
	sv := &siteverify{answers: []func(http.ResponseWriter){says(dummy)}}
	srv := httptest.NewServer(sv)
	t.Cleanup(srv.Close)
	test := New(Config{Secret: "1x0000000000000000000000000000000AA", VerifyURL: srv.URL, Hostname: host})
	if got := test.Check(context.Background(), "XXXX.DUMMY.TOKEN.XXXX", ""); got != Passed {
		t.Errorf("the test secret's answer: %s", got)
	}
	real := New(Config{Secret: secret, VerifyURL: srv.URL, Hostname: host})
	if got := real.Check(context.Background(), "XXXX.DUMMY.TOKEN.XXXX", ""); got != Refused {
		t.Errorf("the test answer to a real secret: %s", got)
	}
}

func FuzzAnswer(f *testing.F) {
	for _, s := range []string{
		passed,
		`{"success":false,"error-codes":["timeout-or-duplicate"]}`,
		`{"success":false,"error-codes":["invalid-input-response","bad-request"]}`,
		`{"success":true,"hostname":"example.com"}`,
		`{"success":"true"}`,
		`{"success":true,"hostname":null,"action":7}`,
		`[]`, `null`, ``, `{"success":true,"error-codes":"x"}`,
	} {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, body []byte) {
		a, err := decode(body)
		if err != nil {
			return
		}
		for _, test := range []bool{false, true} {
			r := judge(a, host, test)
			if r == Passed && !a.Success {
				t.Fatalf("passed without success: %s", body)
			}
			if r == Passed && !test && (a.Hostname != host || a.Action != Action) {
				t.Fatalf("passed for another host or action: %s", body)
			}
		}
	})
}
