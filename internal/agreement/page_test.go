// SPDX-License-Identifier: AGPL-3.0-only

package agreement

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/legal"
)

// pageSite is the signing page served over HTTP, with the fake GitHub
// behind it, and a browser: a client with a cookie jar that follows
// redirects to the page but not to GitHub's sign-in.
type pageSite struct {
	f       *fakeGitHub
	m       *memStore
	c       *Checker
	p       *Page
	srv     *httptest.Server
	browser *http.Client
	signed  []string
}

func newPageSite(t *testing.T, setUp bool) *pageSite {
	s := &pageSite{f: newFakeGitHub(t), m: newMemStore()}
	gh := s.f.client()
	if !setUp {
		gh = nil
	}
	s.c = &Checker{GitHub: gh, Store: s.m, Page: page, Log: quietLog()}
	s.p = &Page{GitHub: gh, Store: s.m, Checker: s.c, Contact: "skipper@example.com", Key: []byte("k"), Log: quietLog(),
		Signed: func(how string) { s.signed = append(s.signed, how) }}
	s.srv = httptest.NewServer(s.p.Handler())
	t.Cleanup(s.srv.Close)
	s.p.Origin = s.srv.URL
	jar, _ := cookiejar.New(nil)
	s.browser = &http.Client{Jar: jar, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if req.URL.Path == "/login/oauth/authorize" {
			return http.ErrUseLastResponse
		}
		return nil
	}}
	return s
}

func (s *pageSite) get(t *testing.T, path string) (int, string) {
	t.Helper()
	res, err := s.browser.Get(s.srv.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func (s *pageSite) post(t *testing.T, path string, form url.Values) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, s.srv.URL+path, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	res, err := s.browser.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

// signIn goes through GitHub's sign-in: the page's redirect, GitHub
// sending the person back with the state and a code.
func (s *pageSite) signIn(t *testing.T, code string) (int, string) {
	t.Helper()
	res, err := s.browser.Get(s.srv.URL + "/agreement/signin")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	loc, _ := url.Parse(res.Header.Get("Location"))
	if res.StatusCode != http.StatusSeeOther || loc.Path != "/login/oauth/authorize" || loc.Query().Get("client_id") != testClientID ||
		loc.Query().Get("redirect_uri") != s.srv.URL+"/agreement/callback" || loc.Query().Get("state") == "" {
		t.Fatalf("sign-in redirect: %d %s", res.StatusCode, loc)
	}
	return s.get(t, "/agreement/callback?code="+code+"&state="+url.QueryEscape(loc.Query().Get("state")))
}

var csrfRE = regexp.MustCompile(`name="csrf" value="([0-9a-f]+)"`)

func csrfOf(t *testing.T, body string) string {
	t.Helper()
	m := csrfRE.FindStringSubmatch(body)
	if m == nil {
		t.Fatal("no form token on the page")
	}
	return m[1]
}

func TestPageSigning(t *testing.T) {
	s := newPageSite(t, true)
	v := legal.Current()
	status, body := s.get(t, "/agreement")
	if status != 200 || !strings.Contains(body, "Sign in with GitHub") || !strings.Contains(body, v.SHA256) || strings.Contains(body, "<script") {
		t.Fatalf("the page before signing in: %d", status)
	}
	// A pull request waits for her.
	s.f.pulls[5] = annsPull()
	s.c.Check(context.Background(), store.PullRef{Repo: "o/r", Number: 5})

	status, body = s.signIn(t, "good")
	if status != 200 || !strings.Contains(body, "Signed in as <strong>@ann</strong>") || !strings.Contains(body, `id="sign"`) {
		t.Fatalf("the page after signing in: %d\n%s", status, body)
	}
	if len(s.f.revoked) != 1 || s.f.revoked[0] != "user-token" {
		t.Errorf("the sign-in's token was not revoked: %v", s.f.revoked)
	}
	token := csrfOf(t, body)

	// Each box is needed.
	for _, form := range []url.Values{
		{"csrf": {token}, "name": {"Ann Smith"}, "employer": {"yes"}, "agree": {"yes"}},
		{"csrf": {token}, "age": {"adult"}, "name": {"  "}, "employer": {"yes"}, "agree": {"yes"}},
		{"csrf": {token}, "age": {"adult"}, "name": {"Ann\u202eSmith"}, "employer": {"yes"}, "agree": {"yes"}},
		{"csrf": {token}, "age": {"adult"}, "name": {"Ann Smith"}, "agree": {"yes"}},
		{"csrf": {token}, "age": {"adult"}, "name": {"Ann Smith"}, "employer": {"yes"}},
	} {
		if status, body := s.post(t, "/agreement/sign", form); status != 400 || !strings.Contains(body, `class="note bad"`) {
			t.Errorf("%v: %d", form, status)
		}
	}
	// Another's token is refused.
	if status, _ := s.post(t, "/agreement/sign", url.Values{"csrf": {strings.Repeat("0", 64)}, "age": {"adult"},
		"name": {"Ann Smith"}, "employer": {"yes"}, "agree": {"yes"}}); status != 403 {
		t.Errorf("a forged form: %d", status)
	}
	if len(s.m.sigs) != 0 {
		t.Fatalf("signed before the form was right: %+v", s.m.sigs)
	}

	good := url.Values{"csrf": {token}, "age": {"adult"}, "name": {" Ann Smith "}, "employer": {"yes"}, "agree": {"yes"}}
	status, body = s.post(t, "/agreement/sign", good)
	if status != 200 || !strings.Contains(body, "Your open pull requests have been checked again") || !strings.Contains(body, "You have signed the") {
		t.Fatalf("after signing: %d\n%s", status, body)
	}
	sig := s.m.sigs[0]
	if sig.GitHubID != ann.ID || sig.Login != "ann" || sig.Name != "Ann Smith" || sig.Version != v.Number || sig.TextSHA256 != v.SHA256 || sig.How != store.SignedOnPage {
		t.Errorf("the signature: %+v", sig)
	}
	// Her pull request is queued, and turns green with no re-run.
	drain(t, s.c)
	if st := s.f.last(); st.State != "success" {
		t.Errorf("the pull request after signing: %+v", st)
	}
	// Signing again is harmless.
	s.post(t, "/agreement/sign", good)
	if len(s.m.sigs) != 1 || len(s.signed) != 1 {
		t.Errorf("a second signing made %d signatures, %d counted", len(s.m.sigs), len(s.signed))
	}

	// The download: the text signed, then the record.
	status, body = s.get(t, "/agreement/download?id="+sig.ID.String())
	if status != 200 || !strings.HasPrefix(body, string(v.Text)) || !strings.Contains(body, "Ann Smith") || !strings.Contains(body, v.SHA256) {
		t.Errorf("the download: %d", status)
	}
	if status, _ := s.get(t, "/agreement/download?id="+store.AccountID{9}.String()); status != 404 {
		t.Errorf("another's download: %d", status)
	}
	// Signing out, then the download is not hers to have.
	s.post(t, "/agreement/signout", url.Values{"csrf": {token}})
	if _, body := s.get(t, "/agreement"); !strings.Contains(body, "Sign in with GitHub") {
		t.Error("still signed in after signing out")
	}
}

func TestPageMinor(t *testing.T) {
	s := newPageSite(t, true)
	_, body := s.signIn(t, "good")
	status, body := s.post(t, "/agreement/sign", url.Values{"csrf": {csrfOf(t, body)}, "age": {"minor"}})
	if status != 200 || !strings.Contains(body, "skipper@example.com") || !strings.Contains(body, "@ann") || !strings.Contains(body, "parent or guardian") {
		t.Fatalf("the way for a minor: %d\n%s", status, body)
	}
	if len(s.m.sigs) != 0 {
		t.Error("a minor's signature was recorded on the page")
	}
}

func TestPageSignInRefused(t *testing.T) {
	s := newPageSite(t, true)
	// A state that is not the cookie's.
	s.get(t, "/agreement")
	if status, body := s.get(t, "/agreement/callback?code=good&state=forged"); status != 400 || !strings.Contains(body, "sign in again") {
		t.Errorf("a forged state: %d", status)
	}
	// A code GitHub refuses.
	if status, _ := s.signIn(t, "bad"); status != 502 {
		t.Errorf("a refused code: %d", status)
	}
	if _, body := s.get(t, "/agreement"); strings.Contains(body, "Signed in as") {
		t.Error("signed in without GitHub's word")
	}
	// A cross-site form.
	req, _ := http.NewRequest(http.MethodPost, s.srv.URL+"/agreement/sign", strings.NewReader("age=adult"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Errorf("a cross-site form: %d", res.StatusCode)
	}
}

// TestPageSession: a session is this process's, unexpired, unaltered.
func TestPageSession(t *testing.T) {
	p := &Page{Key: []byte("k")}
	now := int64(2_000_000_000)
	sealed := p.seal(session{ID: 7, Login: "ann", Expires: now + 10})
	read := func(v string) bool {
		r := httptest.NewRequest("GET", "/agreement", nil)
		r.AddCookie(&http.Cookie{Name: sessionCookie, Value: v})
		_, ok := p.session(r)
		return ok
	}
	if !read(sealed) {
		t.Error("its own session refused")
	}
	body, sig, _ := strings.Cut(sealed, ".")
	forged, _ := json.Marshal(session{ID: 8, Login: "bob", Expires: now + 10})
	for name, v := range map[string]string{
		"altered":  strings.ToUpper(body[:1]) + body[1:] + "." + sig,
		"another":  base64.RawURLEncoding.EncodeToString(forged) + "." + sig,
		"unsigned": body,
		"empty":    "",
	} {
		if read(v) {
			t.Errorf("%s session taken", name)
		}
	}
	other := &Page{Key: []byte("other")}
	r := httptest.NewRequest("GET", "/agreement", nil)
	r.AddCookie(&http.Cookie{Name: sessionCookie, Value: sealed})
	if _, ok := other.session(r); ok {
		t.Error("another process's session taken")
	}
}

func TestPageNotSetUp(t *testing.T) {
	s := newPageSite(t, false)
	status, body := s.get(t, "/agreement")
	if status != 200 || !strings.Contains(body, "Signing is not open yet") || strings.Contains(body, "Sign in with GitHub") {
		t.Errorf("the page not set up: %d", status)
	}
	if status, _ := s.get(t, "/agreement/signin"); status != 200 {
		t.Errorf("signing in while not set up: %d", status)
	}
}

// TestPageServesTheText: the text served is the embedded bytes, whose
// SHA-256 a signature records; the privacy notice, the style and the font
// are served; and the headers forbid script and framing.
func TestPageServesTheText(t *testing.T) {
	s := newPageSite(t, true)
	for _, v := range legal.Versions() {
		res, err := http.Get(s.srv.URL + "/agreement/v/" + string(rune('0'+v.Number)) + ".md")
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if !bytes.Equal(b, v.Text) {
			t.Errorf("version %d served is not the embedded text", v.Number)
		}
	}
	for path, want := range map[string]int{
		"/agreement/v/0.md": 404, "/agreement/v/99.md": 404, "/agreement/v/1": 404, "/agreement/privacy": 200,
		"/agreement/style.css": 200, "/agreement/heading.ttf": 200, "/agreement/": 200,
	} {
		if status, _ := s.get(t, path); status != want {
			t.Errorf("%s: %d, want %d", path, status, want)
		}
	}
	res, err := http.Get(s.srv.URL + "/agreement")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if csp := res.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "default-src 'none'") || strings.Contains(csp, "script-src") ||
		!strings.Contains(csp, "frame-ancestors 'none'") {
		t.Errorf("Content-Security-Policy: %q", csp)
	}
}

func TestMarkdown(t *testing.T) {
	texts := map[string][]byte{"privacy": legal.Privacy()}
	for _, v := range legal.Versions() {
		texts[v.Name()] = v.Text
	}
	for name, text := range texts {
		h := string(Markdown(text))
		for _, left := range []string{"**", "](", "\n#", "\n- ", "`"} {
			if strings.Contains(h, left) {
				t.Errorf("%s: %q is left in the HTML", name, left)
			}
		}
		if !strings.Contains(h, `<a href="https://play.keelovertheedge.com/agreement">`) {
			t.Errorf("%s: the signing page's address is not a link", name)
		}
	}
	got := string(Markdown([]byte("# A <b>\n\nSome **bold** and `code`,\nhttps://x.example/a.\n\n- one\n  more\n- two\n\n---\n")))
	want := "<h1>A &lt;b&gt;</h1>\n<p>Some <strong>bold</strong> and <code>code</code>, " +
		`<a href="https://x.example/a">https://x.example/a</a>.</p>` + "\n<ul>\n<li>one more</li>\n<li>two</li>\n</ul>\n<hr>\n"
	if got != want {
		t.Errorf("Markdown:\n%s\nwant\n%s", got, want)
	}
}

func TestValidName(t *testing.T) {
	for name, want := range map[string]bool{
		"Ann Smith": true, "Zoë Ngāti": true, "李小龍": true, "O'Brien-Smythe": true,
		"": false, "   ": false, "1234": false, "Ann\x00": false, "Ann\u200bSmith": false, strings.Repeat("a", 201): false,
	} {
		if validName(name) != want {
			t.Errorf("validName(%q) = %v", name, !want)
		}
	}
}
