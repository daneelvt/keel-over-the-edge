// SPDX-License-Identifier: AGPL-3.0-only

package oauth

import (
	"errors"
	"html"
	"io"
	"net/http"
	"net/url"
	"time"

	jsonv2 "encoding/json/v2"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The authorization request and the approval page. An app sends the
// player's browser to /oauth/authorize; the request is checked, kept for
// RequestFor under a cookie, and answered with the approval page, which
// reads it back from /oauth/request. The player's passkey (the browser's
// prompt, the player verified) names their account for ConfirmFor; then
// they approve for one of their machine sailors, or one made there, or
// deny. Either way the page is given the redirect back to the app, with
// the code or the error, the state and the issuer. No game session is made
// or read: the page an app opens is often a window of its own, which may
// be shared.

// RequestCookie is the authorization request's cookie: the approval page
// and its passkey are on the game's own origin, so SameSite=Strict.
const RequestCookie = "__Host-keel-authorize"

// MaxState is the longest state an app may send.
const MaxState = 512

// pageCSP is the approval page's Content Security Policy: its own scripts
// and styles alone, nothing framed, no frame of it, no form posted.
const pageCSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
	"font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

func pageHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Content-Security-Policy", pageCSP)
	h.Set("X-Frame-Options", "DENY")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "no-store")
}

// errorPage answers a request that cannot be sent back to its app: an
// unknown client, a document that fails, a redirect URI not listed. The
// page says why, in words, and nothing is redirected (OAuth 2.1, 4.1.2.1).
func errorPage(w http.ResponseWriter, status int, words string) {
	pageHeaders(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`+
		`<title>Keel Over the Edge</title><h1>Keel Over the Edge</h1><p>`+html.EscapeString(words)+`</p>`+
		`<p>Go back to your AI app and connect again.</p></html>`)
}

func requestCookie(handle string) *http.Cookie {
	return &http.Cookie{
		Name: RequestCookie, Value: handle, Path: "/", MaxAge: int(RequestFor / time.Second),
		Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode,
	}
}

func clearedRequestCookie() *http.Cookie {
	c := requestCookie("")
	c.MaxAge = -1
	return c
}

// authorize answers GET /oauth/authorize.
func (s *Server) authorize(w http.ResponseWriter, r *http.Request) {
	m := s.cfg.Metrics
	q := r.URL.Query()
	refused := func(status int, words string) {
		m.OAuthAuthorize.WithLabelValues("refused").Inc()
		errorPage(w, status, words)
	}
	clientID, ok := single(q, "client_id")
	if !ok || clientID == "" {
		refused(http.StatusBadRequest, "The app sent no client ID, or more than one.")
		return
	}
	cl, err := s.clients.resolve(r.Context(), clientID)
	if ce, ok := errors.AsType[*clientError](err); ok {
		s.cfg.Log.Info("an app's client refused", "request_id", obs.RequestID(r.Context()), "client", clientID, "err", err)
		refused(http.StatusBadRequest, ce.words)
		return
	}
	if errors.Is(err, ErrBusy) {
		w.Header().Set("Retry-After", "60")
		refused(http.StatusServiceUnavailable, "Many apps are connecting just now: try again in a minute.")
		return
	}
	if err != nil {
		s.cfg.Log.Warn("finding an app's client", "request_id", obs.RequestID(r.Context()), "err", err)
		refused(http.StatusServiceUnavailable, "Keel Over the Edge cannot answer just now: try again in a moment.")
		return
	}
	redirect, ok := single(q, "redirect_uri")
	if !ok || redirect == "" || !matchRedirect(redirect, cl.RedirectURIs) {
		refused(http.StatusBadRequest, "The app asked to return to an address it has not listed, so the request cannot be trusted.")
		return
	}
	// From here on the redirect is the app's own, so errors go back to it.
	state, okState := single(q, "state")
	back := func(code, words string) {
		m.OAuthAuthorize.WithLabelValues("refused").Inc()
		v := url.Values{"error": {code}, "error_description": {words}}
		if okState && len(state) <= MaxState && state != "" {
			v.Set("state", state)
		}
		http.Redirect(w, r, s.callback(redirect, v), http.StatusFound)
	}
	responseType, ok1 := single(q, "response_type")
	challenge, ok2 := single(q, "code_challenge")
	method, ok3 := single(q, "code_challenge_method")
	_, ok4 := single(q, "scope")
	switch {
	case !okState || !ok1 || !ok2 || !ok3 || !ok4 || len(q["resource"]) > 1:
		back("invalid_request", "A parameter was sent more than once.")
		return
	case len(state) > MaxState:
		back("invalid_request", "The state is longer than 512 characters.")
		return
	case responseType != "code":
		back("unsupported_response_type", "The response type is code.")
		return
	case method != "S256" || len(challenge) != 43 || !unreserved(challenge):
		back("invalid_request", "A code challenge with the method S256 is required (PKCE).")
		return
	case !s.resource(q["resource"]):
		back("invalid_target", wordsResource)
		return
	}
	now := s.cfg.Now()
	handle, err := auth.Issue(s.cfg.Log, "authorization request", auth.DrawToken, func(d auth.Drawn) error {
		return s.cfg.Store.SaveRequest(r.Context(), store.AuthRequest{
			Hash: d.Hash, ClientID: cl.ID, ClientName: cl.Name, Registered: cl.Registered, RedirectURI: redirect,
			State: state, CodeChallenge: challenge, Expires: now.Add(RequestFor),
		})
	})
	if err != nil {
		s.cfg.Log.Warn("keeping an authorization request", "request_id", obs.RequestID(r.Context()), "err", err)
		refused(http.StatusServiceUnavailable, "Keel Over the Edge cannot answer just now: try again in a moment.")
		return
	}
	if cl.Registered {
		_ = s.cfg.Store.ClientUsed(r.Context(), cl.ID)
	}
	m.OAuthAuthorize.WithLabelValues("shown").Inc()
	http.SetCookie(w, requestCookie(handle.Token))
	if s.cfg.Page == nil {
		pageHeaders(w)
		http.Redirect(w, r, "/approve.html", http.StatusSeeOther)
		return
	}
	pageHeaders(w)
	s.cfg.Page(w, r)
}

// requestOf is the request the cookie names, answering 409 "again" when
// there is none to go on with: never made, used, or expired.
func (s *Server) requestOf(w http.ResponseWriter, r *http.Request) (store.AuthRequest, bool) {
	c, err := r.Cookie(RequestCookie)
	if err != nil {
		writeError(w, http.StatusConflict, "again")
		return store.AuthRequest{}, false
	}
	hash, ok := auth.HashToken(c.Value)
	if !ok {
		writeError(w, http.StatusConflict, "again")
		return store.AuthRequest{}, false
	}
	req, err := s.cfg.Store.Request(r.Context(), hash)
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusConflict, "again")
		return store.AuthRequest{}, false
	case err != nil:
		s.unavailable(w, r, "reading an authorization request", err)
		return store.AuthRequest{}, false
	case !s.cfg.Now().Before(req.Expires):
		writeError(w, http.StatusConflict, "again")
		return store.AuthRequest{}, false
	}
	return req, true
}

// pageClient is the app as the approval page shows it.
type pageClient struct {
	Name string `json:"name"`
	// Registered is an app that registered itself: its name is only what
	// it calls itself. VouchedBy is otherwise the host whose document
	// names it.
	Registered bool   `json:"registered"`
	VouchedBy  string `json:"vouchedBy,omitempty"`
}

// signedIn is the account whose passkey confirmed the request.
type signedIn struct {
	Name     string        `json:"name"`
	Machines []MachineItem `json:"machines"`
	// Cap is how many machine sailors the account may have.
	Cap int `json:"cap"`
	// Until is when the confirmation lapses, ms.
	Until int64 `json:"until"`
}

// pageData is GET /oauth/request's answer: the request as the approval
// page shows it.
type pageData struct {
	Client pageClient `json:"client"`
	// ReturnHost is where the sign-in returns, shown first and largest;
	// Loopback, an app on this computer, has none.
	ReturnHost string `json:"returnHost"`
	Loopback   bool   `json:"loopback"`
	// Expires is when the request lapses, ms.
	Expires  int64        `json:"expires"`
	SignedIn *signedIn    `json:"signedIn"`
	Looks    MachineLooks `json:"looks"`
}

func (s *Server) pageDataOf(w http.ResponseWriter, r *http.Request, req store.AuthRequest) (pageData, bool) {
	host, loop := returnHost(req.RedirectURI)
	d := pageData{
		Client:     pageClient{Name: req.ClientName, Registered: req.Registered},
		ReturnHost: host, Loopback: loop, Expires: req.Expires.UnixMilli(), Looks: s.cfg.Looks,
	}
	if !req.Registered {
		if u, err := url.Parse(req.ClientID); err == nil {
			d.Client.VouchedBy = u.Hostname()
		}
	}
	now := s.cfg.Now()
	if req.Confirmed && now.Before(req.ConfirmedUntil) {
		items, err := ListMachines(r.Context(), s.cfg.Store, req.Account, s.cfg.Looks, s.cfg.Lifetime.Get(), now, s.cfg.AtSea)
		if err != nil {
			s.unavailable(w, r, "listing machine sailors", err)
			return d, false
		}
		limit, err := s.cfg.Store.MachineCap(r.Context(), req.Account)
		if err != nil {
			s.unavailable(w, r, "reading a machine cap", err)
			return d, false
		}
		name, err := s.ownerName(r, req.Account)
		if err != nil {
			s.unavailable(w, r, "reading an account", err)
			return d, false
		}
		d.SignedIn = &signedIn{Name: name, Machines: items, Cap: limit, Until: req.ConfirmedUntil.UnixMilli()}
	}
	return d, true
}

// ownerName is the sailor's name of an account.
func (s *Server) ownerName(r *http.Request, id store.AccountID) (string, error) {
	p, err := s.cfg.Store.Profile(r.Context(), id)
	return p.Name, err
}

// request answers GET /oauth/request: what the approval page shows.
//
//	200 pageData
//	409 {"error":"again"}  no request to go on with: connect again from the app
func (s *Server) request(w http.ResponseWriter, r *http.Request) {
	req, ok := s.requestOf(w, r)
	if !ok {
		return
	}
	d, ok := s.pageDataOf(w, r, req)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, d)
}

// approveCookie is the approval's passkey ceremony's cookie.
var approveCookie = auth.CeremonyCookieName(store.CeremonyApprove)

// beginApprove answers POST /oauth/approve/begin: the browser's prompt
// for any of the game's passkeys, the player verified, for the request the
// cookie names.
//
//	200 options             {"publicKey": …} for navigator.credentials.get()
//	409 {"error":"again"}   no request to go on with
func (s *Server) beginApprove(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requestOf(w, r); !ok {
		return
	}
	b, err := s.cfg.Passkeys.BeginApprove()
	if err != nil {
		s.unavailable(w, r, "beginning an approval", err)
		return
	}
	handle, err := auth.Issue(s.cfg.Log, "ceremony", auth.DrawToken, func(d auth.Drawn) error {
		return s.cfg.Store.SaveCeremony(r.Context(), store.Ceremony{
			Hash: d.Hash, Kind: store.CeremonyApprove, Session: b.State, Build: s.cfg.Build, Expires: b.Expires,
		})
	})
	if err != nil {
		s.unavailable(w, r, "keeping a ceremony", err)
		return
	}
	s.cfg.Metrics.Ceremonies.WithLabelValues(store.CeremonyApprove, "begun").Inc()
	http.SetCookie(w, auth.CeremonyCookie(store.CeremonyApprove, handle.Token))
	writeRaw(w, b.Options)
}

func writeRaw(w http.ResponseWriter, body []byte) {
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(append(body, '\n'))
}

// finishApprove answers POST /oauth/approve/finish: the passkey checked,
// the player verified, the request is confirmed for its account for
// ConfirmFor, and the page is told who signed in and their machine
// sailors.
//
//	200 pageData                     signedIn set
//	400 {"error":"refused"}          the browser's answer is not accepted, or the player was not verified
//	403 {"error":"add-passkey"}      the account's recovery code was used and no passkey added since
//	404 {"error":"unknown-passkey"}  no account has the passkey
//	409 {"error":"again"}            no ceremony or request to finish
func (s *Server) finishApprove(w http.ResponseWriter, r *http.Request) {
	m := s.cfg.Metrics
	counted := func(result string) { m.Ceremonies.WithLabelValues(store.CeremonyApprove, result).Inc() }
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "malformed")
		return
	}
	http.SetCookie(w, auth.ClearedCeremonyCookie(store.CeremonyApprove))
	c, err := r.Cookie(approveCookie)
	if err != nil {
		counted("again")
		writeError(w, http.StatusConflict, "again")
		return
	}
	hash, ok := auth.HashToken(c.Value)
	if !ok {
		counted("again")
		writeError(w, http.StatusConflict, "again")
		return
	}
	cer, err := s.cfg.Store.TakeCeremony(r.Context(), hash, store.CeremonyApprove)
	switch {
	case errors.Is(err, store.ErrNotFound):
		counted("again")
		writeError(w, http.StatusConflict, "again")
		return
	case err != nil:
		s.unavailable(w, r, "taking a ceremony", err)
		return
	case !time.Now().Before(cer.Expires):
		// The ceremony's expiry is WebAuthn's, on the real clock.
		counted("expired")
		writeError(w, http.StatusConflict, "again")
		return
	case cer.Build != s.cfg.Build:
		counted("again")
		writeError(w, http.StatusConflict, "again")
		return
	}
	req, ok := s.requestOf(w, r)
	if !ok {
		return
	}
	var holder store.Holder
	_, key, err := s.cfg.Passkeys.FinishApprove(cer.Session, body, func(handle []byte) (*auth.User, error) {
		h, err := s.cfg.Store.AccountByUserHandle(r.Context(), handle)
		if err != nil {
			return nil, err
		}
		holder = h
		return &auth.User{Handle: h.UserHandle, Name: h.Name, Passkeys: h.Passkeys}, nil
	})
	if _, ok := errors.AsType[*auth.UnknownPasskey](err); ok {
		counted("refused")
		writeError(w, http.StatusNotFound, "unknown-passkey")
		return
	}
	if errors.Is(err, auth.ErrRefused) {
		counted("refused")
		s.cfg.Log.Info("a passkey refused", "request_id", obs.RequestID(r.Context()), "ceremony", store.CeremonyApprove, "err", err)
		writeError(w, http.StatusBadRequest, "refused")
		return
	}
	if err != nil {
		s.unavailable(w, r, "finding a passkey's account", err)
		return
	}
	held, err := s.cfg.Store.AccountHeld(r.Context(), holder.ID)
	if err != nil {
		s.unavailable(w, r, "reading an account", err)
		return
	}
	if held {
		counted("refused")
		writeError(w, http.StatusForbidden, "add-passkey")
		return
	}
	if err := s.cfg.Store.PasskeyUsed(r.Context(), holder.ID, key); err != nil {
		s.cfg.Log.Warn("writing back a passkey", "request_id", obs.RequestID(r.Context()), "err", err)
	}
	var passkey [16]byte
	for _, p := range holder.Passkeys {
		if string(p.CredentialID) == string(key.CredentialID) {
			passkey = p.ID
		}
	}
	until := s.cfg.Now().Add(ConfirmFor)
	if err := s.cfg.Store.ConfirmRequest(r.Context(), req.Hash, holder.ID, passkey, until); errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusConflict, "again")
		return
	} else if err != nil {
		s.unavailable(w, r, "confirming a request", err)
		return
	}
	counted("finished")
	obs.SetAccount(r.Context(), holder.ID.String())
	req.Account, req.Passkey, req.Confirmed, req.ConfirmedUntil = holder.ID, passkey, true, until
	d, ok := s.pageDataOf(w, r, req)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, d)
}

// approveRequest is POST /oauth/approve's body: one of the account's
// machine sailors, by its ID, or one to make.
type approveRequest struct {
	Machine string       `json:"machine,omitzero"`
	Make    *makeMachine `json:"make,omitzero"`
}

// makeMachine is a machine sailor to make: a name, as a sailor's, and its
// look.
type makeMachine struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Finish  string `json:"finish"`
	Colour  string `json:"colour"`
}

// CheckMachine checks a machine sailor to make by the game's rules: its
// name as every sailor's, its look of the catalog's choices. It returns the
// machine sailor, or the reason it is refused: look, or one of the name's.
func CheckMachine(looks MachineLooks, name, version, finish, colour string) (store.NewMachine, string) {
	if !looks.Valid(version, finish, colour) {
		return store.NewMachine{}, "look"
	}
	n, err := moderation.CheckName(name)
	if err != nil {
		reason := moderation.Characters
		if ref, ok := errors.AsType[*moderation.Refusal](err); ok {
			reason = ref.Reason
		}
		return store.NewMachine{}, string(reason)
	}
	return store.NewMachine{Name: n.Display, NameKey: n.Key, Version: version, Finish: finish, Colour: colour}, ""
}

// approve answers POST /oauth/approve: the request, confirmed, approved
// for one of the account's machine sailors, or one made with it; the page
// is given the redirect back to the app, with the code.
//
//	200 {"redirect"}
//	400 {"error":"malformed"|"look"}
//	403 {"error":"confirm"}         no passkey confirmed lately: continue with it again
//	404 {"error":"not-found"}       no such machine sailor of the account
//	409 {"error":"again"}           no request to go on with
//	409 {"error":"cap"}             the account has as many machine sailors as it may
//	409 {"error":"too-many-apps"}   the machine sailor has as many apps as it may
//	422 {"error": reason}           the new machine sailor's name is refused
func (s *Server) approve(w http.ResponseWriter, r *http.Request) {
	var body approveRequest
	if !readJSON(w, r, &body) {
		return
	}
	req, ok := s.requestOf(w, r)
	if !ok {
		return
	}
	now := s.cfg.Now()
	if !req.Confirmed || !now.Before(req.ConfirmedUntil) {
		writeError(w, http.StatusForbidden, "confirm")
		return
	}
	a := store.Approval{
		Request: req.Hash, Owner: req.Account, Now: now, Boat: s.cfg.Boat,
		CodeExpires: now.Add(CodeFor), Lifetime: s.cfg.Lifetime.Get(), MaxGrants: MaxAppsPerMachine,
	}
	switch {
	case body.Make != nil && body.Machine == "":
		nm, reason := CheckMachine(s.cfg.Looks, body.Make.Name, body.Make.Version, body.Make.Finish, body.Make.Colour)
		if reason == "look" {
			writeError(w, http.StatusBadRequest, "look")
			return
		}
		if reason != "" {
			s.cfg.Metrics.NamesRefused.WithLabelValues(reason).Inc()
			writeError(w, http.StatusUnprocessableEntity, reason)
			return
		}
		a.Make = &nm
	case body.Make == nil && body.Machine != "":
		id, ok := store.ParseID(body.Machine)
		if !ok {
			writeError(w, http.StatusNotFound, "not-found")
			return
		}
		a.Machine = id
	default:
		writeError(w, http.StatusBadRequest, "malformed")
		return
	}
	var out store.Approved
	code, err := auth.Issue(s.cfg.Log, "code", func() auth.Drawn {
		c, h := newCode()
		return auth.Drawn{Token: c, Hash: h}
	}, func(d auth.Drawn) error {
		a.Code = d.Hash
		var err error
		out, err = s.cfg.Store.Approve(r.Context(), a)
		return err
	})
	switch {
	case errors.Is(err, store.ErrUnconfirmed):
		writeError(w, http.StatusForbidden, "confirm")
		return
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusConflict, "again")
		return
	case errors.Is(err, store.ErrNoMachine):
		writeError(w, http.StatusNotFound, "not-found")
		return
	case errors.Is(err, store.ErrCap):
		writeError(w, http.StatusConflict, "cap")
		return
	case errors.Is(err, store.ErrNameTaken):
		s.cfg.Metrics.NamesRefused.WithLabelValues("taken").Inc()
		writeError(w, http.StatusUnprocessableEntity, "taken")
		return
	case errors.Is(err, store.ErrTooManyGrants):
		writeError(w, http.StatusConflict, "too-many-apps")
		return
	case err != nil:
		s.unavailable(w, r, "approving an app", err)
		return
	}
	if len(out.Replaced) > 0 {
		s.cfg.Grants.ForgetGrants(out.Replaced...)
	}
	if a.Make != nil {
		s.cfg.Metrics.MachinesCreated.WithLabelValues("approval").Inc()
		if s.cfg.Created != nil {
			s.cfg.Created(out.Machine)
		}
	}
	s.cfg.Metrics.OAuthAuthorize.WithLabelValues("approved").Inc()
	s.cfg.Log.Info("an app approved", "request_id", obs.RequestID(r.Context()), "account", req.Account.String(),
		"machine", out.Machine.String(), "client", req.ClientID, "made", a.Make != nil, "replaced", len(out.Replaced))
	http.SetCookie(w, clearedRequestCookie())
	v := url.Values{"code": {code.Token}}
	if out.Request.State != "" {
		v.Set("state", out.Request.State)
	}
	writeJSON(w, http.StatusOK, map[string]string{"redirect": s.callback(out.Request.RedirectURI, v)})
}

// deny answers POST /oauth/deny: the request is dropped, and the page is
// given the redirect back to the app, with access_denied.
//
//	200 {"redirect"}
//	409 {"error":"again"}  no request to go on with
func (s *Server) deny(w http.ResponseWriter, r *http.Request) {
	req, ok := s.requestOf(w, r)
	if !ok {
		return
	}
	if _, err := s.cfg.Store.TakeRequest(r.Context(), req.Hash); err != nil && !errors.Is(err, store.ErrNotFound) {
		s.unavailable(w, r, "dropping a request", err)
		return
	}
	http.SetCookie(w, clearedRequestCookie())
	s.cfg.Metrics.OAuthAuthorize.WithLabelValues("denied").Inc()
	v := url.Values{"error": {"access_denied"}, "error_description": {"The player did not approve the app."}}
	if req.State != "" {
		v.Set("state", req.State)
	}
	writeJSON(w, http.StatusOK, map[string]string{"redirect": s.callback(req.RedirectURI, v)})
}

// readJSON reads a request's body into v as encoding/json/v2 reads it:
// valid UTF-8, no duplicate or unknown members.
func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if r.Header.Get("Content-Type") != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "content-type")
		return false
	}
	if err := jsonv2.UnmarshalRead(r.Body, v, jsonv2.RejectUnknownMembers(true)); err != nil {
		writeError(w, http.StatusBadRequest, "malformed")
		return false
	}
	return true
}
