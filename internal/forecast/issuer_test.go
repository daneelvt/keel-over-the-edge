// SPDX-License-Identifier: AGPL-3.0-only

package forecast

import (
	"context"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

func timeline(t testing.TB) *weather.Timeline {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	tl, err := weather.FromCatalog(cat)
	if err != nil {
		t.Fatal(err)
	}
	return tl
}

const minute = 60 * physics.StepsPerSecond

// galeIssue is the first issue of the sample week with a gale warning in
// force, after its first.
func galeIssue(t testing.TB, tl *weather.Timeline) int64 {
	t.Helper()
	is := New(Config{Timeline: tl})
	every := tl.Prepared().ForecastEvery()
	for tick := 4 * every; tick < tl.Week().Until-2*60*minute; tick += every {
		if x := is.Issue(tick, nil, nil); x.Gale != nil {
			if prev := is.Issue(tick-every, nil, nil); prev.Gale == nil {
				return tick
			}
		}
	}
	t.Fatal("the sample week has no gale warning")
	return 0
}

// An issue is the same from any issuer of the same world at the same
// boundary: two edges' connections, or the world after a restart.
func TestIssuesAgree(t *testing.T) {
	tl := timeline(t)
	a, b := New(Config{Timeline: tl}), New(Config{Timeline: tl})
	ctx := context.Background()
	every := tl.Prepared().ForecastEvery()
	for _, tick := range []int64{3*every + 17, 50*every + 9000, 300 * every} {
		a.Update(ctx, tick, nil, nil)
		b.Update(ctx, tick, nil, nil)
		ma, pa := a.Forecast()
		mb, pb := b.Forecast()
		if ma.GetIssue() != tl.IssueAt(tick) || !proto.Equal(ma, mb) || !proto.Equal(pa, pb) {
			t.Fatalf("at %d two issuers differ, or issued at %d", tick, ma.GetIssue())
		}
	}
}

// After the Welcome a client is told what has been: the issue of ninety
// minutes before and the truth at each five minutes since, the spells in
// play over them.
func TestThePast(t *testing.T) {
	tl := timeline(t)
	is := New(Config{Timeline: tl})
	tick := 100*tl.Prepared().ForecastEvery() + 7*minute + 12
	is.Update(context.Background(), tick, nil, nil)
	m, past := is.Forecast()
	if past.GetIssue().GetIssue() != m.GetIssue()-tl.Prepared().ForecastHorizon() {
		t.Fatalf("the past's issue is %d, the latest %d", past.GetIssue().GetIssue(), m.GetIssue())
	}
	truth, spells, err := protocol.PastOf(past)
	if err != nil {
		t.Fatal(err)
	}
	from := past.GetIssue().GetIssue()
	want := (tick/weather.PastEvery*weather.PastEvery-from)/weather.PastEvery + 1
	if int64(len(truth)) != want || truth[0].Tick != float64(from) {
		t.Fatalf("%d keyframes of the truth from %v, want %d from %d", len(truth), truth[0].Tick, want, from)
	}
	for _, k := range truth {
		var w physics.Keyframe
		tl.Keyframe(int64(k.Tick), nil, &w)
		if k != w {
			t.Fatalf("the truth at %v is not the timeline's", k.Tick)
		}
	}
	if len(spells) == 0 || spells[0].Begin > float64(from) {
		t.Fatalf("the past's spells do not cover it: %d, the first from %v", len(spells), spells[0].Begin)
	}
}

// The message is the forecast's own: every record it holds, born before
// the issue or after it, goes on the wire as it is.
func TestTheMessageIsTheForecast(t *testing.T) {
	tl := timeline(t)
	is := New(Config{Timeline: tl})
	every := tl.Prepared().ForecastEvery()
	born := 0
	for tick := int64(0); tick < 2*24*60*minute; tick += every {
		x := is.Issue(tick, nil, nil)
		for i, s := range x.Message.GetSystems() {
			if s.GetSeed() != uint32(x.Forecast.Systems[i].Seed) {
				t.Fatalf("issue %d: a seed not its own", tick)
			}
			if x.Forecast.Systems[i].Born+x.Forecast.Head.Origin > float64(tick) {
				born++
			}
		}
		var back physics.Forecast
		if err := protocol.ForecastOf(x.Message, &back); err != nil || back != x.Forecast {
			t.Fatalf("issue %d: the message is not the forecast: %v", tick, err)
		}
	}
	if born == 0 {
		t.Error("no system born after an issue in two days")
	}
}

// A gale warning keeps the issue it came into force at while it is in
// force, and after a restart.
func TestGaleWarningKey(t *testing.T) {
	tl := timeline(t)
	first := galeIssue(t, tl)
	is := New(Config{Timeline: tl})
	every := tl.Prepared().ForecastEvery()
	ctx := context.Background()
	for tick := first; ; tick += every {
		is.Update(ctx, tick, nil, nil)
		m, _ := is.Forecast()
		if m.GetGale() == nil {
			break
		}
		if m.GetGale().GetKey() != first {
			t.Fatalf("issue %d: the warning's key is %d, not %d", tick, m.GetGale().GetKey(), first)
		}
		if m.GetGale().GetForce() < 8 || m.GetGale().GetSteps() == 0 {
			t.Fatalf("issue %d: a warning of force %d at steps %b", tick, m.GetGale().GetForce(), m.GetGale().GetSteps())
		}
	}
	// A restart, an issuer made again, finds the same key from inside the
	// warning.
	again := New(Config{Timeline: tl})
	if x := again.Issue(first+2*every, nil, nil); x.Gale != nil && x.Key != first {
		t.Fatalf("after a restart the warning's key is %d, not %d", x.Key, first)
	}
}

// Each of the week's storms is told once as it forms, where it is and how
// it moves, over two days updated every five minutes; an issuer begun
// again tells again only those formed within the horizon.
func TestStormFormedOnce(t *testing.T) {
	tl := timeline(t)
	var mu sync.Mutex
	told := map[[2]uint32]Storm{}
	again := 0
	formed := func(_ context.Context, s Storm) {
		mu.Lock()
		defer mu.Unlock()
		k := [2]uint32{uint32(s.Slot), s.Seed}
		if _, ok := told[k]; ok {
			again++
		}
		told[k] = s
	}
	is := New(Config{Timeline: tl, Formed: formed})
	ctx := context.Background()
	end := int64(2 * 24 * 60 * minute)
	for tick := int64(0); tick < end; tick += weather.PastEvery {
		is.Update(ctx, tick, nil, nil)
	}
	// The week's storms born in the two days, but for any born in the last
	// five minutes.
	cfg := tl.Config()
	want := 0
	for _, s := range tl.Week().Systems {
		at := int64(s.Born) + tl.Origin()
		if s.Kind != float64(cfg.Week.Storms) || at > end-weather.PastEvery || at < 0 {
			continue
		}
		want++
		got, ok := told[[2]uint32{uint32(s.Slot), uint32(s.Seed)}]
		if !ok {
			t.Fatalf("the storm born at %d in slot %d is not told", at, s.Slot)
		}
		k := physics.SystemAt(&s.SystemRecord, float64(got.At-tl.Origin()))
		if got.Born != at || got.At < at || got.At-at >= weather.PastEvery || got.East != k.East/4 || got.North != k.North/4 || got.Speed <= 0 {
			t.Fatalf("the storm born at %d told %+v", at, got)
		}
	}
	if want == 0 || len(told) != want || again != 0 {
		t.Fatalf("%d storms told, %d told again; the week's %d", len(told), again, want)
	}
	t.Logf("%d storms formed in two days", want)
	// Begun again: none older than the horizon is told again.
	clear(told)
	is = New(Config{Timeline: tl, Formed: formed})
	is.Update(ctx, end, nil, nil)
	for _, s := range told {
		if end-s.Born >= tl.Prepared().ForecastHorizon() {
			t.Fatalf("begun again, a storm born %d ticks before is told", end-s.Born)
		}
	}
}

// Steps after the world's end are left out.
func TestEnd(t *testing.T) {
	tl := timeline(t)
	is := New(Config{Timeline: tl})
	issue := 40 * tl.Prepared().ForecastEvery()
	is.SetEnd(issue + 25*minute)
	if m := is.Issue(issue, nil, nil).Message; m.GetSteps() != 3 {
		t.Fatalf("%d steps before an end 25 minutes on", m.GetSteps())
	}
}

// Record asks at each boundary of five minutes, and Run makes the issue.
func TestRecordAndRun(t *testing.T) {
	tl := timeline(t)
	is := New(Config{Timeline: tl})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go is.Run(ctx)
	tick := 77 * tl.Prepared().ForecastEvery()
	is.Record(&bus.Frame{Tick: tick})
	deadline := time.Now().Add(10 * time.Second)
	for {
		if m, _ := is.Forecast(); m != nil && m.GetIssue() == tick {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no issue made")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// What an issue costs on the wire, now that it carries the records of every
// system over its reach: under 10 KB, and under 32 KB with what has been,
// over the sample week.
func TestIssueBytes(t *testing.T) {
	tl := timeline(t)
	is := New(Config{Timeline: tl})
	every := tl.Prepared().ForecastEvery()
	ctx := context.Background()
	most, mostPast, total, n := 0, 0, 0, 0
	for tick := 10 * every; tick < tl.Week().Until-2*60*minute; tick += every {
		is.Update(ctx, tick, nil, nil)
		m, past := is.Forecast()
		b, err := proto.Marshal(&pb.ServerMessage{Body: &pb.ServerMessage_Forecast{Forecast: m}})
		if err != nil {
			t.Fatal(err)
		}
		with := proto.Clone(m).(*pb.Forecast)
		with.Past = past
		bp, _ := proto.Marshal(&pb.ServerMessage{Body: &pb.ServerMessage_Forecast{Forecast: with}})
		most, mostPast, total, n = max(most, len(b)), max(mostPast, len(bp)), total+len(b), n+1
	}
	t.Logf("an issue: %d bytes on average, %d at most, %.2f B/s; with its past %d at most", total/n, most, float64(total)/float64(n)/600, mostPast)
	if most > 10<<10 || mostPast > 32<<10 {
		t.Errorf("an issue of %d bytes, %d with its past", most, mostPast)
	}
}
