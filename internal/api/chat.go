// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Chat aboard, the account's side: its own switch for chat (a player of
// 13 to 17 turns it on, after a card, from off), its mutes and blocks,
// with an end to each, and the statements of reasons the owner sent it,
// with its one answer to each. And the notice page's form, for anyone,
// signed in or not: a report from outside the game into the owner's
// queue. Saying a line, muting, blocking and reporting from aboard are
// the game connection's.

// Chatting is the store's and the game's side of chat for the routes.
type Chatting interface {
	SetChat(ctx context.Context, id store.AccountID, on bool) error
	Talker(ctx context.Context, id store.AccountID) (store.Talker, error)
	TiesOf(ctx context.Context, account store.AccountID) ([]store.TieRow, error)
	Untie(ctx context.Context, account, other store.AccountID, block bool) error
	Statements(ctx context.Context, account store.AccountID) ([]store.Statement, error)
	ReadStatement(ctx context.Context, account store.AccountID, id [16]byte) error
	AnswerStatement(ctx context.Context, account store.AccountID, id [16]byte, answer string) error
	Notice(ctx context.Context, n store.Notice) error
	// Changed tells the game the account's chat may stand differently:
	// its switch, the Rules of the sea.
	Changed(ctx context.Context, id store.AccountID)
}

// chatOf is the account's chat as its page shows it: whether its chat is
// on, whether turning it on shows the card first (13 to 17), whether the
// Rules of the sea are still to be accepted, and whether its age is still
// to be asked.
type chatOf struct {
	On    bool `json:"on"`
	Card  bool `json:"card"`
	Rules bool `json:"rules"`
	Asked bool `json:"asked"`
}

// tieOut is a mute or a block, as the account's list shows it.
type tieOut struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"`
}

// statementOut is a statement of reasons, as its player reads it.
type statementOut struct {
	ID       string `json:"id"`
	Made     string `json:"made"`
	Action   string `json:"action"`
	Rule     string `json:"rule"`
	Seen     string `json:"seen,omitempty"`
	Until    string `json:"until,omitempty"`
	Read     bool   `json:"read"`
	Answer   string `json:"answer,omitempty"`
	Answered string `json:"answered,omitempty"`
}

func stamp(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// chat answers GET /api/me/chat.
func (a *api) chat(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	if acc.Kind != store.Human {
		writeError(w, http.StatusForbidden, "human")
		return
	}
	t, err := a.cfg.Chat.Talker(r.Context(), acc.ID)
	if err != nil {
		a.unavailable(w, r, "reading a sailor's chat", err)
		return
	}
	band := aboard.Unknown
	if b, ok := aboard.BornOf(t.Born); ok {
		band = aboard.BandOf(b, time.Now())
	}
	writeJSON(w, http.StatusOK, chatOf{
		On: aboard.ChatOn(band, t.ChatSet, t.Chat), Card: band == aboard.Teen, Rules: !t.Rules, Asked: t.Born != 0,
	})
}

// setChat answers POST /api/me/chat {"on"}: the account's own switch.
func (a *api) setChat(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	var in struct {
		On *bool `json:"on"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if in.On == nil {
		writeError(w, http.StatusBadRequest, "on")
		return
	}
	if acc.Kind != store.Human {
		writeError(w, http.StatusForbidden, "human")
		return
	}
	if *in.On && acc.Born == 0 {
		writeError(w, http.StatusForbidden, "first")
		return
	}
	if err := a.cfg.Chat.SetChat(r.Context(), acc.ID, *in.On); err != nil {
		a.unavailable(w, r, "setting a sailor's chat", err)
		return
	}
	a.cfg.Chat.Changed(r.Context(), acc.ID)
	w.WriteHeader(http.StatusNoContent)
}

// ties answers GET /api/me/ties: the account's mutes and blocks.
func (a *api) ties(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	rows, err := a.cfg.Chat.TiesOf(r.Context(), acc.ID)
	if err != nil {
		a.unavailable(w, r, "reading mutes and blocks", err)
		return
	}
	out := make([]tieOut, len(rows))
	for i, t := range rows {
		out[i] = tieOut{ID: store.AccountID(t.Other).String(), Name: t.Name, Kind: t.Kind}
	}
	writeJSON(w, http.StatusOK, out)
}

// untie answers POST /api/me/ties/end {"id", "kind"}: a mute or a block
// ended.
func (a *api) untie(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	var in struct {
		ID   string `json:"id"`
		Kind string `json:"kind"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	other, err := store.ParseAccountID(in.ID)
	if err != nil || in.Kind != "mute" && in.Kind != "block" {
		writeError(w, http.StatusBadRequest, "id")
		return
	}
	if err := a.cfg.Chat.Untie(r.Context(), acc.ID, other, in.Kind == "block"); err != nil {
		a.unavailable(w, r, "ending a mute or a block", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// statements answers GET /api/me/statements.
func (a *api) statements(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	list, err := a.cfg.Chat.Statements(r.Context(), acc.ID)
	if err != nil {
		a.unavailable(w, r, "reading statements of reasons", err)
		return
	}
	out := make([]statementOut, len(list))
	for i, s := range list {
		out[i] = statementOut{
			ID: store.AccountID(s.ID).String(), Made: stamp(s.Made), Action: s.Action, Rule: s.Rule, Seen: s.Seen,
			Until: stamp(s.Until), Read: !s.Read.IsZero(), Answer: s.Answer, Answered: stamp(s.Answered),
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// readStatement answers POST /api/me/statements/read {"id"}.
func (a *api) readStatement(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	var in struct {
		ID string `json:"id"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	id, err := store.ParseAccountID(in.ID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "id")
		return
	}
	if err := a.cfg.Chat.ReadStatement(r.Context(), acc.ID, id); err != nil {
		a.unavailable(w, r, "marking a statement read", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// answerStatement answers POST /api/me/statements/answer {"id", "answer"}:
// the player's one answer, at most 500 characters.
func (a *api) answerStatement(w http.ResponseWriter, r *http.Request) {
	acc, _ := auth.FromContext(r.Context())
	var in struct {
		ID     string `json:"id"`
		Answer string `json:"answer"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	id, err := store.ParseAccountID(in.ID)
	answer := strings.TrimSpace(in.Answer)
	switch {
	case err != nil:
		writeError(w, http.StatusBadRequest, "id")
		return
	case answer == "" || utf8.RuneCountInString(answer) > store.MaxAnswer:
		writeError(w, http.StatusBadRequest, "answer")
		return
	}
	err = a.cfg.Chat.AnswerStatement(r.Context(), acc.ID, id, answer)
	switch {
	case errors.Is(err, store.ErrAnsweredAlready):
		writeError(w, http.StatusConflict, "answered")
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "statement")
	case err != nil:
		a.unavailable(w, r, "keeping an answer to a statement", err)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

// Notices from outside: at most NoticesAnHour from one address.
const NoticesAnHour = 5

// notices counts the notices from each address in the last hour.
type notices struct {
	mu   sync.Mutex
	by   map[string][]time.Time
	tidy time.Time
}

func (n *notices) allow(addr string, now time.Time) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.by == nil {
		n.by = map[string][]time.Time{}
	}
	if now.Sub(n.tidy) > time.Hour {
		for k, ts := range n.by {
			if len(ts) == 0 || now.Sub(ts[len(ts)-1]) > time.Hour {
				delete(n.by, k)
			}
		}
		n.tidy = now
	}
	ts := n.by[addr]
	for len(ts) > 0 && now.Sub(ts[0]) > time.Hour {
		ts = ts[1:]
	}
	if len(ts) >= NoticesAnHour {
		n.by[addr] = ts
		return false
	}
	n.by[addr] = append(ts, now)
	return true
}

// notice answers POST /api/notice, for anyone, signed in or not: who they
// are and how to reach them, the sailor's name if they know it, where and
// when, a reason and what happened.
func (a *api) notice(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Who      string `json:"who"`
		Contact  string `json:"contact"`
		Sailor   string `json:"sailor"`
		Happened string `json:"happened"`
		Reason   string `json:"reason"`
		What     string `json:"what"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	addr := r.Header.Get("Cf-Connecting-Ip")
	if addr == "" {
		addr, _, _ = net.SplitHostPort(r.RemoteAddr)
	}
	if !a.notices.allow(addr, time.Now()) {
		writeError(w, http.StatusTooManyRequests, "often")
		return
	}
	err := a.cfg.Chat.Notice(r.Context(), store.Notice{
		Who: in.Who, Contact: in.Contact, Sailor: in.Sailor, Happened: in.Happened, Reason: in.Reason, What: in.What,
	})
	switch {
	case errors.Is(err, ErrNoticeForm):
		writeError(w, http.StatusBadRequest, "form")
	case err != nil:
		a.unavailable(w, r, "keeping a notice", err)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

// ErrNoticeForm is a notice missing what it needs, or too long: the
// Chatting's Notice answers it.
var ErrNoticeForm = errors.New("api: a notice needs who, how to reach them, a reason and what happened")

// registerChat adds chat's routes.
func (a *api) registerChat(mux *http.ServeMux, required func(http.HandlerFunc) http.Handler) {
	if a.cfg.Chat == nil {
		return
	}
	mux.Handle("GET /api/me/chat", required(a.chat))
	mux.Handle("POST /api/me/chat", required(a.setChat))
	mux.Handle("GET /api/me/ties", required(a.ties))
	mux.Handle("POST /api/me/ties/end", required(a.untie))
	mux.Handle("GET /api/me/statements", required(a.statements))
	mux.Handle("POST /api/me/statements/read", required(a.readStatement))
	mux.Handle("POST /api/me/statements/answer", required(a.answerStatement))
	mux.HandleFunc("POST /api/notice", a.notice)
}
