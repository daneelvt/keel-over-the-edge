// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"mime"
	"net/http"
	"time"

	jsonv2 "encoding/json/v2"

	"github.com/go-webauthn/webauthn/protocol"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Accounts keeps accounts, their passkeys, sessions and ceremonies: the
// store.
type Accounts interface {
	NameFree(ctx context.Context, key string) (bool, error)
	CreateAccount(ctx context.Context, a store.NewAccount) (store.AccountID, error)
	AccountByUserHandle(ctx context.Context, handle []byte) (store.Holder, error)
	Profile(ctx context.Context, id store.AccountID) (store.Profile, error)
	SignIn(ctx context.Context, id store.AccountID, token [32]byte) (time.Time, error)
	Recover(ctx context.Context, code, token [32]byte) (store.Account, error)
	AddPasskey(ctx context.Context, id store.AccountID, p store.Passkey, release, recovery *[32]byte) error
	PasskeyUsed(ctx context.Context, id store.AccountID, p store.Passkey) error
	RemovePasskey(ctx context.Context, id store.AccountID, passkey [16]byte) error
	SetRecoveryCode(ctx context.Context, id store.AccountID, hash [32]byte) error
	EndSession(ctx context.Context, hash [32]byte) error
	EndOtherSessions(ctx context.Context, id store.AccountID, keep [32]byte) (int64, error)
	ConfirmSession(ctx context.Context, id store.AccountID, hash [32]byte, until time.Time) error
	SaveCeremony(ctx context.Context, c store.Ceremony) error
	TakeCeremony(ctx context.Context, hash [32]byte, kind string) (store.Ceremony, error)
}

// The ceremonies' results, as keel_ceremonies_total labels them: begun;
// finished; refused, the browser's answer not accepted; expired, its five
// minutes up; again, its state gone, used or written by another build;
// stopped, its passkey good but its account stopped.
var ceremonyResults = []string{"begun", "finished", "refused", "expired", "again", "stopped"}

var ceremonyKinds = []string{store.CeremonyCreate, store.CeremonySignIn, store.CeremonyAdd, store.CeremonyConfirm, store.CeremonyApprove}

func (a *api) ceremonyCounted(kind, result string) {
	a.cfg.Metrics.Ceremonies.WithLabelValues(kind, result).Inc()
}

// begin keeps a ceremony begun, sets its cookie and answers its options.
func (a *api) begin(w http.ResponseWriter, r *http.Request, c store.Ceremony, b auth.Begun) {
	c.Session, c.Build, c.Expires = b.State, a.cfg.Version.Build, b.Expires
	handle, err := auth.Issue(a.cfg.Log, "ceremony", auth.DrawToken, func(d auth.Drawn) error {
		c.Hash = d.Hash
		return a.cfg.Accounts.SaveCeremony(r.Context(), c)
	})
	if err != nil {
		a.unavailable(w, r, "keeping a ceremony", err)
		return
	}
	a.ceremonyCounted(c.Kind, "begun")
	http.SetCookie(w, auth.CeremonyCookie(c.Kind, handle.Token))
	writeRaw(w, http.StatusOK, b.Options)
}

// take takes the ceremony of a kind that the request's cookie names, to
// finish it, and clears the cookie; it answers 409 "again" and returns
// false when there is none to finish: never begun, finished already,
// expired, or begun by another build, whose state this one may not read.
func (a *api) take(w http.ResponseWriter, r *http.Request, kind string) (store.Ceremony, bool) {
	http.SetCookie(w, auth.ClearedCeremonyCookie(kind))
	cookie, err := r.Cookie(auth.CeremonyCookieName(kind))
	if err != nil {
		a.ceremonyCounted(kind, "again")
		writeError(w, http.StatusConflict, "again")
		return store.Ceremony{}, false
	}
	hash, ok := auth.HashToken(cookie.Value)
	if !ok {
		a.ceremonyCounted(kind, "again")
		writeError(w, http.StatusConflict, "again")
		return store.Ceremony{}, false
	}
	c, err := a.cfg.Accounts.TakeCeremony(r.Context(), hash, kind)
	switch {
	case errors.Is(err, store.ErrNotFound):
		a.ceremonyCounted(kind, "again")
		writeError(w, http.StatusConflict, "again")
		return store.Ceremony{}, false
	case err != nil:
		a.unavailable(w, r, "taking a ceremony", err)
		return store.Ceremony{}, false
	case !time.Now().Before(c.Expires):
		a.ceremonyCounted(kind, "expired")
		writeError(w, http.StatusConflict, "again")
		return store.Ceremony{}, false
	case c.Build != a.cfg.Version.Build:
		a.ceremonyCounted(kind, "again")
		writeError(w, http.StatusConflict, "again")
		return store.Ceremony{}, false
	}
	return c, true
}

// answer reads a finish's body: the browser's answer, a credential as
// PublicKeyCredential's toJSON() writes it, which go-webauthn parses.
func answer(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	if !jsonBody(w, r) {
		return nil, false
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
			writeError(w, http.StatusRequestEntityTooLarge, "too-large")
			return nil, false
		}
		writeError(w, http.StatusBadRequest, "malformed")
		return nil, false
	}
	return body, true
}

// jsonBody answers 415 to a request whose body is not JSON.
func jsonBody(w http.ResponseWriter, r *http.Request) bool {
	if mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mt != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "content-type")
		return false
	}
	return true
}

// readJSON reads a request's body into v as encoding/json/v2 reads it:
// valid UTF-8, no duplicate or unknown members, nothing after the object.
func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if !jsonBody(w, r) {
		return false
	}
	if err := jsonv2.UnmarshalRead(r.Body, v, jsonv2.RejectUnknownMembers(true)); err != nil {
		if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
			writeError(w, http.StatusRequestEntityTooLarge, "too-large")
			return false
		}
		writeError(w, http.StatusBadRequest, "malformed")
		return false
	}
	return true
}

// refusedPasskey answers a browser's answer the ceremony did not accept.
func (a *api) refusedPasskey(w http.ResponseWriter, r *http.Request, kind string, err error) {
	a.ceremonyCounted(kind, "refused")
	a.cfg.Log.Info("a passkey refused", "request_id", obs.RequestID(r.Context()), "ceremony", kind, "err", err)
	writeError(w, http.StatusBadRequest, "refused")
}

func (a *api) unavailable(w http.ResponseWriter, r *http.Request, doing string, err error) {
	a.cfg.Log.Warn(doing, "request_id", obs.RequestID(r.Context()), "err", err)
	writeError(w, http.StatusServiceUnavailable, "unavailable")
}

// unknownCredential is the Signal API's signalUnknownCredential argument:
// a passkey the browser may forget, the server knowing no account it is
// of.
func (a *api) unknownCredential(id []byte) protocol.SignalUnknownCredential {
	return protocol.SignalUnknownCredential{CredentialID: id, RPID: a.cfg.Passkeys.RPID()}
}

// refusal is an error's answer that carries a passkey the browser may
// forget.
type refusal struct {
	Error   string                           `json:"error"`
	Unknown protocol.SignalUnknownCredential `json:"unknown"`
}

// userOf is an account as the ceremonies see it.
func userOf(h *store.Holder) *auth.User {
	return &auth.User{Handle: h.UserHandle, Name: h.Name, Passkeys: h.Passkeys}
}

// keyID is a passkey's ID on the account page.
func keyID(id [16]byte) string { return base64.RawURLEncoding.EncodeToString(id[:]) }

func parseKeyID(s string) ([16]byte, bool) {
	var id [16]byte
	raw, err := base64.RawURLEncoding.Strict().DecodeString(s)
	if err != nil || len(raw) != len(id) {
		return id, false
	}
	copy(id[:], raw)
	return id, true
}

// writeRaw answers with a body already JSON.
func writeRaw(w http.ResponseWriter, status int, body []byte) {
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(append(body, '\n'))
}
