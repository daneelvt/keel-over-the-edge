// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/api"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/edge/edgetest"
	"github.com/daneelvt/keel-over-the-edge/internal/owner"
	"github.com/daneelvt/keel-over-the-edge/internal/sim/loop"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// minutes is a schedule of worlds four minutes long, from the bubble's
// clock's start: closing two minutes before the end, the next world made a
// minute before.
const minutes = "every=4m from=2000-01-01T00:00:00Z notice=2m ahead=1m"

// TestWorldOfMinutes: a world's life on a schedule of minutes. Begun, it
// gets the schedule's end; the news tells of it as it closes; the next
// world is made ahead; at the end's tick the falls take the boat afloat,
// the connection is closed with 4004, and the next world begins in the
// running process at that tick's time, with the next end; a connection
// again is welcomed into it.
func TestWorldOfMinutes(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		db := &memDB{epoch: bubbleEpoch}
		s, token := gameServer(t, map[string]string{"KEEL_WORLD_SCHEDULE": minutes}, db)
		end := bubbleEpoch.Add(4 * time.Minute)
		if w, _ := db.ActiveOrFirstWorld(t.Context(), time.Time{}); !w.EndsAt.Equal(end) {
			t.Fatalf("the first world ends at %v, not %v", w.EndsAt, end)
		}
		time.Sleep(time.Until(bubbleEpoch.Add(2*time.Minute + 10*time.Second)))
		db.mu.Lock()
		news := append([]store.WorldNews(nil), db.news...)
		db.mu.Unlock()
		if len(news) != 1 || !news[0].EndsAt.Equal(end) || news[0].Column != worldColumn(testCatalog(t)) {
			t.Fatalf("the news as the world closes: %+v", news)
		}
		if got := db.run(jobClosing, end.Add(-2*time.Minute)); got != store.JobOK {
			t.Fatalf("the closing's run: %q", got)
		}
		// The first world, which had none, has its week, made as it opened.
		if w, _ := db.ActiveOrFirstWorld(t.Context(), time.Time{}); !weekFor(t, db, w.ID, w.Epoch, end) {
			t.Fatal("the first world has no week made for its epoch and end")
		}
		time.Sleep(time.Until(bubbleEpoch.Add(3*time.Minute + 10*time.Second)))
		if nw, err := db.NextWorld(t.Context()); err != nil || !nw.Stored || nw.Number != 2 {
			t.Fatalf("the next world a minute before the end: %+v %v", nw, err)
		} else if !weekFor(t, db, nw.ID, end, end.Add(4*time.Minute)) {
			t.Fatal("the next world's week is not made with it for when it is planned to begin")
		}
		// A sailor connects, within the connection's idle limit of the end.
		time.Sleep(time.Until(end.Add(-20 * time.Second)))
		_, in, welcome := connect(t, s, token)
		if welcome.GetEndsUs() != end.UnixMicro() {
			t.Fatalf("the welcome says the world ends at %d", welcome.GetEndsUs())
		}
		heardCh := make(chan heard, 1)
		go func() { heardCh <- listen(in) }()

		h := <-heardCh
		if h.code != edge.CloseWorldEnded {
			t.Fatalf("closed with %d", h.code)
		}
		endTick := loop.TickAt(end, bubbleEpoch)
		if h.last.Tick > endTick || h.last.Tick < endTick-3 || h.closed.Before(end) || h.closed.Sub(end) > time.Second {
			t.Fatalf("the last snapshot of tick %d, the end's %d; closed %v after the end", h.last.Tick, endTick, h.closed.Sub(end))
		}
		time.Sleep(time.Second)
		w, _ := db.ActiveOrFirstWorld(t.Context(), time.Time{})
		if w.Number != 2 || !w.Epoch.Equal(end) || !w.EndsAt.Equal(end.Add(4*time.Minute)) {
			t.Fatalf("the world after the end: %+v", w)
		}
		if !weekFor(t, db, w.ID, end, end.Add(4*time.Minute)) {
			t.Fatal("the world begun at its planned time has not the week made for it")
		}
		if strings.Contains(s.logs.String(), "its week is made again") {
			t.Fatal("the week of a world begun on time was made again")
		}
		_, events, _ := db.state()
		var taken int
		for _, e := range events {
			if e.Kind == store.EventTaken && e.Tick == endTick {
				taken++
			}
		}
		if taken != 1 {
			t.Fatalf("%d boats taken by the falls at the end's tick: %+v", taken, events)
		}
		if got := db.run(jobSwitch, end); got != store.JobOK {
			t.Fatalf("the switch's run: %q", got)
		}
		ws, _, again := connect(t, s, token)
		defer ws.CloseNow()
		if again.GetWorld() == welcome.GetWorld() || again.GetEpochUs() != end.UnixMicro() || again.GetEndsUs() != end.Add(4*time.Minute).UnixMicro() {
			t.Fatalf("welcomed again into world %s, epoch %d, ends %d", again.GetWorld(), again.GetEpochUs(), again.GetEndsUs())
		}
		if wt := again.GetWorldTimeUs(); wt < 0 || wt > (5*time.Second).Microseconds() {
			t.Fatalf("the new world's time %d µs", wt)
		}
		logs := s.logs.String()
		if !strings.Contains(logs, `"how":"scheduled"`) {
			t.Fatal("the logs lack the switch")
		}
		s.stop(t)
	})
}

// TestLateEnd: keel started after its world's end, with no next world
// stored, makes it and switches to it before anyone is let in; the new
// world ends at the schedule's end at least ahead from its beginning, and
// the missed ends are one switch.
func TestLateEnd(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		db := &memDB{epoch: bubbleEpoch, begins: bubbleEpoch, ends: bubbleEpoch.Add(-25 * time.Minute)}
		s, token := gameServer(t, map[string]string{"KEEL_WORLD_SCHEDULE": minutes}, db)
		w, _ := db.ActiveOrFirstWorld(t.Context(), time.Time{})
		started := bubbleEpoch
		if w.Number != 2 || db.switches != 1 || w.BeginsAt.Before(started) || !w.EndsAt.Equal(bubbleEpoch.Add(4*time.Minute)) {
			t.Fatalf("the world sailed: %+v after %d switches", w, db.switches)
		}
		if got := db.run(jobSwitch, bubbleEpoch.Add(-25*time.Minute)); got != store.JobOK {
			t.Fatalf("the late switch's run: %q", got)
		}
		if !weekFor(t, db, w.ID, w.Epoch, w.EndsAt) {
			t.Fatal("the world begun late has not its week made again for when it began")
		}
		ws, _, welcome := connect(t, s, token)
		defer ws.CloseNow()
		if welcome.GetEpochUs() != w.Epoch.UnixMicro() {
			t.Fatalf("welcomed into the world of epoch %d", welcome.GetEpochUs())
		}
		s.stop(t)
	})
}

// sundayEnd is the first world's end on the weekly schedule, from the
// bubble's start on a Friday at 7 pm in New York: Sunday 2 January 2000 at
// 6 pm there.
var sundayEnd = time.Date(2000, 1, 2, 23, 0, 0, 0, time.UTC)

// TestBeginByHandKeepsTheSchedule: the world page's "Begin the next world
// now" ends the world in about a second and begins the next, made first,
// in the running process; the new world ends when the old one would have,
// on the published Sunday, and says so in its Welcome and its status; it
// is closing from its start, told in the news at once; its week is made
// for its own beginning and end; and its next world waits for the day
// before the end. A making asked during the switch is refused. Begun by
// hand again, the next world too ends that Sunday, with its own runs.
func TestBeginByHandKeepsTheSchedule(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		db := &memDB{epoch: bubbleEpoch}
		s, token := gameServer(t, map[string]string{}, db)
		if w, _ := db.ActiveOrFirstWorld(t.Context(), time.Time{}); !w.EndsAt.Equal(sundayEnd) {
			t.Fatalf("the first world ends at %v, not %v", w.EndsAt, sundayEnd)
		}
		_, in, _ := connect(t, s, token)
		heardCh := make(chan heard, 1)
		go func() { heardCh <- listen(in) }()
		code, body := postJSON(t, s, internalURL+"/owner/api/world", `{"number":1}`)
		if code != 202 || !strings.Contains(body, fmt.Sprintf(`"ends":%d`, sundayEnd.UnixMilli())) {
			t.Fatalf("begin the next world: %d %s", code, body)
		}
		if code, body := postJSON(t, s, internalURL+"/owner/api/next", `{"number":2}`); code != 409 {
			t.Errorf("a next world made during the switch: %d %s", code, body)
		}
		h := <-heardCh
		if h.code != edge.CloseWorldEnded {
			t.Fatalf("closed with %d", h.code)
		}
		time.Sleep(2 * time.Second)
		w, _ := db.ActiveOrFirstWorld(t.Context(), time.Time{})
		if w.Number != 2 || !w.EndsAt.Equal(sundayEnd) {
			t.Fatalf("the world after: %+v", w)
		}
		if !weekFor(t, db, w.ID, w.Epoch, sundayEnd) {
			t.Fatal("the world begun by hand has not its week made for its beginning and its end")
		}
		if got := db.run(jobClosing, w.BeginsAt.Truncate(time.Microsecond)); got != store.JobOK {
			t.Errorf("the closing's run as the world began: %q", got)
		}
		if !toldClosing(db, 2) {
			t.Error("the news does not tell world 2's end")
		}
		var st api.Status
		getJSON(t, s, "http://127.0.0.1:8080/api/status", &st)
		if st.World != 2 || st.EndsAt != sundayEnd.Format(time.RFC3339) || !st.Closing {
			t.Errorf("the status: %+v", st)
		}
		var lc owner.Lifecycle
		getJSON(t, s, internalURL+"/owner/api/lifecycle.json", &lc)
		if lc.Next != nil || lc.NextMadeAt != sundayEnd.Add(-24*time.Hour).UnixMilli() || !lc.Closing {
			t.Errorf("the next world, more than a day before the end: %+v, made at %d", lc.Next, lc.NextMadeAt)
		}
		if code, _ := postJSON(t, s, internalURL+"/owner/api/world", `{"number":1}`); code != 409 {
			t.Fatalf("the old world's number again: %d", code)
		}
		ws, _, welcome := connect(t, s, token)
		if welcome.GetEpochUs() != w.Epoch.UnixMicro() || welcome.GetEndsUs() != sundayEnd.UnixMicro() ||
			welcome.GetClosingUs() > w.Epoch.UnixMicro() {
			t.Fatalf("welcomed into the world of epoch %d, ending %d, closing from %d", welcome.GetEpochUs(), welcome.GetEndsUs(), welcome.GetClosingUs())
		}
		ws.CloseNow()

		time.Sleep(10 * time.Second)
		if code, body := postJSON(t, s, internalURL+"/owner/api/world", `{"number":2}`); code != 202 {
			t.Fatalf("begin world 3: %d %s", code, body)
		}
		time.Sleep(3 * time.Second)
		w3, _ := db.ActiveOrFirstWorld(t.Context(), time.Time{})
		if w3.Number != 3 || !w3.EndsAt.Equal(sundayEnd) {
			t.Fatalf("the world begun by hand again: %+v", w3)
		}
		if got := db.run(jobClosing, w3.BeginsAt.Truncate(time.Microsecond)); got != store.JobOK || !toldClosing(db, 3) {
			t.Errorf("world 3's closing: run %q", got)
		}
		if n := strings.Count(s.logs.String(), `"how":"by_hand"`); n != 2 {
			t.Errorf("%d switches by hand logged", n)
		}
		s.stop(t)
	})
}

// TestWorldBegunInItsLastDay: a world in its last day makes its next world
// as it begins; begun by hand, the next world made is the one sailed, and
// the new world, begun inside its last day too, makes its own next world
// at once, and only once.
func TestWorldBegunInItsLastDay(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		end := bubbleEpoch.Add(20 * time.Hour)
		db := &memDB{epoch: bubbleEpoch, begins: bubbleEpoch, ends: end}
		s, _ := gameServer(t, map[string]string{}, db)
		time.Sleep(2 * time.Second)
		nw, err := db.NextWorld(t.Context())
		if err != nil || !nw.Stored || nw.Number != 2 || db.run(jobNextWorld, bubbleEpoch) != store.JobOK {
			t.Fatalf("the next world of a world in its last day: %+v %v", nw, err)
		}
		if code, body := postJSON(t, s, internalURL+"/owner/api/world", `{"number":1}`); code != 202 {
			t.Fatalf("begin the next world: %d %s", code, body)
		}
		time.Sleep(3 * time.Second)
		w, _ := db.ActiveOrFirstWorld(t.Context(), time.Time{})
		if seed, _, _, _ := db.WorldSeed(t.Context(), w.ID); w.Number != 2 || seed != nw.Seed || !w.EndsAt.Equal(end) {
			t.Fatalf("the world begun: %+v, seed %d, not the next world made, %d", w, seed, nw.Seed)
		}
		due := w.BeginsAt.Truncate(time.Microsecond)
		next, err := db.NextWorld(t.Context())
		if err != nil || !next.Stored || next.Number != 3 || db.run(jobNextWorld, due) != store.JobOK {
			t.Fatalf("world 2's next world, at once: %+v %v, its run %q", next, err, db.run(jobNextWorld, due))
		}
		time.Sleep(2 * time.Minute)
		if again, _ := db.NextWorld(t.Context()); again.Seed != next.Seed || len(db.runsOf(jobNextWorld)) != 2 {
			t.Fatalf("world 3 made again: %+v; runs %v", again, db.runsOf(jobNextWorld))
		}
		s.stop(t)
	})
}

// TestByHandNotInTheLastMinutes: in a world's last ten minutes, as the
// scheduled switch prepares, no next world is made or begun by hand.
func TestByHandNotInTheLastMinutes(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		end := bubbleEpoch.Add(9 * time.Minute)
		db := &memDB{epoch: bubbleEpoch, begins: bubbleEpoch, ends: end}
		s, _ := gameServer(t, map[string]string{}, db)
		for path, body := range map[string]string{"world": `{"number":1}`, "next": `{"number":2}`} {
			if code, why := postJSON(t, s, internalURL+"/owner/api/"+path, body); code != 409 || !strings.Contains(why, "too near") {
				t.Errorf("%s in the last minutes: %d %s", path, code, why)
			}
		}
		var lc owner.Lifecycle
		getJSON(t, s, internalURL+"/owner/api/lifecycle.json", &lc)
		if lc.RemakeUntil != end.Add(-10*time.Minute).UnixMilli() {
			t.Errorf("made or begun by hand until %d", lc.RemakeUntil)
		}
		s.stop(t)
	})
}

// TestMakeNextByHand: with no next world, the world page makes one, stored
// and recorded as made by hand, and the next world's job then finds it
// made; made again, it is replaced under the same number from another
// seed. The lifecycle names the generator each is made by.
func TestMakeNextByHand(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		end := bubbleEpoch.Add(24*time.Hour + 2*time.Minute)
		db := &memDB{epoch: bubbleEpoch, begins: bubbleEpoch, ends: end}
		s, _ := gameServer(t, map[string]string{}, db)
		if code, body := postJSON(t, s, internalURL+"/owner/api/next", `{"number":3}`); code != 409 {
			t.Errorf("another number: %d %s", code, body)
		}
		code, body := postJSON(t, s, internalURL+"/owner/api/next", `{"number":2}`)
		if code != 202 || !strings.Contains(body, `"discarding":false`) {
			t.Fatalf("make the next world: %d %s", code, body)
		}
		time.Sleep(2 * time.Second)
		first, err := db.NextWorld(t.Context())
		if err != nil || !first.Stored || first.Number != 2 {
			t.Fatalf("the next world made by hand: %+v %v", first, err)
		}
		runs := db.runsOf(jobNextWorld)
		if len(runs) != 1 || runs[0].outcome != store.JobOK || !strings.HasPrefix(runs[0].detail, "by hand: world 2 made") {
			t.Fatalf("the runs: %+v", runs)
		}
		var lc owner.Lifecycle
		getJSON(t, s, internalURL+"/owner/api/lifecycle.json", &lc)
		if lc.Next == nil || lc.Next.Generator != worldgen.Version || lc.Generator != worldgen.Version || lc.Making {
			t.Errorf("the lifecycle: %+v, next %+v", lc, lc.Next)
		}
		code, body = postJSON(t, s, internalURL+"/owner/api/next", `{"number":2}`)
		if code != 202 || !strings.Contains(body, `"discarding":true`) {
			t.Fatalf("make it again: %d %s", code, body)
		}
		time.Sleep(2 * time.Second)
		second, err := db.NextWorld(t.Context())
		if err != nil || !second.Stored || second.Number != 2 || second.Seed == first.Seed {
			t.Fatalf("the next world made again: %+v %v; the first's seed %d", second, err, first.Seed)
		}
		time.Sleep(time.Until(end.Add(-24*time.Hour + 10*time.Second)))
		if got := db.run(jobNextWorld, end.Add(-24*time.Hour)); got != store.JobSkipped {
			t.Errorf("the job a day before the end: %q", got)
		}
		if again, _ := db.NextWorld(t.Context()); again.Seed != second.Seed {
			t.Error("the job made the next world again")
		}
		logs := s.logs.String()
		for _, want := range []string{`"action":"make"`, `"action":"remake"`} {
			if !strings.Contains(logs, want) {
				t.Errorf("the logs lack %s", want)
			}
		}
		s.stop(t)
	})
}

// TestMakeNextWhileTheJobMakesIt: asked for while the next world's job is
// making it, the new next world waits for the job's to be stored, then
// replaces it; nothing fails.
func TestMakeNextWhileTheJobMakesIt(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		db := &memDB{epoch: bubbleEpoch, begins: bubbleEpoch, ends: bubbleEpoch.Add(20 * time.Hour), sessions: edgetest.NewSessions()}
		var made atomic.Int32
		slow := func(seed uint64) (*worldgen.Bundle, error) {
			if made.Add(1) > 1 {
				time.Sleep(30 * time.Second)
			}
			return emptyWorld(seed)
		}
		s := startServer(t, map[string]string{}, newMemNet(), db.with(serveOptions{generate: slow}))
		time.Sleep(5 * time.Second)
		jobs, err := db.NextWorld(t.Context())
		if err != nil || jobs.Stored {
			t.Fatalf("the job's next world, being made: %+v %v", jobs, err)
		}
		code, body := postJSON(t, s, internalURL+"/owner/api/next", `{"number":2}`)
		if code != 202 || !strings.Contains(body, `"discarding":true`) {
			t.Fatalf("make the next world: %d %s", code, body)
		}
		var lc owner.Lifecycle
		getJSON(t, s, internalURL+"/owner/api/lifecycle.json", &lc)
		if !lc.Making {
			t.Error("the lifecycle does not say a world is being made")
		}
		if code, body := postJSON(t, s, internalURL+"/owner/api/world", `{"number":1}`); code != 409 {
			t.Errorf("begun while made by hand: %d %s", code, body)
		}
		time.Sleep(70 * time.Second)
		nw, err := db.NextWorld(t.Context())
		if err != nil || !nw.Stored || nw.Seed == jobs.Seed || made.Load() != 3 {
			t.Fatalf("the next world: %+v %v, the job's seed %d; %d made", nw, err, jobs.Seed, made.Load())
		}
		for _, r := range db.runsOf(jobNextWorld) {
			if r.outcome != store.JobOK {
				t.Errorf("a run: %+v", r)
			}
		}
		if got := db.run(jobNextWorld, bubbleEpoch); got != store.JobOK {
			t.Errorf("the job's run: %q", got)
		}
		s.stop(t)
	})
}

// TestDueOf: a world's jobs fall due their time before its end, or as it
// began if that is later.
func TestDueOf(t *testing.T) {
	end := time.Date(2026, 11, 1, 23, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		before, notice time.Duration
		want           time.Time
	}{
		{7 * 24 * time.Hour, 72 * time.Hour, end.Add(-72 * time.Hour)},                                     // a week: as scheduled
		{4 * 24 * time.Hour, 72 * time.Hour, end.Add(-72 * time.Hour)},                                     // four days
		{50 * time.Hour, 72 * time.Hour, end.Add(-50 * time.Hour)},                                         // inside the notice: as it began
		{50 * time.Hour, 24 * time.Hour, end.Add(-24 * time.Hour)},                                         // the next world a day before
		{20*time.Hour + 1500*time.Nanosecond, 24 * time.Hour, end.Add(-20*time.Hour - 2*time.Microsecond)}, // to the database's µs
	} {
		h := &worldHalf{row: store.World{BeginsAt: end.Add(-tc.before)}}
		h.endsAt.Store(end.UnixNano())
		if got := dueOf(h, tc.notice); !got.Equal(tc.want) {
			t.Errorf("begun %v before the end, due %v before: %v, not %v", tc.before, tc.notice, got, tc.want)
		}
	}
}

// toldClosing reports whether the news tells of world n's end.
func toldClosing(db *memDB, n int) bool {
	db.mu.Lock()
	defer db.mu.Unlock()
	return slices.ContainsFunc(db.news, func(w store.WorldNews) bool { return w.Number == n })
}

// getJSON reads a JSON body from url through the server's network.
func getJSON(t *testing.T, s *server, url string, v any) {
	t.Helper()
	resp, err := s.client.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("GET %s: %d", url, resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		t.Fatal(err)
	}
}

// postJSON posts a body to url through the server's network.
func postJSON(t *testing.T, s *server, url, body string) (int, string) {
	t.Helper()
	resp, err := s.client.Post(url, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var b strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		b.Write(buf[:n])
		if err != nil {
			break
		}
	}
	return resp.StatusCode, b.String()
}

// testCatalog is the catalog.
func testCatalog(t *testing.T) *catalog.Catalog {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	return cat
}

// weekFor reports whether the world's week is stored, made for an epoch and
// an end, and reads back as a week.
func weekFor(t *testing.T, db *memDB, world [16]byte, epoch, ends time.Time) bool {
	t.Helper()
	sw, err := db.LoadWeather(t.Context(), world)
	if err != nil {
		return false
	}
	w, err := weather.Decode(sw.Records, sw.Digest)
	if err != nil {
		t.Fatal(err)
	}
	return sw.Epoch.Equal(epoch) && sw.Ends.Equal(ends) && w.Epoch == epoch.UnixMicro() && w.Ends == ends.UnixMicro()
}
