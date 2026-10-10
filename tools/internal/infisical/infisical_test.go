// SPDX-License-Identifier: AGPL-3.0-only

package infisical

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path"
	"strings"
	"testing"
)

// fakeInfisical answers as Infisical does, for one identity, one token and
// one folder of one project.
func fakeInfisical(t *testing.T, values map[string]string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/auth/oidc-auth/login" && r.Method == http.MethodPost:
			var in map[string]string
			json.NewDecoder(r.Body).Decode(&in)
			if in["identityId"] != "gha-accounts-id" || in["jwt"] != "the-job-token" {
				w.WriteHeader(http.StatusUnauthorized)
				io.WriteString(w, `{"message":"OIDC subject not allowed"}`)
				return
			}
			io.WriteString(w, `{"accessToken":"the-access-token","expiresIn":600}`)
		case strings.HasPrefix(r.URL.Path, "/api/v4/secrets/"):
			q := r.URL.Query()
			if r.Header.Get("Authorization") != "Bearer the-access-token" || q.Get("projectId") != "keel-accounts-id" || q.Get("environment") != "prod" || q.Get("secretPath") != "/accounts" {
				w.WriteHeader(http.StatusForbidden)
				io.WriteString(w, `{"message":"forbidden"}`)
				return
			}
			v, ok := values[path.Base(r.URL.Path)]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				io.WriteString(w, `{"message":"Secret not found"}`)
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"secret": map[string]string{"secretValue": v}})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestReadMasksEachValue(t *testing.T) {
	srv := fakeInfisical(t, map[string]string{"A": "first-value", "B": "line one\nline two"})
	var log bytes.Buffer
	c := &Client{Host: srv.URL + "/", HC: srv.Client(), Log: &log}
	s, err := c.Login(context.Background(), "gha-accounts-id", "the-job-token")
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.Read(context.Background(), "keel-accounts-id", "prod", "/accounts", "A", "B")
	if err != nil {
		t.Fatal(err)
	}
	if got["A"] != "first-value" || got["B"] != "line one\nline two" {
		t.Errorf("read %q", got)
	}
	for _, want := range []string{"::add-mask::the-access-token\n", "::add-mask::first-value\n", "::add-mask::line one\n", "::add-mask::line two\n"} {
		if !strings.Contains(log.String(), want) {
			t.Errorf("the log does not mask %q:\n%s", want, log.String())
		}
	}
}

func TestRefusals(t *testing.T) {
	srv := fakeInfisical(t, map[string]string{"EMPTY": ""})
	c := &Client{Host: srv.URL, HC: srv.Client(), Log: io.Discard}
	if _, err := c.Login(context.Background(), "gha-accounts-id", "another-token"); err == nil || !strings.Contains(err.Error(), "401 Unauthorized: OIDC subject not allowed") {
		t.Errorf("a token Infisical refuses: %v", err)
	}
	s, err := c.Login(context.Background(), "gha-accounts-id", "the-job-token")
	if err != nil {
		t.Fatal(err)
	}
	for name, tc := range map[string]struct{ project, secret, want string }{
		"another project": {"keel-cluster-id", "EMPTY", "403 Forbidden"},
		"no such secret":  {"keel-accounts-id", "MISSING", "reading prod/accounts/MISSING from Infisical: the answer was 404 Not Found: Secret not found"},
		"an empty secret": {"keel-accounts-id", "EMPTY", "prod/accounts/EMPTY is empty in Infisical"},
	} {
		if _, err := s.Read(context.Background(), tc.project, "prod", "/accounts", tc.secret); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: %v", name, err)
		}
	}
}
