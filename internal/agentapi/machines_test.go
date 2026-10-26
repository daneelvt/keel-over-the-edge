// SPDX-License-Identifier: AGPL-3.0-only

package agentapi_test

import (
	"encoding/json"
	"strings"
	"testing"
)

// The game's routes for machine sailors are tested here, beside the
// approval page and the MCP address they share their grants with.

// TestMachineRoutes: a machine sailor is made from the game up to the cap,
// its name by every sailor's rules, and brings a boat to the fleet; the
// list shows its look in words and its apps; a connection token needs a
// passkey confirmed and is shown once, a new one ending the old; deleting
// one needs the passkey and its name typed again, and frees the name;
// deleting the account deletes its machine sailors.
func TestMachineRoutes(t *testing.T) {
	h := newHarness(t)
	b := h.browser()
	b.sailor("Ann Bonny")
	if _, me, _ := b.do("GET", "/api/me", ""); strings.Contains(me, "machines") {
		t.Fatalf("me with none: %s", me)
	}
	for body, want := range map[string]string{
		`{"name":"Ann Bonny","version":"v1","finish":"f1","colour":"c1"}`: `422 {"error":"taken"}`,
		`{"name":"x","version":"v1","finish":"f1","colour":"c1"}`:         `422 {"error":"short"}`,
		`{"name":"Iron Mary","version":"v1","finish":"f9","colour":"c1"}`: `400 {"error":"look"}`,
		`{"name":"Iron Mary"}`: `400 {"error":"look"}`,
	} {
		status, out := b.post("/api/machines", body)
		if got := strings.TrimSpace(strings.Join([]string{itoa(status), out}, " ")); got != want {
			t.Errorf("%s: %s, want %s", body, got, want)
		}
	}
	status, page := b.post("/api/machines", `{"name":"Iron Mary","version":"v2","finish":"f1","colour":"c2"}`)
	var p struct {
		MCP      string
		Cap      int
		Fleet    map[string]int
		Machines []struct {
			ID, Name string
			Look     struct{ Words, SRGB string }
			AtSea    bool
			Apps     []struct{ ID string }
			Token    *struct{ ID string }
		}
		ConfirmedUntil int64
	}
	if err := json.Unmarshal([]byte(page), &p); status != 201 || err != nil || p.MCP != h.resource || p.Cap != 1 || p.Fleet[boatKind] != 2 ||
		len(p.Machines) != 1 || p.Machines[0].Name != "Iron Mary" || p.Machines[0].Look.Words != "Tin · second · navy blue" ||
		p.Machines[0].Look.SRGB != "#24406b" || p.Machines[0].AtSea || p.Machines[0].Token != nil {
		t.Fatalf("made: %d %s", status, page)
	}
	if _, me, _ := b.do("GET", "/api/me", ""); !strings.Contains(me, `"machines":1`) {
		t.Fatalf("me with one: %s", me)
	}
	if status, out := b.post("/api/machines", `{"name":"Brass Bess","version":"v1","finish":"f1","colour":"c1"}`); status != 409 || out != `{"error":"cap"}` {
		t.Fatalf("over the cap: %d %s", status, out)
	}
	// The machine sailor's name is taken for a human too.
	other := h.browser()
	if status, out := other.post("/account/begin", `{"name":"iron  mary","look":"figure"}`); status != 422 || out != `{"error":"taken"}` {
		t.Fatalf("a human named as the machine sailor: %d %s", status, out)
	}
	id := p.Machines[0].ID
	// A connection token, or a deletion, needs a passkey confirmed.
	if status, out := b.post("/api/machines/token", `{"machine":"`+id+`"}`); status != 403 || out != `{"error":"confirm"}` {
		t.Fatalf("a token unconfirmed: %d %s", status, out)
	}
	if status, out := b.post("/api/machines/delete", `{"machine":"`+id+`","name":"Iron Mary"}`); status != 403 || out != `{"error":"confirm"}` {
		t.Fatalf("deleted unconfirmed: %d %s", status, out)
	}
	first := b.connectionToken()
	second := b.connectionToken()
	if first == second {
		t.Fatal("the same token twice")
	}
	_, page, _ = b.do("GET", "/api/machines", "")
	if strings.Contains(page, first) || strings.Contains(page, second) || !strings.Contains(page, `"token":{"id":`) {
		t.Fatalf("the token listed: %s", page)
	}
	if status, out := b.post("/api/machines/token", `{"machine":"01900000-0000-7000-8000-000000000000"}`); status != 404 {
		t.Fatalf("another's machine sailor: %d %s", status, out)
	}
	if status, _ := b.post("/api/machines/token/revoke", `{"machine":"`+id+`"}`); status != 200 {
		t.Fatal("revoke the token")
	}
	if code, challenge, _ := h.mcpCall(second); code != 401 || !strings.Contains(challenge, "revoked on the account page") {
		t.Fatalf("the token revoked: %d %q", code, challenge)
	}
	if status, out := b.post("/api/machines/revoke", `{"grant":"01900000-0000-7000-8000-000000000000"}`); status != 404 {
		t.Fatalf("revoke another's: %d %s", status, out)
	}
	// Deleting: the name typed again, any case and spacing.
	if status, out := b.post("/api/machines/delete", `{"machine":"`+id+`","name":"Brass Bess"}`); status != 422 || out != `{"error":"name"}` {
		t.Fatalf("the wrong name: %d %s", status, out)
	}
	if status, out := b.post("/api/machines/delete", `{"machine":"`+id+`","name":" iron mary "}`); status != 200 || !strings.Contains(out, `"machines":[]`) ||
		!strings.Contains(out, `"fleet":{"`+boatKind+`":2}`) {
		t.Fatalf("deleted: %d %s", status, out)
	}
	if status, out := other.post("/account/begin", `{"name":"Iron Mary","look":"figure"}`); status != 200 {
		t.Fatalf("the name free: %d %s", status, out)
	}
	// Deleting the account deletes its machine sailors first.
	if status, _ := b.post("/api/machines", `{"name":"Copper Kate","version":"v1","finish":"f1","colour":"c1"}`); status != 201 {
		t.Fatal("another")
	}
	b.connectionToken()
	if status, out := b.post("/api/account/delete", `{"name":"Ann Bonny"}`); status != 200 {
		t.Fatalf("delete the account: %d %s", status, out)
	}
	var left int
	if err := poolQuery(t, h, "SELECT (SELECT count(*) FROM account) + (SELECT count(*) FROM ai_grant) + (SELECT count(*) FROM oauth_token) + (SELECT count(*) FROM boat)", &left); err != nil || left != 0 {
		t.Fatalf("left after the account: %d %v", left, err)
	}
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}
