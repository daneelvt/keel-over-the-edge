// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/daneelvt/keel-over-the-edge/internal/review"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// fakeReports is the reports' queue and the owner's hand on it in
// memory: the queue as given, the reports by ID, each action asked, and
// an error to answer the next.
type fakeReports struct {
	mu      sync.Mutex
	queue   []store.QueueItem
	reports map[store.ReportID]store.Report
	acts    []review.Act
	err     error
}

func (f *fakeReports) Queue(context.Context) ([]store.QueueItem, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.queue, f.err
}

func (f *fakeReports) Read(_ context.Context, id store.ReportID) (store.Report, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	r, ok := f.reports[id]
	if !ok {
		return store.Report{}, store.ErrNotFound
	}
	return r, nil
}

func (f *fakeReports) Do(_ context.Context, a review.Act) (review.Done, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.acts = append(f.acts, a)
	if f.err != nil {
		return review.Done{}, f.err
	}
	if _, ok := f.reports[a.Report]; !ok {
		return review.Done{}, store.ErrNotFound
	}
	verb := "Would"
	if !a.Check {
		verb = "Did"
	}
	return review.Done{Action: a.Action, Done: !a.Check, Words: verb + " " + a.Action + "."}, nil
}

func reportID(n byte) store.ReportID { return store.ReportID{0x02, 0x77, 15: n} }

// reportsRig is the owner's tools with two reports: a child's safety,
// on a machine sailor, holding two lines and an answer; and a notice.
func reportsRig(t *testing.T) (*rig, *fakeReports) {
	t.Helper()
	r := newRig(t, 0)
	made := time.Date(2026, 11, 9, 8, 30, 0, 0, time.UTC)
	f := &fakeReports{
		queue: []store.QueueItem{
			{ID: reportID(1), Made: made, Source: store.ReportByPlayer, Reason: store.ReasonChild, ReporterName: "Ann Bonny",
				ReportedName: "Iron Mary", ReportedKind: string(store.AI), Place: "aboard Ann Bonny’s boat", Reports: 2, Urgent: true, Lines: 2, Answers: 1},
			{ID: reportID(2), Made: made.Add(time.Hour), Source: store.ReportByNotice, Reason: store.ReasonScam, ReportedName: "Calico Jack", Reports: 1},
		},
		reports: map[store.ReportID]store.Report{
			reportID(1): {
				ID: reportID(1), Made: made, Source: store.ReportByPlayer, Reason: store.ReasonChild, Note: "<b>asked her age</b>",
				Reporter: store.AccountID(account(1)), HasReporter: true, ReporterName: "Ann Bonny",
				Reported: store.AccountID(account(3)), HasReported: true, ReportedKind: string(store.AI), ReportedName: "Iron Mary",
				Owner: store.AccountID(account(2)), HasOwner: true, Place: "aboard Ann Bonny’s boat",
				People:      []store.ReportPerson{{Name: "Ann Bonny", Band: "13-17", Skipper: true}, {Name: "Iron Mary", Band: "adult", Machine: true}},
				FollowUntil: time.Now().Add(5 * time.Minute),
				Lines: []store.ReportLine{
					{Line: 7, At: made.Add(-time.Minute), Name: "Iron Mary", Machine: true, Text: "how old are you", Reported: true},
					{Line: 9, At: made.Add(30 * time.Second), Name: "Ann Bonny", Text: "<script>no</script>"},
				},
				Notes: []store.ReportNote{{At: made.Add(2 * time.Hour), By: "player", Text: "a misunderstanding"}},
			},
			reportID(2): {
				ID: reportID(2), Made: made.Add(time.Hour), Source: store.ReportByNotice, Reason: store.ReasonScam, ReportedName: "Calico Jack",
				FollowUntil: time.Now().Add(-time.Minute), HeldUntil: made.Add(365 * 24 * time.Hour), Referred: "the police, 123",
				Notice: &store.Notice{Who: "a parent", Contact: "a@example.com", Sailor: "Calico Jack", Happened: "Sunday", Reason: store.ReasonScam, What: "asked for money"},
			},
		},
	}
	r.o.cfg.Reports = f
	return r, f
}

// TestReports: the queue as the page reads it, a child's safety marked; a
// report whole, its lines in order and their text as said; a report
// nobody holds, or an ID that is none.
func TestReports(t *testing.T) {
	r, _ := reportsRig(t)
	code, body := r.do(t, "GET", "/owner/api/reports.json", nil)
	var rows []QueueRow
	if code != 200 || json.Unmarshal(body, &rows) != nil || len(rows) != 2 {
		t.Fatalf("reports.json: %d %s", code, body)
	}
	want := QueueRow{ID: store.AccountID(reportID(1)).String(), Made: "2026-11-09T08:30:00Z", Source: "player", Reason: "child",
		Reporter: "Ann Bonny", Reported: "Iron Mary", Machine: true, Place: "aboard Ann Bonny’s boat", Reports: 2, Urgent: true, Lines: 2, Answered: true}
	if rows[0] != want {
		t.Fatalf("the first row:\n%+v\nnot\n%+v", rows[0], want)
	}
	if rows[1].Machine || rows[1].Urgent || rows[1].Answered || rows[1].Reporter != "" || rows[1].Source != "notice" {
		t.Fatalf("the notice's row: %+v", rows[1])
	}

	code, body = r.do(t, "GET", "/owner/api/report.json?id="+store.AccountID(reportID(1)).String(), nil)
	var rep ReportJSON
	if code != 200 || json.Unmarshal(body, &rep) != nil {
		t.Fatalf("report.json: %d %s", code, body)
	}
	if rep.Account != store.AccountID(account(3)).String() || rep.Owner != store.AccountID(account(2)).String() || !rep.Machine ||
		rep.Taking == "" || rep.Note != "<b>asked her age</b>" || len(rep.People) != 2 || rep.People[0].Band != "13-17" || rep.Notice != nil {
		t.Fatalf("the report: %+v", rep)
	}
	if len(rep.Lines) != 2 || !rep.Lines[0].Reported || rep.Lines[0].At != "2026-11-09T08:29:00Z" || rep.Lines[1].Text != "<script>no</script>" ||
		rep.Lines[1].Reported || !rep.Lines[0].Machine {
		t.Fatalf("the lines: %+v", rep.Lines)
	}
	if len(rep.Notes) != 1 || rep.Notes[0].By != "player" || strings.Join(rep.Actions, ",") != strings.Join(review.Actions, ",") || len(rep.Days) != 3 {
		t.Fatalf("the notes and actions: %+v %v %v", rep.Notes, rep.Actions, rep.Days)
	}
	// The JSON escapes markup; the page shows it as text.
	if strings.Contains(string(body), "<script>") {
		t.Fatalf("markup unescaped: %s", body)
	}

	code, body = r.do(t, "GET", "/owner/api/report.json?id="+store.AccountID(reportID(2)).String(), nil)
	rep = ReportJSON{}
	if code != 200 || json.Unmarshal(body, &rep) != nil {
		t.Fatalf("the notice: %d %s", code, body)
	}
	if rep.Taking != "" || rep.Account != "" || rep.Owner != "" || rep.Held == "" || rep.Referred != "the police, 123" ||
		rep.Notice == nil || rep.Notice.Contact != "a@example.com" || rep.Lines == nil || rep.Notes == nil || rep.People == nil {
		t.Fatalf("the notice: %+v", rep)
	}
	if !strings.Contains(string(body), `"lines":[]`) || !strings.Contains(string(body), `"people":[]`) {
		t.Fatalf("empty lists as null: %s", body)
	}

	for path, want := range map[string]int{
		"/owner/api/report.json?id=" + store.AccountID(reportID(9)).String(): 404,
		"/owner/api/report.json?id=nine":                                     400,
		"/owner/api/report.json":                                             400,
	} {
		if code, _ := r.do(t, "GET", path, nil); code != want {
			t.Errorf("%s: %d, not %d", path, code, want)
		}
	}
}

// TestReportsAct: an action checked does nothing and is not counted; done,
// it is counted and recorded with where it came from; the line's time is
// read as report.json gives it; what the reports refuse is told.
func TestReportsAct(t *testing.T) {
	r, f := reportsRig(t)
	id := store.AccountID(reportID(1)).String()
	act := func(req ActRequest) (int, review.Done, string) {
		t.Helper()
		code, body := r.do(t, "POST", "/owner/api/reports/act", req)
		var d review.Done
		if code == 200 {
			if err := json.Unmarshal(body, &d); err != nil {
				t.Fatalf("%s: %v", body, err)
			}
		}
		return code, d, strings.TrimSpace(string(body))
	}
	code, d, _ := act(ActRequest{Report: id, Action: review.MuteChat, Days: 7, Reason: "asked a child's age", Note: "the age", Check: true})
	if code != 200 || d.Done || d.Words != "Would mute-chat." {
		t.Fatalf("checked: %d %+v", code, d)
	}
	a := f.acts[0]
	if !a.Check || a.Report != reportID(1) || a.Days != 7 || a.Reason != "asked a child's age" || a.Note != "the age" || a.Source != store.SourcePage {
		t.Fatalf("the act checked: %+v", a)
	}
	if got := testutil.ToFloat64(r.metrics.OwnerActions.WithLabelValues("report-mute-chat")); got != 0 {
		t.Fatalf("a check counted: %v", got)
	}

	// A line removed, from the command, at the time report.json gave.
	req := httptest.NewRequest("POST", "http://localhost:9090/owner/api/reports/act",
		strings.NewReader(`{"report":"`+id+`","action":"remove-line","line":7,"at":"2026-11-09T08:29:00Z"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(SourceHeader, store.SourceCommand)
	rec := httptest.NewRecorder()
	r.h.ServeHTTP(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"done":true`) {
		t.Fatalf("remove-line: %d %s", rec.Code, rec.Body)
	}
	a = f.acts[1]
	if a.Check || a.Line != 7 || !a.LineAt.Equal(time.Date(2026, 11, 9, 8, 29, 0, 0, time.UTC)) || a.Source != store.SourceCommand {
		t.Fatalf("the line's act: %+v", a)
	}
	if got := testutil.ToFloat64(r.metrics.OwnerActions.WithLabelValues("report-remove-line")); got != 1 {
		t.Fatalf("remove-line counted %v", got)
	}

	n := len(f.acts)
	for _, c := range []struct {
		req  ActRequest
		code int
	}{
		{ActRequest{Report: "nine", Action: review.Dismiss}, 400},
		{ActRequest{Report: id, Action: review.RemoveLine, Line: 7, At: "yesterday"}, 400},
	} {
		if code, _, body := act(c.req); code != c.code {
			t.Errorf("%+v: %d %s", c.req, code, body)
		}
	}
	if len(f.acts) != n {
		t.Fatalf("a refused act reached the reports: %+v", f.acts[n:])
	}
	if code, _, _ := act(ActRequest{Report: store.AccountID(reportID(9)).String(), Action: review.Dismiss}); code != 404 {
		t.Errorf("no such report: %d", code)
	}
	for err, want := range map[error]int{
		review.ErrAction:                  400,
		review.ErrNoOne:                   400,
		review.ErrLine:                    400,
		errors.New("the account is held"): 409,
	} {
		f.err = err
		if code, _, body := act(ActRequest{Report: id, Action: review.Warn}); code != want || !strings.Contains(body, err.Error()) {
			t.Errorf("%v: %d %s", err, code, body)
		}
	}
	f.err = nil
	if got := testutil.ToFloat64(r.metrics.OwnerRefused.WithLabelValues("report")); got != 7 {
		t.Errorf("refusals counted %v", got)
	}

	// Without reports, nothing is served.
	r.o.cfg.Reports = nil
	for _, path := range []string{"/owner/api/reports.json", "/owner/api/report.json?id=" + id} {
		if code, _ := r.do(t, "GET", path, nil); code != 503 {
			t.Errorf("%s not running: %d", path, code)
		}
	}
	if code, _, _ := act(ActRequest{Report: id, Action: review.Dismiss}); code != 503 {
		t.Errorf("act, not running: %d", code)
	}
}

// TestReportsGuarded: the reports are the guard's, off this computer and
// from another site.
func TestReportsGuarded(t *testing.T) {
	r, f := reportsRig(t)
	req := httptest.NewRequest("GET", "http://x/owner/api/reports.json", nil)
	req.Host = "keel.example:9090"
	rec := httptest.NewRecorder()
	r.h.ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Fatalf("off this computer: %d", rec.Code)
	}
	req = httptest.NewRequest("POST", "http://localhost:9090/owner/api/reports/act",
		strings.NewReader(`{"report":"`+store.AccountID(reportID(1)).String()+`","action":"dismiss"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	rec = httptest.NewRecorder()
	r.h.ServeHTTP(rec, req)
	if rec.Code != 403 || len(f.acts) != 0 {
		t.Fatalf("from another site: %d %+v", rec.Code, f.acts)
	}
}
