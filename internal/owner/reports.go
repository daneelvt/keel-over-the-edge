// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/review"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The review page's side: the reports' queue, a report whole with the
// lines it holds, and the owner's actions on it. The lines are shown here
// and nowhere else: what players say is never kept but in a report.

// Reports is the reports' queue and the owner's hand on it.
type Reports interface {
	Queue(ctx context.Context) ([]store.QueueItem, error)
	Read(ctx context.Context, id store.ReportID) (store.Report, error)
	Do(ctx context.Context, a review.Act) (review.Done, error)
}

// QueueRow is a report in reports.json.
type QueueRow struct {
	ID       string `json:"id"`
	Made     string `json:"made"`
	Source   string `json:"source"`
	Reason   string `json:"reason"`
	Reporter string `json:"reporter,omitempty"`
	Reported string `json:"reported,omitempty"`
	Machine  bool   `json:"machine,omitempty"`
	Place    string `json:"place,omitempty"`
	Reports  int64  `json:"reports"`
	Urgent   bool   `json:"urgent,omitempty"`
	Lines    int64  `json:"lines"`
	Answered bool   `json:"answered,omitempty"`
}

// ReportJSON is report.json: a report whole.
type ReportJSON struct {
	ID       string               `json:"id"`
	Made     string               `json:"made"`
	Source   string               `json:"source"`
	Reason   string               `json:"reason"`
	Note     string               `json:"note,omitempty"`
	Reporter string               `json:"reporter,omitempty"`
	Reported string               `json:"reported,omitempty"`
	Account  string               `json:"account,omitempty"`
	Machine  bool                 `json:"machine,omitempty"`
	Owner    string               `json:"owner,omitempty"`
	OwnerOf  string               `json:"ownerName,omitempty"`
	Place    string               `json:"place,omitempty"`
	People   []store.ReportPerson `json:"people"`
	Taking   string               `json:"taking,omitempty"`
	Closed   string               `json:"closed,omitempty"`
	Outcome  string               `json:"outcome,omitempty"`
	Held     string               `json:"held,omitempty"`
	Referred string               `json:"referred,omitempty"`
	Notice   *store.Notice        `json:"notice,omitempty"`
	Lines    []LineJSON           `json:"lines"`
	Notes    []NoteJSON           `json:"notes"`
	Actions  []string             `json:"actions"`
	Days     []int                `json:"days"`
}

// LineJSON is a line a report holds.
type LineJSON struct {
	Line     uint64 `json:"line"`
	At       string `json:"at"`
	Name     string `json:"name"`
	Machine  bool   `json:"machine,omitempty"`
	Text     string `json:"text"`
	Reported bool   `json:"reported,omitempty"`
}

// NoteJSON is a note on a report: the owner's, or the player's answer.
type NoteJSON struct {
	At   string `json:"at"`
	By   string `json:"by"`
	Text string `json:"text"`
}

func iso(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339Nano)
}

// reports serves reports.json: the queue, a child's safety first.
func (o *Owner) reports(w http.ResponseWriter, r *http.Request) {
	if o.cfg.Reports == nil {
		http.Error(w, "reports are not running", http.StatusServiceUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), dbTimeout)
	defer cancel()
	q, err := o.cfg.Reports.Queue(ctx)
	if err != nil {
		http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	out := make([]QueueRow, len(q))
	for i, it := range q {
		out[i] = QueueRow{
			ID: store.AccountID(it.ID).String(), Made: iso(it.Made), Source: it.Source, Reason: it.Reason,
			Reporter: it.ReporterName, Reported: it.ReportedName, Machine: it.ReportedKind == string(store.AI), Place: it.Place,
			Reports: it.Reports, Urgent: it.Urgent, Lines: it.Lines, Answered: it.Answers > 0,
		}
	}
	writeJSON(w, out)
}

// report serves report.json?id=…: a report whole, with its lines.
func (o *Owner) report(w http.ResponseWriter, r *http.Request) {
	if o.cfg.Reports == nil {
		http.Error(w, "reports are not running", http.StatusServiceUnavailable)
		return
	}
	id, ok := parseAccount(r.URL.Query().Get("id"))
	if !ok {
		http.Error(w, "id: a report's ID", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), dbTimeout)
	defer cancel()
	rep, err := o.cfg.Reports.Read(ctx, store.ReportID(id))
	switch {
	case errors.Is(err, store.ErrNotFound):
		http.Error(w, "no such report", http.StatusNotFound)
		return
	case err != nil:
		http.Error(w, "the database: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, reportJSON(rep))
}

func reportJSON(rep store.Report) ReportJSON {
	out := ReportJSON{
		ID: store.AccountID(rep.ID).String(), Made: iso(rep.Made), Source: rep.Source, Reason: rep.Reason, Note: rep.Note,
		Reporter: rep.ReporterName, Reported: rep.ReportedName, Machine: rep.ReportedKind == string(store.AI), Place: rep.Place,
		People: rep.People, Closed: iso(rep.Closed), Outcome: rep.Outcome, Held: iso(rep.HeldUntil), Referred: rep.Referred,
		Notice: rep.Notice, Lines: []LineJSON{}, Notes: []NoteJSON{}, Actions: review.Actions, Days: review.MuteDays,
	}
	if rep.HasReported {
		out.Account = rep.Reported.String()
	}
	if rep.HasOwner {
		out.Owner, out.OwnerOf = rep.Owner.String(), rep.OwnerName
	}
	if rep.FollowUntil.After(time.Now()) {
		out.Taking = iso(rep.FollowUntil)
	}
	if out.People == nil {
		out.People = []store.ReportPerson{}
	}
	for _, l := range rep.Lines {
		out.Lines = append(out.Lines, LineJSON{Line: l.Line, At: iso(l.At), Name: l.Name, Machine: l.Machine, Text: l.Text, Reported: l.Reported})
	}
	for _, n := range rep.Notes {
		out.Notes = append(out.Notes, NoteJSON{At: iso(n.At), By: n.By, Text: n.Text})
	}
	return out
}

// ActRequest is an action on a report; with Check, it only says what it
// would do.
type ActRequest struct {
	Report   string `json:"report"`
	Action   string `json:"action"`
	Reason   string `json:"reason,omitempty"`
	Days     int    `json:"days,omitempty"`
	Line     uint64 `json:"line,omitempty"`
	At       string `json:"at,omitempty"`
	Referred string `json:"referred,omitempty"`
	Rule     string `json:"rule,omitempty"`
	Note     string `json:"note,omitempty"`
	Check    bool   `json:"check,omitempty"`
}

// actOnReport does an action on a report.
//
//	POST /owner/api/reports/act {"report", "action": "mute-chat", "days": 7, "reason", "note", "check": true}
func (o *Owner) actOnReport(w http.ResponseWriter, r *http.Request) {
	var req ActRequest
	if !readBody(w, r, &req) {
		return
	}
	if o.cfg.Reports == nil {
		o.refuse(w, "report", http.StatusServiceUnavailable, "reports are not running")
		return
	}
	id, ok := parseAccount(req.Report)
	if !ok {
		o.refuse(w, "report", http.StatusBadRequest, "report: a report's ID")
		return
	}
	var at time.Time
	if req.At != "" {
		var err error
		if at, err = time.Parse(time.RFC3339Nano, req.At); err != nil {
			o.refuse(w, "report", http.StatusBadRequest, "at: when the line was said, as report.json has it")
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), dbTimeout)
	defer cancel()
	d, err := o.cfg.Reports.Do(ctx, review.Act{
		Report: store.ReportID(id), Action: req.Action, Reason: req.Reason, Days: req.Days, Line: req.Line, LineAt: at,
		Referred: req.Referred, Rule: req.Rule, Note: req.Note, Source: sourceOf(r), From: r.RemoteAddr, Check: req.Check,
	})
	switch {
	case errors.Is(err, store.ErrNotFound):
		o.refuse(w, "report", http.StatusNotFound, "no such report")
		return
	case errors.Is(err, review.ErrAction), errors.Is(err, review.ErrNoOne), errors.Is(err, review.ErrLine):
		o.refuse(w, "report", http.StatusBadRequest, err.Error())
		return
	case err != nil:
		o.refuse(w, "report", http.StatusConflict, err.Error())
		return
	}
	if d.Done {
		o.count("report-" + req.Action)
		o.cfg.Log.Info("owner: acted on a report", "action", req.Action, "report", req.Report, "from", r.RemoteAddr)
	}
	writeJSON(w, d)
}
