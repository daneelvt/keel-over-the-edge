// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// RacingSettings are the racing limits and the harbour races' timetable
// as the database keeps them, set with an entry in the record: the store.
type RacingSettings interface {
	RaceSettings(ctx context.Context) (store.RaceSettings, error)
	SetRaceSettings(ctx context.Context, r store.RaceSettings, a store.Action) error
}

// RacesJSON is races: the most races a sailor may be entered in ahead,
// start in a day, make in a day and own not finished; how long before a
// world's end no race starts, s; the harbour races every so many hours,
// their boats in turn, and the share of the week's newcomers' harbour
// races at the hours that suit the US, percent.
type RacesJSON struct {
	Ahead       int      `json:"ahead"`
	Daily       int      `json:"daily"`
	Made        int      `json:"made"`
	Owned       int      `json:"owned"`
	Cutoff      int64    `json:"cutoff"`
	Every       int      `json:"every"`
	Boats       []string `json:"boats"`
	GreenhornUS int      `json:"greenhornUS"`
}

// RacesRequest changes any of the racing settings; with Check, it only
// says what it would do.
type RacesRequest struct {
	Ahead       *int      `json:"ahead,omitempty"`
	Daily       *int      `json:"daily,omitempty"`
	Made        *int      `json:"made,omitempty"`
	Owned       *int      `json:"owned,omitempty"`
	Cutoff      *int64    `json:"cutoff,omitempty"`
	Every       *int      `json:"every,omitempty"`
	Boats       *[]string `json:"boats,omitempty"`
	GreenhornUS *int      `json:"greenhornUS,omitempty"`
	Check       bool      `json:"check,omitempty"`
}

// RacesAnswer is what a change did, or checked would do: the settings
// after it and its words.
type RacesAnswer struct {
	Settings RacesJSON `json:"settings"`
	Words    string    `json:"words"`
}

func racesOf(r store.RaceSettings) RacesJSON {
	boats := r.Boats
	if boats == nil {
		boats = []string{}
	}
	return RacesJSON{Ahead: r.Ahead, Daily: r.Daily, Made: r.Made, Owned: r.Owned, Cutoff: int64(r.Cutoff / time.Second),
		Every: r.Every, Boats: boats, GreenhornUS: r.GreenhornUS}
}

// races serves the racing settings in force.
//
//	GET /owner/api/races
func (o *Owner) races(w http.ResponseWriter, r *http.Request) {
	if o.cfg.Racing == nil {
		http.Error(w, "races are not running", http.StatusServiceUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), dbTimeout)
	defer cancel()
	s, err := o.cfg.Racing.RaceSettings(ctx)
	if err != nil {
		http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, racesOf(s))
}

// harbourEvery are the hours apart harbour races may be: each divides the
// day.
var harbourEvery = []int{1, 2, 3, 4, 6, 8, 12}

// setRaces changes the racing limits and the harbour timetable, with an
// entry in the record. The limits count from the races' rows, so a change
// holds at once for every sailor; a new timetable makes the harbour races
// not yet made, and a world's newcomers' hours, set as it begins, stay.
//
//	POST /owner/api/races {"daily": 6, "check": true}
func (o *Owner) setRaces(w http.ResponseWriter, r *http.Request) {
	var req RacesRequest
	if !readBody(w, r, &req) {
		return
	}
	if o.cfg.Racing == nil {
		o.refuse(w, "races", http.StatusServiceUnavailable, "races are not running")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), dbTimeout)
	defer cancel()
	s, err := o.cfg.Racing.RaceSettings(ctx)
	if err != nil {
		http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	var words []string
	limit := func(v *int, into *int, least, most int, what string) bool {
		if v == nil {
			return true
		}
		if *v < least || *v > most {
			o.refuse(w, "races", http.StatusBadRequest, fmt.Sprintf("%s: from %d to %d", what, least, most))
			return false
		}
		*into = *v
		words = append(words, fmt.Sprintf("%s %d", what, *v))
		return true
	}
	if !limit(req.Ahead, &s.Ahead, 1, 20, "races entered ahead") || !limit(req.Daily, &s.Daily, 1, 100, "races started a day") ||
		!limit(req.Made, &s.Made, 1, 100, "races made a day") || !limit(req.Owned, &s.Owned, 1, 20, "races owned not finished") ||
		!limit(req.GreenhornUS, &s.GreenhornUS, 0, 100, "newcomers' races at US hours, percent") {
		return
	}
	if req.Cutoff != nil {
		d := time.Duration(*req.Cutoff) * time.Second
		if d < 0 || d > 24*time.Hour {
			o.refuse(w, "races", http.StatusBadRequest, "cutoff: from 0 to 86400 s")
			return
		}
		s.Cutoff = d
		words = append(words, fmt.Sprintf("no race starts in the last %s of a world", d))
	}
	if req.Every != nil {
		if !slices.Contains(harbourEvery, *req.Every) {
			o.refuse(w, "races", http.StatusBadRequest, "every: 1, 2, 3, 4, 6, 8 or 12 hours")
			return
		}
		s.Every = *req.Every
		words = append(words, fmt.Sprintf("a harbour race every %d hours", *req.Every))
	}
	if req.Boats != nil {
		boats := *req.Boats
		if len(boats) == 0 || len(boats) > 24 {
			o.refuse(w, "races", http.StatusBadRequest, "boats: 1 to 24 of the catalog's boats")
			return
		}
		for _, b := range boats {
			if !slices.Contains(o.cfg.RaceBoats, b) {
				o.refuse(w, "races", http.StatusBadRequest, "boats: each one of "+strings.Join(o.cfg.RaceBoats, ", "))
				return
			}
		}
		s.Boats = slices.Clone(boats)
		words = append(words, "the harbour races' boats in turn: "+strings.Join(boats, ", "))
	}
	if len(words) == 0 {
		o.refuse(w, "races", http.StatusBadRequest, "nothing to change: give ahead, daily, made, owned, cutoff, every, boats or greenhornUS")
		return
	}
	said := strings.Join(words, "; ")
	if req.Check {
		writeJSON(w, RacesAnswer{Settings: racesOf(s), Words: "Would set: " + said + "."})
		return
	}
	a := store.Action{Source: sourceOf(r), From: r.RemoteAddr, Detail: said}
	if err := o.cfg.Racing.SetRaceSettings(ctx, s, a); err != nil {
		http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	o.count(store.ActionRacing)
	o.cfg.Log.Info("owner: racing set", "action", store.ActionRacing, "from", r.RemoteAddr)
	writeJSON(w, RacesAnswer{Settings: racesOf(s), Words: "Done: " + said + "."})
}
