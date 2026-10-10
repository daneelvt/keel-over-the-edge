// SPDX-License-Identifier: AGPL-3.0-only

package actions

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIDToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer request-token" || r.URL.Query().Get("audience") != "https://example.com/aud" || r.URL.Query().Get("api-version") != "2.0" {
			http.Error(w, "no", http.StatusForbidden)
			return
		}
		io.WriteString(w, `{"value":"eyJ.the.jwt"}`)
	}))
	defer srv.Close()
	t.Setenv("ACTIONS_ID_TOKEN_REQUEST_URL", srv.URL+"/token?api-version=2.0")
	t.Setenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "request-token")
	var log bytes.Buffer
	jwt, err := IDToken(context.Background(), srv.Client(), &log, "https://example.com/aud")
	if err != nil || jwt != "eyJ.the.jwt" {
		t.Fatalf("got %q, %v", jwt, err)
	}
	if log.String() != "::add-mask::eyJ.the.jwt\n" {
		t.Errorf("log %q: the token is masked, and printed nowhere else", log.String())
	}

	if _, err := IDToken(context.Background(), srv.Client(), &log, "https://example.com/other"); err == nil {
		t.Error("a refusal is no token")
	}
	t.Setenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "")
	if _, err := IDToken(context.Background(), srv.Client(), &log, "x"); err == nil || !strings.Contains(err.Error(), "id-token: write") {
		t.Errorf("got %v", err)
	}
}

func TestMaskEachLine(t *testing.T) {
	var log bytes.Buffer
	Mask(&log, "first\n second \n\n")
	if log.String() != "::add-mask::first\n::add-mask::second\n" {
		t.Errorf("%q", log.String())
	}
}
