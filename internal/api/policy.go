// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/url"
	"strings"
)

// Every page the play listener serves by name sends a Content Security
// Policy of its own, and X-Frame-Options: DENY. A page that runs script
// may run only the page's own files and compile WebAssembly (the physics,
// the models' and textures' decoders), start workers from its own files
// and its own blob: addresses (three.js's texture transcoder is one),
// fetch from its own origin, its game connection and its own blob:
// addresses (the textures inside the sailors' models), and draw its own
// images, styles and fonts; script addresses pass through its Trusted
// Types policies (client/src/boot/policy.ts), and no HTML string reaches
// the page. The game's own page may load the human check's script and
// frame from the check's origin, when there is a check. A page without
// script may load its styles, images and fonts alone. No page may be
// framed, change its base or post a form elsewhere.
//
// An inline <style> is allowed by its hash, taken from the built page when
// the page's files are read: editing one changes the hash with it. Nothing
// else inline is allowed: no inline script, no style attribute, no handler.
//
// The approval page for AI apps, the world page and the agreement page are
// served elsewhere and send policies of their own.

// PolicyOptions are what the pages' policies are built from.
type PolicyOptions struct {
	// Origin is the play origin, whose game connection's address the
	// pages may open: wss:// for an https:// origin, ws:// for http://.
	// Without it only 'self' is allowed, which browsers read differently
	// for a WebSocket.
	Origin string
	// Check, if not "", is the human check's origin (its script's address
	// reduced to its origin), whose script and frame the game's page may
	// load. "" leaves it out: there is no check.
	Check string
	// Report sends each policy as Content-Security-Policy-Report-Only:
	// the browser tells the page what it would refuse, and refuses
	// nothing.
	Report bool
}

// The policy's headers.
const (
	policyHeader       = "Content-Security-Policy"
	policyReportHeader = "Content-Security-Policy-Report-Only"
)

// gamePage is the game's own page, the one that may load the human check.
const gamePage = "index.html"

// pagePolicy is a page's policy, as its header sends it.
type pagePolicy struct {
	header, value string
}

// set writes the policy and the frame refusal to the answer's headers.
func (p pagePolicy) set(h http.Header) {
	if p.value == "" {
		return
	}
	h.Set(p.header, p.value)
	h.Set("X-Frame-Options", "DENY")
}

// policies are the policies of every HTML page the page holds, by name.
func (p *Page) policies(o PolicyOptions) map[string]pagePolicy {
	header := policyHeader
	if o.Report {
		header = policyReportHeader
	}
	check := originOf(o.Check)
	out := map[string]pagePolicy{}
	for name, f := range p.files {
		if !f.html {
			continue
		}
		var v string
		switch {
		case !f.script:
			v = staticPolicy(f.styles)
		case name == gamePage:
			v = scriptPolicy(f.styles, o.Origin, check)
		default:
			v = scriptPolicy(f.styles, o.Origin, "")
		}
		out[name] = pagePolicy{header: header, value: v}
	}
	return out
}

// scriptPolicy is the policy of a page that runs script: its inline
// styles' hashes, the play origin, and the human check's origin or "".
func scriptPolicy(styles []string, origin, check string) string {
	script := "'self' 'wasm-unsafe-eval'"
	if check != "" {
		script += " " + check
	}
	connect := "'self'"
	if ws := socketOrigin(origin); ws != "" {
		connect += " " + ws
	}
	connect += " blob:"
	parts := []string{
		"default-src 'none'",
		"script-src " + script,
		"worker-src 'self' blob:",
		"connect-src " + connect,
		"img-src 'self' blob: data:",
		"style-src " + styleSources(styles),
		"font-src 'self'",
		"manifest-src 'self'",
	}
	if check != "" {
		parts = append(parts, "frame-src "+check)
	}
	parts = append(parts,
		"frame-ancestors 'none'",
		"base-uri 'none'",
		"form-action 'self'",
		"require-trusted-types-for 'script'",
		"trusted-types keel default",
	)
	return strings.Join(parts, "; ")
}

// staticPolicy is the policy of a page without script: its styles, images
// and fonts alone.
func staticPolicy(styles []string) string {
	return strings.Join([]string{
		"default-src 'none'",
		"style-src " + styleSources(styles),
		"img-src 'self' data:",
		"font-src 'self'",
		"frame-ancestors 'none'",
		"base-uri 'none'",
		"form-action 'none'",
	}, "; ")
}

// styleSources are 'self' and each inline style's hash.
func styleSources(styles []string) string {
	return strings.Join(append([]string{"'self'"}, styles...), " ")
}

// socketOrigin is the game connection's origin at the play origin: ws://
// or wss:// at its host, "" if there is none.
func socketOrigin(origin string) string {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return ""
	}
	switch u.Scheme {
	case "https":
		return "wss://" + u.Host
	case "http":
		return "ws://" + u.Host
	}
	return ""
}

// originOf is an address's origin, its scheme and host, for a policy: ""
// for anything but an http or https address with a host and nothing a
// policy could read as more than one source.
func originOf(address string) string {
	if address == "" {
		return ""
	}
	u, err := url.Parse(address)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil ||
		strings.ContainsAny(u.Host, " ;,'\"") {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// styleHashes are a page's inline <style> elements' hashes, as a policy
// names them: 'sha256-' and the base64 of the SHA-256 of each one's text,
// in the page's order.
func styleHashes(page []byte) []string {
	var out []string
	lower := asciiLower(page)
	for i := 0; ; {
		at := bytes.Index(lower[i:], []byte("<style"))
		if at < 0 {
			return out
		}
		at += i
		after := at + len("<style")
		if after >= len(lower) {
			return out
		}
		if c := lower[after]; c != '>' && c != ' ' && c != '\t' && c != '\n' && c != '\r' && c != '/' {
			i = after
			continue
		}
		open := bytes.IndexByte(lower[after:], '>')
		if open < 0 {
			return out
		}
		start := after + open + 1
		end := bytes.Index(lower[start:], []byte("</style"))
		if end < 0 {
			return out
		}
		sum := sha256.Sum256(page[start : start+end])
		out = append(out, "'sha256-"+base64.StdEncoding.EncodeToString(sum[:])+"'")
		i = start + end
	}
}

// runsScript reports whether a page has a <script> element.
func runsScript(page []byte) bool {
	lower := asciiLower(page)
	for i := 0; ; {
		at := bytes.Index(lower[i:], []byte("<script"))
		if at < 0 {
			return false
		}
		after := i + at + len("<script")
		if after >= len(lower) {
			return false
		}
		if c := lower[after]; c == '>' || c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '/' {
			return true
		}
		i = after
	}
}

// asciiLower is b with its ASCII letters lowercase, every byte where it
// was.
func asciiLower(b []byte) []byte {
	out := make([]byte, len(b))
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		out[i] = c
	}
	return out
}
