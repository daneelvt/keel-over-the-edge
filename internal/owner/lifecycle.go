// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Life is the world's life, as keel keeps it: its end, the next world, the
// jobs' runs; and the owner's hand on it.
type Life interface {
	// Lifecycle is the world's life now.
	Lifecycle(ctx context.Context) (Lifecycle, error)
	// BeginNext ends the active world, of the number given, at once and
	// begins the next, made first if it was not; it answers before the
	// switch, with the number of the world to begin.
	BeginNext(ctx context.Context, number int) (int, error)
	// RemakeNext discards the next world, of the number given, and makes
	// another from a new seed; it answers before the making.
	RemakeNext(ctx context.Context, number int) error
	// NextView is the next world's view, nil until its terrain is stored.
	NextView(ctx context.Context) (*Owner, error)
}

// Lifecycle is the world's life as the page shows it. Times are ms of UTC
// since 1970, 0 for none; Now is the server's clock, which the page counts
// down from, never its own.
type Lifecycle struct {
	Now      int64  `json:"now"`
	Schedule string `json:"schedule"`
	// Zone is the schedule's time zone, "" for a schedule of periods.
	Zone  string `json:"zone"`
	World int    `json:"world"`
	Began int64  `json:"began"`
	Ends  int64  `json:"ends"`
	// Closing says the world is in its last days; ClosingFrom is when they
	// began, NextMadeAt when the next world is made, RemakeUntil the last
	// moment it may be made again.
	Closing     bool       `json:"closing"`
	ClosingFrom int64      `json:"closingFrom"`
	NextMadeAt  int64      `json:"nextMadeAt"`
	RemakeUntil int64      `json:"remakeUntil"`
	Switching   bool       `json:"switching"`
	Next        *NextWorld `json:"next"`
	Runs        []JobRun   `json:"runs"`
}

// NextWorld is the next world: its number, its seed (as a string: a seed
// is a whole number to 2⁶⁴), when its row was made, and its terrain if
// stored.
type NextWorld struct {
	Number       int    `json:"number"`
	Seed         string `json:"seed"`
	Created      int64  `json:"created"`
	Stored       bool   `json:"stored"`
	StoredAt     int64  `json:"storedAt"`
	Attempts     int    `json:"attempts"`
	GenerationMs int    `json:"generationMs"`
}

// JobRun is a run of a job.
type JobRun struct {
	Job      string `json:"job"`
	Due      int64  `json:"due"`
	Started  int64  `json:"started"`
	Finished int64  `json:"finished"`
	Outcome  string `json:"outcome"`
	Detail   string `json:"detail"`
	Attempts int    `json:"attempts"`
}

// lifecycle serves the world's life.
//
//	GET /owner/api/lifecycle.json
func (o *Owner) lifecycle(w http.ResponseWriter, r *http.Request) {
	if o.cfg.Life == nil {
		http.Error(w, "this keel keeps no world's life", http.StatusNotFound)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), dbTimeout)
	defer cancel()
	lc, err := o.cfg.Life.Lifecycle(ctx)
	if err != nil {
		http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, lc)
}

// NewWorldRequest names a world by its number, typed, so that no world is
// ended or made again by a stray click.
type NewWorldRequest struct {
	Number int `json:"number"`
}

// newWorld ends the active world at once and begins the next, in the
// running process, as its scheduled end would: the next world made first
// if it was not. Every player's boat goes with the world.
//
//	POST /owner/api/world {"number": 3}
func (o *Owner) newWorld(w http.ResponseWriter, r *http.Request) {
	var req NewWorldRequest
	if !readBody(w, r, &req) {
		return
	}
	if o.cfg.Life == nil {
		o.refuse(w, "world", http.StatusServiceUnavailable, "this keel cannot begin a world")
		return
	}
	if req.Number != o.cfg.World.Number {
		o.refuse(w, "world", http.StatusBadRequest, "type the active world's number to end it")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), dbTimeout)
	defer cancel()
	next, err := o.cfg.Life.BeginNext(ctx, req.Number)
	switch {
	case errors.Is(err, store.ErrNotActive):
		o.refuse(w, "world", http.StatusConflict, "that world is no longer the active one")
		return
	case err != nil:
		o.refuse(w, "world", http.StatusConflict, err.Error())
		return
	}
	o.count("world")
	o.cfg.Log.Warn("owner: the next world begun by hand", "action", "world", "ended", req.Number, "begun", next, "from", r.RemoteAddr)
	writeAccepted(w, map[string]any{"ended": req.Number, "begun": next})
}

// remake discards the next world, before anyone has sailed it, and makes
// another from a new seed under its number.
//
//	POST /owner/api/next {"number": 4}
func (o *Owner) remake(w http.ResponseWriter, r *http.Request) {
	var req NewWorldRequest
	if !readBody(w, r, &req) {
		return
	}
	if o.cfg.Life == nil {
		o.refuse(w, "remake", http.StatusServiceUnavailable, "this keel cannot make a world")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), dbTimeout)
	defer cancel()
	switch err := o.cfg.Life.RemakeNext(ctx, req.Number); {
	case errors.Is(err, store.ErrNoNext):
		o.refuse(w, "remake", http.StatusBadRequest, "type the next world's number to make it again")
		return
	case err != nil:
		o.refuse(w, "remake", http.StatusConflict, err.Error())
		return
	}
	o.count("remake")
	o.cfg.Log.Warn("owner: the next world to be made again", "action", "remake", "world", req.Number, "from", r.RemoteAddr)
	writeAccepted(w, map[string]any{"remaking": req.Number})
}

// next serves the next world's view: what is drawn and listed of its
// terrain, as the current world's is, from its stored bundle; 404 until it
// is stored.
//
//	GET /owner/api/next/land.png, …/islands.json, …
func (o *Owner) next(w http.ResponseWriter, r *http.Request) {
	if o.cfg.Life == nil {
		http.NotFound(w, r)
		return
	}
	v, err := o.cfg.Life.NextView(r.Context())
	switch {
	case err != nil:
		http.Error(w, "the next world: "+err.Error(), http.StatusServiceUnavailable)
		return
	case v == nil:
		http.Error(w, "the next world is not made yet", http.StatusNotFound)
		return
	}
	v.DrawnHandler().ServeHTTP(w, r)
}

// writeAccepted answers 202: what was asked is under way.
func writeAccepted(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(v)
}
