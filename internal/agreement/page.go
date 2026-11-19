// SPDX-License-Identifier: AGPL-3.0-only

package agreement

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html/template"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/legal"
)

//go:embed static
var static embed.FS

var pageTemplate = template.Must(template.ParseFS(static, "static/page.html"))

// Cookies: the sign-in's state, against a forged sign-in, and the session
// that follows, both for the signing page's paths alone.
const (
	stateCookie   = "agreement_state"
	sessionCookie = "agreement_session"
	stateLife     = 10 * time.Minute
	sessionLife   = time.Hour
	maxName       = 200
	// maxForm is the most a form's body may be, bytes.
	maxForm = 4 << 10
)

// csp is the page's Content Security Policy: its own style and font, no
// script at all, forms to itself alone, never framed.
const csp = "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self'; " +
	"frame-ancestors 'none'; base-uri 'none'"

// Page is the signing page, at /agreement on the players' host.
type Page struct {
	// GitHub signs people in; nil when the App is not set up, when the page
	// shows the agreement to read and nothing to sign.
	GitHub  *GitHub
	Store   Store
	Checker *Checker
	// Origin is the players' origin, https://play.keelovertheedge.com.
	Origin string
	// Contact is the owner's address for a parent or guardian, and for
	// privacy requests.
	Contact string
	// Key signs the page's sessions and forms' tokens: random, made at the
	// start, so a restart signs everyone out.
	Key []byte
	Log *slog.Logger
	// Signed, if not nil, is told of each new signature: page or owner.
	Signed func(how string)
	// Now, if not nil, is the time.
	Now func() time.Time
}

// session is a signed-in person.
type session struct {
	ID      int64  `json:"id"`
	Login   string `json:"login"`
	Expires int64  `json:"exp"`
}

func (p *Page) now() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now()
}

func (p *Page) secure() bool { return strings.HasPrefix(p.Origin, "https://") }

func (p *Page) setUp() bool { return p.GitHub != nil }

// Handler serves the page's paths, all under /agreement, but the webhook's.
func (p *Page) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /agreement", p.page)
	mux.HandleFunc("GET /agreement/{$}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/agreement", http.StatusMovedPermanently)
	})
	mux.HandleFunc("GET /agreement/privacy", p.privacy)
	mux.HandleFunc("GET /agreement/v/{file}", p.text)
	mux.HandleFunc("GET /agreement/style.css", p.asset("static/style.css", "text/css; charset=utf-8"))
	mux.HandleFunc("GET /agreement/heading.ttf", p.asset("static/IMFellEnglishSC-Regular.ttf", "font/ttf"))
	mux.HandleFunc("GET /agreement/signin", p.signin)
	mux.HandleFunc("GET /agreement/callback", p.callback)
	mux.HandleFunc("POST /agreement/sign", p.sign)
	mux.HandleFunc("POST /agreement/signout", p.signout)
	mux.HandleFunc("GET /agreement/download", p.download)
	cross := http.NewCrossOriginProtection()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Frame-Options", "DENY")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		if err := cross.Check(r); err != nil {
			http.Error(w, "a cross-origin request", http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

// pageData is what the template shows.
type pageData struct {
	Kind          string // "", "privacy" or "minor"
	Title         string
	SetUp         bool
	User          *session
	Version       legal.Version
	Body          template.HTML
	Signed        []store.Signature
	SignedCurrent bool
	JustSigned    bool
	Error         string
	CSRF          string
	Contact       string
	// The form, as it was sent, to show it again.
	Age             string
	Name            string
	Employer, Agree bool
}

func (p *Page) render(w http.ResponseWriter, status int, d pageData) {
	d.SetUp = p.setUp()
	d.Contact = p.Contact
	if d.Version.Number == 0 {
		d.Version = legal.Current()
	}
	if d.Title == "" {
		d.Title = "Contributor agreement"
	}
	var buf bytes.Buffer
	if err := pageTemplate.Execute(&buf, d); err != nil {
		p.Log.Error("the signing page did not render", "err", err)
		http.Error(w, "the page could not be shown", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	w.Write(buf.Bytes())
}

func (p *Page) page(w http.ResponseWriter, r *http.Request) {
	v := legal.Current()
	d := pageData{Version: v, Body: Markdown(v.Text), JustSigned: r.URL.Query().Has("signed")}
	if s, ok := p.session(r); ok {
		if err := p.withSignatures(r.Context(), &d, s); err != nil {
			p.Log.Warn("a signer's signatures were not read", "err", err)
			http.Error(w, "the agreement's records did not answer; try again in a moment", http.StatusServiceUnavailable)
			return
		}
	}
	p.render(w, http.StatusOK, d)
}

// withSignatures fills in a signed-in person's session and signatures.
func (p *Page) withSignatures(ctx context.Context, d *pageData, s session) error {
	d.User = &s
	d.CSRF = p.csrf(s)
	sigs, err := p.Store.SignaturesOf(ctx, s.ID)
	if err != nil {
		return err
	}
	d.Signed = sigs
	for _, sig := range sigs {
		if sig.Version == d.Version.Number {
			d.SignedCurrent = true
		}
	}
	return nil
}

func (p *Page) privacy(w http.ResponseWriter, _ *http.Request) {
	p.render(w, http.StatusOK, pageData{Kind: "privacy", Title: "Privacy", Body: Markdown(legal.Privacy())})
}

// text serves a version's text, its exact bytes, whose SHA-256 a signature
// records: /agreement/v/1.md.
func (p *Page) text(w http.ResponseWriter, r *http.Request) {
	n, err := strconv.Atoi(strings.TrimSuffix(r.PathValue("file"), ".md"))
	v, ok := legal.Get(n)
	if err != nil || !ok || !strings.HasSuffix(r.PathValue("file"), ".md") {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.Write(v.Text)
}

func (p *Page) asset(name, contentType string) http.HandlerFunc {
	b, err := static.ReadFile(name)
	if err != nil {
		panic(err) // embedded
	}
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.Write(b)
	}
}

func (p *Page) cookie(name, value string, life time.Duration) *http.Cookie {
	return &http.Cookie{
		Name: name, Value: value, Path: "/agreement", MaxAge: int(life / time.Second),
		HttpOnly: true, Secure: p.secure(), SameSite: http.SameSiteLaxMode,
	}
}

func (p *Page) callbackURL() string { return p.Origin + "/agreement/callback" }

// signin sends a person to GitHub to sign in, with a state kept in a
// cookie that the callback must find again.
func (p *Page) signin(w http.ResponseWriter, r *http.Request) {
	if !p.setUp() {
		http.Redirect(w, r, "/agreement", http.StatusSeeOther)
		return
	}
	b := make([]byte, 32)
	rand.Read(b)
	state := base64.RawURLEncoding.EncodeToString(b)
	http.SetCookie(w, p.cookie(stateCookie, state, stateLife))
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, p.GitHub.AuthorizeURL(state, p.callbackURL()), http.StatusSeeOther)
}

// callback is where GitHub sends a person back: their state checked
// against the cookie, their code exchanged for who they are, and a session
// begun.
func (p *Page) callback(w http.ResponseWriter, r *http.Request) {
	if !p.setUp() {
		http.Redirect(w, r, "/agreement", http.StatusSeeOther)
		return
	}
	q := r.URL.Query()
	c, err := r.Cookie(stateCookie)
	http.SetCookie(w, p.cookie(stateCookie, "", -time.Second))
	if err != nil || c.Value == "" || subtle.ConstantTimeCompare([]byte(c.Value), []byte(q.Get("state"))) != 1 {
		p.render(w, http.StatusBadRequest, pageData{Version: legal.Current(), Body: Markdown(legal.Current().Text),
			Error: "The sign-in was not the one this page began, or took too long. Please sign in again."})
		return
	}
	if q.Get("code") == "" {
		// Turned down at GitHub.
		http.Redirect(w, r, "/agreement", http.StatusSeeOther)
		return
	}
	u, err := p.GitHub.SignedIn(r.Context(), q.Get("code"), p.callbackURL())
	if err != nil {
		p.Log.Warn("a sign-in failed", "err", err)
		p.render(w, http.StatusBadGateway, pageData{Version: legal.Current(), Body: Markdown(legal.Current().Text),
			Error: "GitHub did not confirm the sign-in. Please sign in again."})
		return
	}
	http.SetCookie(w, p.cookie(sessionCookie, p.seal(session{ID: u.ID, Login: u.Login, Expires: p.now().Add(sessionLife).Unix()}), sessionLife))
	http.Redirect(w, r, "/agreement#sign", http.StatusSeeOther)
}

func (p *Page) signout(w http.ResponseWriter, r *http.Request) {
	if s, ok := p.session(r); ok && p.formOK(w, r, s) {
		http.SetCookie(w, p.cookie(sessionCookie, "", -time.Second))
	}
	http.Redirect(w, r, "/agreement", http.StatusSeeOther)
}

// sign records a signature from the form: the person signed in, the token
// theirs, a name given and the three boxes ticked.
func (p *Page) sign(w http.ResponseWriter, r *http.Request) {
	s, ok := p.session(r)
	if !ok || !p.setUp() {
		http.Redirect(w, r, "/agreement", http.StatusSeeOther)
		return
	}
	if !p.formOK(w, r, s) {
		http.Error(w, "the form was not this page's, or is too old: go back to the agreement and sign again", http.StatusForbidden)
		return
	}
	v := legal.Current()
	d := pageData{Version: v, Body: Markdown(v.Text), Age: r.PostForm.Get("age"), Name: strings.TrimSpace(r.PostForm.Get("name")),
		Employer: r.PostForm.Get("employer") == "yes", Agree: r.PostForm.Get("agree") == "yes"}
	if d.Age == "minor" {
		d.Kind, d.Title, d.User = "minor", "Signing under 18", &s
		p.render(w, http.StatusOK, d)
		return
	}
	switch {
	case d.Age != "adult":
		d.Error = "Please say whether you are 18 or older."
	case !validName(d.Name):
		d.Error = "Please give your full name: the name you would sign a letter with."
	case !d.Employer || !d.Agree:
		d.Error = "Please tick both boxes to sign."
	}
	if d.Error != "" {
		if err := p.withSignatures(r.Context(), &d, s); err != nil {
			http.Error(w, "the agreement's records did not answer; try again in a moment", http.StatusServiceUnavailable)
			return
		}
		p.render(w, http.StatusBadRequest, d)
		return
	}
	made, err := p.Store.Sign(r.Context(), store.Signature{
		GitHubID: s.ID, Login: s.Login, Name: d.Name, Version: v.Number, TextSHA256: v.SHA256, How: store.SignedOnPage,
	})
	if err != nil {
		p.Log.Warn("a signature was not recorded", "err", err)
		http.Error(w, "the signature was not recorded: try again in a moment", http.StatusServiceUnavailable)
		return
	}
	if made {
		p.Log.Info("signed the contributor agreement", "github_id", s.ID, "version", v.Number)
		if p.Signed != nil {
			p.Signed(store.SignedOnPage)
		}
	}
	p.recheck(r.Context(), s.ID)
	http.Redirect(w, r, "/agreement?signed", http.StatusSeeOther)
}

// recheck queues the pull requests waiting for a signer.
func (p *Page) recheck(ctx context.Context, githubID int64) {
	prs, err := p.Store.WaitingFor(ctx, githubID)
	if err != nil {
		p.Log.Warn("a signer's pull requests were not found to check again", "err", err)
		return
	}
	p.Checker.Enqueue(prs...)
}

// download is a signature of the signed-in person's, with the text signed.
func (p *Page) download(w http.ResponseWriter, r *http.Request) {
	s, ok := p.session(r)
	if !ok {
		http.Redirect(w, r, "/agreement", http.StatusSeeOther)
		return
	}
	sigs, err := p.Store.SignaturesOf(r.Context(), s.ID)
	if err != nil {
		http.Error(w, "the agreement's records did not answer; try again in a moment", http.StatusServiceUnavailable)
		return
	}
	for _, sig := range sigs {
		if sig.ID.String() != r.URL.Query().Get("id") {
			continue
		}
		v, ok := legal.Get(sig.Version)
		if !ok {
			break
		}
		name := fmt.Sprintf("keel-over-the-edge-contributor-agreement-%d-%s.md", sig.Version, safeFile(sig.Login))
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
		w.Header().Set("Cache-Control", "no-store")
		w.Write(Download(v, sig, p.Origin))
		return
	}
	http.NotFound(w, r)
}

// Download is a version's text with a signature's record after it.
func Download(v legal.Version, sig store.Signature, origin string) []byte {
	var b bytes.Buffer
	b.Write(v.Text)
	fmt.Fprintf(&b, "\n\n---\n\n## Signature\n\n")
	fmt.Fprintf(&b, "- Name: %s\n", sig.Name)
	fmt.Fprintf(&b, "- GitHub account: %s (number %d)\n", sig.Login, sig.GitHubID)
	fmt.Fprintf(&b, "- Signed: %s\n", sig.SignedAt.UTC().Format("2 January 2006, 15:04:05 UTC"))
	if sig.How == store.SignedByOwner {
		fmt.Fprintf(&b, "- Recorded by the owner")
		if sig.Guardian != "" {
			fmt.Fprintf(&b, ", with the consent of %s, parent or guardian", sig.Guardian)
		}
		fmt.Fprintf(&b, "\n")
	} else {
		fmt.Fprintf(&b, "- Signed on the signing page, %s/agreement\n", origin)
	}
	fmt.Fprintf(&b, "- Version: %d\n", sig.Version)
	fmt.Fprintf(&b, "- SHA-256 of the agreement's text, everything above this record, as served at %s/agreement/v/%d.md: %s\n",
		origin, sig.Version, sig.TextSHA256)
	return b.Bytes()
}

// session is the signed-in person, if the request's cookie is a session
// this process sealed and it has not expired.
func (p *Page) session(r *http.Request) (session, bool) {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return session{}, false
	}
	body, sig, ok := strings.Cut(c.Value, ".")
	if !ok {
		return session{}, false
	}
	want := p.mac("session", body)
	got, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil || !hmac.Equal(got, want) {
		return session{}, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		return session{}, false
	}
	var s session
	if err := json.Unmarshal(raw, &s); err != nil || s.ID <= 0 || p.now().Unix() >= s.Expires {
		return session{}, false
	}
	return s, true
}

func (p *Page) seal(s session) string {
	raw, _ := json.Marshal(s)
	body := base64.RawURLEncoding.EncodeToString(raw)
	return body + "." + base64.RawURLEncoding.EncodeToString(p.mac("session", body))
}

func (p *Page) mac(purpose, s string) []byte {
	m := hmac.New(sha256.New, p.Key)
	m.Write([]byte(purpose + "\x00" + s))
	return m.Sum(nil)
}

// csrf is a session's forms' token.
func (p *Page) csrf(s session) string {
	return hex.EncodeToString(p.mac("csrf", strconv.FormatInt(s.ID, 10)+"/"+strconv.FormatInt(s.Expires, 10)))
}

// formOK reads a form, at most maxForm bytes, and checks its token is the
// session's.
func (p *Page) formOK(w http.ResponseWriter, r *http.Request, s session) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxForm)
	if err := r.ParseForm(); err != nil {
		return false
	}
	got, err := hex.DecodeString(r.PostForm.Get("csrf"))
	want, _ := hex.DecodeString(p.csrf(s))
	return err == nil && hmac.Equal(got, want)
}

// validName reports whether a name is one a person could sign with: not
// empty, not too long, and no control or formatting characters.
func validName(name string) bool {
	if name == "" || utf8.RuneCountInString(name) > maxName || !utf8.ValidString(name) {
		return false
	}
	letters := 0
	for _, r := range name {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return false
		}
		if unicode.IsLetter(r) {
			letters++
		}
	}
	return letters > 0
}

// safeFile keeps a GitHub login's characters that are safe in a file's
// name, which are all of a login's.
func safeFile(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' {
			return r
		}
		return '-'
	}, s)
}
