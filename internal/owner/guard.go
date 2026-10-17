// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"mime"
	"net"
	"net/http"
	"strings"
)

// The guard. The owner's browser reaches the internal listener at
// http://localhost through a forward, and any web page the owner has open
// can send a request there too:
//
//   - A cross-site request: the Fetch standard's Sec-Fetch-Site header says
//     where it comes from, and the Origin header (RFC 6454) whose page sent
//     it. net/http's CrossOriginProtection refuses a request that changes
//     anything (not GET, HEAD or OPTIONS) unless it is same-origin or the
//     user's own (Sec-Fetch-Site: none), or, without that header, unless
//     its Origin's host is its Host.
//   - DNS rebinding: a site whose name is re-pointed at 127.0.0.1 is, to
//     the browser, the same origin as itself, so its requests pass the
//     check above, and its GETs would read the whole map. Every such
//     request carries the site's own name as its Host, so a request whose
//     Host is not localhost or a loopback address is refused, whatever its
//     method (NCC Group, "Preventing DNS Rebinding Attacks"; the MCP SDKs'
//     host header validation does the same).
//
// A control's body is JSON alone, which a form cannot send, and at most
// MaxBody bytes. No response carries a CORS header, so no other origin's
// script reads one; each forbids framing and carries a strict Content
// Security Policy. http://localhost is a secure context in every browser
// (W3C, Secure Contexts), so the page needs no certificate.

// MaxBody is the most a control's body may be, bytes.
const MaxBody = 4 << 10

// csp is the page's Content Security Policy: its own scripts, styles and
// images alone, no inline script, nothing framed and no frame of it.
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; " +
	"font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

// Guard refuses what the guard refuses, calling refused, if not nil, for
// each, and passes the rest to next.
func Guard(next http.Handler, refused func()) http.Handler {
	cross := http.NewCrossOriginProtection()
	refuse := func(w http.ResponseWriter, status int, why string) {
		if refused != nil {
			refused()
		}
		http.Error(w, why, status)
	}
	cross.SetDenyHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		refuse(w, http.StatusForbidden, "a cross-origin request")
	}))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Frame-Options", "DENY")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		if !LocalHost(r.Host) {
			refuse(w, http.StatusForbidden, "this page is served to this computer alone")
			return
		}
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			next.ServeHTTP(w, r)
			return
		}
		if err := cross.Check(r); err != nil {
			refuse(w, http.StatusForbidden, "a cross-origin request")
			return
		}
		if t, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || t != "application/json" {
			refuse(w, http.StatusUnsupportedMediaType, "a control's body is JSON")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, MaxBody)
		next.ServeHTTP(w, r)
	})
}

// LocalHost reports whether a request's Host names this computer:
// localhost, or a loopback address, on any port, which is the owner's to
// choose for the forward.
func LocalHost(host string) bool {
	if host == "" {
		return false
	}
	name := host
	if h, _, err := net.SplitHostPort(host); err == nil {
		name = h
	} else if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		name = host[1 : len(host)-1]
	}
	if strings.EqualFold(name, "localhost") {
		return true
	}
	ip := net.ParseIP(name)
	return ip != nil && ip.IsLoopback()
}
