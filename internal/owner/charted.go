// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
)

// The world's chart as the world page shows it: each subject charted, by
// whom and when, and what it was worth, beside the map's whole world; and
// its one control, which charts the whole world for every sailor at once.
// No single subject is charted from the page: a test charts one through
// the developer's commands.

// Charted is a subject charted, as the page lists it.
type Charted struct {
	// Subject is its kind's word, "island", "place" or "feature", and
	// Number its number among those.
	Subject string `json:"subject"`
	Number  int32  `json:"number"`
	// By is the sailor's name as it was, empty for one known from the
	// world's start or charted with another; AI says the sailor is an
	// agent.
	By    string  `json:"by"`
	AI    bool    `json:"ai"`
	At    int64   `json:"at"` // ms of UTC since 1970
	Worth float64 `json:"worth"`
}

// ChartedList is the world's chart as it stands, in the order it was
// charted: the chart's model.
type ChartedList func() []Charted

// chartedJSON is charted.json: the subjects charted, and how many there are
// to chart.
type chartedJSON struct {
	Subjects int       `json:"subjects"`
	Charted  []Charted `json:"charted"`
}

// charted serves charted.json, never cached.
func (o *Owner) charted(w http.ResponseWriter, _ *http.Request) {
	out := chartedJSON{Subjects: o.cfg.Subjects, Charted: []Charted{}}
	if o.cfg.Charted != nil {
		out.Charted = append(out.Charted, o.cfg.Charted()...)
	}
	body, err := json.Marshal(out)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", "no-store")
	_, _ = w.Write(body)
}

// chartWhole charts every subject of the world sailed not yet charted, for
// every sailor, at the next tick: credited to no one, as what is known
// from the world's start is, so no news is written and no notice raised,
// and what sailors charted keeps its credit. It cannot be undone. Refused
// for another world than the active one, during a switch, and once all is
// charted.
//
//	POST /owner/api/chart {"number": 3}
func (o *Owner) chartWhole(w http.ResponseWriter, r *http.Request) {
	var req NewWorldRequest
	if !readBody(w, r, &req) {
		return
	}
	n := o.cfg.World.Number
	switch {
	case o.cfg.Charted == nil || o.cfg.Frames == nil:
		o.refuse(w, "chart", http.StatusServiceUnavailable, "this world has no chart to fill")
		return
	case req.Number != n:
		o.refuse(w, "chart", http.StatusConflict, fmt.Sprintf("world %d is not the active world: world %d is", req.Number, n))
		return
	case o.cfg.Life != nil && o.cfg.Life.Switching():
		o.refuse(w, "chart", http.StatusConflict, "a switch is under way")
		return
	}
	charted := len(o.cfg.Charted())
	left := o.cfg.Subjects - charted
	if left <= 0 {
		o.refuse(w, "chart", http.StatusConflict, fmt.Sprintf("world %d is charted whole", n))
		return
	}
	if err := o.send(bus.Command{Op: bus.Chart, Subject: -1, On: true}); err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	o.count("chart")
	o.cfg.Log.Warn("owner: the whole world charted", "action", "chart", "world", n, "charting", left, "charted", charted,
		"subjects", o.cfg.Subjects, "from", r.RemoteAddr)
	writeAccepted(w, map[string]any{"world": n, "charting": left})
}
