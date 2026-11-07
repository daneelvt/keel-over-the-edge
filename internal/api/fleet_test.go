// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/fleet"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// TestFleet: a new sailor's fleet holds a Jolly boat and a keelboat; the
// first is theirs until they take another; a boat's look is changed, its
// name checked and its number its own; a boat not of the fleet is not
// found.
func TestFleet(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	st, _ := storetest.Store(t, store.Options{})
	srv := newTestServer(t, st, func(c *Config) {
		c.Boat, c.SharedBoats = "jolly-boat", []string{"keelboat"}
		c.Fleet = fleet.New(fleet.Config{Store: st, Catalog: cat, Log: slog.New(slog.DiscardHandler)})
	})
	b, _ := makeSailor(t, srv, "Ann Bonny")
	read := func(status int, body string) fleetJSON {
		t.Helper()
		var f fleetJSON
		if status != 200 {
			t.Fatalf("%d %s", status, body)
		}
		if err := json.Unmarshal([]byte(body), &f); err != nil {
			t.Fatal(err)
		}
		return f
	}
	f := read(b.do("GET", "/api/fleet", ""))
	if len(f.Boats) != 2 || f.Boats[0].Kind != "jolly-boat" || f.Boats[1].Kind != "keelboat" || f.Boat != f.Boats[0].ID {
		t.Fatalf("the fleet: %+v", f)
	}
	if b0 := f.Boats[0]; b0.Number != 1 || b0.Paint != "white-lead" || b0.Cloth != "bleached-canvas" || b0.Name != "" || b0.AtSea || b0.Yours {
		t.Fatalf("the Jolly boat: %+v", b0)
	}
	keel := f.Boats[1].ID
	f = read(b.post("/api/boat", `{"boat":"`+keel+`"}`))
	if f.Boat != keel || !f.Boats[1].Yours || f.Boats[1].Sailor != "Ann Bonny" || f.Boats[1].Machine {
		t.Fatalf("the keelboat taken: %+v", f)
	}
	f = read(b.post("/api/boat/look", `{"boat":"`+keel+`","paint":"red-ochre","cloth":"tanbark","number":311,"name":"  Saltpeter "}`))
	if k := f.Boats[1]; k.Paint != "red-ochre" || k.Cloth != "tanbark" || k.Number != 311 || k.Name != "Saltpeter" {
		t.Fatalf("the keelboat's look: %+v", k)
	}
	f = read(b.post("/api/boat/look", `{"boat":"`+keel+`","name":""}`))
	if k := f.Boats[1]; k.Name != "" || k.Paint != "red-ochre" || k.Number != 311 {
		t.Fatalf("its name cleared: %+v", k)
	}
	for _, c := range []struct {
		path, body string
		status     int
		want       string
	}{
		{"/api/boat/look", `{"boat":"` + keel + `","paint":"puce"}`, 400, `{"error":"look"}`},
		{"/api/boat/look", `{"boat":"` + keel + `","number":10000}`, 400, `{"error":"look"}`},
		{"/api/boat/look", `{"boat":"` + keel + `","name":"J"}`, 422, `{"error":"short"}`},
		{"/api/boat/look", `{"boat":"` + keel + `","name":"Abcdefghijklmnopqrstu"}`, 422, `{"error":"long"}`},
		{"/api/boat/look", `{"boat":"` + keel + `","name":"Port Royal"}`, 422, ``},
		{"/api/boat/look", `{"boat":"00000000-0000-0000-0000-000000000001","number":5}`, 404, `{"error":"boat"}`},
		{"/api/boat", `{"boat":"nonsense"}`, 404, `{"error":"boat"}`},
		{"/api/boat", `{"boat":"` + keel + `","more":1}`, 400, ``},
	} {
		status, body := b.post(c.path, c.body)
		if status != c.status || c.want != "" && strings.TrimSpace(body) != c.want {
			t.Errorf("%s %s: %d %s", c.path, c.body, status, body)
		}
	}
	// Another sailor's keelboat has number 1; Ann's may not take it.
	other, _ := makeSailor(t, srv, "Mary Read")
	if of := read(other.do("GET", "/api/fleet", "")); of.Boats[1].Number != 1 || of.Boats[0].Number != 2 {
		t.Fatalf("Mary's fleet: %+v", of)
	}
	if status, body := b.post("/api/boat/look", `{"boat":"`+keel+`","number":1}`); status != 409 || strings.TrimSpace(body) != `{"error":"number"}` {
		t.Fatalf("another's number: %d %s", status, body)
	}
	if status, _ := other.post("/api/boat", `{"boat":"`+keel+`"}`); status != 404 {
		t.Fatalf("Mary takes Ann's keelboat: %d", status)
	}
}
