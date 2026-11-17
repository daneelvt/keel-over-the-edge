// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// cover is an inline style as the game's page has one.
const cover = "\n      html { background: #1a242c; }\n    "

// policyPage writes a built page with an inline style on the game's page,
// pages with script and pages without.
func policyPage(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range map[string]string{
		"index.html":             "<!doctype html><head><style>" + cover + "</style><script type=\"module\" crossorigin src=\"/assets/main-B7.js\"></script></head>",
		"sailors.html":           `<!doctype html><script type="module" src="/assets/sailors-A1.js"></script>`,
		"report.html":            `<!doctype html><link rel="stylesheet" href="/assets/pages-C3.css"><form id="notice"></form><SCRIPT type="module" src="/assets/report-B2.js"></SCRIPT>`,
		"rules.html":             `<!doctype html><link rel="stylesheet" href="/assets/pages-C3.css"><p>No script here, nor in <scripture>.</p>`,
		"approve.html":           `<!doctype html><script type="module" src="/assets/approve-E5.js"></script>`,
		"manifest.webmanifest":   `{"name":"Keel Over the Edge"}`,
		"assets/main-B7.js":      "console.log(1)",
		"assets/pages-C3.css":    "body{}",
		"assets/sailors-A1.js":   "console.log(2)",
		"assets/report-B2.js":    "console.log(3)",
		"assets/approve-E5.js":   "console.log(4)",
		"assets/inner.html":      "<style>x{}</style>",
		"assets/physics-20.wasm": "\x00asm\x01\x00\x00\x00",
	} {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// hashOf is a style's hash as a policy names it.
func hashOf(style string) string {
	sum := sha256.Sum256([]byte(style))
	return "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
}

func policyServer(t *testing.T, change func(*Config)) *testServer {
	t.Helper()
	page, err := OpenPage(policyPage(t))
	if err != nil {
		t.Fatal(err)
	}
	return newTestServer(t, noDatabase{}, func(c *Config) {
		c.Page = page
		c.Origin = "https://play.keelovertheedge.com"
		if change != nil {
			change(c)
		}
	})
}

func headersOf(t *testing.T, srv *testServer, path string) http.Header {
	t.Helper()
	res, err := http.Get(srv.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("%s: %d", path, res.StatusCode)
	}
	return res.Header
}

// TestPagePolicies: each page the play listener serves by name sends its
// policy and X-Frame-Options: DENY. The game's page may run its own script
// and the human check's, and its inline style by its hash; the other pages
// with script the same without the check; a page without script loads its
// styles, images and fonts alone. The page's other files send none.
func TestPagePolicies(t *testing.T) {
	srv := policyServer(t, func(c *Config) {
		c.CheckOrigin = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
	})
	game := "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com; worker-src 'self' blob:; " +
		"connect-src 'self' wss://play.keelovertheedge.com blob:; img-src 'self' blob: data:; style-src 'self' " + hashOf(cover) + "; " +
		"font-src 'self'; manifest-src 'self'; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'none'; " +
		"form-action 'self'; require-trusted-types-for 'script'; trusted-types keel default"
	scripted := "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; " +
		"connect-src 'self' wss://play.keelovertheedge.com blob:; img-src 'self' blob: data:; style-src 'self'; " +
		"font-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; " +
		"form-action 'self'; require-trusted-types-for 'script'; trusted-types keel default"
	static := "default-src 'none'; style-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
	for path, want := range map[string]string{
		"/":             game,
		"/?s=abc":       game,
		"/index.html":   game,
		"/sailors.html": scripted,
		"/report.html":  scripted,
		"/report":       scripted,
		"/rules.html":   static,
	} {
		h := headersOf(t, srv, path)
		if got := h.Get("Content-Security-Policy"); got != want {
			t.Errorf("%s:\n got %s\nwant %s", path, got, want)
		}
		if h.Get("Content-Security-Policy-Report-Only") != "" {
			t.Errorf("%s: a report too", path)
		}
		if h.Get("X-Frame-Options") != "DENY" {
			t.Errorf("%s: X-Frame-Options %q", path, h.Get("X-Frame-Options"))
		}
	}
	for _, path := range []string{"/assets/main-B7.js", "/assets/pages-C3.css", "/manifest.webmanifest", "/assets/physics-20.wasm"} {
		if h := headersOf(t, srv, path); h.Get("Content-Security-Policy") != "" || h.Get("X-Frame-Options") != "" {
			t.Errorf("%s: a policy %q", path, h.Get("Content-Security-Policy"))
		}
	}
}

// TestPagePoliciesReported: KEEL_PAGE_POLICY=report sends the same
// policies as reports only; without a check the game's page names no
// other origin; without a play origin, the connection is 'self”s.
func TestPagePoliciesReported(t *testing.T) {
	srv := policyServer(t, func(c *Config) { c.PolicyReport = true })
	for _, path := range []string{"/", "/sailors.html", "/rules.html", "/report"} {
		h := headersOf(t, srv, path)
		if h.Get("Content-Security-Policy") != "" || h.Get("Content-Security-Policy-Report-Only") == "" {
			t.Errorf("%s: enforced %q, reported %q", path, h.Get("Content-Security-Policy"), h.Get("Content-Security-Policy-Report-Only"))
		}
		if h.Get("X-Frame-Options") != "DENY" {
			t.Errorf("%s: X-Frame-Options %q", path, h.Get("X-Frame-Options"))
		}
	}
	got := headersOf(t, srv, "/").Get("Content-Security-Policy-Report-Only")
	if strings.Contains(got, "cloudflare") || strings.Contains(got, "frame-src") || !strings.Contains(got, "trusted-types keel default") {
		t.Errorf("without a check: %s", got)
	}

	local := policyServer(t, func(c *Config) { c.Origin = "http://localhost:18088" })
	if got := headersOf(t, local, "/").Get("Content-Security-Policy"); !strings.Contains(got, "connect-src 'self' ws://localhost:18088 blob:;") {
		t.Errorf("an http origin: %s", got)
	}
	none := policyServer(t, func(c *Config) { c.Origin = "" })
	if got := headersOf(t, none, "/").Get("Content-Security-Policy"); !strings.Contains(got, "connect-src 'self' blob:;") {
		t.Errorf("no origin: %s", got)
	}
}

// TestPageServeSendsNoPolicy: the approval page and the world page are
// served through Serve, by routes that send policies of their own.
func TestPageServeSendsNoPolicy(t *testing.T) {
	page, err := OpenPage(policyPage(t))
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	page.Serve(w, httptest.NewRequest("GET", "/oauth/authorize", nil), "approve.html")
	if w.Code != http.StatusOK || w.Header().Get("Content-Security-Policy") != "" || w.Header().Get("X-Frame-Options") != "" {
		t.Errorf("%d %v", w.Code, w.Header())
	}
}

// TestCoverHash: the game's page's cover, its one inline style, is allowed
// by the hash of its text as the page holds it, the build's too when
// there is one: the hash is taken when the page is read, so an edit to the
// cover changes it.
func TestCoverHash(t *testing.T) {
	for _, file := range []string{"../../client/index.html", "../../client/dist/index.html"} {
		body, err := os.ReadFile(file)
		if os.IsNotExist(err) && strings.Contains(file, "dist") {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		s := string(body)
		start := strings.Index(s, "<style>")
		end := strings.Index(s, "</style>")
		if start < 0 || end < start || strings.Count(s, "<style") != 1 {
			t.Fatalf("%s: not one inline style", file)
		}
		want := hashOf(s[start+len("<style>") : end])
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "index.html"), body, 0o644); err != nil {
			t.Fatal(err)
		}
		page, err := OpenPage(dir)
		if err != nil {
			t.Fatal(err)
		}
		got := page.policies(PolicyOptions{})["index.html"].value
		if !strings.Contains(got, "style-src 'self' "+want+";") || !strings.Contains(got, "require-trusted-types-for 'script'") {
			t.Errorf("%s: %s, want the hash %s", file, got, want)
		}
	}
}

// TestStyleHashes: every inline style, its attributes and its case aside,
// in order; a <styles> or a style left open is none.
func TestStyleHashes(t *testing.T) {
	for page, want := range map[string][]string{
		"<style>a{}</style><p>x</p><STYLE media=\"screen\">b{}</Style>": {hashOf("a{}"), hashOf("b{}")},
		"<style>\n</style>":         {hashOf("\n")},
		"<styles>a{}</styles>":      nil,
		"<style>a{}":                nil,
		"<p>no style</p>":           nil,
		"<style":                    nil,
		"<style\n>é{}</style>":      {hashOf("é{}")},
		"<link rel=\"stylesheet\">": nil,
	} {
		got := styleHashes([]byte(page))
		if strings.Join(got, " ") != strings.Join(want, " ") {
			t.Errorf("%q: %v, want %v", page, got, want)
		}
	}
	for page, want := range map[string]bool{
		`<script src="/a.js"></script>`: true, "<SCRIPT\nsrc=x>": true, "<noscript>x</noscript>": false,
		"<scripture>": false, "before any script": false, "<script": false,
	} {
		if runsScript([]byte(page)) != want {
			t.Errorf("%q: %v", page, !want)
		}
	}
}

// TestPolicyOrigins: the check's origin is an http or https address's
// scheme and host, nothing a policy could read as another source; the game
// connection's follows the play origin's scheme.
func TestPolicyOrigins(t *testing.T) {
	for in, want := range map[string]string{
		"https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit": "https://challenges.cloudflare.com",
		"http://localhost:18088/turnstile/api.js":                               "http://localhost:18088",
		"https://challenges.cloudflare.com":                                     "https://challenges.cloudflare.com",
		"":                                                                      "",
		"/turnstile/api.js":                                                     "",
		"javascript:alert(1)":                                                   "",
		"https://a.example; script-src *":                                       "",
		"https://user@challenges.example.com":                                   "",
		"data:text/javascript,1":                                                "",
	} {
		if got := originOf(in); got != want {
			t.Errorf("originOf(%q) = %q, want %q", in, got, want)
		}
	}
	for in, want := range map[string]string{
		"https://play.keelovertheedge.com": "wss://play.keelovertheedge.com",
		"http://localhost:5181":            "ws://localhost:5181",
		"":                                 "",
		"ftp://example.com":                "",
	} {
		if got := socketOrigin(in); got != want {
			t.Errorf("socketOrigin(%q) = %q, want %q", in, got, want)
		}
	}
}
