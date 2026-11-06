// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// seat is the world's answer to a change of look, and the looks it was
// asked to change to.
type seat struct {
	place LookPlace
	codes []uint32
}

func (s *seat) ChangeLook(_ context.Context, _ store.AccountID, code uint32) (LookPlace, error) {
	s.codes = append(s.codes, code)
	return s.place, nil
}

const (
	oldSalt   = `"look":"oldsalt","version":"male","skin":"tone-5","hair":"silver","colour":"indigo-navy"`
	oldSaltMe = `"look":"oldsalt","version":"male","skin":"tone-5","hair":"silver","colour":"indigo-navy","lookChosen":true`
)

// A new sailor's look must be made of the catalog's choices: a person's,
// all five.
func TestBeginRefusesALook(t *testing.T) {
	srv, _, _ := accountServer(t)
	b := newBrowser(t, srv)
	for _, look := range []string{
		`"look":"stand-in"`,
		`"look":"rover","version":"female","skin":"tone-2","hair":"brown"`,
		`"look":"oldsalt","version":"male","skin":"tone-5","hair":"brown","colour":"indigo-navy"`,
		`"look":"machine","version":"female","skin":"tone-2","hair":"brown","colour":"madder-red"`,
		`"look":"rover","version":"female","skin":"tone-9","hair":"brown","colour":"madder-red"`,
	} {
		if status, body := b.post("/account/begin", `{"name":"Ann Bonny",`+look+`}`); status != 400 || body != `{"error":"look"}` {
			t.Errorf("%s: %d %s", look, status, body)
		}
	}
}

// A sailor's look is changed ashore, and in Port Royal's harbour, and kept;
// at sea beyond the harbour it is refused and stays.
func TestSetLook(t *testing.T) {
	st, _ := storetest.Store(t, store.Options{})
	at := &seat{}
	srv := newTestServer(t, st, func(c *Config) { c.LookSeat = at })
	b, _ := makeSailor(t, srv, "Ann Bonny")
	if status, body := b.post("/api/sailor/look", `{`+oldSalt+`}`); status != 200 || !strings.Contains(body, oldSaltMe) {
		t.Fatalf("ashore: %d %s", status, body)
	}
	if status, body := b.do("GET", "/api/me", ""); status != 200 || !strings.Contains(body, oldSaltMe) {
		t.Fatalf("me after: %d %s", status, body)
	}
	want, _ := testBook.Of(at.codes[0])
	if want.Look != "oldsalt" || want.Hair != "silver" {
		t.Fatalf("the world was asked for %+v", want)
	}
	at.place = Away
	if status, body := b.post("/api/sailor/look", `{"look":"rover","version":"male","skin":"tone-1","hair":"black","colour":"black"}`); status != 409 || body != `{"error":"port-royal"}` {
		t.Fatalf("away: %d %s", status, body)
	}
	if _, body := b.do("GET", "/api/me", ""); !strings.Contains(body, oldSaltMe) {
		t.Fatalf("the look changed away from Port Royal: %s", body)
	}
	at.place = InHarbour
	rover := `"look":"rover","version":"male","skin":"tone-1","hair":"black","colour":"black"`
	if status, body := b.post("/api/sailor/look", `{`+rover+`}`); status != 200 || !strings.Contains(body, rover+`,"lookChosen":true`) {
		t.Fatalf("in the harbour: %d %s", status, body)
	}
	for _, bad := range []string{`{"look":"machine","version":"female","skin":"","hair":"","colour":"black"}`, `{"look":"rover"}`, `{` + rover + `,"finish":"brass"}`} {
		if status, body := b.post("/api/sailor/look", bad); status != 400 {
			t.Errorf("%s: %d %s", bad, status, body)
		}
	}
	if len(at.codes) != 3 {
		t.Fatalf("the world was asked %d times", len(at.codes))
	}
}

// A sailor made before looks were chosen is shown a look drawn for it, the
// same each time, not chosen; choosing it keeps it.
func TestDrawnLook(t *testing.T) {
	st, u := storetest.Store(t, store.Options{})
	srv := newTestServer(t, st, nil)
	b, _ := makeSailor(t, srv, "Ann Bonny")
	pool := storetest.PoolOn(t, u)
	if _, err := pool.Exec(context.Background(),
		"UPDATE sailor SET look = 'stand-in', version = NULL, skin = NULL, hair = NULL, colour = NULL, look_chosen = false"); err != nil {
		t.Fatal(err)
	}
	srv2 := newTestServer(t, st, nil)
	b.srv = srv2
	_, first := b.do("GET", "/api/me", "")
	_, again := b.do("GET", "/api/me", "")
	if !strings.Contains(first, `"lookChosen":false`) || first != again || strings.Contains(first, "stand-in") {
		t.Fatalf("drawn: %s, then %s", first, again)
	}
	i, j := strings.Index(first, `"look":`), strings.Index(first, `,"lookChosen"`)
	drawn := first[i:j]
	if status, body := b.post("/api/sailor/look", `{`+drawn+`}`); status != 200 || !strings.Contains(body, drawn+`,"lookChosen":true`) {
		t.Fatalf("kept: %d %s", status, body)
	}
}
