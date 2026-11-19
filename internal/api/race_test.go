// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/race"
)

// fakeRaces answers one race, "abcdefghij", whose entry is refused for the
// day, and records who asked.
type fakeRaces struct {
	asked []race.Sailor
	made  []race.Making
	hung  []bool
	runs  []int
}

var raceUntil = time.Date(2026, 11, 17, 16, 10, 0, 0, time.UTC)

func (f *fakeRaces) card(by race.Sailor, code string) (race.Card, error) {
	f.asked = append(f.asked, by)
	if code != "abcdefghij" {
		return race.Card{}, race.ErrNotFound
	}
	return race.Card{Code: code, Name: "Tuesday Triangle", Kind: race.KindRace, Phase: race.PhaseOpen, Entrants: []race.Entrant{}}, nil
}

func (f *fakeRaces) Board(_ context.Context, by race.Sailor) (race.Board, error) {
	f.asked = append(f.asked, by)
	return race.Board{Harbour: []race.Summary{}, Greenhorn: []int64{}, Mine: []race.Summary{}}, nil
}
func (f *fakeRaces) Card(_ context.Context, by race.Sailor, code string) (race.Card, error) {
	return f.card(by, code)
}
func (f *fakeRaces) Make(_ context.Context, by race.Sailor, m race.Making) (race.Card, error) {
	f.made = append(f.made, m)
	if m.Name == "x" {
		return race.Card{}, &race.Refusal{Reason: race.RefuseName, Name: "short"}
	}
	return f.card(by, "abcdefghij")
}
func (f *fakeRaces) SuggestName(string, string, time.Time) (string, error) {
	return "the Noon Gun", nil
}
func (f *fakeRaces) Enter(_ context.Context, by race.Sailor, code string, crew bool) (race.Card, error) {
	if _, err := f.card(by, code); err != nil {
		return race.Card{}, err
	}
	return race.Card{}, &race.Refusal{Reason: race.RefuseDaily, Until: raceUntil}
}
func (f *fakeRaces) Withdraw(_ context.Context, by race.Sailor, code string) (race.Card, error) {
	return f.card(by, code)
}
func (f *fakeRaces) Close(_ context.Context, by race.Sailor, code string) (race.Card, error) {
	return race.Card{}, race.ErrNotOwner
}
func (f *fakeRaces) Cancel(_ context.Context, by race.Sailor, code string) (race.Card, error) {
	return f.card(by, code)
}
func (f *fakeRaces) Remove(_ context.Context, by race.Sailor, code string, n int) (race.Card, error) {
	return f.card(by, code)
}
func (f *fakeRaces) Move(_ context.Context, by race.Sailor, code string, at time.Time) (race.Card, error) {
	return f.card(by, code)
}
func (f *fakeRaces) Again(_ context.Context, by race.Sailor, code string) (race.Card, error) {
	return race.Card{}, &race.Refusal{Reason: race.RefuseNotFinished}
}
func (f *fakeRaces) Calendar(_ context.Context, by race.Sailor, code string) ([]byte, string, error) {
	if _, err := f.card(by, code); err != nil {
		return nil, "", err
	}
	return []byte("BEGIN:VCALENDAR\r\n"), "Tuesday-Triangle.ics", nil
}

func (f *fakeRaces) Spoon(_ context.Context, by race.Sailor, code string, hang bool) error {
	if _, err := f.card(by, code); err != nil {
		return err
	}
	f.hung = append(f.hung, hang)
	return nil
}

func (f *fakeRaces) Replay(_ context.Context, by race.Sailor, code string, runs []int) (race.Replay, error) {
	if code == "racingnow2" {
		return race.Replay{}, race.ErrNotFinished
	}
	if _, err := f.card(by, code); err != nil {
		return race.Replay{}, err
	}
	f.runs = runs
	tr := &race.ReplayTrack{First: 100, Every: 60, P: make([]int32, 4000)}
	return race.Replay{Code: code, Name: "Tuesday Triangle", Kind: race.KindTrial, Kept: true,
		Runs: []race.ReplayRun{{Run: 1, Boats: []race.ReplayBoat{{Number: 1, Track: tr}}}}}, nil
}

// TestRacesBehindSession: every race route answers only a signed-in
// sailor, the card and the calendar file too; refusals carry their reason
// and when they end; a code no race has is not found; another's race is
// not the player's to close.
func TestRacesBehindSession(t *testing.T) {
	f := &fakeRaces{}
	srv := newAboardServer(t, func(c *Config) { c.Races = f })
	for _, r := range []struct{ method, path string }{
		{"GET", "/api/races"}, {"GET", "/api/race/abcdefghij"}, {"GET", "/api/race/abcdefghij/calendar.ics"},
		{"GET", "/api/race/name?course=island:3"}, {"POST", "/api/race"}, {"POST", "/api/race/abcdefghij/enter"},
		{"POST", "/api/race/abcdefghij/withdraw"}, {"POST", "/api/race/abcdefghij/cancel"},
		{"POST", "/api/race/abcdefghij/spoon"}, {"GET", "/api/race/abcdefghij/replay"},
	} {
		req, _ := http.NewRequest(r.method, srv.URL+r.path, nil)
		req.Header.Set("Origin", srv.URL)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s %s without a session: %d", r.method, r.path, res.StatusCode)
		}
	}
	if len(f.asked) != 0 {
		t.Fatalf("asked without a session: %v", f.asked)
	}
	ann, cookie := makeSailor(t, srv.testServer, "Ann Bonny")
	if status, body := ann.do("GET", "/api/race/abcdefghij", ""); status != 200 || !strings.Contains(body, `"name":"Tuesday Triangle"`) {
		t.Errorf("the card: %d %s", status, body)
	}
	if len(f.asked) != 1 || f.asked[0].ID != srv.idOf(t, "Ann Bonny") || f.asked[0].Machine {
		t.Errorf("asked as %+v", f.asked)
	}
	if status, body := ann.do("GET", "/api/race/nosuchrace", ""); status != 404 || strings.TrimSpace(body) != `{"error":"not-found"}` {
		t.Errorf("no such race: %d %s", status, body)
	}
	want := `{"error":"daily","until":` + strconv.FormatInt(raceUntil.UnixMilli(), 10) + `}`
	if status, body := ann.do("POST", "/api/race/abcdefghij/enter", `{"crew":true}`); status != 409 || strings.TrimSpace(body) != want {
		t.Errorf("entering at the day's limit: %d %s", status, body)
	}
	if status, _ := ann.do("POST", "/api/race/abcdefghij/enter", ""); status != 409 {
		t.Errorf("entering with no body: %d", status)
	}
	if status, body := ann.do("POST", "/api/race/abcdefghij/close", ""); status != 403 || strings.TrimSpace(body) != `{"error":"not-owner"}` {
		t.Errorf("closing another's race: %d %s", status, body)
	}
	if status, body := ann.do("POST", "/api/race", `{"kind":"race","course":"buoy:triangle:short","boat":"b","at":1,"who":"everyone","name":"x"}`); status != 409 ||
		strings.TrimSpace(body) != `{"error":"name","name":"short"}` {
		t.Errorf("a name refused: %d %s", status, body)
	}
	if status, _ := ann.do("POST", "/api/race", `{"kind":"race","course":"buoy:triangle:short","boat":"b","at":1,"who":"everyone"}`); status != 201 {
		t.Errorf("made: %d", status)
	}
	if status, _ := ann.do("POST", "/api/race/abcdefghij/again", ""); status != 409 {
		t.Errorf("again: %d", status)
	}
	if status, body := ann.do("POST", "/api/race/abcdefghij/spoon", `{"hang":true}`); status != 200 || strings.TrimSpace(body) != `{"hang":true}` {
		t.Errorf("the spoon hung: %d %s", status, body)
	}
	if status, _ := ann.do("POST", "/api/race/nosuchrace/spoon", `{"hang":true}`); status != 404 {
		t.Errorf("a spoon of no such race: %d", status)
	}
	if len(f.hung) != 1 || !f.hung[0] {
		t.Errorf("hung %v", f.hung)
	}
	if status, body := ann.do("GET", "/api/race/name?kind=race&course=island:3", ""); status != 200 || strings.TrimSpace(body) != `{"name":"the Noon Gun"}` {
		t.Errorf("a name: %d %s", status, body)
	}
	// The replay: gzipped, kept a while by the reader's browser, a
	// trial's runs asked for passed on.
	if status, body := ann.do("GET", "/api/race/abcdefghij/replay?runs=3,x,7,-1", ""); status != 200 || !strings.Contains(body, `"p":[0,0,`) ||
		len(f.runs) != 2 || f.runs[0] != 3 || f.runs[1] != 7 {
		t.Errorf("the replay: %d %.80s, runs %v", status, body, f.runs)
	}
	if status, body := ann.do("GET", "/api/race/racingnow2/replay", ""); status != 409 || strings.TrimSpace(body) != `{"error":"not-finished"}` {
		t.Errorf("a replay before the race is over: %d %s", status, body)
	}
	if status, _ := ann.do("GET", "/api/race/nosuchrace/replay", ""); status != 404 {
		t.Errorf("the replay of no such race: %d", status)
	}
	req, _ := http.NewRequest("GET", srv.URL+"/api/race/abcdefghij/replay", nil)
	req.AddCookie(cookie)
	req.Header.Set("Accept-Encoding", "gzip")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	zipped, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || res.Header.Get("Content-Encoding") != "gzip" || res.Header.Get("Cache-Control") != "private, max-age=60" ||
		len(zipped) > 1000 {
		t.Errorf("the replay's answer: %d %v, %d bytes", res.StatusCode, res.Header, len(zipped))
	}
	req, _ = http.NewRequest("GET", srv.URL+"/api/race/abcdefghij/calendar.ics", nil)
	req.AddCookie(cookie)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "text/calendar; charset=utf-8" ||
		res.Header.Get("Content-Disposition") != `attachment; filename="Tuesday-Triangle.ics"` {
		t.Errorf("the calendar file: %d %v", res.StatusCode, res.Header)
	}
}
