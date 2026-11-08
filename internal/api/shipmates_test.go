// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/shipmates"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// TestShipmatesRoutes: a person's list, an offer by ID that needs sailing
// together first, its acceptance, Appear offline, ending it, and the
// refusals: nobody on the lists, a seat with no world, a malformed ID.
func TestShipmatesRoutes(t *testing.T) {
	ctx := context.Background()
	ties := aboard.NewTies(nil, nil)
	srv := newAboardServer(t, func(c *Config) {
		c.Shipmates = shipmates.New(shipmates.Config{Store: c.Sailing.(*sailing).Store, Ties: ties})
	})
	st := srv.st
	ann, _ := makeSailor(t, srv.testServer, "Ann Bonny")
	bob, _ := makeSailor(t, srv.testServer, "Bob Read")
	idOf := func(name string) store.AccountID {
		var id [16]byte
		if err := storetest.PoolOn(t, srv.u).QueryRow(ctx, "SELECT account_id FROM sailor WHERE name = $1", name).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	annID, bobID := idOf("Ann Bonny"), idOf("Bob Read")
	list := func(b *browser) shipmates.List {
		t.Helper()
		status, body := b.do("GET", "/api/shipmates", "")
		var l shipmates.List
		if status != 200 || json.Unmarshal([]byte(body), &l) != nil {
			t.Fatalf("the list: %d %s", status, body)
		}
		return l
	}
	if l := list(ann); l.Shipmates == nil || l.Offers == nil || l.Recent == nil || !l.Messages || l.Offline {
		t.Fatalf("an empty list: %+v", l)
	}
	if status, body := ann.post("/api/shipmates/offer", `{"id":"`+bobID.String()+`"}`); status != 200 || !strings.Contains(body, `"not-yet"`) {
		t.Fatalf("an offer before sailing together: %d %s", status, body)
	}
	if err := st.SawTogether(ctx, annID, bobID, time.Now(), 3, true); err != nil {
		t.Fatal(err)
	}
	if status, body := ann.post("/api/shipmates/offer", `{"id":"`+bobID.String()+`"}`); status != 200 || !strings.Contains(body, `"offered"`) {
		t.Fatalf("an offer: %d %s", status, body)
	}
	if l := list(bob); len(l.Offers) != 1 || l.Offers[0].ID != annID.String() || len(l.Recent) != 1 {
		t.Fatalf("Bob's list: %+v", l)
	}
	if status, body := bob.post("/api/shipmates/accept", `{"id":"`+annID.String()+`"}`); status != 200 || !strings.Contains(body, `"made"`) {
		t.Fatalf("accepting: %d %s", status, body)
	}
	if status, _ := bob.post("/api/me/offline", `{"on":true}`); status != 204 {
		t.Fatalf("appear offline: %d", status)
	}
	if l := list(ann); len(l.Shipmates) != 1 || l.Shipmates[0].Name != "Bob Read" || !list(bob).Offline {
		t.Fatalf("Ann's shipmates: %+v", l)
	}
	if status, _ := ann.post("/api/shipmates/end", `{"id":"`+bobID.String()+`"}`); status != 204 {
		t.Fatalf("ending it: %d", status)
	}
	if l := list(bob); len(l.Shipmates) != 0 || ties.Shipmates(annID, bobID) {
		t.Fatalf("Bob's list after the end: %+v", l)
	}
	for _, c := range []struct {
		path, body string
		status     int
		want       string
	}{
		{"/api/shipmates/accept", `{"id":"` + annID.String() + `"}`, 409, "gone"},
		{"/api/shipmates/offer", `{"seat":1}`, 404, "no-one"},
		{"/api/shipmates/offer", `{"id":"nobody"}`, 400, "id"},
		{"/api/shipmates/offer", `{"id":"` + annID.String() + `"}`, 200, "not-yet"},
		{"/api/shipmates/offer", `{"id":"` + bobID.String() + `"}`, 404, "no-one"},
		{"/api/shipmates/report", `{"id":"` + store.AccountID{9}.String() + `","reason":"other"}`, 404, "no-one"},
		{"/api/me/offline", `{}`, 400, "on"},
	} {
		if status, body := bob.post(c.path, c.body); status != c.status || !strings.Contains(body, c.want) {
			t.Errorf("%s %s: %d %s", c.path, c.body, status, body)
		}
	}
}
