// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// conditional reports whether a sign-in is the one offered as the name
// field is touched (autofill), ?mediation=conditional, rather than the
// browser's own prompt.
func conditional(r *http.Request) bool { return r.URL.Query().Get("mediation") == "conditional" }

// beginSignIn answers POST /signin/begin: a sign-in with whichever of the
// game's passkeys the browser holds, no name typed. With
// ?mediation=conditional, the browser offers them as the name field is
// touched, and waits while the player makes a new sailor instead.
//
//	200 options             {"publicKey": …, "mediation"?} for navigator.credentials.get()
//	409 {"error":"session"} the request already has a session
func (a *api) beginSignIn(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.SessionFromContext(r.Context()); ok {
		writeError(w, http.StatusConflict, "session")
		return
	}
	b, err := a.cfg.Passkeys.BeginSignIn(conditional(r))
	if err != nil {
		a.unavailable(w, r, "beginning a sign-in", err)
		return
	}
	a.begin(w, r, store.Ceremony{Kind: store.CeremonySignIn}, b)
}

// finishSignIn answers POST /signin/finish: the passkey the browser offered
// is checked, what it says of itself written back, and a new session made,
// whose cookie the answer sets.
//
//	200 {"name", "look", "accepted", "recovered"?}
//	400 {"error":"refused"}          the browser's answer is not accepted
//	404 {"error":"unknown-passkey", "unknown"}  no account has the passkey
//	                                 (its account was deleted, or it was
//	                                 removed); the browser may forget it
//	409 {"error":"again"}            no ceremony to finish
//	409 {"error":"session"}          the request already has a session
func (a *api) finishSignIn(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.SessionFromContext(r.Context()); ok {
		writeError(w, http.StatusConflict, "session")
		return
	}
	body, ok := answer(w, r)
	if !ok {
		return
	}
	c, ok := a.take(w, r, store.CeremonySignIn)
	if !ok {
		return
	}
	var holder store.Holder
	u, key, err := a.cfg.Passkeys.FinishSignIn(c.Session, body, func(handle []byte) (*auth.User, error) {
		h, err := a.cfg.Accounts.AccountByUserHandle(r.Context(), handle)
		if err != nil {
			return nil, err
		}
		holder = h
		return userOf(&h), nil
	})
	if unknown, ok := errors.AsType[*auth.UnknownPasskey](err); ok {
		a.ceremonyCounted(c.Kind, "refused")
		writeJSON(w, http.StatusNotFound, refusal{Error: "unknown-passkey", Unknown: a.unknownCredential(unknown.CredentialID)})
		return
	}
	if errors.Is(err, auth.ErrRefused) {
		a.refusedPasskey(w, r, c.Kind, err)
		return
	}
	if err != nil {
		a.unavailable(w, r, "finding a passkey's account", err)
		return
	}
	a.used(r, holder.ID, key)
	var recovered time.Time
	session, err := auth.Issue(a.cfg.Log, "session", auth.DrawToken, func(d auth.Drawn) error {
		var err error
		recovered, err = a.cfg.Accounts.SignIn(r.Context(), holder.ID, d.Hash)
		return err
	})
	token, hash := session.Token, session.Hash
	if err != nil {
		a.unavailable(w, r, "signing in", err)
		return
	}
	a.ceremonyCounted(c.Kind, "finished")
	mediation := "prompt"
	if conditional(r) {
		mediation = "conditional"
	}
	a.cfg.Metrics.SignIns.WithLabelValues(mediation).Inc()
	obs.SetAccount(r.Context(), holder.ID.String())
	a.cfg.Sessions.Add(hash, store.Session{Account: holder.Account})
	http.SetCookie(w, auth.SessionCookie(token))
	writeJSON(w, http.StatusOK, sailorResponse{
		Name: holder.Name, Look: holder.Look, Recovered: ms(recovered), Accepted: a.cfg.Passkeys.Accepted(u),
	})
}

// recoveryRequest is POST /recovery's body: the recovery code as typed.
type recoveryRequest struct {
	Code string `json:"code"`
}

// recover answers POST /recovery: the recovery code, typed in any case,
// with or without its hyphens, signs its account in once. The code is
// spent, every other session of the account ends (whoever uses it may have
// lost a phone), and the session made may only add a passkey until one is
// added, when a new code is shown.
//
//	200 {"name", "look", "addPasskey": true}
//	409 {"error":"session"} the request already has a session
//	422 {"error":"code"}    not a recovery code, or one no account has
func (a *api) recover(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.SessionFromContext(r.Context()); ok {
		writeError(w, http.StatusConflict, "session")
		return
	}
	var req recoveryRequest
	if !readJSON(w, r, &req) {
		return
	}
	code, ok := auth.HashRecoveryCode(req.Code)
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "code")
		return
	}
	var acc store.Account
	session, err := auth.Issue(a.cfg.Log, "session", auth.DrawToken, func(d auth.Drawn) error {
		var err error
		acc, err = a.cfg.Accounts.Recover(r.Context(), code, d.Hash)
		return err
	})
	token, hash := session.Token, session.Hash
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusUnprocessableEntity, "code")
		return
	}
	if err != nil {
		a.unavailable(w, r, "using a recovery code", err)
		return
	}
	a.cfg.Metrics.RecoveryUsed.Inc()
	a.cfg.Log.Info("a recovery code used", "request_id", obs.RequestID(r.Context()), "account", acc.ID.String())
	obs.SetAccount(r.Context(), acc.ID.String())
	a.cfg.Sessions.ForgetAccount(acc.ID)
	a.cfg.Sessions.Add(hash, store.Session{Account: acc, Held: true})
	http.SetCookie(w, auth.SessionCookie(token))
	writeJSON(w, http.StatusOK, sailorResponse{Name: acc.Name, Look: acc.Look, AddPasskey: true})
}

// logout answers POST /logout, behind auth.Signed: this session ends, and
// its cookie with it.
func (a *api) logout(w http.ResponseWriter, r *http.Request) {
	cur, _ := auth.SessionFromContext(r.Context())
	if err := a.cfg.Accounts.EndSession(r.Context(), cur.Hash); err != nil {
		a.unavailable(w, r, "ending a session", err)
		return
	}
	a.cfg.Sessions.Forget(cur.Hash)
	http.SetCookie(w, auth.ClearedSessionCookie())
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

// madeOn is the device and browser a passkey is made on, as the account
// page lists it ("iPhone · Safari"), from the User-Agent of the request
// that made it; a browser not known is "a browser".
func madeOn(ua string) string {
	var device string
	switch {
	case strings.Contains(ua, "iPhone"):
		device = "iPhone"
	case strings.Contains(ua, "iPad"):
		device = "iPad"
	case strings.Contains(ua, "Android"):
		device = "Android"
	case strings.Contains(ua, "CrOS"):
		device = "Chromebook"
	case strings.Contains(ua, "Macintosh"):
		device = "Mac"
	case strings.Contains(ua, "Windows"):
		device = "Windows"
	case strings.Contains(ua, "Linux"):
		device = "Linux"
	}
	var browser string
	switch {
	case strings.Contains(ua, "Edg/"), strings.Contains(ua, "EdgA/"), strings.Contains(ua, "EdgiOS/"):
		browser = "Edge"
	case strings.Contains(ua, "SamsungBrowser/"):
		browser = "Samsung Internet"
	case strings.Contains(ua, "OPR/"), strings.Contains(ua, "OPiOS/"):
		browser = "Opera"
	case strings.Contains(ua, "Firefox/"), strings.Contains(ua, "FxiOS/"):
		browser = "Firefox"
	case strings.Contains(ua, "CriOS/"), strings.Contains(ua, "Chrome/"):
		browser = "Chrome"
	case strings.Contains(ua, "Safari/"):
		browser = "Safari"
	}
	switch {
	case device != "" && browser != "":
		return device + " · " + browser
	case device != "":
		return device
	case browser != "":
		return browser
	}
	return "a browser"
}
