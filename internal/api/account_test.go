// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/daneelvt/keel-over-the-edge/internal/accounts"
	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/auth/softkey"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// noAccounts is a store of accounts that is never reached.
type noAccounts struct{}

var errNoDatabase = errors.New("no database in this test")

func (noAccounts) NameFree(context.Context, string) (bool, error) { return false, errNoDatabase }
func (noAccounts) CreateAccount(context.Context, store.NewAccount) (store.AccountID, error) {
	return store.AccountID{}, errNoDatabase
}
func (noAccounts) AccountByUserHandle(context.Context, []byte) (store.Holder, error) {
	return store.Holder{}, errNoDatabase
}
func (noAccounts) Profile(context.Context, store.AccountID) (store.Profile, error) {
	return store.Profile{}, errNoDatabase
}
func (noAccounts) SignIn(context.Context, store.AccountID, [32]byte) (time.Time, error) {
	return time.Time{}, errNoDatabase
}
func (noAccounts) Recover(context.Context, [32]byte, [32]byte) (store.Account, error) {
	return store.Account{}, errNoDatabase
}
func (noAccounts) AddPasskey(context.Context, store.AccountID, store.Passkey, *[32]byte, *[32]byte) error {
	return errNoDatabase
}
func (noAccounts) PasskeyUsed(context.Context, store.AccountID, store.Passkey) error {
	return errNoDatabase
}
func (noAccounts) RemovePasskey(context.Context, store.AccountID, [16]byte) error {
	return errNoDatabase
}
func (noAccounts) SetRecoveryCode(context.Context, store.AccountID, [32]byte) error {
	return errNoDatabase
}
func (noAccounts) EndSession(context.Context, [32]byte) error { return errNoDatabase }
func (noAccounts) EndOtherSessions(context.Context, store.AccountID, [32]byte) (int64, error) {
	return 0, errNoDatabase
}
func (noAccounts) ConfirmSession(context.Context, store.AccountID, [32]byte, time.Time) error {
	return errNoDatabase
}
func (noAccounts) DeleteAccount(context.Context, store.AccountID) ([]store.AccountID, error) {
	return nil, errNoDatabase
}
func (noAccounts) SaveCeremony(context.Context, store.Ceremony) error { return errNoDatabase }
func (noAccounts) TakeCeremony(context.Context, [32]byte, string) (store.Ceremony, error) {
	return store.Ceremony{}, errNoDatabase
}

// browserJar keeps cookies as a browser on localhost does: Secure ones
// too, over plain HTTP, which Go's cookie jar keeps for HTTPS alone.
type browserJar struct {
	mu sync.Mutex
	by map[string]*http.Cookie
}

func (j *browserJar) SetCookies(_ *url.URL, cs []*http.Cookie) {
	j.mu.Lock()
	defer j.mu.Unlock()
	for _, c := range cs {
		if c.MaxAge < 0 {
			delete(j.by, c.Name)
			continue
		}
		j.by[c.Name] = &http.Cookie{Name: c.Name, Value: c.Value}
	}
}

func (j *browserJar) Cookies(*url.URL) []*http.Cookie {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := make([]*http.Cookie, 0, len(j.by))
	for _, c := range j.by {
		out = append(out, c)
	}
	return out
}

func (j *browserJar) get(name string) *http.Cookie {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.by[name]
}

// browser is a player's browser: its cookies, and the passkeys it holds.
type browser struct {
	t    *testing.T
	srv  *testServer
	jar  *browserJar
	c    *http.Client
	keys []*softkey.Key
	ua   string
}

func newBrowser(t *testing.T, srv *testServer) *browser {
	jar := &browserJar{by: map[string]*http.Cookie{}}
	return &browser{t: t, srv: srv, jar: jar, c: &http.Client{Jar: jar},
		ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1"}
}

// do sends a request with a JSON body, or none for "".
func (b *browser) do(method, path, body string) (int, string) {
	b.t.Helper()
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req, _ := http.NewRequest(method, b.srv.URL+path, r)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("User-Agent", b.ua)
	res, err := b.c.Do(req)
	if err != nil {
		b.t.Fatal(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	return res.StatusCode, strings.TrimSpace(string(out))
}

func (b *browser) post(path, body string) (int, string) { return b.do("POST", path, body) }

// session is the browser's session cookie, nil without one.
func (b *browser) session() *http.Cookie { return b.jar.get(auth.CookieName) }

// create makes a sailor with a new passkey, returning the finish's answer.
func (b *browser) create(name string) (int, string) {
	b.t.Helper()
	status, opts := b.post("/account/begin", `{"name":"`+name+`","look":"figure"}`)
	if status != 200 {
		return status, opts
	}
	key, answer, err := softkey.Create([]byte(opts), testOrigin)
	if err != nil {
		b.t.Fatal(err)
	}
	status, body := b.post("/account/finish", string(answer))
	if status == 201 {
		b.keys = append(b.keys, key)
	}
	return status, body
}

// signIn signs in with the browser's newest passkey, through the
// browser's prompt or, conditional, autofill.
func (b *browser) signIn(conditional bool) (int, string) {
	b.t.Helper()
	q := ""
	if conditional {
		q = "?mediation=conditional"
	}
	status, opts := b.post("/signin/begin"+q, "")
	if status != 200 {
		return status, opts
	}
	answer, err := b.keys[len(b.keys)-1].Get([]byte(opts))
	if err != nil {
		b.t.Fatal(err)
	}
	return b.post("/signin/finish"+q, string(answer))
}

// confirm confirms the browser's newest passkey.
func (b *browser) confirm() (int, string) {
	b.t.Helper()
	status, opts := b.post("/api/account/confirm/begin", "")
	if status != 200 {
		return status, opts
	}
	answer, err := b.keys[len(b.keys)-1].Get([]byte(opts))
	if err != nil {
		b.t.Fatal(err)
	}
	return b.post("/api/account/confirm/finish", string(answer))
}

// addPasskey adds a passkey to the account, made from the browser's newest.
func (b *browser) addPasskey() (int, string) {
	b.t.Helper()
	status, opts := b.post("/api/account/passkeys/begin", "")
	if status != 200 {
		return status, opts
	}
	var key *softkey.Key
	var answer []byte
	var err error
	if len(b.keys) > 0 {
		key, answer, err = b.keys[len(b.keys)-1].Another([]byte(opts))
	} else {
		key, answer, err = softkey.Create([]byte(opts), testOrigin)
	}
	if err != nil {
		b.t.Fatal(err)
	}
	status, body := b.post("/api/account/passkeys/finish", string(answer))
	if status == 201 {
		b.keys = append(b.keys, key)
	}
	return status, body
}

func decode[T any](t *testing.T, body string) T {
	t.Helper()
	var v T
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		t.Fatalf("%s: %v", body, err)
	}
	return v
}

// makeSailor makes a sailor through the routes, and returns the browser
// and its session's cookie.
func makeSailor(t *testing.T, srv *testServer, name string) (*browser, *http.Cookie) {
	t.Helper()
	b := newBrowser(t, srv)
	if status, body := b.create(name); status != 201 {
		t.Fatalf("making %s: %d %s", name, status, body)
	}
	return b, b.session()
}

func accountServer(t *testing.T) (*testServer, *store.Store, string) {
	t.Helper()
	st, u := storetest.Store(t, store.Options{})
	return newTestServer(t, st, nil), st, u
}

func count(t *testing.T, u, table string) int {
	t.Helper()
	var n int
	if err := storetest.PoolOn(t, u).QueryRow(context.Background(), "SELECT count(*) FROM "+table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

var codeForm = regexp.MustCompile(`^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{2}$`)

// TestMakeAnAccount: a name and a look, a passkey made, and the account
// is there: its cookie works, its recovery code is shown once, and its
// ceremony is used up.
func TestMakeAnAccount(t *testing.T) {
	srv, _, u := accountServer(t)
	b := newBrowser(t, srv)
	if status, body := b.do("GET", "/api/me", ""); status != 401 || body != `{"error":"session"}` {
		t.Fatalf("me without a session: %d %s", status, body)
	}
	status, opts := b.post("/account/begin", `{"name":"  Ann   Bonny ","look":"figure"}`)
	if status != 200 {
		t.Fatalf("begin: %d %s", status, opts)
	}
	o := decode[struct {
		PublicKey struct {
			RP struct {
				ID, Name string
			} `json:"rp"`
			User struct {
				ID, Name, DisplayName string
			} `json:"user"`
			Challenge              string
			Attestation            string
			AuthenticatorSelection struct {
				ResidentKey, UserVerification string
			}
			PubKeyCredParams []struct{ Alg int }
			Extensions       map[string]any
			Timeout          int
		} `json:"publicKey"`
	}](t, opts)
	pk := o.PublicKey
	if pk.RP.ID != testRPID || pk.RP.Name != "Keel Over the Edge" || pk.User.Name != "Ann Bonny" || pk.User.DisplayName != "Ann Bonny" ||
		len(pk.User.ID) != 86 || pk.AuthenticatorSelection.ResidentKey != "required" || pk.AuthenticatorSelection.UserVerification != "preferred" ||
		pk.Attestation != "none" || len(pk.PubKeyCredParams) != 3 || pk.PubKeyCredParams[0].Alg != -7 || pk.Extensions["credProps"] != true ||
		pk.Timeout != 300_000 {
		t.Fatalf("the options: %s", opts)
	}
	created := b.jar.get(auth.CeremonyCookieName("create"))
	if created == nil {
		t.Fatal("no ceremony cookie")
	}
	key, answer, err := softkey.Create([]byte(opts), testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	status, body := b.post("/account/finish", string(answer))
	if status != 201 {
		t.Fatalf("finish: %d %s", status, body)
	}
	made := decode[sailorResponse](t, body)
	if made.Name != "Ann Bonny" || made.Look != "figure" || !codeForm.MatchString(made.RecoveryCode) {
		t.Fatalf("made: %s", body)
	}
	if b.session() == nil || b.jar.get(auth.CeremonyCookieName("create")) != nil {
		t.Fatalf("cookies: session %v, ceremony %v", b.session(), b.jar.get(auth.CeremonyCookieName("create")))
	}
	if status, body := b.do("GET", "/api/me", ""); status != 200 || body != `{"name":"Ann Bonny","look":"figure","kind":"human","noticesOff":[]}` {
		t.Fatalf("me: %d %s", status, body)
	}
	status, page := b.do("GET", "/api/account", "")
	acc := decode[accountPage](t, page)
	if status != 200 || acc.Name != "Ann Bonny" || len(acc.Passkeys) != 1 || acc.Passkeys[0].MadeOn != "iPhone · Safari" ||
		acc.Passkeys[0].Synced || acc.RecoveryMade == 0 || acc.ConfirmedUntil != 0 {
		t.Fatalf("the account page: %d %s", status, page)
	}

	// The ceremony is used: finished again, with its cookie put back, it
	// is refused, and nothing more is made.
	other := newBrowser(t, srv)
	other.jar.SetCookies(nil, []*http.Cookie{created})
	if status, body := other.post("/account/finish", string(answer)); status != 409 || body != `{"error":"again"}` {
		t.Fatalf("finished twice: %d %s", status, body)
	}
	// With a session, no second account, and no ceremony begun.
	if status, body := b.post("/account/begin", `{"name":"Mary Read","look":"figure"}`); status != 409 || body != `{"error":"session"}` {
		t.Fatalf("a second account: %d %s", status, body)
	}
	if n := count(t, u, "account"); n != 1 {
		t.Fatalf("%d accounts", n)
	}
	if n := count(t, u, "webauthn_ceremony"); n != 0 {
		t.Fatalf("%d ceremonies left", n)
	}
	if n := testutil.ToFloat64(srv.metrics.AccountsCreated); n != 1 {
		t.Errorf("%v accounts counted", n)
	}
	if n := testutil.ToFloat64(srv.metrics.Ceremonies.WithLabelValues("create", "again")); n != 1 {
		t.Errorf("%v ceremonies counted again", n)
	}

	// The access log names the account, and holds no cookie, name, code
	// or passkey.
	logs := srv.logs.String()
	if !strings.Contains(logs, `"route":"POST /account/finish"`) || !strings.Contains(logs, `"account":"`) {
		t.Errorf("the access log lacks the route or the account:\n%s", logs)
	}
	for _, secret := range []string{b.session().Value, "Bonny", made.RecoveryCode, string(key.CredentialID)} {
		if strings.Contains(logs, secret) {
			t.Errorf("the access log holds %q", secret)
		}
	}
}

// TestNamesRefusedBeforeAnyCeremony: a refused name is answered before the
// browser is asked for anything; a name and its look-alikes are taken.
func TestNamesRefusedBeforeAnyCeremony(t *testing.T) {
	srv, _, u := accountServer(t)
	makeSailor(t, srv, "Ann Bonny")
	b := newBrowser(t, srv)
	for name, want := range map[string]string{
		"Al": "short", "Abcdefghijklmnopqrstu": "long", "Harbourmaster": "words", "Guest": "words",
		"Ann Bonny": "taken", "ann-bonny": "taken", "AnnBonny": "taken", "Ann B0nny": "taken", "Ａｎｎ Ｂｏｎｎｙ": "taken",
	} {
		if status, body := b.post("/account/begin", `{"name":"`+name+`","look":"figure"}`); status != 422 || body != `{"error":"`+want+`"}` {
			t.Errorf("%q: %d %s", name, status, body)
		}
	}
	if b.jar.get(auth.CeremonyCookieName("create")) != nil {
		t.Error("a ceremony cookie for a refused name")
	}
	if n := count(t, u, "webauthn_ceremony"); n != 0 {
		t.Fatalf("%d ceremonies kept for refused names", n)
	}
}

// TestNameTakenMeanwhile: two players begin with one name; the first to
// finish has it, and the second is told, with the passkey just made for the
// browser to forget, and nothing made.
func TestNameTakenMeanwhile(t *testing.T) {
	srv, _, u := accountServer(t)
	first, second := newBrowser(t, srv), newBrowser(t, srv)
	_, opts1 := first.post("/account/begin", `{"name":"Calico Jack","look":"figure"}`)
	_, opts2 := second.post("/account/begin", `{"name":"Calico Jack","look":"figure"}`)
	_, a1, _ := softkey.Create([]byte(opts1), testOrigin)
	key2, a2, _ := softkey.Create([]byte(opts2), testOrigin)
	if status, body := first.post("/account/finish", string(a1)); status != 201 {
		t.Fatalf("the first: %d %s", status, body)
	}
	status, body := second.post("/account/finish", string(a2))
	r := decode[struct {
		Error   string
		Unknown struct{ CredentialID, RPID string } `json:"unknown"`
	}](t, body)
	if status != 422 || r.Error != "taken" || r.Unknown.RPID != testRPID || r.Unknown.CredentialID != b64(key2.CredentialID) || second.session() != nil {
		t.Fatalf("the second: %d %s", status, body)
	}
	if n := count(t, u, "account"); n != 1 {
		t.Fatalf("%d accounts", n)
	}
	if n := count(t, u, "passkey"); n != 1 {
		t.Fatalf("%d passkeys", n)
	}
}

// TestAccountsAtOnce makes accounts with one name at once: one is made and
// the others refused.
func TestAccountsAtOnce(t *testing.T) {
	srv, _, _ := accountServer(t)
	var wg sync.WaitGroup
	statuses := make([]int, 8)
	for i := range statuses {
		wg.Go(func() {
			statuses[i], _ = newBrowser(t, srv).create("Calico Jack")
		})
	}
	wg.Wait()
	made := 0
	for _, s := range statuses {
		switch s {
		case 201:
			made++
		case 422:
		default:
			t.Errorf("status %d", s)
		}
	}
	if made != 1 {
		t.Fatalf("%d accounts made with one name: %v", made, statuses)
	}
}

// TestCeremonyLeftOrForeign: a ceremony begun and never finished leaves
// only its row, which the job deletes once it expires; one begun by
// another build, or expired, answers "again".
func TestCeremonyLeftOrForeign(t *testing.T) {
	st, u := storetest.Store(t, store.Options{})
	srv := newTestServer(t, st, nil)
	older := newTestServer(t, st, func(c *Config) { c.Version.Build = "older" })

	b := newBrowser(t, older)
	_, opts := b.post("/account/begin", `{"name":"Ann Bonny","look":"figure"}`)
	_, answer, _ := softkey.Create([]byte(opts), testOrigin)
	b.srv = srv
	if status, body := b.post("/account/finish", string(answer)); status != 409 || body != `{"error":"again"}` {
		t.Fatalf("another build's: %d %s", status, body)
	}

	// Left: a row, until it expires and the job runs.
	left := newBrowser(t, srv)
	left.post("/account/begin", `{"name":"Mary Read","look":"figure"}`)
	left.post("/signin/begin?mediation=conditional", "")
	if n := count(t, u, "webauthn_ceremony"); n != 2 {
		t.Fatalf("%d ceremonies left", n)
	}
	if n, err := st.DeleteCeremonies(context.Background(), time.Now()); err != nil || n != 0 {
		t.Fatalf("deleted before they expired: %d, %v", n, err)
	}
	pool := storetest.PoolOn(t, u)
	if _, err := pool.Exec(context.Background(), "UPDATE webauthn_ceremony SET expires_at = now() - interval '1 second'"); err != nil {
		t.Fatal(err)
	}
	_, answer, _ = softkey.Create([]byte(opts), testOrigin)
	if status, body := left.post("/account/finish", string(answer)); status != 409 || body != `{"error":"again"}` {
		t.Fatalf("expired: %d %s", status, body)
	}
	if n := testutil.ToFloat64(srv.metrics.Ceremonies.WithLabelValues("create", "expired")); n != 1 {
		t.Errorf("%v counted expired", n)
	}
	if n, err := st.DeleteCeremonies(context.Background(), time.Now()); err != nil || n != 1 {
		t.Fatalf("the job: %d, %v", n, err)
	}
}

// TestSignIn: a passkey signs its account in on another browser, with a new
// session; what the passkey says of itself is written back; a create and an
// autofill sign-in begun in one browser both finish.
func TestSignIn(t *testing.T) {
	srv, st, _ := accountServer(t)
	first, _ := makeSailor(t, srv, "Ann Bonny")
	before := first.session()

	// Another device with the same passkey, synced: the autofill request
	// held open while a second sailor is made, then the passkey offered.
	phone := newBrowser(t, srv)
	key := *first.keys[0]
	key.Synced, key.SignCount = true, 0
	status, opts := phone.post("/signin/begin?mediation=conditional", "")
	if status != 200 || !strings.Contains(opts, `"mediation":"conditional"`) || strings.Contains(opts, "allowCredentials") {
		t.Fatalf("autofill begun: %d %s", status, opts)
	}
	if status, _ := phone.post("/account/begin", `{"name":"Mary Read","look":"figure"}`); status != 200 {
		t.Fatalf("a create beside it: %d", status)
	}
	// A passkey whose backup-eligible flag changed is refused: it is not
	// the passkey that was made.
	answer, _ := key.Get([]byte(opts))
	status, body := phone.post("/signin/finish?mediation=conditional", string(answer))
	if status != 400 || body != `{"error":"refused"}` {
		t.Fatalf("a changed backup eligibility: %d %s", status, body)
	}
	key.Synced = false
	_, opts = phone.post("/signin/begin?mediation=conditional", "")
	answer, _ = key.Get([]byte(opts))
	status, body = phone.post("/signin/finish?mediation=conditional", string(answer))
	r := decode[sailorResponse](t, body)
	if status != 200 || r.Name != "Ann Bonny" || r.Recovered != 0 || r.Accepted == nil || len(r.Accepted.AllAcceptedCredentialIDs) != 1 ||
		r.Accepted.RPID != testRPID {
		t.Fatalf("signed in: %d %s", status, body)
	}
	if phone.session() == nil || phone.session().Value == before.Value {
		t.Fatal("no new session")
	}
	if status, _ := phone.do("GET", "/api/me", ""); status != 200 {
		t.Fatalf("me: %d", status)
	}
	// The create begun beside it is still there to finish, by its own
	// cookie, though the browser now has a session.
	if phone.jar.get(auth.CeremonyCookieName("create")) == nil {
		t.Fatal("the create's cookie went with the sign-in")
	}
	if n := testutil.ToFloat64(srv.metrics.SignIns.WithLabelValues("conditional")); n != 1 {
		t.Errorf("%v sign-ins counted", n)
	}

	// A count that goes back is a warning, never a refusal.
	k := first.keys[0]
	k.SignCount = 5
	first.post("/logout", "")
	if status, body := first.signIn(false); status != 200 {
		t.Fatalf("a count of 6: %d %s", status, body)
	}
	h, _ := st.AccountByUserHandle(context.Background(), k.UserHandle)
	if h.Passkeys[0].SignCount != 6 || h.Passkeys[0].CloneWarning {
		t.Fatalf("written back: %+v", h.Passkeys[0])
	}
	first.post("/logout", "")
	k.SignCount = 2
	if status, body := first.signIn(false); status != 200 {
		t.Fatalf("a count gone back: %d %s", status, body)
	}
	h, _ = st.AccountByUserHandle(context.Background(), k.UserHandle)
	if !h.Passkeys[0].CloneWarning || testutil.ToFloat64(srv.metrics.CloneWarnings) != 1 {
		t.Fatalf("no clone warning: %+v", h.Passkeys[0])
	}

	// With a session, no sign-in.
	if status, body := first.post("/signin/begin", ""); status != 409 || body != `{"error":"session"}` {
		t.Fatalf("signed in already: %d %s", status, body)
	}
}

// TestSignOut: this session ends, then the others.
func TestSignOut(t *testing.T) {
	srv, _, _ := accountServer(t)
	a, _ := makeSailor(t, srv, "Ann Bonny")
	other := newBrowser(t, srv)
	other.keys = a.keys
	if status, _ := other.signIn(false); status != 200 {
		t.Fatal(status)
	}
	third := newBrowser(t, srv)
	third.keys = a.keys
	third.signIn(true)
	if status, body := a.post("/api/account/logout-others", ""); status != 200 || body != `{"ended":2}` {
		t.Fatalf("the others: %d %s", status, body)
	}
	for _, b := range []*browser{other, third} {
		if status, _ := b.do("GET", "/api/me", ""); status != 401 {
			t.Errorf("another session after: %d", status)
		}
	}
	if status, _ := a.do("GET", "/api/me", ""); status != 200 {
		t.Fatalf("this one after: %d", status)
	}
	old := a.session()
	if status, _ := a.post("/logout", ""); status != 204 || a.session() != nil {
		t.Fatalf("sign out: %d", status)
	}
	a.jar.SetCookies(nil, []*http.Cookie{old})
	if status, _ := a.do("GET", "/api/me", ""); status != 401 {
		t.Fatalf("the old cookie after: %d", status)
	}
	if status, _ := newBrowser(t, srv).post("/logout", ""); status != 401 {
		t.Fatalf("no session: %d", status)
	}
}

// TestRecovery: the recovery code, in any case, with or without hyphens,
// signs in once; the other sessions end; only adding a passkey is allowed
// until one is added, when a new code follows; the next sign-in is told.
func TestRecovery(t *testing.T) {
	srv, _, _ := accountServer(t)
	a := newBrowser(t, srv)
	_, body := a.create("Ann Bonny")
	code := decode[sailorResponse](t, body).RecoveryCode

	lost := newBrowser(t, srv)
	typed := strings.ToLower(strings.ReplaceAll(code, "-", " "))
	typed = strings.NewReplacer("0", "o", "1", "l").Replace(typed)
	status, body := lost.post("/recovery", `{"code":"`+typed+`"}`)
	if status != 200 || body != `{"name":"Ann Bonny","look":"figure","addPasskey":true}` {
		t.Fatalf("recovered: %d %s", status, body)
	}
	if status, _ := a.do("GET", "/api/me", ""); status != 401 {
		t.Fatalf("the other session after: %d", status)
	}
	if status, body := newBrowser(t, srv).post("/recovery", `{"code":"`+code+`"}`); status != 422 || body != `{"error":"code"}` {
		t.Fatalf("used twice: %d %s", status, body)
	}
	for _, bad := range []string{"", "nope", strings.Repeat("Z", 26), code + "Z"} {
		if status, _ := newBrowser(t, srv).post("/recovery", `{"code":"`+bad+`"}`); status != 422 {
			t.Errorf("%q: %d", bad, status)
		}
	}
	// Held: me says so; the rest is refused, the game connection too.
	if status, body := lost.do("GET", "/api/me", ""); status != 200 || !strings.Contains(body, `"addPasskey":true`) {
		t.Fatalf("me, held: %d %s", status, body)
	}
	for _, p := range []string{"/api/account", "/api/account/confirm/begin", "/api/account/delete"} {
		method := "POST"
		if p == "/api/account" {
			method = "GET"
		}
		if status, body := lost.do(method, p, ""); status != 403 || body != `{"error":"add-passkey"}` {
			t.Errorf("%s, held: %d %s", p, status, body)
		}
	}
	status, body = lost.addPasskey()
	added := decode[struct {
		Passkeys     []passkeyItem
		RecoveryCode string
	}](t, body)
	if status != 201 || len(added.Passkeys) != 2 || !codeForm.MatchString(added.RecoveryCode) || added.RecoveryCode == code {
		t.Fatalf("a passkey added: %d %s", status, body)
	}
	if status, _ := lost.do("GET", "/api/account", ""); status != 200 {
		t.Fatalf("let go: %d", status)
	}
	if status, _ := newBrowser(t, srv).post("/recovery", `{"code":"`+added.RecoveryCode+`"}`); status != 200 {
		t.Fatalf("the new code: %d", status)
	}
	// The next sign-in is told when the code was used.
	if status, body := a.signIn(false); status != 200 || decode[sailorResponse](t, body).Recovered == 0 {
		t.Fatalf("the next sign-in: %d %s", status, body)
	}
	a.post("/logout", "")
	if status, body := a.signIn(false); status != 200 || decode[sailorResponse](t, body).Recovered != 0 {
		t.Fatalf("the one after: %d %s", status, body)
	}
	if n := testutil.ToFloat64(srv.metrics.RecoveryUsed); n != 2 {
		t.Errorf("%v recoveries counted", n)
	}
}

// TestConfirmFirst: removing a passkey, a new recovery code and deleting
// the account are refused without a passkey of the account's own
// confirmed in the last five minutes.
func TestConfirmFirst(t *testing.T) {
	srv, _, u := accountServer(t)
	a, _ := makeSailor(t, srv, "Ann Bonny")
	mallory, _ := makeSailor(t, srv, "Mallory")
	if status, _ := a.addPasskey(); status != 201 {
		t.Fatal(status)
	}
	_, page := a.do("GET", "/api/account", "")
	keys := decode[accountPage](t, page).Passkeys
	for p, body := range map[string]string{
		"/api/account/passkeys/remove": `{"id":"` + keys[0].ID + `"}`,
		"/api/account/recovery":        "",
		"/api/account/delete":          `{"name":"Ann Bonny"}`,
	} {
		if status, got := a.post(p, body); status != 403 || got != `{"error":"confirm"}` {
			t.Errorf("%s unconfirmed: %d %s", p, status, got)
		}
	}
	// Another account's passkey confirms nothing.
	_, opts := a.post("/api/account/confirm/begin", "")
	if _, err := mallory.keys[0].Get([]byte(opts)); !errors.Is(err, softkey.ErrNotAllowed) {
		t.Fatalf("another's passkey allowed: %v", err)
	}
	stolen := *mallory.keys[0]
	stolen.CredentialID = a.keys[0].CredentialID
	answer, _ := stolen.Get([]byte(opts))
	if status, body := a.post("/api/account/confirm/finish", string(answer)); status != 400 || body != `{"error":"refused"}` {
		t.Fatalf("a forged confirmation: %d %s", status, body)
	}
	// Begun by one account, finished by another's session.
	_, opts = a.post("/api/account/confirm/begin", "")
	cookie := a.jar.get(auth.CeremonyCookieName("confirm"))
	mallory.jar.SetCookies(nil, []*http.Cookie{cookie})
	answer, _ = a.keys[0].Get([]byte(opts))
	if status, body := mallory.post("/api/account/confirm/finish", string(answer)); status != 403 || body != `{"error":"account"}` {
		t.Fatalf("finished by another account: %d %s", status, body)
	}
	_, opts = a.post("/api/account/passkeys/begin", "")
	mallory.jar.SetCookies(nil, []*http.Cookie{a.jar.get(auth.CeremonyCookieName("add"))})
	_, answer, _ = softkey.Create([]byte(opts), testOrigin)
	if status, body := mallory.post("/api/account/passkeys/finish", string(answer)); status != 403 || body != `{"error":"account"}` {
		t.Fatalf("an add finished by another account: %d %s", status, body)
	}

	if status, body := a.confirm(); status != 200 || !strings.Contains(body, "confirmedUntil") {
		t.Fatalf("confirmed: %d %s", status, body)
	}
	if status, body := a.post("/api/account/recovery", ""); status != 200 || !codeForm.MatchString(decode[struct{ RecoveryCode string }](t, body).RecoveryCode) {
		t.Fatalf("a new code: %d %s", status, body)
	}
	status, body := a.post("/api/account/passkeys/remove", `{"id":"`+keys[0].ID+`"}`)
	left := decode[struct {
		Passkeys []passkeyItem
		Accepted struct{ AllAcceptedCredentialIDs []string }
	}](t, body)
	if status != 200 || len(left.Passkeys) != 1 || len(left.Accepted.AllAcceptedCredentialIDs) != 1 {
		t.Fatalf("removed: %d %s", status, body)
	}
	if status, body := a.post("/api/account/passkeys/remove", `{"id":"`+left.Passkeys[0].ID+`"}`); status != 409 || body != `{"error":"last-passkey"}` {
		t.Fatalf("the last: %d %s", status, body)
	}
	if status, _ := a.post("/api/account/passkeys/remove", `{"id":"`+keys[0].ID+`"}`); status != 404 {
		t.Fatalf("gone already: %d", status)
	}
	// The removed passkey signs in no more, and the browser may forget it.
	removed := newBrowser(t, srv)
	removed.keys = []*softkey.Key{a.keys[0]}
	if status, body := removed.signIn(false); status != 404 || !strings.Contains(body, `"error":"unknown-passkey"`) {
		t.Fatalf("a removed passkey: %d %s", status, body)
	}
	if status, _ := a.post("/api/account/delete", `{"name":"Mary Read"}`); status != 422 {
		t.Fatalf("the wrong name: %d", status)
	}
	if n := count(t, u, "account"); n != 2 {
		t.Fatalf("%d accounts", n)
	}
}

// TestDeleteAnAccount: the account goes, its session with it, its name is
// free at once, and its passkeys are named for the browser to forget; a
// sign-in with one of them is told the passkey is unknown.
func TestDeleteAnAccount(t *testing.T) {
	st, u := storetest.Store(t, store.Options{})
	deleted := make(deletedWorld, 4)
	srv := newTestServer(t, st, func(c *Config) {
		c.Deletions = accounts.New(accounts.Config{Store: st, Sessions: c.Sessions, Metrics: c.Metrics,
			World: func() accounts.World { return deleted }})
	})
	a, _ := makeSailor(t, srv, "Ann Bonny")
	other := newBrowser(t, srv)
	other.keys = a.keys
	other.signIn(false)
	a.confirm()
	status, body := a.post("/api/account/delete", `{"name":"ann bonny"}`)
	r := decode[struct {
		Unknown []struct{ CredentialID, RPID string }
	}](t, body)
	if status != 200 || len(r.Unknown) != 1 || r.Unknown[0].CredentialID != b64(a.keys[0].CredentialID) || a.session() != nil {
		t.Fatalf("deleted: %d %s", status, body)
	}
	if len(deleted) != 1 {
		t.Fatalf("told of %d deletions", len(deleted))
	}
	if status, _ := other.do("GET", "/api/me", ""); status != 401 {
		t.Fatalf("another session after: %d", status)
	}
	for _, table := range []string{"account", "sailor", "passkey", "session", "webauthn_ceremony"} {
		if n := count(t, u, table); n != 0 {
			t.Errorf("%s: %d rows left", table, n)
		}
	}
	gone := newBrowser(t, srv)
	gone.keys = a.keys
	status, body = gone.signIn(false)
	if status != 404 || !strings.Contains(body, `"credentialId":"`+b64(a.keys[0].CredentialID)+`"`) {
		t.Fatalf("its passkey after: %d %s", status, body)
	}
	if status, _ := newBrowser(t, srv).create("Ann Bonny"); status != 201 {
		t.Fatalf("the name again: %d", status)
	}
	if n := testutil.ToFloat64(srv.metrics.AccountsDeleted.WithLabelValues("player")); n != 1 {
		t.Errorf("%v deletions counted", n)
	}
}

// deletedWorld is told of the accounts deleted.
type deletedWorld chan store.AccountID

func (deletedWorld) Stopped(store.AccountID)                  {}
func (w deletedWorld) Deleted(id store.AccountID)             { w <- id }
func (deletedWorld) Sea(store.AccountID) (accounts.Sea, bool) { return accounts.Sea{}, false }

// TestAccountRoutesNeedASession: none of the account's routes without a
// session, and none from another site.
func TestAccountRoutesNeedASession(t *testing.T) {
	srv, _, _ := accountServer(t)
	b := newBrowser(t, srv)
	for _, p := range []string{
		"/api/account/passkeys/begin", "/api/account/passkeys/finish", "/api/account/passkeys/remove",
		"/api/account/confirm/begin", "/api/account/confirm/finish", "/api/account/recovery",
		"/api/account/logout-others", "/api/account/delete", "/logout",
	} {
		if status, body := b.post(p, "{}"); status != 401 || body != `{"error":"session"}` {
			t.Errorf("%s: %d %s", p, status, body)
		}
	}
	if status, _ := b.do("GET", "/api/account", ""); status != 401 {
		t.Errorf("the page: %d", status)
	}
	a, _ := makeSailor(t, srv, "Ann Bonny")
	for _, p := range []string{"/api/account/delete", "/api/account/logout-others", "/logout", "/signin/begin", "/account/begin", "/recovery"} {
		req, _ := http.NewRequest("POST", srv.URL+p, strings.NewReader("{}"))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Sec-Fetch-Site", "cross-site")
		res, err := a.c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 403 {
			t.Errorf("%s from another site: %d", p, res.StatusCode)
		}
	}
}

func TestMadeOn(t *testing.T) {
	for ua, want := range map[string]string{
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1":    "iPhone · Safari",
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1":     "iPhone · Chrome",
		"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36":                            "Android · Chrome",
		"Mozilla/5.0 (Android 15; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0":                                                                       "Android · Firefox",
		"Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36": "Android · Samsung Internet",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36":                      "Mac · Chrome",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0":              "Windows · Edge",
		"curl/8.7.1": "a browser",
		"":           "a browser",
	} {
		if got := madeOn(ua); got != want {
			t.Errorf("%q: %q, want %q", ua, got, want)
		}
	}
}
