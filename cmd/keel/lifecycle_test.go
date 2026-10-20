// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/sim/loop"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
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

// TestBeginNextByHand: the world page's "Begin the next world now" ends the
// world in about a second and begins the next, made first, in the running
// process; the next world's end is the schedule's.
func TestBeginNextByHand(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		db := &memDB{epoch: bubbleEpoch}
		s, token := gameServer(t, map[string]string{}, db)
		_, in, _ := connect(t, s, token)
		heardCh := make(chan heard, 1)
		go func() { heardCh <- listen(in) }()
		code, body := postJSON(t, s, "http://127.0.0.1:9090/owner/api/world", `{"number":1}`)
		if code != 202 {
			t.Fatalf("begin the next world: %d %s", code, body)
		}
		h := <-heardCh
		if h.code != edge.CloseWorldEnded {
			t.Fatalf("closed with %d", h.code)
		}
		time.Sleep(time.Second)
		w, _ := db.ActiveOrFirstWorld(t.Context(), time.Time{})
		if w.Number != 2 || w.EndsAt.IsZero() {
			t.Fatalf("the world after: %+v", w)
		}
		if !weekFor(t, db, w.ID, w.Epoch, w.EndsAt) {
			t.Fatal("the world begun by hand has not its week made again for when it began")
		}
		if code, _ := postJSON(t, s, "http://127.0.0.1:9090/owner/api/world", `{"number":1}`); code != 400 {
			t.Fatalf("the old world's number again: %d", code)
		}
		ws, _, welcome := connect(t, s, token)
		defer ws.CloseNow()
		if welcome.GetEpochUs() != w.Epoch.UnixMicro() {
			t.Fatalf("welcomed into the world of epoch %d", welcome.GetEpochUs())
		}
		s.stop(t)
	})
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
