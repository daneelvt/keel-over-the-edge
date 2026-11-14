// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/logbook"
	"github.com/daneelvt/keel-over-the-edge/internal/news"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// fakeNews is a day's edition, as a machine sailor reads it.
type fakeNews struct{ reader store.AccountID }

func (f *fakeNews) ParseDay(text string) (time.Time, error) {
	if text == "" || text == "2026-11-11" {
		return time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC), nil
	}
	return time.Time{}, news.ErrNoEdition
}

func (f *fakeNews) Edition(_ context.Context, reader store.AccountID, _ time.Time) (news.Edition, error) {
	f.reader = reader
	x, y := 0.0, 9000.0
	return news.Edition{
		World: 12, Day: "2026-11-12", Number: 4, Zone: "America/New_York",
		FiguresText: "Sailed this day, 212 boats (31 machine ⚙) · 1,804 NM · 14 places charted.",
		Lead:        []news.Story{},
		Stories: []news.Story{
			{Head: "KEYHOLE ROCK", Text: "A sea arch on an island of the rim, first sighted by {0}.",
				Names: []news.Name{{Kind: news.NameHuman, Name: "Mira"}}, Subject: "feature", Number: 3, X: &x, Y: &y},
			{Head: "OFF THE SKERRIES", Text: "{0} passed 8 m from the lip, nearer than any boat this world.",
				Names: []news.Name{{Kind: news.NameBoat, Name: "Iron Mary"}}},
			{Head: "IN COMPANY", Text: "A crew of four under {0}: {1} and two more.",
				Names: []news.Name{{Kind: news.NameMachine, Name: "Gus"}, {Kind: news.NameBoat, Type: "Jolly boat"}}},
		},
		Shipmates: []news.Story{{Head: "GULL REACH", Text: "{0} met a humpback whale.", Names: []news.Name{{Kind: news.NameSailor}}}},
		Notices:   []news.Notice{{Head: "PORT ROYAL", EndsAt: time.Date(2026, 11, 15, 23, 0, 0, 0, time.UTC).UnixMilli()}},
		Days:      []news.DayRef{{Day: "2026-11-12", Number: 4}, {Day: "2026-11-11", Number: 3, Set: true}},
	}, nil
}

// TestNewsWords: the news tool reads the day's edition as its machine
// sailor: the figures, each story with its headword, its names marked as
// players' and as a human's or a machine's, where it happened in the
// chart's words; the notices and the other days; a day with no edition
// refused; and with log, the sailor's own log.
func TestNewsWords(t *testing.T) {
	f := &fakeNews{}
	me := store.AccountID{7}
	s := &Sea{News: f, Log: func(_ context.Context, id store.AccountID) (logbook.Log, error) {
		if id != me {
			return logbook.Log{}, logbook.ErrNotFound
		}
		closest := 12.5
		return logbook.Log{Name: "Gus", Machine: true, Record: logbook.Record{DistanceM: 212 * 1852, Voyages: 30, Aboard: 1, Worlds: 2, Charted: 14,
			ClosestM: &closest}, World: &logbook.WorldDays{WorldRef: logbook.WorldRef{Number: 12}, Days: []logbook.Day{{Date: "2026-11-12", RunM: 18.4 * 1852,
			Voyages: []logbook.Voyage{{}}, Entries: []logbook.Entry{{Kind: store.LogCharted, Title: "Keyhole Rock"}}}}},
			Groups: []logbook.Group{{ID: "life", Found: 3, Kinds: make([]logbook.Kind, 24)}}}, nil
	}}
	text, r := newsWords(context.Background(), s, me, &newsArgs{})
	if r != nil {
		t.Fatal(r)
	}
	for _, want := range []string{
		"The Shipping Intelligence, No. 4 · Thursday 12 November (the day by New York's clock) · today's",
		"Sailed this day, 212 boats (31 machine) · 1,804 NM",
		"1. KEYHOLE ROCK. A sea arch on an island of the rim, first sighted by «Mira» (human). At ",
		"2. OFF THE SKERRIES. The «Iron Mary» passed 8 m from the lip",
		"3. IN COMPANY. A crew of four under «Gus» (machine): a jolly boat and two more.",
		"From your shipmates:\n- GULL REACH. A sailor met a humpback whale.",
		"Notices to Mariners: PORT ROYAL. The falls take this world at Sunday 23:00 UTC.",
		"Other editions: 2026-11-11 (No. 3): call news with day.",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("the edition lacks %q:\n%s", want, text)
		}
	}
	if f.reader != me {
		t.Errorf("read as %x", f.reader[:1])
	}
	if _, r := newsWords(context.Background(), s, me, &newsArgs{Day: "1999-01-01"}); r == nil || r.kind != refusedArgs {
		t.Errorf("a day with no edition: %v", r)
	}
	text, r = newsWords(context.Background(), s, me, &newsArgs{Log: true})
	if r != nil {
		t.Fatal(r)
	}
	for _, want := range []string{"The log of «Gus» (machine):", "Sailed 212 NM · 31 voyages · 2 worlds · 14 places charted · closest", "closest to the falls 12.5 m",
		"Thursday 12 November · 18 NM · 1 voyage · charted Keyhole Rock", "The collection: life 3 of 24."} {
		if !strings.Contains(text, want) {
			t.Errorf("the log lacks %q:\n%s", want, text)
		}
	}
	t.Logf("the edition:\n%s\n\nthe log:\n%s", func() string { s, _ := newsWords(context.Background(), s, me, &newsArgs{}); return s }(), text)
}
