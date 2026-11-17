// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/humancheck"
)

// TestTurnstileStandIn: keel's own check passes the stand-in's token once
// for each a widget was given, for the page's host and the widget's
// action, refuses it repeated, and answers as told for a page's test.
func TestTurnstileStandIn(t *testing.T) {
	mux := http.NewServeMux()
	newTurnstile().routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	check := humancheck.New(humancheck.Config{Secret: turnstileSecret, VerifyURL: srv.URL + "/turnstile/siteverify", Hostname: "localhost"})
	ctx := context.Background()
	post := func(path, body string) int {
		t.Helper()
		req, _ := http.NewRequest("POST", srv.URL+path, strings.NewReader(body))
		req.Host = "localhost:5181"
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	res, err := http.Get(srv.URL + "/turnstile/api.js?render=explicit")
	if err != nil {
		t.Fatal(err)
	}
	js, _ := io.ReadAll(res.Body)
	res.Body.Close()
	for _, want := range []string{"render(", "execute(", "reset(", "remove(", "getResponse(", "isExpired(", turnstileToken} {
		if !strings.Contains(string(js), want) {
			t.Errorf("api.js has no %s", want)
		}
	}
	if strings.Contains(string(js), "innerHTML") {
		t.Error("api.js writes HTML")
	}
	if got := check.Check(ctx, turnstileToken, ""); got != humancheck.Spent {
		t.Fatalf("a token never given: %s", got)
	}
	post("/turnstile/issue", `{"action":"new-sailor"}`)
	if got := check.Check(ctx, "another token", ""); got != humancheck.Refused {
		t.Fatalf("another token: %s", got)
	}
	if got := check.Check(ctx, turnstileToken, "127.0.0.1"); got != humancheck.Passed {
		t.Fatalf("given: %s", got)
	}
	if got := check.Check(ctx, turnstileToken, ""); got != humancheck.Spent {
		t.Fatalf("repeated: %s", got)
	}
	post("/turnstile/issue", `{"action":"sign-in"}`)
	if got := check.Check(ctx, turnstileToken, ""); got != humancheck.Refused {
		t.Fatalf("another action: %s", got)
	}
	wrong := humancheck.New(humancheck.Config{Secret: "wrong", VerifyURL: srv.URL + "/turnstile/siteverify", Hostname: "localhost"})
	post("/turnstile/issue", `{"action":"new-sailor"}`)
	if got := wrong.Check(ctx, turnstileToken, ""); got != humancheck.Unavailable {
		t.Fatalf("a wrong secret: %s", got)
	}
	for answer, want := range map[string]humancheck.Result{"refused": humancheck.Refused, "spent": humancheck.Spent, "unavailable": humancheck.Unavailable} {
		if status := post("/turnstile/next?answer="+answer, ""); status != 204 {
			t.Fatalf("next %s: %d", answer, status)
		}
		if got := check.Check(ctx, turnstileToken, ""); got != want {
			t.Errorf("told %s: %s", answer, got)
		}
	}
	// The token given before the answers told is still good.
	if got := check.Check(ctx, turnstileToken, ""); got != humancheck.Passed {
		t.Fatalf("after the answers told: %s", got)
	}
	if status := post("/turnstile/next?answer=maybe", ""); status != 400 {
		t.Fatalf("next maybe: %d", status)
	}
}
