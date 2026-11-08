// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/accounts"
	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/auth/softkey"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// sailing is the store, counting the links it is asked for.
type sailing struct {
	*store.Store
	lookups atomic.Int32
}

func (s *sailing) SailLink(ctx context.Context, hash [32]byte) (store.SailLink, error) {
	s.lookups.Add(1)
	return s.Store.SailLink(ctx, hash)
}

// deck is a world in which every skipper sails the Swift, a keelboat,
// and may take crew.
type deck struct{ can string }

func (d deck) LinkCan(_, _ store.AccountID) (string, uint16, string) { return d.can, 1, "Swift" }

// aboardServer is a server with sailing together: the store, the owner's
// switches, links made at an origin of its own, and the sessions' cache.
type aboardServer struct {
	*testServer
	st       *store.Store
	u        string
	sail     *sailing
	switches *aboard.Switches
	sessions *auth.Cache
}

func newAboardServer(t *testing.T, change func(*Config)) *aboardServer {
	t.Helper()
	st, u := storetest.Store(t, store.Options{})
	s := &aboardServer{st: st, u: u, sail: &sailing{Store: st}, switches: aboard.NewSwitches(aboard.DefaultLifetime)}
	s.testServer = newTestServer(t, st, func(c *Config) {
		c.Sailing, c.Switches, c.Origin = s.sail, s.switches, "https://keel.example"
		c.Young = c.Deletions.(*accounts.Accounts)
		s.sessions = c.Sessions
		if change != nil {
			change(c)
		}
	})
	return s
}

// bornAgo is a month of birth as a request gives it, years and months
// before this month.
func bornAgo(years, months int) string {
	now := time.Now().UTC()
	m := now.Year()*12 + int(now.Month()) - 1 - years*12 - months
	return fmt.Sprintf(`{"year":%d,"month":%d}`, m/12, m%12+1)
}

func beginBody(name, born string) string {
	b := ""
	if born != "" {
		b = `,"born":` + born
	}
	return `{"name":"` + name + `","look":"rover","version":"female","skin":"tone-2","hair":"brown","colour":"madder-red"` + b + `}`
}

// rawPost sends a JSON POST with the cookies given, returning the answer
// and its cookies.
func rawPost(t *testing.T, url, body string, cookies ...*http.Cookie) (int, string, []*http.Cookie) {
	t.Helper()
	req, _ := http.NewRequest("POST", url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for _, c := range cookies {
		req.AddCookie(c)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	return res.StatusCode, strings.TrimSpace(readAll(res)), res.Cookies()
}

func readAll(res *http.Response) string {
	b, _ := io.ReadAll(res.Body)
	return string(b)
}

// checkYoungCookie checks the cookie that answers a player under 13.
func checkYoungCookie(t *testing.T, cookies []*http.Cookie) {
	t.Helper()
	for _, c := range cookies {
		if c.Name == YoungCookie {
			if c.Value != "1" || c.Path != "/" || c.MaxAge != 30*24*3600 || !c.Secure || c.HttpOnly || c.SameSite != http.SameSiteLaxMode {
				t.Errorf("the young cookie: %+v", c)
			}
			return
		}
	}
	t.Errorf("no young cookie in %v", cookies)
}

// TestBornAtBegin: making a sailor asks when its player was born; under
// 13 nothing is made or kept, not in the database and not in the log, and
// the cookie answers the same before anything else.
func TestBornAtBegin(t *testing.T) {
	s := newAboardServer(t, nil)
	now := time.Now().UTC()
	for _, born := range []string{"", `null`, `"2001-04"`, `{"year":2001}`, `{"month":4}`, `{"year":2001,"month":13}`, `{"year":2001,"month":0}`,
		`{"year":1899,"month":12}`, `{"year":2001,"month":4,"day":1}`, `{"year":2001.5,"month":4}`,
		fmt.Sprintf(`{"year":%d,"month":1}`, now.Year()+1)} {
		if status, body, _ := rawPost(t, s.URL+"/account/begin", beginBody("Ann Bonny", born)); status != 400 || body != `{"error":"born"}` {
			t.Errorf("born %s: %d %s", born, status, body)
		}
	}
	young := bornAgo(12, 11)
	status, body, cookies := rawPost(t, s.URL+"/account/begin", beginBody("Ann Bonny", young))
	if status != 403 || body != `{"error":"young"}` {
		t.Fatalf("under 13: %d %s", status, body)
	}
	checkYoungCookie(t, cookies)
	for _, c := range cookies {
		if strings.HasPrefix(c.Name, "__Host-keel-") {
			t.Errorf("a cookie besides: %+v", c)
		}
	}
	// The cookie answers first, whatever the answer now.
	if status, body, _ := rawPost(t, s.URL+"/account/begin", beginBody("Ann Bonny", bornAgo(30, 0)), &http.Cookie{Name: YoungCookie, Value: "1"}); status != 403 || body != `{"error":"young"}` {
		t.Fatalf("with the cookie: %d %s", status, body)
	}
	if status, body, _ := rawPost(t, s.URL+"/account/finish", `{}`, &http.Cookie{Name: YoungCookie, Value: "1"}); status != 403 || body != `{"error":"young"}` {
		t.Fatalf("finish with the cookie: %d %s", status, body)
	}
	for _, table := range []string{"account", "webauthn_ceremony", "account_action"} {
		if n := count(t, s.u, table); n != 0 {
			t.Errorf("%s: %d rows after the young answers", table, n)
		}
	}
	if logs := s.logs.String(); strings.Contains(logs, "born") || strings.Contains(logs, "year") || strings.Contains(logs, "young") {
		t.Errorf("the log tells of the answer: %s", logs)
	}

	// Thirteen this month makes a sailor, and keeps the month.
	b := newBrowser(t, s.testServer)
	status, opts := b.post("/account/begin", beginBody("Ann Bonny", bornAgo(13, 0)))
	if status != 200 {
		t.Fatalf("thirteen: %d %s", status, opts)
	}
	if n := count(t, s.u, "webauthn_ceremony WHERE born IS NOT NULL"); n != 1 {
		t.Fatalf("the ceremony's month: %d", n)
	}
	key, answer, err := softkey.Create([]byte(opts), testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	if status, body := b.post("/account/finish", string(answer)); status != 201 {
		t.Fatalf("finish: %d %s", status, body)
	}
	b.keys = append(b.keys, key)
	var born int32
	if err := storetest.PoolOn(t, s.u).QueryRow(context.Background(), "SELECT born FROM account").Scan(&born); err != nil {
		t.Fatal(err)
	}
	if want, _ := bornCode(bornAgo(13, 0)); born != want {
		t.Fatalf("kept %d, want %d", born, want)
	}
	if status, body := b.do("GET", "/api/me", ""); status != 200 || !strings.Contains(body, `"born":true,"rules":false`) {
		t.Fatalf("me: %d %s", status, body)
	}
}

// bornCode is a request's month of birth as the database keeps it.
func bornCode(s string) (int32, bool) {
	var y, m int
	if _, err := fmt.Sscanf(s, `{"year":%d,"month":%d}`, &y, &m); err != nil {
		return 0, false
	}
	return int32(y*100 + m), true
}

// older makes a sailor as one made before the question was asked: no
// month of birth.
func (s *aboardServer) older(t *testing.T, name string) (*browser, store.AccountID) {
	t.Helper()
	b, _ := makeSailor(t, s.testServer, name)
	id := s.idOf(t, name)
	mustExec(t, s.u, "UPDATE account SET born = NULL WHERE id = $1", id)
	s.sessions.ForgetAccount(id)
	return b, id
}

func (s *aboardServer) idOf(t *testing.T, name string) store.AccountID {
	t.Helper()
	var id [16]byte
	if err := storetest.PoolOn(t, s.u).QueryRow(context.Background(), "SELECT account_id FROM sailor WHERE name = $1", name).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func mustExec(t *testing.T, u, sql string, args ...any) {
	t.Helper()
	if _, err := storetest.PoolOn(t, u).Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
}

// TestBornOnce: an account made before the question answers it once; an
// answer under 13 keeps nothing of it and stops the account for the owner
// to review, its reason the owner's alone.
func TestBornOnce(t *testing.T) {
	s := newAboardServer(t, nil)
	ann, annID := s.older(t, "Ann Bonny")
	if status, body := ann.do("GET", "/api/me", ""); status != 200 || !strings.Contains(body, `"born":false`) {
		t.Fatalf("me before: %d %s", status, body)
	}
	if status, body := ann.post("/api/me/born", `{"year":2001,"month":13}`); status != 400 || body != `{"error":"born"}` {
		t.Fatalf("a month 13: %d %s", status, body)
	}
	if status, body := ann.post("/api/me/born", `{"year":2001,"month":4}`); status != 204 {
		t.Fatalf("answered: %d %s", status, body)
	}
	if status, body := ann.do("GET", "/api/me", ""); status != 200 || !strings.Contains(body, `"born":true`) {
		t.Fatalf("me after: %d %s", status, body)
	}
	if status, body := ann.post("/api/me/born", `{"year":2001,"month":5}`); status != 409 || body != `{"error":"answered"}` {
		t.Fatalf("again: %d %s", status, body)
	}
	if status, body := ann.post("/api/me/born", bornAgo(5, 0)); status != 409 || body != `{"error":"answered"}` {
		t.Fatalf("again, young: %d %s", status, body)
	}
	if k, err := s.st.Knocker(context.Background(), annID); err != nil || k.Born != 200104 {
		t.Fatalf("kept: %+v %v", k, err)
	}

	mary, maryID := s.older(t, "Mary Read")
	req, _ := http.NewRequest("POST", s.URL+"/api/me/born", strings.NewReader(bornAgo(12, 0)))
	req.Header.Set("Content-Type", "application/json")
	res, err := mary.c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body := strings.TrimSpace(readAll(res))
	res.Body.Close()
	if res.StatusCode != 403 || body != `{"error":"young"}` {
		t.Fatalf("under 13: %d %s", res.StatusCode, body)
	}
	checkYoungCookie(t, res.Cookies())
	if status, _ := mary.do("GET", "/api/me", ""); status != 401 {
		t.Fatalf("mary's session after: %d", status)
	}
	var born *int32
	var reason string
	if err := storetest.PoolOn(t, s.u).QueryRow(context.Background(), "SELECT born, stop_reason FROM account WHERE id = $1", maryID).Scan(&born, &reason); err != nil {
		t.Fatal(err)
	}
	if born != nil || reason != accounts.YoungReason {
		t.Fatalf("mary kept %v, stopped %q", born, reason)
	}
	acts, err := s.st.Actions(context.Background(), &maryID, 10)
	if err != nil || len(acts) != 1 || acts[0].Action != store.ActionYoung || acts[0].Source != store.SourceGame {
		t.Fatalf("the record: %+v %v", acts, err)
	}
	// Her browser keeps the answer: no new sailor.
	if status, body := mary.post("/account/begin", beginBody("Mary Reade", bornAgo(30, 0))); status != 403 || body != `{"error":"young"}` {
		t.Fatalf("a new sailor after: %d %s", status, body)
	}
}

// TestRulesOnce: the Rules of the sea are accepted once; again is the
// same.
func TestRulesOnce(t *testing.T) {
	s := newAboardServer(t, nil)
	b, _ := makeSailor(t, s.testServer, "Ann Bonny")
	if status, body := b.post("/api/me/rules", `{"yes":true}`); status != 400 {
		t.Fatalf("a body: %d %s", status, body)
	}
	for _, body := range []string{`{}`, ""} {
		if status, out := b.post("/api/me/rules", body); status != 204 {
			t.Fatalf("accepted with %q: %d %s", body, status, out)
		}
	}
	if status, body := b.do("GET", "/api/me", ""); status != 200 || !strings.Contains(body, `"born":true,"rules":true`) {
		t.Fatalf("me: %d %s", status, body)
	}
	if n := count(t, s.u, "account WHERE rules_at IS NOT NULL"); n != 1 {
		t.Fatalf("accepted: %d", n)
	}
	// Another site's page cannot answer for the player, nor make a link.
	for _, path := range []string{"/api/me/born", "/api/me/rules", "/api/sail/link", "/api/sail/link/end"} {
		req, _ := http.NewRequest("POST", s.URL+path, strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Sec-Fetch-Site", "cross-site")
		req.AddCookie(b.session())
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusForbidden {
			t.Errorf("%s from another site: %d", path, res.StatusCode)
		}
	}
}

// links is a snapshot of the links kept: each one's hash, ending and
// times.
func links(t *testing.T, u string) string {
	t.Helper()
	rows, err := storetest.PoolOn(t, u).Query(context.Background(),
		"SELECT encode(hash, 'hex'), made_at, expires_at, ended_at IS NOT NULL FROM sail_link ORDER BY hash")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var b strings.Builder
	for rows.Next() {
		var h string
		var made, expires time.Time
		var ended bool
		if err := rows.Scan(&h, &made, &expires, &ended); err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(&b, "%s %v %v %v\n", h, made, expires, ended)
	}
	return b.String()
}

// tokenOf is a link's token, from its address.
func tokenOf(t *testing.T, url string) string {
	t.Helper()
	token, ok := strings.CutPrefix(url, "https://keel.example/sail/")
	if !ok {
		t.Fatalf("the link's address: %s", url)
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != 16 || len(token) != aboard.TokenLen {
		t.Fatalf("a token of %d bytes: %q %v", len(raw), token, err)
	}
	return token
}

// TestSailLinks: a skipper who has answered and accepted makes a link of
// 128 bits at the play origin; whoever is signed in reads it, which
// changes nothing; it ends on a new link, at its end, on links off, at
// its expiry and at a lowered lifetime.
func TestSailLinks(t *testing.T) {
	var d atomic.Pointer[deck]
	s := newAboardServer(t, nil)
	ann, _ := makeSailor(t, s.testServer, "Ann Bonny")
	if status, body := ann.post("/api/sail/link", ""); status != 403 || body != `{"error":"rules"}` {
		t.Fatalf("before the rules: %d %s", status, body)
	}
	older, _ := s.older(t, "Mary Read")
	older.post("/api/me/rules", "")
	if status, body := older.post("/api/sail/link", ""); status != 403 || body != `{"error":"born"}` {
		t.Fatalf("before the age: %d %s", status, body)
	}
	ann.post("/api/me/rules", "")
	if status, body := ann.do("GET", "/api/sail/link", ""); status != 200 || body != `{"live":false}` {
		t.Fatalf("no link yet: %d %s", status, body)
	}
	before := time.Now()
	status, body := ann.post("/api/sail/link", "")
	if status != 201 {
		t.Fatalf("a link: %d %s", status, body)
	}
	made := decode[linkMade](t, body)
	token := tokenOf(t, made.URL)
	expires, err := time.Parse(time.RFC3339, made.Expires)
	if err != nil || expires.Before(before.Add(24*time.Hour).Truncate(time.Second)) || expires.After(time.Now().Add(24*time.Hour)) {
		t.Fatalf("expires %s, %v", made.Expires, err)
	}
	if status, body := ann.do("GET", "/api/sail/link", ""); status != 200 || body != `{"live":true,"expires":"`+made.Expires+`"}` {
		t.Fatalf("the link out: %d %s", status, body)
	}

	// Reading it: a session needed, and nothing changes.
	if status, body := get(t, http.DefaultClient, s.URL+"/api/sail/"+token, nil); status != 401 || body != `{"error":"session"}` {
		t.Fatalf("no session: %d %s", status, body)
	}
	jack, _ := makeSailor(t, s.testServer, "Calico Jack")
	kept := links(t, s.u)
	want := fmt.Sprintf(`{"skipper":"Ann Bonny","look":%d,"kind":0,"boat":"","can":"not-at-sea"}`, testBook.Code(storeLook(t, s, "Ann Bonny")))
	if status, body := jack.do("GET", "/api/sail/"+token, ""); status != 200 || body != want {
		t.Fatalf("read with no world: %d %s, want %s", status, body, want)
	}
	if status, body := ann.do("GET", "/api/sail/"+token, ""); status != 200 || !strings.Contains(body, `"can":"own"`) {
		t.Fatalf("the skipper's own: %d %s", status, body)
	}
	if got := links(t, s.u); got != kept {
		t.Fatalf("a read changed the links:\n%s\nwas\n%s", got, kept)
	}

	// With a world: the boat, and whether boarding is on.
	s2 := s.withDeck(t, &d)
	d.Store(&deck{can: CanOK})
	jack2 := s2.browserOf(t, jack)
	if status, body := jack2.do("GET", "/api/sail/"+token, ""); status != 200 || !strings.HasSuffix(body, `"kind":1,"boat":"Swift","can":"ok"}`) {
		t.Fatalf("read at sea: %d %s", status, body)
	}
	s.switches.SetBoarding(false)
	if status, body := jack2.do("GET", "/api/sail/"+token, ""); status != 200 || !strings.HasSuffix(body, `"can":"closed"}`) {
		t.Fatalf("boarding off: %d %s", status, body)
	}
	s.switches.SetBoarding(true)
	d.Store(&deck{can: CanFull})
	if status, body := jack2.do("GET", "/api/sail/"+token, ""); status != 200 || !strings.HasSuffix(body, `"can":"full"}`) {
		t.Fatalf("full: %d %s", status, body)
	}

	// Not a token of the game's: never asked of the database.
	n := s.sail.lookups.Load()
	for _, bad := range []string{"x", strings.Repeat("A", 21), strings.Repeat("A", 23), strings.Repeat("*", 22), strings.Repeat("A", 21) + "B"} {
		if status, body := jack.do("GET", "/api/sail/"+bad, ""); status != 410 || body != `{"error":"ended"}` {
			t.Errorf("token %q: %d %s", bad, status, body)
		}
	}
	if got := s.sail.lookups.Load(); got != n {
		t.Fatalf("malformed tokens asked of the store: %d", got-n)
	}
	if status, body := jack.do("GET", "/api/sail/"+strings.Repeat("A", 22), ""); status != 410 || body != `{"error":"ended"}` {
		t.Fatalf("an unknown token: %d %s", status, body)
	}

	// A new link ends the old.
	_, body = ann.post("/api/sail/link", "")
	second := tokenOf(t, decode[linkMade](t, body).URL)
	if status, _ := jack.do("GET", "/api/sail/"+token, ""); status != 410 {
		t.Fatalf("the first after the second: %d", status)
	}
	if status, _ := jack.do("GET", "/api/sail/"+second, ""); status != 200 {
		t.Fatalf("the second: %d", status)
	}

	// Links off: every link stops, and none is made.
	s.switches.SetLinks(false)
	if status, _ := jack.do("GET", "/api/sail/"+second, ""); status != 410 {
		t.Fatalf("links off: %d", status)
	}
	if status, body := ann.do("GET", "/api/sail/link", ""); body != `{"live":false}` {
		t.Fatalf("the link out, links off: %d %s", status, body)
	}
	if status, body := ann.post("/api/sail/link", ""); status != 409 || body != `{"error":"links-off"}` {
		t.Fatalf("a link, links off: %d %s", status, body)
	}
	s.switches.SetLinks(true)

	// A lowered lifetime stops a link older than it; its expiry stops it.
	mustExec(t, s.u, "UPDATE sail_link SET made_at = made_at - interval '10 minutes', expires_at = expires_at - interval '10 minutes' WHERE ended_at IS NULL")
	s.switches.SetLifetime(5 * time.Minute)
	if status, _ := jack.do("GET", "/api/sail/"+second, ""); status != 410 {
		t.Fatalf("a lowered lifetime: %d", status)
	}
	if _, body := ann.do("GET", "/api/sail/link", ""); body != `{"live":false}` {
		t.Fatalf("the link out, a lowered lifetime: %s", body)
	}
	s.switches.SetLifetime(time.Hour)
	if status, body := ann.do("GET", "/api/sail/link", ""); status != 200 || !strings.Contains(body, `"live":true`) {
		t.Fatalf("an hour's lifetime: %d %s", status, body)
	}
	s.switches.SetLifetime(aboard.DefaultLifetime)
	if status, _ := jack.do("GET", "/api/sail/"+second, ""); status != 200 {
		t.Fatalf("the lifetime raised: %d", status)
	}
	mustExec(t, s.u, "UPDATE sail_link SET expires_at = now() - interval '1 second', made_at = now() - interval '1 minute' WHERE ended_at IS NULL")
	if status, _ := jack.do("GET", "/api/sail/"+second, ""); status != 410 {
		t.Fatalf("expired: %d", status)
	}

	// Ended by its skipper.
	_, body = ann.post("/api/sail/link", "")
	third := tokenOf(t, decode[linkMade](t, body).URL)
	if status, body := ann.post("/api/sail/link/end", ""); status != 204 {
		t.Fatalf("ended: %d %s", status, body)
	}
	if status, _ := jack.do("GET", "/api/sail/"+third, ""); status != 410 {
		t.Fatalf("after its end: %d", status)
	}
	if _, body := ann.do("GET", "/api/sail/link", ""); body != `{"live":false}` {
		t.Fatalf("the link out after its end: %s", body)
	}
}

// storeLook is a sailor's look as kept.
func storeLook(t *testing.T, s *aboardServer, name string) store.Look {
	t.Helper()
	l, err := s.st.Knocker(context.Background(), s.idOf(t, name))
	if err != nil {
		t.Fatal(err)
	}
	return testBook.Resolve(s.idOf(t, name), l.Look)
}

// withDeck is a second server on the same store with the world given.
func (s *aboardServer) withDeck(t *testing.T, d *atomic.Pointer[deck]) *testServer {
	t.Helper()
	return newTestServer(t, s.st, func(c *Config) {
		c.Sailing, c.Switches, c.Origin, c.Deck = s.sail, s.switches, "https://keel.example", deckOf{d}
	})
}

type deckOf struct{ d *atomic.Pointer[deck] }

func (d deckOf) LinkCan(skipper, viewer store.AccountID) (string, uint16, string) {
	return d.d.Load().LinkCan(skipper, viewer)
}

// browserOf is a browser on srv with b's session.
func (srv *testServer) browserOf(t *testing.T, b *browser) *browser {
	t.Helper()
	o := newBrowser(t, srv)
	o.jar.SetCookies(nil, []*http.Cookie{b.session()})
	return o
}

// TestLinksOften: at most LinkLimit links an hour.
func TestLinksOften(t *testing.T) {
	s := newAboardServer(t, nil)
	ann, _ := makeSailor(t, s.testServer, "Ann Bonny")
	ann.post("/api/me/rules", "")
	for i := range LinkLimit {
		if status, body := ann.post("/api/sail/link", ""); status != 201 {
			t.Fatalf("link %d: %d %s", i, status, body)
		}
	}
	if status, body := ann.post("/api/sail/link", ""); status != 429 || body != `{"error":"often"}` {
		t.Fatalf("one too many: %d %s", status, body)
	}
	if n := count(t, s.u, "sail_link"); n != LinkLimit {
		t.Fatalf("%d links kept", n)
	}
	if n := count(t, s.u, "sail_link WHERE ended_at IS NULL"); n != 1 {
		t.Fatalf("%d live", n)
	}
	var l linkTimes
	now := time.Now()
	for range LinkLimit {
		l.allow(store.AccountID{1}, now)
	}
	if l.allow(store.AccountID{1}, now.Add(LinkWindow-time.Second)) || !l.allow(store.AccountID{1}, now.Add(LinkWindow+time.Second)) {
		t.Fatal("the window")
	}
	if !l.allow(store.AccountID{2}, now.Add(3*LinkWindow)) || len(l.times) != 1 {
		t.Fatalf("the sweep: %d accounts kept", len(l.times))
	}
}

// TestLinkPage: a link's address is the game's own page, for anyone, with
// no session asked and nothing read.
func TestLinkPage(t *testing.T) {
	srv := pageServer(t)
	token := strings.Repeat("A", 22)
	res, body := raw(t, srv, "GET", "/sail/"+token)
	if res.StatusCode != 200 || body != "<!doctype html><title>Keel Over the Edge</title>" {
		t.Fatalf("the page: %d %q", res.StatusCode, body)
	}
	h := res.Header
	if h.Get("Content-Type") != "text/html; charset=utf-8" || h.Get("Cache-Control") != "no-cache" || h.Get("Referrer-Policy") != "no-referrer" ||
		h.Get("X-Robots-Tag") != "noindex" || h.Get("Set-Cookie") != "" {
		t.Fatalf("headers %v", h)
	}
	// A session's cookie is not even read: the database is never asked.
	req, _ := http.NewRequest("GET", srv.URL+"/sail/"+token, nil)
	req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: strings.Repeat("A", 43)})
	r2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	r2.Body.Close()
	if r2.StatusCode != 200 {
		t.Fatalf("with a cookie: %d", r2.StatusCode)
	}
	if res, _ := raw(t, srv, "GET", "/sail/"); res.StatusCode != 404 {
		t.Fatalf("no token: %d", res.StatusCode)
	}
	if res, body := raw(t, srv, "GET", "/robots.txt"); res.StatusCode != 200 || !strings.Contains(body, "Disallow: /sail/") {
		t.Fatalf("robots: %d %s", res.StatusCode, body)
	}
}
