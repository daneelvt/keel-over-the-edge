// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"net/http"
	"net/netip"
)

// AddressHeader is the header Cloudflare sets to the address a request
// came from, replacing any the client sent. Only Traefik reaches keel, and
// only Cloudflare's tunnel reaches Traefik, so keel trusts it.
const AddressHeader = "Cf-Connecting-Ip"

// IPv6Prefix is how many bits of an IPv6 address are one address to the
// game's counts: a /56, a household's or a small office's whole network,
// which hands its devices many addresses of it.
const IPv6Prefix = 56

type addressKey struct{}

// clientAddress puts the address each request came from in its context,
// for Address: Cloudflare's header when it holds an address, else the
// connection's own (the local cluster, tests). It is never logged.
func clientAddress(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		addr := addressOf(r.Header.Get(AddressHeader), r.RemoteAddr)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), addressKey{}, addr)))
	})
}

// addressOf is the address a request came from: header when it parses as
// an address, else remote's host; an IPv4 address carried in IPv6 is the
// IPv4 address. The zero Addr when neither is one.
func addressOf(header, remote string) netip.Addr {
	if a, err := netip.ParseAddr(header); err == nil && a.Zone() == "" {
		return a.Unmap()
	}
	if ap, err := netip.ParseAddrPort(remote); err == nil {
		return ap.Addr().WithZone("").Unmap()
	}
	if a, err := netip.ParseAddr(remote); err == nil {
		return a.WithZone("").Unmap()
	}
	return netip.Addr{}
}

// Address is the address a request came from, as the middleware read it:
// the zero Addr when it could not be read, or for a context no request of
// the game's carries.
func Address(ctx context.Context) netip.Addr {
	a, _ := ctx.Value(addressKey{}).(netip.Addr)
	return a
}

// AddressPrefix is the network an address counts as one of: an IPv4
// address alone, an IPv6 address's /56. Not valid for the zero Addr.
func AddressPrefix(a netip.Addr) netip.Prefix {
	a = a.Unmap()
	if !a.IsValid() {
		return netip.Prefix{}
	}
	bits := 32
	if a.Is6() {
		bits = IPv6Prefix
	}
	p, _ := a.Prefix(bits)
	return p
}

// prefixBytes are the bytes of an address's prefix: an IPv4 address's 4,
// an IPv6 /56's 7, so the two never share bytes; none for the zero Addr.
func prefixBytes(a netip.Addr) []byte {
	p := AddressPrefix(a)
	if !p.IsValid() {
		return nil
	}
	b := p.Addr().AsSlice()
	return b[:p.Bits()/8]
}

// AddressKeyed is an address's prefix as the database keeps it:
// HMAC-SHA256 under key, so that a database or a backup alone never gives
// the address back (an unkeyed hash of every IPv4 address is reversed in
// minutes). Every request whose address could not be read shares one.
func AddressKeyed(key []byte, a netip.Addr) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(prefixBytes(a))
	return m.Sum(nil)
}
