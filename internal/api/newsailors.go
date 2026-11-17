// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/humancheck"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// NewSailors are the limits on making a new sailor, at POST /account/begin,
// before the passkey prompt: how many one address may make in a day, as
// the owner sets it (Config.Switches), and the human check.
type NewSailors struct {
	// Count keeps the new sailors from each address: the store.
	Count NewSailorCount
	// Key is the address key: an address is kept only as its HMAC under it
	// (AddressKeyed).
	Key []byte
	// Check, if not nil, is the human check, made while the owner has it
	// on; SiteKey and Script are what the page renders its widget with.
	Check   HumanCheck
	SiteKey string
	Script  string
}

// NewSailorCount counts the new sailors from an address's key since a
// time, and tells when the oldest of them was made: the store.
type NewSailorCount interface {
	NewSailorsFrom(ctx context.Context, key []byte, since time.Time) (int64, time.Time, error)
}

// HumanCheck checks a page's Turnstile token: humancheck.Checker.
type HumanCheck interface {
	Check(ctx context.Context, token, remoteip string) humancheck.Result
}

var _ HumanCheck = (*humancheck.Checker)(nil)

// perAddress is how many new sailors one address may make in a day.
func (a *api) perAddress() int64 {
	if s := a.cfg.Switches; s != nil && s.NewSailorsPerAddress() > 0 {
		return int64(s.NewSailorsPerAddress())
	}
	return aboard.DefaultNewSailorsPerAddress
}

// checking reports whether a new sailor passes the human check: one is set
// up, and the owner has it on.
func (a *api) checking() bool {
	ns := a.cfg.NewSailors
	return ns != nil && ns.Check != nil && (a.cfg.Switches == nil || a.cfg.Switches.HumanCheck())
}

// letIn decides whether a new sailor may go on to the passkey prompt: the
// address's count first, so a full address spends none of Cloudflare's
// checks, then the human check, token. The token is spent whatever begin
// answers next. On a refusal it has answered, and returns false.
//
//	429 {"error":"often"} + Retry-After  the address has made its day's sailors
//	403 {"error":"check"}                no token, or one refused or spent
//	503 {"error":"check-unavailable"}    Cloudflare could not answer: no new
//	                                     sailor until it can (or the owner
//	                                     switches the check off)
func (a *api) letIn(w http.ResponseWriter, r *http.Request, token string) bool {
	ns := a.cfg.NewSailors
	if ns == nil {
		a.cfg.Metrics.HumanChecks.WithLabelValues(string(humancheck.Off)).Inc()
		return true
	}
	addr := Address(r.Context())
	now := time.Now()
	made, oldest, err := ns.Count.NewSailorsFrom(r.Context(), AddressKeyed(ns.Key, addr), now.Add(-store.NewSailorWindow))
	if err != nil {
		a.unavailable(w, r, "counting new sailors", err)
		return false
	}
	if made >= a.perAddress() {
		a.cfg.Metrics.NewSailorsRefused.WithLabelValues("address").Inc()
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter(oldest, now)))
		writeError(w, http.StatusTooManyRequests, "often")
		return false
	}
	if !a.checking() {
		a.cfg.Metrics.HumanChecks.WithLabelValues(string(humancheck.Off)).Inc()
		return true
	}
	remote := ""
	if addr.IsValid() {
		remote = addr.String()
	}
	res := ns.Check.Check(r.Context(), token, remote)
	a.cfg.Metrics.HumanChecks.WithLabelValues(string(res)).Inc()
	switch res {
	case humancheck.Passed:
		return true
	case humancheck.Unavailable:
		a.cfg.Metrics.NewSailorsRefused.WithLabelValues("check").Inc()
		writeError(w, http.StatusServiceUnavailable, "check-unavailable")
	default:
		a.cfg.Metrics.NewSailorsRefused.WithLabelValues("check").Inc()
		writeError(w, http.StatusForbidden, "check")
	}
	return false
}

// retryAfter is how many seconds until the oldest of an address's sailors
// leaves the day it counts for: at least 1.
func retryAfter(oldest, now time.Time) int {
	d := oldest.Add(store.NewSailorWindow).Sub(now)
	return max(1, int((d+time.Second-1)/time.Second))
}

// from is the keyed hash of the address a request came from, kept with the
// account it makes; nil when new sailors are not counted.
func (a *api) from(r *http.Request) []byte {
	if a.cfg.NewSailors == nil {
		return nil
	}
	return AddressKeyed(a.cfg.NewSailors.Key, Address(r.Context()))
}

// checkShown is the human check as the page renders it: its widget's site
// key and its script's address.
type checkShown struct {
	SiteKey string `json:"siteKey"`
	Script  string `json:"script"`
}

// noSession is GET /api/me's answer to a browser without a session: whether
// it has had a sailor, so the start screen offers to sign in first, and the
// human check its new sailor would pass, null for none.
type noSession struct {
	Error  string      `json:"error"`
	Sailed bool        `json:"sailed"`
	Check  *checkShown `json:"check"`
}

// noMe answers GET /api/me without a session: 401, with noSession.
func (a *api) noMe(w http.ResponseWriter, r *http.Request) {
	body := noSession{Error: "session", Sailed: auth.Sailed(r)}
	if a.checking() {
		body.Check = &checkShown{SiteKey: a.cfg.NewSailors.SiteKey, Script: a.cfg.NewSailors.Script}
	}
	writeJSON(w, http.StatusUnauthorized, body)
}
