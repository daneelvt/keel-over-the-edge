// SPDX-License-Identifier: AGPL-3.0-only

package oauth

import (
	"net"
	"net/url"
	"strings"
)

// Redirect URIs. A client lists where its sign-ins may return; a request
// names one, which must be one listed (OAuth 2.1, draft -16, 2.3.1 and
// 4.1.3): an https URI, character for character; or a loopback one, on
// this computer, whose port may be any, since an app on the computer
// listens where it can (8.4.2), the rest matched exactly. Nothing else: no
// other http, no custom scheme.

// MaxRedirectURI is the longest redirect URI accepted.
const MaxRedirectURI = 2048

// loopbackNames are the hosts of a redirect to an app on this computer.
var loopbackNames = map[string]bool{"127.0.0.1": true, "[::1]": true, "localhost": true}

// redirectURI checks a redirect URI a client lists or a request names, and
// reports whether it is a loopback one.
func redirectURI(s string) (loopback bool, ok bool) {
	if len(s) == 0 || len(s) > MaxRedirectURI || strings.ContainsAny(s, " \t\r\n#") {
		return false, false
	}
	u, err := url.Parse(s)
	if err != nil || !u.IsAbs() || u.Opaque != "" || u.User != nil || u.Fragment != "" || u.Host == "" {
		return false, false
	}
	switch u.Scheme {
	case "https":
		return false, true
	case "http":
		return true, loopbackNames[strings.ToLower(hostOnly(u.Host))]
	}
	return false, false
}

// hostOnly is a URL's host without its port, an IPv6 address in its
// brackets.
func hostOnly(hostport string) string {
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		if strings.Contains(h, ":") {
			return "[" + h + "]"
		}
		return h
	}
	return hostport
}

// matchRedirect reports whether a request's redirect URI is one the
// client listed.
func matchRedirect(requested string, listed []string) bool {
	loop, ok := redirectURI(requested)
	if !ok {
		return false
	}
	if !loop {
		for _, l := range listed {
			if l == requested {
				return true
			}
		}
		return false
	}
	r, _ := url.Parse(requested)
	for _, l := range listed {
		if lloop, ok := redirectURI(l); !ok || !lloop {
			continue
		}
		u, _ := url.Parse(l)
		if strings.EqualFold(hostOnly(u.Host), hostOnly(r.Host)) && u.EscapedPath() == r.EscapedPath() &&
			u.RawQuery == r.RawQuery && u.ForceQuery == r.ForceQuery {
			return true
		}
	}
	return false
}

// returnHost is what the approval page shows first of where the sign-in
// returns: the redirect's host, or none for an app on this computer.
func returnHost(redirect string) (host string, loopback bool) {
	loop, _ := redirectURI(redirect)
	if loop {
		return "", true
	}
	u, err := url.Parse(redirect)
	if err != nil {
		return "", false
	}
	return u.Hostname(), false
}

func isIP(host string) bool {
	return net.ParseIP(strings.Trim(host, "[]")) != nil
}
