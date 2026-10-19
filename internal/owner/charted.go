// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"encoding/json"
	"net/http"
)

// The world's chart as the world page shows it: each subject charted, by
// whom and when, and what it was worth, beside the map's whole world. The
// page has no control to chart anything: a test charts by hand through the
// developer's commands.

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
