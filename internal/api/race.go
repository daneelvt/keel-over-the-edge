// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/race"
)

// Races are a world's races ashore: internal/race. A human makes, opens,
// enters and runs races here; a machine sailor does the same through its
// tools, by the same service.
type Races interface {
	Board(ctx context.Context, by race.Sailor) (race.Board, error)
	Card(ctx context.Context, by race.Sailor, code string) (race.Card, error)
	Make(ctx context.Context, by race.Sailor, m race.Making) (race.Card, error)
	SuggestName(kind, course string, start time.Time) (string, error)
	Enter(ctx context.Context, by race.Sailor, code string, crew bool) (race.Card, error)
	Withdraw(ctx context.Context, by race.Sailor, code string) (race.Card, error)
	Close(ctx context.Context, by race.Sailor, code string) (race.Card, error)
	Cancel(ctx context.Context, by race.Sailor, code string) (race.Card, error)
	Remove(ctx context.Context, by race.Sailor, code string, number int) (race.Card, error)
	Move(ctx context.Context, by race.Sailor, code string, at time.Time) (race.Card, error)
	Again(ctx context.Context, by race.Sailor, code string) (race.Card, error)
	Calendar(ctx context.Context, by race.Sailor, code string) ([]byte, string, error)
	Spoon(ctx context.Context, by race.Sailor, code string, hang bool) error
}

var _ Races = (*race.Service)(nil)

// registerRaces adds the races' routes, every one behind a session, the
// card and the calendar file too: a visitor from a race's link makes a
// sailor first.
func (a *api) registerRaces(mux *http.ServeMux, required func(http.HandlerFunc) http.Handler) {
	if a.cfg.Races == nil {
		return
	}
	mux.Handle("GET /api/races", required(a.raceBoard))
	mux.Handle("GET /api/race/name", required(a.raceName))
	mux.Handle("POST /api/race", required(a.makeRace))
	mux.Handle("GET /api/race/{code}", required(a.raceCard))
	mux.Handle("GET /api/race/{code}/calendar.ics", required(a.raceCalendar))
	mux.Handle("POST /api/race/{code}/enter", required(a.enterRace))
	mux.Handle("POST /api/race/{code}/withdraw", required(a.raceAction(func(ctx context.Context, by race.Sailor, code string) (race.Card, error) {
		return a.cfg.Races.Withdraw(ctx, by, code)
	})))
	mux.Handle("POST /api/race/{code}/close", required(a.raceAction(func(ctx context.Context, by race.Sailor, code string) (race.Card, error) {
		return a.cfg.Races.Close(ctx, by, code)
	})))
	mux.Handle("POST /api/race/{code}/cancel", required(a.raceAction(func(ctx context.Context, by race.Sailor, code string) (race.Card, error) {
		return a.cfg.Races.Cancel(ctx, by, code)
	})))
	mux.Handle("POST /api/race/{code}/remove", required(a.removeEntrant))
	mux.Handle("POST /api/race/{code}/move", required(a.moveRace))
	mux.Handle("POST /api/race/{code}/again", required(a.raceAgain))
	mux.Handle("POST /api/race/{code}/spoon", required(a.raceSpoon))
}

// racer is the session's sailor as races see them: a human's, since a
// machine sailor races through its tools.
func racer(w http.ResponseWriter, r *http.Request) (race.Sailor, bool) {
	acc, ok := human(w, r)
	return race.Sailor{ID: acc.ID}, ok
}

// raceRefusal is a refusal's answer: why, until when, and a name's
// reason.
type raceRefusal struct {
	Error string `json:"error"`
	Until int64  `json:"until,omitempty"`
	Name  string `json:"name,omitempty"`
}

// answerRace answers what asking of a race came to: its card with
// status, or why not. A refusal is a 409 with its reason; a code no race
// has, 404; another's race, 403.
func (a *api) answerRace(w http.ResponseWriter, r *http.Request, status int, c race.Card, err error) {
	if err == nil {
		writeJSON(w, status, c)
		return
	}
	a.refusedRace(w, r, err)
}

// refusedRace answers an error of asking of a race.
func (a *api) refusedRace(w http.ResponseWriter, r *http.Request, err error) {
	if ref, ok := race.RefusalOf(err); ok {
		out := raceRefusal{Error: ref.Reason, Name: ref.Name}
		if !ref.Until.IsZero() {
			out.Until = ref.Until.UnixMilli()
		}
		writeJSON(w, http.StatusConflict, out)
		return
	}
	switch {
	case errors.Is(err, race.ErrNotFound):
		writeError(w, http.StatusNotFound, "not-found")
	case errors.Is(err, race.ErrNotOwner):
		writeError(w, http.StatusForbidden, "not-owner")
	default:
		a.unavailable(w, r, "asking of a race", err)
	}
}

// raceBoard answers GET /api/races, behind auth.Required: the next
// harbour races, the week's newcomers' harbour races, the player's own
// races, and what they may make a race of.
//
//	200 race.Board
//	403 {"error":"ai-account"}
func (a *api) raceBoard(w http.ResponseWriter, r *http.Request) {
	by, ok := racer(w, r)
	if !ok {
		return
	}
	b, err := a.cfg.Races.Board(r.Context(), by)
	if err != nil {
		a.refusedRace(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, b)
}

// raceName answers GET /api/race/name?kind=&course=&at=, behind
// auth.Required: a name suggested for a race.
//
//	200 {"name"}
//	409 {"error":"course"}
//	403 {"error":"ai-account"}
func (a *api) raceName(w http.ResponseWriter, r *http.Request) {
	if _, ok := racer(w, r); !ok {
		return
	}
	v := r.URL.Query()
	var start time.Time
	if ms, err := strconv.ParseInt(v.Get("at"), 10, 64); err == nil && ms > 0 {
		start = time.UnixMilli(ms)
	}
	name, err := a.cfg.Races.SuggestName(v.Get("kind"), clip(v.Get("course"), maxCode), start)
	if err != nil {
		a.refusedRace(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"name": name})
}

// makeBody is POST /api/race's body: a race or a trial, its course's ID,
// its boat, its start (ms), who may enter and its name ("" for the one
// suggested).
type makeBody struct {
	Kind   string `json:"kind"`
	Course string `json:"course"`
	Boat   string `json:"boat"`
	At     int64  `json:"at"`
	Who    string `json:"who"`
	Name   string `json:"name"`
}

// makeRace answers POST /api/race, behind auth.Required: a race made,
// the player its owner.
//
//	201 race.Card
//	409 {"error": reason, "until", "name"}
//	403 {"error":"ai-account"}
func (a *api) makeRace(w http.ResponseWriter, r *http.Request) {
	by, ok := racer(w, r)
	if !ok {
		return
	}
	var body makeBody
	if !readJSON(w, r, &body) {
		return
	}
	m := race.Making{Kind: clip(body.Kind, maxCode), Course: clip(body.Course, maxCode), Boat: clip(body.Boat, maxCode),
		Who: clip(body.Who, maxCode), Name: clip(body.Name, 4*maxName)}
	if body.At > 0 {
		m.At = time.UnixMilli(body.At)
	}
	c, err := a.cfg.Races.Make(r.Context(), by, m)
	a.answerRace(w, r, http.StatusCreated, c, err)
}

// raceCode is the code of the race a route names.
func raceCode(r *http.Request) string { return clip(r.PathValue("code"), maxCode) }

// raceCard answers GET /api/race/{code}, behind auth.Required: the race's
// card as the player is shown it.
//
//	200 race.Card
//	404 {"error":"not-found"}
//	403 {"error":"ai-account"}
func (a *api) raceCard(w http.ResponseWriter, r *http.Request) {
	by, ok := racer(w, r)
	if !ok {
		return
	}
	c, err := a.cfg.Races.Card(r.Context(), by, raceCode(r))
	a.answerRace(w, r, http.StatusOK, c, err)
}

// enterBody is POST /api/race/{code}/enter's body: whether those aboard
// come.
type enterBody struct {
	Crew bool `json:"crew"`
}

// enterRace answers POST /api/race/{code}/enter, behind auth.Required:
// the player's boat entered, with those aboard if crew.
//
//	200 race.Card
//	409 {"error": reason, "until"}
//	404 {"error":"not-found"}
//	403 {"error":"ai-account"}
func (a *api) enterRace(w http.ResponseWriter, r *http.Request) {
	by, ok := racer(w, r)
	if !ok {
		return
	}
	var body enterBody
	if r.ContentLength != 0 && !readJSON(w, r, &body) {
		return
	}
	c, err := a.cfg.Races.Enter(r.Context(), by, raceCode(r), body.Crew)
	a.answerRace(w, r, http.StatusOK, c, err)
}

// raceAction answers an action on a race that takes no body: withdraw,
// close or cancel, behind auth.Required.
//
//	200 race.Card
//	409 {"error": reason}
//	404 {"error":"not-found"}
//	403 {"error":"not-owner"} | {"error":"ai-account"}
func (a *api) raceAction(do func(ctx context.Context, by race.Sailor, code string) (race.Card, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		by, ok := racer(w, r)
		if !ok {
			return
		}
		c, err := do(r.Context(), by, raceCode(r))
		a.answerRace(w, r, http.StatusOK, c, err)
	}
}

// removeBody is POST /api/race/{code}/remove's body: the boat's race
// number.
type removeBody struct {
	Number int `json:"number"`
}

// removeEntrant answers POST /api/race/{code}/remove, behind
// auth.Required: a boat removed by the race's owner.
//
//	200 race.Card
//	409 {"error":"not-entered"|"started"|…}
//	403 {"error":"not-owner"}
func (a *api) removeEntrant(w http.ResponseWriter, r *http.Request) {
	by, ok := racer(w, r)
	if !ok {
		return
	}
	var body removeBody
	if !readJSON(w, r, &body) {
		return
	}
	c, err := a.cfg.Races.Remove(r.Context(), by, raceCode(r), body.Number)
	a.answerRace(w, r, http.StatusOK, c, err)
}

// moveBody is POST /api/race/{code}/move's body: the new start, ms.
type moveBody struct {
	At int64 `json:"at"`
}

// moveRace answers POST /api/race/{code}/move, behind auth.Required: the
// race's start moved by its owner, once.
//
//	200 race.Card
//	400 {"error":"at"}
//	409 {"error":"moved"|"soon"|"late"|…, "until"}
//	403 {"error":"not-owner"}
func (a *api) moveRace(w http.ResponseWriter, r *http.Request) {
	by, ok := racer(w, r)
	if !ok {
		return
	}
	var body moveBody
	if !readJSON(w, r, &body) {
		return
	}
	if body.At <= 0 {
		writeError(w, http.StatusBadRequest, "at")
		return
	}
	c, err := a.cfg.Races.Move(r.Context(), by, raceCode(r), time.UnixMilli(body.At))
	a.answerRace(w, r, http.StatusOK, c, err)
}

// raceAgain answers POST /api/race/{code}/again, behind auth.Required: a
// finished race made again by its owner.
//
//	201 race.Card, the new race's
//	409 {"error":"not-finished"|…}
//	403 {"error":"not-owner"}
func (a *api) raceAgain(w http.ResponseWriter, r *http.Request) {
	by, ok := racer(w, r)
	if !ok {
		return
	}
	c, err := a.cfg.Races.Again(r.Context(), by, raceCode(r))
	a.answerRace(w, r, http.StatusCreated, c, err)
}

// spoonBody is POST /api/race/{code}/spoon's body and answer: whether the
// wooden spoon hangs from the sailor's sterns.
type spoonBody struct {
	Hang bool `json:"hang"`
}

// raceSpoon answers POST /api/race/{code}/spoon, behind auth.Required:
// the wooden spoon the player was given in the race hung from their
// boats' sterns for the rest of the world, or taken down.
//
//	200 {"hang"}
//	404 {"error":"not-found"}   no such race this world, or no spoon of theirs in it
//	403 {"error":"ai-account"}
func (a *api) raceSpoon(w http.ResponseWriter, r *http.Request) {
	by, ok := racer(w, r)
	if !ok {
		return
	}
	var body spoonBody
	if !readJSON(w, r, &body) {
		return
	}
	if err := a.cfg.Races.Spoon(r.Context(), by, raceCode(r), body.Hang); err != nil {
		a.refusedRace(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, body)
}

// raceCalendar answers GET /api/race/{code}/calendar.ics, behind
// auth.Required: the race's calendar file, for the player to save, never
// a subscription: the session's cookie fetches it.
//
//	200 text/calendar
//	404 {"error":"not-found"}
//	403 {"error":"ai-account"}
func (a *api) raceCalendar(w http.ResponseWriter, r *http.Request) {
	by, ok := racer(w, r)
	if !ok {
		return
	}
	file, name, err := a.cfg.Races.Calendar(r.Context(), by, raceCode(r))
	if err != nil {
		a.refusedRace(w, r, err)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/calendar; charset=utf-8")
	h.Set("Content-Disposition", `attachment; filename="`+name+`"`)
	h.Set("Cache-Control", "private, no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(file)
}
