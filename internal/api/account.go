// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/go-webauthn/webauthn/protocol"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// ConfirmFor is how long a passkey confirmed allows what cannot be undone:
// long enough for the task, so removing a passkey and adding another asks
// once.
const ConfirmFor = 5 * time.Minute

// sailorRequest is POST /account/begin's body.
type sailorRequest struct {
	Name string `json:"name"`
	Look string `json:"look"`
}

// sailorResponse is a sailor signed in: the name as it will be shown, and
// what a passkey manager may be told of the account's passkeys.
type sailorResponse struct {
	Name string `json:"name"`
	Look string `json:"look"`
	// RecoveryCode is a new recovery code, shown once.
	RecoveryCode string `json:"recoveryCode,omitempty"`
	// Recovered is when the recovery code was last used, in ms of the Unix
	// epoch, if no sign-in has been told since.
	Recovered int64 `json:"recovered,omitempty"`
	// AddPasskey is a session held to adding a passkey: the recovery
	// code's.
	AddPasskey bool `json:"addPasskey,omitempty"`
	// Accepted is the Signal API's signalAllAcceptedCredentials argument.
	Accepted *protocol.SignalAllAcceptedCredentials `json:"accepted,omitempty"`
}

// beginAccount answers POST /account/begin: a new sailor's name and look,
// checked before the browser is asked for anything, begin making the
// passkey their account is made with. Nothing is made yet, and the name is
// not held: a player who closes the prompt leaves nothing behind.
//
//	200 options             {"publicKey": …} for navigator.credentials.create()
//	400 {"error"}           malformed, an unknown member, or a look not in the catalog
//	409 {"error":"session"} the request already has a session
//	415                     not application/json
//	422 {"error": reason}   the name is refused: short, long, characters,
//	                        scripts, words or taken
//	503                     the database could not be asked
func (a *api) beginAccount(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.SessionFromContext(r.Context()); ok {
		writeError(w, http.StatusConflict, "session")
		return
	}
	var req sailorRequest
	if !readJSON(w, r, &req) {
		return
	}
	if !a.looks[req.Look] {
		writeError(w, http.StatusBadRequest, "look")
		return
	}
	name, ok := a.checkName(w, req.Name)
	if !ok {
		return
	}
	free, err := a.cfg.Accounts.NameFree(r.Context(), name.Key)
	if err != nil {
		a.unavailable(w, r, "checking a name", err)
		return
	}
	if !free {
		a.refuse(w, "taken")
		return
	}
	u := &auth.User{Handle: auth.NewUserHandle(), Name: name.Display}
	b, err := a.cfg.Passkeys.BeginCreate(u)
	if err != nil {
		a.unavailable(w, r, "beginning a passkey", err)
		return
	}
	a.begin(w, r, store.Ceremony{Kind: store.CeremonyCreate, Name: name.Display, NameKey: name.Key, Look: req.Look, UserHandle: u.Handle}, b)
}

// checkName checks a sailor's name by the game's rules, answering 422 with
// the reason when it is refused.
func (a *api) checkName(w http.ResponseWriter, typed string) (moderation.Name, bool) {
	name, err := moderation.CheckName(typed)
	if err != nil {
		reason := moderation.Characters
		if ref, ok := errors.AsType[*moderation.Refusal](err); ok {
			reason = ref.Reason
		}
		a.refuse(w, string(reason))
		return moderation.Name{}, false
	}
	return name, true
}

// finishAccount answers POST /account/finish: the passkey the browser made
// is checked and, in one transaction, the account is made with its sailor,
// that passkey, a recovery code and a session, whose cookie the answer
// sets. The recovery code is in the answer, and nowhere else ever again.
//
//	201 {"name", "look", "recoveryCode"}
//	400 {"error":"refused"}  the browser's answer is not accepted
//	409 {"error":"again"}    no ceremony to finish: begin again
//	409 {"error":"session"}  the request already has a session
//	422 {"error":"taken", "unknown"}  another sailor took the name meanwhile;
//	                         the browser may forget the passkey just made
//	503                      the database could not be asked
func (a *api) finishAccount(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.SessionFromContext(r.Context()); ok {
		writeError(w, http.StatusConflict, "session")
		return
	}
	body, ok := answer(w, r)
	if !ok {
		return
	}
	c, ok := a.take(w, r, store.CeremonyCreate)
	if !ok {
		return
	}
	u := &auth.User{Handle: c.UserHandle, Name: c.Name}
	key, err := a.cfg.Passkeys.FinishCreate(u, c.Session, body)
	if err != nil {
		a.refusedPasskey(w, r, c.Kind, err)
		return
	}
	key.MadeOn = madeOn(r.UserAgent())
	code, recovery := auth.NewRecoveryCode()
	var id store.AccountID
	session, err := auth.Issue(a.cfg.Log, "session", auth.DrawToken, func(d auth.Drawn) error {
		var err error
		id, err = a.cfg.Accounts.CreateAccount(r.Context(), store.NewAccount{
			Name: c.Name, NameKey: c.NameKey, Look: c.Look, UserHandle: c.UserHandle,
			Passkey: key, RecoveryHash: recovery, TokenHash: d.Hash, Boat: a.cfg.Boat,
		})
		return err
	})
	token, hash := session.Token, session.Hash
	switch {
	case errors.Is(err, store.ErrNameTaken):
		a.ceremonyCounted(c.Kind, "refused")
		a.cfg.Metrics.NamesRefused.WithLabelValues("taken").Inc()
		writeJSON(w, http.StatusUnprocessableEntity, refusal{Error: "taken", Unknown: a.unknownCredential(key.CredentialID)})
		return
	case errors.Is(err, store.ErrPasskeyTaken):
		a.refusedPasskey(w, r, c.Kind, err)
		return
	case err != nil:
		a.unavailable(w, r, "making an account", err)
		return
	}
	a.ceremonyCounted(c.Kind, "finished")
	a.cfg.Metrics.AccountsCreated.Inc()
	obs.SetAccount(r.Context(), id.String())
	a.cfg.Sessions.Add(hash, store.Session{Account: store.Account{ID: id, Kind: store.Human, Name: c.Name, Look: c.Look, NoticesOff: []string{}}})
	http.SetCookie(w, auth.SessionCookie(token))
	writeJSON(w, http.StatusCreated, sailorResponse{Name: c.Name, Look: c.Look, RecoveryCode: code})
}

func (a *api) refuse(w http.ResponseWriter, reason string) {
	a.cfg.Metrics.NamesRefused.WithLabelValues(reason).Inc()
	writeError(w, http.StatusUnprocessableEntity, reason)
}

// accountPage is GET /api/account's answer.
type accountPage struct {
	Name string `json:"name"`
	Look string `json:"look"`
	// Created is when the account was made, and RecoveryMade when its
	// recovery code was, in ms of the Unix epoch; 0 for no code.
	Created      int64         `json:"created"`
	RecoveryMade int64         `json:"recoveryMade"`
	Passkeys     []passkeyItem `json:"passkeys"`
	// ConfirmedUntil is when the passkey last confirmed on this session
	// stops allowing what cannot be undone, in ms; 0 for none.
	ConfirmedUntil int64 `json:"confirmedUntil"`
}

// passkeyItem is a passkey as the account page lists it.
type passkeyItem struct {
	ID       string `json:"id"`
	MadeOn   string `json:"madeOn"`
	Created  int64  `json:"created"`
	LastUsed int64  `json:"lastUsed"`
	// Synced is a passkey its manager says it has backed up: on the
	// player's other devices too.
	Synced bool `json:"synced"`
}

func ms(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

func passkeyItems(keys []store.Passkey) []passkeyItem {
	out := make([]passkeyItem, len(keys))
	for i, k := range keys {
		out[i] = passkeyItem{ID: keyID(k.ID), MadeOn: k.MadeOn, Created: ms(k.Created), LastUsed: ms(k.LastUsed), Synced: k.BackupState}
	}
	return out
}

// account answers GET /api/account, behind auth.Required: what the account
// page shows.
func (a *api) account(w http.ResponseWriter, r *http.Request) {
	cur, _ := auth.SessionFromContext(r.Context())
	p, err := a.cfg.Accounts.Profile(r.Context(), cur.ID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusUnauthorized, "session")
		return
	}
	if err != nil {
		a.unavailable(w, r, "reading an account", err)
		return
	}
	page := accountPage{
		Name: p.Name, Look: p.Look, Created: ms(p.Created), RecoveryMade: ms(p.RecoveryMade),
		Passkeys: passkeyItems(p.Passkeys),
	}
	if cur.Confirmed(time.Now()) {
		page.ConfirmedUntil = ms(cur.ConfirmedUntil)
	}
	writeJSON(w, http.StatusOK, page)
}

// holder is the request's account with its passkeys, answering 401 or 503
// when it cannot be read.
func (a *api) holder(w http.ResponseWriter, r *http.Request) (auth.Current, *store.Holder, bool) {
	cur, _ := auth.SessionFromContext(r.Context())
	p, err := a.cfg.Accounts.Profile(r.Context(), cur.ID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusUnauthorized, "session")
		return cur, nil, false
	}
	if err != nil {
		a.unavailable(w, r, "reading an account", err)
		return cur, nil, false
	}
	return cur, &p.Holder, true
}

// beginPasskey answers POST /api/account/passkeys/begin, behind
// auth.Signed: one more passkey for the account, on this device, another
// by its QR code, or a security key. The browser is told the passkeys the
// account has, so it makes none twice. A session held to adding a passkey,
// after the recovery code, may.
func (a *api) beginPasskey(w http.ResponseWriter, r *http.Request) {
	cur, h, ok := a.holder(w, r)
	if !ok {
		return
	}
	b, err := a.cfg.Passkeys.BeginCreate(userOf(h))
	if err != nil {
		a.unavailable(w, r, "beginning a passkey", err)
		return
	}
	a.begin(w, r, store.Ceremony{Kind: store.CeremonyAdd, Account: cur.ID, HasAccount: true}, b)
}

// finishPasskey answers POST /api/account/passkeys/finish, behind
// auth.Signed: the passkey made is the account's. A session held to adding
// a passkey is let go, and the account given a new recovery code, which
// the answer carries.
//
//	201 {"passkeys", "recoveryCode"?}
//	400 {"error":"refused"}  the browser's answer is not accepted
//	403 {"error":"account"}  begun by another account's session
//	409 {"error":"again"}    no ceremony to finish
func (a *api) finishPasskey(w http.ResponseWriter, r *http.Request) {
	body, ok := answer(w, r)
	if !ok {
		return
	}
	c, ok := a.take(w, r, store.CeremonyAdd)
	if !ok {
		return
	}
	cur, h, ok := a.holder(w, r)
	if !ok {
		return
	}
	if c.Account != cur.ID {
		a.ceremonyCounted(c.Kind, "refused")
		writeError(w, http.StatusForbidden, "account")
		return
	}
	key, err := a.cfg.Passkeys.FinishCreate(userOf(h), c.Session, body)
	if err != nil {
		a.refusedPasskey(w, r, c.Kind, err)
		return
	}
	key.MadeOn = madeOn(r.UserAgent())
	var res struct {
		Passkeys     []passkeyItem `json:"passkeys"`
		RecoveryCode string        `json:"recoveryCode,omitempty"`
	}
	var release, recovery *[32]byte
	if cur.Held {
		code, hash := auth.NewRecoveryCode()
		res.RecoveryCode, release, recovery = code, &cur.Hash, &hash
	}
	switch err := a.cfg.Accounts.AddPasskey(r.Context(), cur.ID, key, release, recovery); {
	case errors.Is(err, store.ErrPasskeyTaken):
		a.refusedPasskey(w, r, c.Kind, err)
		return
	case err != nil:
		a.unavailable(w, r, "adding a passkey", err)
		return
	}
	a.ceremonyCounted(c.Kind, "finished")
	a.cfg.Sessions.Forget(cur.Hash)
	keys, err := a.cfg.Accounts.Profile(r.Context(), cur.ID)
	if err != nil {
		a.unavailable(w, r, "reading an account", err)
		return
	}
	res.Passkeys = passkeyItems(keys.Passkeys)
	writeJSON(w, http.StatusCreated, res)
}

// confirmed answers 403 "confirm" to a request whose session has had no
// passkey confirmed in the last ConfirmFor.
func confirmed(w http.ResponseWriter, cur auth.Current) bool {
	if !cur.Confirmed(time.Now()) {
		writeError(w, http.StatusForbidden, "confirm")
		return false
	}
	return true
}

// beginConfirm answers POST /api/account/confirm/begin, behind
// auth.Required: the browser is asked for one of the account's own
// passkeys, with the player verified by their device.
func (a *api) beginConfirm(w http.ResponseWriter, r *http.Request) {
	cur, h, ok := a.holder(w, r)
	if !ok {
		return
	}
	b, err := a.cfg.Passkeys.BeginConfirm(userOf(h))
	if err != nil {
		a.unavailable(w, r, "beginning a confirmation", err)
		return
	}
	a.begin(w, r, store.Ceremony{Kind: store.CeremonyConfirm, Account: cur.ID, HasAccount: true}, b)
}

// finishConfirm answers POST /api/account/confirm/finish, behind
// auth.Required: the passkey checked, the session may remove a passkey,
// make a new recovery code or delete the account for ConfirmFor.
//
//	200 {"confirmedUntil"}   ms of the Unix epoch
//	400 {"error":"refused"}  not one of the account's passkeys, or unverified
//	403 {"error":"account"}  begun by another account's session
//	409 {"error":"again"}    no ceremony to finish
func (a *api) finishConfirm(w http.ResponseWriter, r *http.Request) {
	body, ok := answer(w, r)
	if !ok {
		return
	}
	c, ok := a.take(w, r, store.CeremonyConfirm)
	if !ok {
		return
	}
	cur, h, ok := a.holder(w, r)
	if !ok {
		return
	}
	if c.Account != cur.ID {
		a.ceremonyCounted(c.Kind, "refused")
		writeError(w, http.StatusForbidden, "account")
		return
	}
	key, err := a.cfg.Passkeys.FinishConfirm(userOf(h), c.Session, body)
	if err != nil {
		a.refusedPasskey(w, r, c.Kind, err)
		return
	}
	a.used(r, cur.ID, key)
	until := time.Now().Add(ConfirmFor)
	if err := a.cfg.Accounts.ConfirmSession(r.Context(), cur.ID, cur.Hash, until); err != nil {
		a.unavailable(w, r, "confirming a session", err)
		return
	}
	a.ceremonyCounted(c.Kind, "finished")
	a.cfg.Sessions.Forget(cur.Hash)
	writeJSON(w, http.StatusOK, map[string]int64{"confirmedUntil": until.UnixMilli()})
}

// used writes back what a ceremony learnt of a passkey. A clone warning is
// logged and counted, never refused: a passkey that syncs reports a count
// of 0 every time, so refusing on the count would lock out the commonest
// passkeys.
func (a *api) used(r *http.Request, id store.AccountID, key store.Passkey) {
	if key.CloneWarning {
		a.cfg.Metrics.CloneWarnings.Inc()
		a.cfg.Log.Warn("a passkey's count went back: it may have been copied", "request_id", obs.RequestID(r.Context()), "account", id.String())
	}
	if err := a.cfg.Accounts.PasskeyUsed(r.Context(), id, key); err != nil {
		a.cfg.Log.Warn("writing back a passkey", "request_id", obs.RequestID(r.Context()), "err", err)
	}
}

// removeRequest is POST /api/account/passkeys/remove's body.
type removeRequest struct {
	ID string `json:"id"`
}

// removePasskey answers POST /api/account/passkeys/remove, behind
// auth.Required and a passkey confirmed: one of the account's passkeys is
// removed, while another remains.
//
//	200 {"passkeys", "accepted"}  those left, and the Signal API's list of them
//	403 {"error":"confirm"}       no passkey confirmed lately
//	404 {"error":"not-found"}     no such passkey of the account
//	409 {"error":"last-passkey"}  the account's last passkey stays
func (a *api) removePasskey(w http.ResponseWriter, r *http.Request) {
	cur, _ := auth.SessionFromContext(r.Context())
	var req removeRequest
	if !readJSON(w, r, &req) {
		return
	}
	if !confirmed(w, cur) {
		return
	}
	id, ok := parseKeyID(req.ID)
	if !ok {
		writeError(w, http.StatusNotFound, "not-found")
		return
	}
	switch err := a.cfg.Accounts.RemovePasskey(r.Context(), cur.ID, id); {
	case errors.Is(err, store.ErrLastPasskey):
		writeError(w, http.StatusConflict, "last-passkey")
		return
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not-found")
		return
	case err != nil:
		a.unavailable(w, r, "removing a passkey", err)
		return
	}
	_, h, ok := a.holder(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Passkeys []passkeyItem                          `json:"passkeys"`
		Accepted *protocol.SignalAllAcceptedCredentials `json:"accepted"`
	}{passkeyItems(h.Passkeys), a.cfg.Passkeys.Accepted(userOf(h))})
}

// newRecoveryCode answers POST /api/account/recovery, behind auth.Required
// and a passkey confirmed: a new recovery code, shown once, in place of the
// old one, which no longer works.
func (a *api) newRecoveryCode(w http.ResponseWriter, r *http.Request) {
	cur, _ := auth.SessionFromContext(r.Context())
	if !confirmed(w, cur) {
		return
	}
	code, hash := auth.NewRecoveryCode()
	if err := a.cfg.Accounts.SetRecoveryCode(r.Context(), cur.ID, hash); err != nil {
		a.unavailable(w, r, "making a recovery code", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"recoveryCode": code, "recoveryMade": time.Now().UnixMilli()})
}

// logoutOthers answers POST /api/account/logout-others, behind
// auth.Required: every session of the account but this one ends.
func (a *api) logoutOthers(w http.ResponseWriter, r *http.Request) {
	cur, _ := auth.SessionFromContext(r.Context())
	n, err := a.cfg.Accounts.EndOtherSessions(r.Context(), cur.ID, cur.Hash)
	if err != nil {
		a.unavailable(w, r, "ending sessions", err)
		return
	}
	a.cfg.Sessions.ForgetAccount(cur.ID)
	writeJSON(w, http.StatusOK, map[string]int64{"ended": n})
}

// deleteRequest is POST /api/account/delete's body: the sailor's name typed
// again.
type deleteRequest struct {
	Name string `json:"name"`
}

// deleteAccount answers POST /api/account/delete, behind auth.Required and
// a passkey confirmed: the account goes, with its sailor, passkeys and
// sessions, and its machine sailors with their grants, and every name is
// free. Its boat leaves the water at once and its
// game connection is closed; what it charted reads "a former sailor". The
// answer lists its passkeys, which the browser may forget.
//
//	200 {"unknown": [...]}   signalUnknownCredential's argument for each passkey
//	403 {"error":"confirm"}  no passkey confirmed lately
//	422 {"error":"name"}     the name typed is not the sailor's
func (a *api) deleteAccount(w http.ResponseWriter, r *http.Request) {
	cur, _ := auth.SessionFromContext(r.Context())
	var req deleteRequest
	if !readJSON(w, r, &req) {
		return
	}
	if !confirmed(w, cur) {
		return
	}
	if moderation.Key(req.Name) != moderation.Key(cur.Name) {
		writeError(w, http.StatusUnprocessableEntity, "name")
		return
	}
	_, h, ok := a.holder(w, r)
	if !ok {
		return
	}
	machines, err := a.cfg.Accounts.DeleteAccount(r.Context(), cur.ID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		a.unavailable(w, r, "deleting an account", err)
		return
	}
	a.cfg.Sessions.ForgetAccount(cur.ID)
	a.machinesDeleted(machines...)
	if a.cfg.Deleted != nil {
		a.cfg.Deleted(cur.ID)
	}
	a.cfg.Metrics.AccountsDeleted.Inc()
	a.cfg.Log.Info("an account deleted", "request_id", obs.RequestID(r.Context()), "account", cur.ID.String())
	unknown := make([]protocol.SignalUnknownCredential, len(h.Passkeys))
	for i, k := range h.Passkeys {
		unknown[i] = a.unknownCredential(k.CredentialID)
	}
	http.SetCookie(w, auth.ClearedSessionCookie())
	writeJSON(w, http.StatusOK, map[string]any{"unknown": unknown})
}
