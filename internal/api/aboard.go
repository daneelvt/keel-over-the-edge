// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"bytes"
	"context"
	"encoding/json/jsontext"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	jsonv2 "encoding/json/v2"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Sailing together. A player says when they were born as their sailor is
// made, or once at the next entry for an account made before it was
// asked; under 13, no sailor is made, nothing of the answer is kept, and a
// cookie gives the same answer for 30 days. A player accepts the Rules of
// the sea once. A skipper shares a link, one at a time, whose token only
// the skipper is ever shown: the game keeps its hash. Whoever opens it,
// signed in, reads whose boat it is and whether they may knock; the knock
// itself is the game connection's.

// Sailing is the store's side of sailing together.
type Sailing interface {
	SetBorn(ctx context.Context, id store.AccountID, born int32) error
	AcceptRules(ctx context.Context, id store.AccountID) error
	MakeSailLink(ctx context.Context, skipper store.AccountID, hash [32]byte, made, expires time.Time) error
	EndSailLink(ctx context.Context, skipper store.AccountID) (bool, error)
	LiveSailLink(ctx context.Context, skipper store.AccountID) (made, expires time.Time, ok bool, err error)
	SailLink(ctx context.Context, hash [32]byte) (store.SailLink, error)
}

// Deck is the world sailed as a link's page reads it: whether the viewer
// may knock on the skipper's boat now (can is "ok", "not-at-sea", "full",
// "closed" or "own"), and the boat's kind, by its place in the catalog,
// and name.
type Deck interface {
	LinkCan(skipper, viewer store.AccountID) (can string, kind uint16, boat string)
}

// Young stops an account whose player said they are under 13, as the
// owner's stop does, for the owner to review: internal/accounts.
type Young interface {
	StopYoung(ctx context.Context, id store.AccountID) error
}

// What a link's page may be told of the boat.
const (
	CanOK       = "ok"
	CanNotAtSea = "not-at-sea"
	CanFull     = "full"
	CanClosed   = "closed"
	CanOwn      = "own"
)

// YoungCookie is the cookie that answers a browser whose player said they
// are under 13 as the start screen did, for YoungFor. The page reads it.
const (
	YoungCookie = "keel-young"
	YoungFor    = 30 * 24 * time.Hour
)

func youngCookie() *http.Cookie {
	return &http.Cookie{
		Name: YoungCookie, Value: "1", Path: "/", MaxAge: int(YoungFor / time.Second),
		Secure: true, SameSite: http.SameSiteLaxMode,
	}
}

// young reports whether the request carries the cookie of a player under
// 13.
func young(r *http.Request) bool {
	_, err := r.Cookie(YoungCookie)
	return err == nil
}

// refuseYoung answers a player under 13: the cookie, and 403 young.
func refuseYoung(w http.ResponseWriter) {
	http.SetCookie(w, youngCookie())
	writeError(w, http.StatusForbidden, "young")
}

// bornJSON is a month of birth as a request gives it.
type bornJSON struct {
	Year  *int `json:"year"`
	Month *int `json:"month"`
}

// bornFrom reads a month of birth: both members, whole numbers, a month
// that could be someone's birth by now.
func bornFrom(raw jsontext.Value, now time.Time) (aboard.Born, bool) {
	if len(raw) == 0 {
		return aboard.Born{}, false
	}
	var b bornJSON
	if err := jsonv2.Unmarshal(raw, &b, jsonv2.RejectUnknownMembers(true)); err != nil || b.Year == nil || b.Month == nil {
		return aboard.Born{}, false
	}
	born := aboard.Born{Year: *b.Year, Month: time.Month(*b.Month)}
	return born, born.Valid(now)
}

// LinkLimit is how many links an account may make in LinkWindow.
const (
	LinkLimit  = 10
	LinkWindow = time.Hour
)

// linkTimes are the times of each account's latest links, in memory, to
// hold each to LinkLimit in LinkWindow.
type linkTimes struct {
	mu    sync.Mutex
	times map[store.AccountID][]time.Time
	swept time.Time
}

// allow reports whether the account may make a link at now, and counts it
// if it may.
func (l *linkTimes) allow(id store.AccountID, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.times == nil {
		l.times = map[store.AccountID][]time.Time{}
	}
	since := now.Add(-LinkWindow)
	if now.Sub(l.swept) > LinkWindow {
		for k, ts := range l.times {
			if !ts[len(ts)-1].After(since) {
				delete(l.times, k)
			}
		}
		l.swept = now
	}
	ts := l.times[id]
	i := 0
	for i < len(ts) && !ts[i].After(since) {
		i++
	}
	ts = ts[i:]
	if len(ts) >= LinkLimit {
		l.times[id] = ts
		return false
	}
	l.times[id] = append(ts, now)
	return true
}

// setBorn answers POST /api/me/born, behind auth.Required: the one-time
// question for an account made before it was asked. Under 13, nothing of
// the answer is kept: the account is stopped for the owner to review, and
// the browser given the cookie.
//
//	204                       kept
//	400 {"error":"born"}      not a month of birth
//	403 {"error":"young"}     under 13: the account stopped
//	409 {"error":"answered"}  the account has one already
func (a *api) setBorn(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	var raw jsontext.Value
	if !readJSON(w, r, &raw) {
		return
	}
	if acc.Kind != store.Human {
		writeError(w, http.StatusForbidden, "human")
		return
	}
	now := time.Now()
	born, ok := bornFrom(raw, now)
	if !ok {
		writeError(w, http.StatusBadRequest, "born")
		return
	}
	if acc.Born != 0 {
		writeError(w, http.StatusConflict, "answered")
		return
	}
	if aboard.BandOf(born, now) == aboard.Child {
		http.SetCookie(w, youngCookie())
		if a.cfg.Young == nil {
			writeError(w, http.StatusServiceUnavailable, "unavailable")
			return
		}
		if err := a.cfg.Young.StopYoung(r.Context(), acc.ID); err != nil {
			a.unavailable(w, r, "stopping an account", err)
			return
		}
		writeError(w, http.StatusForbidden, "young")
		return
	}
	err := a.cfg.Sailing.SetBorn(r.Context(), acc.ID, born.Code())
	switch {
	case errors.Is(err, store.ErrAnswered):
		a.cfg.Sessions.ForgetAccount(acc.ID)
		writeError(w, http.StatusConflict, "answered")
		return
	case err != nil:
		a.unavailable(w, r, "keeping a month of birth", err)
		return
	}
	a.cfg.Sessions.ForgetAccount(acc.ID)
	if a.cfg.Chat != nil {
		a.cfg.Chat.Changed(r.Context(), acc.ID)
	}
	w.WriteHeader(http.StatusNoContent)
}

// acceptRules answers POST /api/me/rules, behind auth.Required: the Rules
// of the sea accepted, once; again answers the same.
func (a *api) acceptRules(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	if !emptyBody(w, r) {
		return
	}
	if acc.Kind != store.Human {
		writeError(w, http.StatusForbidden, "human")
		return
	}
	if !acc.Rules {
		if err := a.cfg.Sailing.AcceptRules(r.Context(), acc.ID); err != nil {
			a.unavailable(w, r, "accepting the rules", err)
			return
		}
		a.cfg.Sessions.ForgetAccount(acc.ID)
		if a.cfg.Chat != nil {
			a.cfg.Chat.Changed(r.Context(), acc.ID)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// emptyBody reads a body that may be none, or an empty JSON object.
func emptyBody(w http.ResponseWriter, r *http.Request) bool {
	var peek [1]byte
	n, err := io.ReadFull(r.Body, peek[:])
	if n == 0 && (err == io.EOF || err == io.ErrUnexpectedEOF) {
		return true
	}
	r.Body = io.NopCloser(io.MultiReader(bytes.NewReader(peek[:n]), r.Body))
	var none struct{}
	return readJSON(w, r, &none)
}

// linkMade is a new link: its address, shown this once, and when it
// expires.
type linkMade struct {
	URL     string `json:"url"`
	Expires string `json:"expires"`
}

// linkPath is where a link's page is, before its token.
const linkPath = "/sail/"

// mayLink is whether a human account may make a link, answering 403 when
// it may not: its player's age asked first, then the Rules of the sea.
func mayLink(w http.ResponseWriter, acc store.Account, now time.Time) bool {
	if acc.Kind != store.Human {
		writeError(w, http.StatusForbidden, "human")
		return false
	}
	b, ok := aboard.BornOf(acc.Born)
	if band := aboard.BandOf(b, now); !ok || (band != aboard.Teen && band != aboard.Adult) {
		writeError(w, http.StatusForbidden, "born")
		return false
	}
	if !acc.Rules {
		writeError(w, http.StatusForbidden, "rules")
		return false
	}
	return true
}

// makeLink answers POST /api/sail/link, behind auth.Required: a new link
// for the skipper, the old one ended.
//
//	201 {"url", "expires"}
//	403 {"error":"born"}       the age question not answered
//	403 {"error":"rules"}      the Rules of the sea not accepted
//	403 {"error":"human"}      not a human's account
//	409 {"error":"links-off"}  the owner has switched links off
//	429 {"error":"often"}      LinkLimit links in the last LinkWindow
func (a *api) makeLink(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	if !emptyBody(w, r) {
		return
	}
	now := time.Now()
	if !mayLink(w, acc, now) {
		return
	}
	if !a.cfg.Switches.Links() {
		writeError(w, http.StatusConflict, "links-off")
		return
	}
	if !a.links.allow(acc.ID, now) {
		writeError(w, http.StatusTooManyRequests, "often")
		return
	}
	expires := now.Add(a.cfg.Switches.Lifetime())
	var token string
	var err error
	for range 2 {
		var hash [32]byte
		token, hash = aboard.NewToken()
		if err = a.cfg.Sailing.MakeSailLink(r.Context(), acc.ID, hash, now, expires); !errors.Is(err, store.ErrTokenTaken) {
			break
		}
	}
	if err != nil {
		a.unavailable(w, r, "making a link", err)
		return
	}
	writeJSON(w, http.StatusCreated, linkMade{URL: a.cfg.Origin + linkPath + token, Expires: expires.UTC().Format(time.RFC3339)})
}

// endLink answers POST /api/sail/link/end, behind auth.Required: the
// skipper's live link ended, if it has one.
func (a *api) endLink(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	if !emptyBody(w, r) {
		return
	}
	if _, err := a.cfg.Sailing.EndSailLink(r.Context(), acc.ID); err != nil {
		a.unavailable(w, r, "ending a link", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// linkStatus is GET /api/sail/link's answer.
type linkStatus struct {
	Live    bool   `json:"live"`
	Expires string `json:"expires,omitempty"`
}

// linkEnd is when a link stops working under the lifetime in force.
func linkEnd(made, expires time.Time, lifetime time.Duration) time.Time {
	if e := made.Add(lifetime); e.Before(expires) {
		return e
	}
	return expires
}

// liveLink answers GET /api/sail/link, behind auth.Required: whether the
// skipper's link works, and until when. Its token is never shown again.
func (a *api) liveLink(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	made, expires, ok, err := a.cfg.Sailing.LiveSailLink(r.Context(), acc.ID)
	if err != nil {
		a.unavailable(w, r, "reading a link", err)
		return
	}
	life := a.cfg.Switches.Lifetime()
	if !ok || !a.cfg.Switches.Links() || !aboard.Live(made, expires, false, life, time.Now()) {
		writeJSON(w, http.StatusOK, linkStatus{})
		return
	}
	writeJSON(w, http.StatusOK, linkStatus{Live: true, Expires: linkEnd(made, expires, life).UTC().Format(time.RFC3339)})
}

// linkPage is GET /api/sail/{token}'s answer: whose boat, how they look,
// the boat's kind and name, and whether the viewer may knock.
type linkPage struct {
	Skipper string `json:"skipper"`
	Look    uint32 `json:"look"`
	Kind    uint16 `json:"kind"`
	Boat    string `json:"boat"`
	Can     string `json:"can"`
}

// readLink answers GET /api/sail/{token}, behind auth.Required: what a
// link's page shows. It changes nothing. A token that is not one the game
// makes never reaches the database.
//
//	200 {"skipper", "look", "kind", "boat", "can"}
//	410 {"error":"ended"}  unknown, expired, ended, or links off
func (a *api) readLink(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	hash, err := aboard.TokenHash(r.PathValue("token"))
	if err != nil || !a.cfg.Switches.Links() {
		writeError(w, http.StatusGone, "ended")
		return
	}
	l, err := a.cfg.Sailing.SailLink(r.Context(), hash)
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusGone, "ended")
		return
	case err != nil:
		a.unavailable(w, r, "reading a link", err)
		return
	}
	if l.Kind != store.Human || !aboard.Live(l.Made, l.Expires, l.Ended, a.cfg.Switches.Lifetime(), time.Now()) {
		writeError(w, http.StatusGone, "ended")
		return
	}
	out := linkPage{Skipper: l.Name, Can: CanNotAtSea}
	if a.cfg.Looks != nil {
		out.Look = a.cfg.Looks.Code(a.cfg.Looks.Resolve(l.Skipper, l.Look))
	}
	if d := a.cfg.Deck; d != nil {
		out.Can, out.Kind, out.Boat = d.LinkCan(l.Skipper, acc.ID)
	}
	switch {
	case l.Skipper == acc.ID:
		out.Can = CanOwn
	case out.Can == CanOK && !a.cfg.Switches.Boarding():
		out.Can = CanClosed
	}
	writeJSON(w, http.StatusOK, out)
}

// registerSailing adds sailing together's routes.
func (a *api) registerSailing(mux *http.ServeMux, required func(http.HandlerFunc) http.Handler) {
	mux.Handle("POST /api/me/born", required(a.setBorn))
	mux.Handle("POST /api/me/rules", required(a.acceptRules))
	if a.cfg.Switches == nil {
		return
	}
	mux.Handle("POST /api/sail/link", required(a.makeLink))
	mux.Handle("POST /api/sail/link/end", required(a.endLink))
	mux.Handle("GET /api/sail/link", required(a.liveLink))
	mux.Handle("GET /api/sail/{token}", required(a.readLink))
}
