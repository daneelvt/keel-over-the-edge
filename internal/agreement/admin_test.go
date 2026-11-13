// SPDX-License-Identifier: AGPL-3.0-only

package agreement

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/legal"
)

func adminCall(t *testing.T, h http.Handler, path string, body any) (int, Done, string) {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "http://localhost:9090"+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var d Done
	json.Unmarshal(rec.Body.Bytes(), &d)
	return rec.Code, d, rec.Body.String()
}

func TestAdminAddAndVoid(t *testing.T) {
	ctx := context.Background()
	f := newFakeGitHub(t)
	m := newMemStore()
	c := &Checker{GitHub: f.client(), Store: m, Page: page, Log: quietLog()}
	var signed []string
	a := (&Admin{GitHub: f.client(), Store: m, Checker: c, Signed: func(h string) { signed = append(signed, h) }}).Handler()

	// A minor's pull request waits.
	f.pulls[5] = annsPull()
	c.Check(ctx, store.PullRef{Repo: "o/r", Number: 5})

	add := AddRequest{Login: "ann", Name: "Ann Smith", Guardian: "Carol Smith", GuardianEmail: "carol@example.com", Note: "by e-mail, 14 November", Check: true}
	status, d, _ := adminCall(t, a, "/agreements/api/add", add)
	if status != 200 || d.Done || !strings.Contains(d.Words, "Would record") || !strings.Contains(d.Words, "Carol Smith") || len(m.sigs) != 0 {
		t.Fatalf("add's check: %d %+v", status, d)
	}
	add.Check = false
	status, d, _ = adminCall(t, a, "/agreements/api/add", add)
	if status != 200 || !d.Done || !strings.Contains(d.Words, "1 pull request checked again") {
		t.Fatalf("add: %d %+v", status, d)
	}
	sig := m.sigs[0]
	if sig.GitHubID != ann.ID || sig.How != store.SignedByOwner || sig.Guardian != "Carol Smith" || sig.Version != legal.Current().Number ||
		sig.TextSHA256 != legal.Current().SHA256 || len(signed) != 1 {
		t.Errorf("the signature: %+v", sig)
	}
	drain(t, c)
	if st := f.last(); st.State != "success" {
		t.Errorf("the minor's pull request: %+v", st)
	}
	if _, d, _ := adminCall(t, a, "/agreements/api/add", add); !strings.Contains(d.Words, "already") || len(m.sigs) != 1 {
		t.Errorf("adding again: %+v", d)
	}

	for name, bad := range map[string]AddRequest{
		"no name":          {Login: "ann", Note: "x"},
		"no note":          {Login: "ann", Name: "Ann"},
		"half a guardian":  {Login: "ann", Name: "Ann", Note: "x", Guardian: "Carol"},
		"a bad e-mail":     {Login: "ann", Name: "Ann", Note: "x", Guardian: "Carol", GuardianEmail: "carol"},
		"no such version":  {Login: "ann", Name: "Ann", Note: "x", Version: 99},
		"nobody on GitHub": {Login: "nobody", Name: "No One", Note: "x"},
	} {
		if status, _, _ := adminCall(t, a, "/agreements/api/add", bad); status/100 == 2 {
			t.Errorf("%s: %d", name, status)
		}
	}

	void := VoidRequest{ID: sig.ID.String(), Reason: "entered for the wrong account", Check: true}
	if _, d, _ := adminCall(t, a, "/agreements/api/void", void); d.Done || !m.sigs[0].Voided.IsZero() {
		t.Errorf("void's check: %+v", d)
	}
	void.Check = false
	if status, d, _ := adminCall(t, a, "/agreements/api/void", void); status != 200 || !d.Done || m.sigs[0].Voided.IsZero() {
		t.Errorf("void: %d %+v", status, d)
	}
	if status, _, _ := adminCall(t, a, "/agreements/api/void", void); status != 404 {
		t.Errorf("voiding again: %d", status)
	}
	if status, _, _ := adminCall(t, a, "/agreements/api/void", VoidRequest{ID: sig.ID.String()}); status != 400 {
		t.Errorf("a void without a reason: %d", status)
	}

	req := httptest.NewRequest(http.MethodGet, "http://localhost:9090/agreements/api/signatures.json", nil)
	rec := httptest.NewRecorder()
	a.ServeHTTP(rec, req)
	var list []SignatureJSON
	if json.Unmarshal(rec.Body.Bytes(), &list); len(list) != 1 || list[0].VoidedAt == "" || list[0].GuardianEmail != "carol@example.com" {
		t.Errorf("the list: %s", rec.Body.String())
	}

	// Guarded as the world page is: not from another host.
	req = httptest.NewRequest(http.MethodGet, "http://keel.example/agreements/api/signatures.json", nil)
	rec = httptest.NewRecorder()
	a.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("from another host: %d", rec.Code)
	}
}

// TestAdminAddByNumber: while the App is not set up, a signature is
// entered by the account's number and name.
func TestAdminAddByNumber(t *testing.T) {
	m := newMemStore()
	a := (&Admin{Store: m, Checker: &Checker{}}).Handler()
	if status, _, _ := adminCall(t, a, "/agreements/api/add", AddRequest{Login: "ann", Name: "Ann", Note: "paper"}); status != 400 {
		t.Errorf("by name alone, not set up: %d", status)
	}
	if status, d, body := adminCall(t, a, "/agreements/api/add", AddRequest{Login: "ann", GitHubID: 7, Name: "Ann", Note: "paper"}); status != 200 || !d.Done {
		t.Errorf("by number: %d %s", status, body)
	}
}
