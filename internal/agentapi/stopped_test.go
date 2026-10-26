// SPDX-License-Identifier: AGPL-3.0-only

package agentapi_test

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/daneelvt/keel-over-the-edge/internal/accounts"
	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// signIn signs the browser in with its newest passkey, as the start
// screen's button does.
func (b *browser) signIn() (int, string) {
	b.t.Helper()
	status, opts := b.post("/signin/begin", "")
	if status != 200 {
		return status, opts
	}
	answer, err := b.keys[len(b.keys)-1].Get([]byte(opts))
	if err != nil {
		b.t.Fatal(err)
	}
	return b.post("/signin/finish", string(answer))
}

// confirm confirms the browser's session with its newest passkey, as the
// account page does before what cannot be undone.
func (b *browser) confirm() {
	b.t.Helper()
	status, opts := b.post("/api/account/confirm/begin", "")
	if status != 200 {
		b.t.Fatalf("confirm: %d %s", status, opts)
	}
	answer, err := b.keys[len(b.keys)-1].Get([]byte(opts))
	if err != nil {
		b.t.Fatal(err)
	}
	if status, body := b.post("/api/account/confirm/finish", string(answer)); status != 200 {
		b.t.Fatalf("confirm: %d %s", status, body)
	}
}

// accountOf is the account of a sailor's name.
func accountOf(t *testing.T, h *harness, name string) store.AccountID {
	t.Helper()
	var id [16]byte
	if err := storetest.PoolOn(t, h.db).QueryRow(context.Background(), "SELECT account_id FROM sailor WHERE name = $1", name).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// TestEveryDoorRefusesAStoppedAccount: a stopped human and its machine
// sailor are refused at every door, each in its own words, and the
// passkey's sign-in is never told the passkey is unknown, which would let
// the browser forget it; after a start, every door admits them again but
// for the grants the stop revoked, which stay revoked.
func TestEveryDoorRefusesAStoppedAccount(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	b := h.browser()
	b.sailor("Ann Bonny")
	ann := accountOf(t, h, "Ann Bonny")
	code, hash := auth.NewRecoveryCode()
	if err := h.st.SetRecoveryCode(ctx, ann, hash); err != nil {
		t.Fatal(err)
	}
	b.signOut()
	// An app approved for a machine sailor made on the approval page, its
	// tokens issued; another app's code given and not yet exchanged.
	app := h.register("https://app.example/cb")
	access, refresh := h.grant(b, app, makeAnn)
	other := h.register("https://other.example/cb")
	verifier, challenge := pkcePair("0th3r")
	pending := b.approved(h.authorizeURL(other.id, other.redirect, "s", challenge, nil), `{"machine":"`+machineOf(t, h)+`"}`)
	if status, out := b.signIn(); status != 200 {
		t.Fatalf("sign in: %d %s", status, out)
	}
	connection := b.connectionToken()
	for _, tok := range []string{access, connection} {
		if status, challenge, _ := h.mcpCall(tok); status == 401 {
			t.Fatalf("before the stop: %d %s", status, challenge)
		}
	}

	done, err := h.hand.Stop(ctx, accounts.Request{Account: ann, Reason: "a test of every door"})
	if err != nil || !done.Done || done.Effects.Machines != 1 || done.Effects.Sessions != 2 || done.Effects.Grants != 3 {
		t.Fatalf("stop: %+v %v", done, err)
	}
	if _, err := h.hand.Stop(ctx, accounts.Request{Account: ann, Reason: "again"}); err != accounts.ErrAlreadyStopped {
		t.Fatalf("stopped twice: %v", err)
	}

	// The session's cookie names no account.
	if status, _, _ := b.do("GET", "/api/me", ""); status != 401 {
		t.Fatalf("its session: %d", status)
	}
	// Signing in, by the button or the recovery code, is refused as
	// stopped, after the passkey is checked: never as unknown.
	again := h.browser()
	again.keys = b.keys
	if status, out := again.signIn(); status != 403 || out != `{"error":"stopped"}` {
		t.Fatalf("sign in: %d %s", status, out)
	}
	if status, out := again.post("/recovery", `{"code":"`+code+`"}`); status != 403 || out != `{"error":"stopped"}` {
		t.Fatalf("the recovery code: %d %s", status, out)
	}
	if n := testutil.ToFloat64(h.metrics.Ceremonies.WithLabelValues(store.CeremonySignIn, "stopped")); n != 1 {
		t.Errorf("%v sign-ins counted stopped", n)
	}
	// The approval page.
	_, challenge2 := pkcePair("thrd")
	if status, body, _ := again.do("GET", h.authorizeURL(app.id, app.redirect, "s", challenge2, nil), ""); status != 200 {
		t.Fatalf("authorize: %d %s", status, body)
	}
	if status, out := again.passkey(); status != 403 || out != `{"error":"stopped"}` {
		t.Fatalf("the approval's passkey: %d %s", status, out)
	}
	// The code exchange and the refresh.
	status, tok := h.form("/oauth/token", url.Values{
		"grant_type": {"authorization_code"}, "code": {pending.Query().Get("code")}, "client_id": {other.id},
		"redirect_uri": {other.redirect}, "code_verifier": {verifier}, "resource": {h.resource},
	})
	if c, words := errorOf(tok); status != 400 || c != "invalid_grant" || !strings.Contains(words, "revoked by the game's operator") {
		t.Fatalf("the code: %d %v", status, tok)
	}
	status, tok = h.form("/oauth/token", url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}, "client_id": {app.id}})
	if c, words := errorOf(tok); status != 400 || c != "invalid_grant" || !strings.Contains(words, "revoked by the game's operator") {
		t.Fatalf("the refresh: %d %v", status, tok)
	}
	// The MCP address, with the stop's words.
	for _, tok := range []string{access, connection} {
		if status, challenge, body := h.mcpCall(tok); status != 401 || !strings.Contains(challenge, oauth.WordsStopped) || !strings.Contains(body, "stopped") {
			t.Fatalf("the MCP address: %d %q %s", status, challenge, body)
		}
	}
	if n := testutil.ToFloat64(h.metrics.DoorRequests.WithLabelValues("stopped")); n != 2 {
		t.Errorf("%v door refusals counted stopped", n)
	}

	// Started again: the passkey signs in, the recovery code is still
	// good, and the app is approved again; the grants revoked stay so.
	if _, err := h.hand.Start(ctx, accounts.Request{Account: ann}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.hand.Start(ctx, accounts.Request{Account: ann}); err != accounts.ErrNotStopped {
		t.Fatalf("started twice: %v", err)
	}
	for _, tok := range []string{access, connection} {
		if status, challenge, _ := h.mcpCall(tok); status != 401 || !strings.Contains(challenge, "revoked by the game's operator") {
			t.Fatalf("a token the stop revoked: %d %q", status, challenge)
		}
	}
	if status, out := again.signIn(); status != 200 {
		t.Fatalf("sign in after the start: %d %s", status, out)
	}
	if access2, _ := h.grant(b, app, `{"machine":"`+machineOf(t, h)+`"}`); access2 == "" {
		t.Fatal("approved again")
	} else if status, challenge, _ := h.mcpCall(access2); status == 401 {
		t.Fatalf("a new approval: %d %q", status, challenge)
	}

	// A machine sailor stopped on its own: its human is not, but nothing
	// may be approved for it or given a token, and the account page says
	// so; its human's start leaves it stopped.
	machine, _ := store.ParseID(machineOf(t, h))
	if _, err := h.hand.Stop(ctx, accounts.Request{Account: machine, Reason: "alone"}); err != nil {
		t.Fatal(err)
	}
	if status, out := b.signIn(); status != 200 {
		t.Fatalf("its human signs in: %d %s", status, out)
	}
	_, challenge3 := pkcePair("f0urth")
	if status, body, _ := b.do("GET", h.authorizeURL(app.id, app.redirect, "s", challenge3, nil), ""); status != 200 {
		t.Fatalf("authorize: %d %s", status, body)
	}
	if status, out := b.passkey(); status != 200 {
		t.Fatalf("the approval's passkey: %d %s", status, out)
	}
	if status, out := b.post("/oauth/approve", `{"machine":"`+machine.String()+`"}`); status != 409 || out != `{"error":"stopped"}` {
		t.Fatalf("approved for a stopped machine sailor: %d %s", status, out)
	}
	b.confirm()
	if status, out := b.post("/api/machines/token", `{"machine":"`+machine.String()+`"}`); status != 409 || out != `{"error":"stopped"}` {
		t.Fatalf("a token for a stopped machine sailor: %d %s", status, out)
	}
	_, page, _ := b.do("GET", "/api/machines", "")
	var p struct{ Machines []struct{ Stopped int64 } }
	if err := json.Unmarshal([]byte(page), &p); err != nil || len(p.Machines) != 1 || p.Machines[0].Stopped == 0 {
		t.Fatalf("the account page: %s", page)
	}
	if _, err := h.hand.Stop(ctx, accounts.Request{Account: ann, Reason: "both"}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.hand.Start(ctx, accounts.Request{Account: ann}); err != nil {
		t.Fatal(err)
	}
	stopped, err := h.st.Stopped(ctx)
	if err != nil || len(stopped) != 1 || stopped[machine] != store.AI {
		t.Fatalf("stopped after its human's start: %v %v", stopped, err)
	}
	// The recovery code the stop left unspent works.
	again.signOut()
	if status, out := again.post("/recovery", `{"code":"`+code+`"}`); status != 200 {
		t.Fatalf("the recovery code after the start: %d %s", status, out)
	}
}
