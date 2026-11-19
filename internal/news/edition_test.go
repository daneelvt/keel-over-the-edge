// SPDX-License-Identifier: AGPL-3.0-only

package news

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// memStore is the news's store in memory: one world's stories and
// editions, and the people they name.
type memStore struct {
	stories  []store.Story
	editions []store.Edition
	people   map[store.AccountID]store.LogPerson
	figures  store.Figures
	notices  []store.WorldNotice
	sets     int
}

func sameDay(a, b time.Time) bool {
	return a.Year() == b.Year() && a.Month() == b.Month() && a.Day() == b.Day()
}

func (m *memStore) DayStories(_ context.Context, _ [16]byte, day time.Time) ([]store.Story, error) {
	var out []store.Story
	for _, s := range m.stories {
		if sameDay(s.Day, day) {
			out = append(out, s)
		}
	}
	return out, nil
}

func (m *memStore) RankedStories(_ context.Context, _ [16]byte, days []time.Time) ([]store.Story, error) {
	var out []store.Story
	for _, s := range m.stories {
		if s.Rank > 0 && slices.ContainsFunc(days, func(d time.Time) bool { return sameDay(s.Day, d) }) {
			out = append(out, s)
		}
	}
	return out, nil
}

func (m *memStore) StoriesAbout(_ context.Context, _ [16]byte, id store.AccountID, limit int) ([]store.Story, error) {
	var out []store.Story
	for _, s := range slices.Backward(m.stories) {
		if s.Rank > 0 && !s.Struck && (s.Account == id || slices.Contains(s.Named, id)) && len(out) < limit {
			out = append(out, s)
		}
	}
	return out, nil
}

func (m *memStore) Editions(context.Context, [16]byte) ([]store.Edition, error) {
	return slices.Clone(m.editions), nil
}

func (m *memStore) SetEdition(_ context.Context, _ int64, _ [16]byte, _ string, e store.Edition, ranks map[[16]byte]int) error {
	for _, o := range m.editions {
		if sameDay(o.Day, e.Day) {
			return store.ErrEditionSet
		}
	}
	m.sets++
	m.editions = append(m.editions, e)
	for i := range m.stories {
		if r, ok := ranks[m.stories[i].ID]; ok {
			m.stories[i].Rank = r
		}
	}
	return nil
}

func (m *memStore) WorldNotices(context.Context, [16]byte) ([]store.WorldNotice, error) {
	return m.notices, nil
}

func (m *memStore) DayFigures(context.Context, [16]byte, int, time.Time, time.Time) (store.Figures, error) {
	return m.figures, nil
}

func (m *memStore) LogPeople(_ context.Context, ids []store.AccountID) (map[store.AccountID]store.LogPerson, error) {
	out := map[store.AccountID]store.LogPerson{}
	for _, id := range ids {
		if p, ok := m.people[id]; ok {
			out[id] = p
		}
	}
	return out, nil
}

func (m *memStore) StrikeStory(_ context.Context, _, id [16]byte, struck bool) (store.Struck, error) {
	for i := range m.stories {
		if m.stories[i].ID == id {
			m.stories[i].Struck = struck
			return store.Struck{Account: m.stories[i].Account, Title: m.stories[i].Title}, nil
		}
	}
	return store.Struck{}, store.ErrNotFound
}

func (m *memStore) LogSailorByID(_ context.Context, id store.AccountID) (store.LogSailor, error) {
	p, ok := m.people[id]
	if !ok {
		return store.LogSailor{}, store.ErrNotFound
	}
	return store.LogSailor{ID: id, Kind: p.Kind, Owner: p.Owner, Name: p.Name, Born: p.Born, Shown: p.Shown}, nil
}

func (m *memStore) LogSailorByKey(_ context.Context, key string) (store.LogSailor, error) {
	for id, p := range m.people {
		if strings.EqualFold(p.Name, key) {
			return m.LogSailorByID(context.Background(), id)
		}
	}
	return store.LogSailor{}, store.ErrNotFound
}

// born is a month of birth years ago, as the database keeps it.
func born(now time.Time, years int) int32 {
	return int32((now.Year()-years)*100 + int(now.Month()))
}

var ny = func() *time.Location {
	z, err := time.LoadLocation("America/New_York")
	if err != nil {
		panic(err)
	}
	return z
}()

// world is a world begun on Monday 9 November 2026 in New York, read at
// noon on Thursday the 12th.
type world struct {
	t     *testing.T
	m     *memStore
	s     *Service
	now   time.Time
	n     int
	ann   store.AccountID // an adult
	bob   store.AccountID // an adult, Ann's shipmate
	tia   store.AccountID // a teen who lets sailors read her log
	gus   store.AccountID // a machine sailor
	gone  store.AccountID // deleted
	block map[[2]store.AccountID]bool
}

func newWorld(t *testing.T) *world {
	t.Helper()
	now := time.Date(2026, 11, 12, 12, 0, 0, 0, ny)
	w := &world{t: t, m: &memStore{people: map[store.AccountID]store.LogPerson{}}, now: now,
		ann: store.AccountID{1}, bob: store.AccountID{2}, tia: store.AccountID{3}, gus: store.AccountID{4}, gone: store.AccountID{5},
		block: map[[2]store.AccountID]bool{}}
	w.m.people[w.ann] = store.LogPerson{ID: w.ann, Kind: store.Human, Born: born(now, 30), Name: "Ann Bonny"}
	w.m.people[w.bob] = store.LogPerson{ID: w.bob, Kind: store.Human, Born: born(now, 40), Name: "Bob Read"}
	w.m.people[w.tia] = store.LogPerson{ID: w.tia, Kind: store.Human, Born: born(now, 15), Name: "Tia", Shown: store.LogShownSailors}
	w.m.people[w.gus] = store.LogPerson{ID: w.gus, Kind: store.AI, Owner: w.ann, Born: born(now, 30), Name: "Gus"}
	w.s = NewService(Config{
		Store: w.m, Catalog: testCatalog(t), Zone: ny, Now: func() time.Time { return w.now },
		World: World{ID: [16]byte{9}, Number: 12, Begins: time.Date(2026, 11, 8, 18, 0, 0, 0, ny)},
		Blocks: func(a, b store.AccountID) bool {
			return w.block[[2]store.AccountID{a, b}] || w.block[[2]store.AccountID{b, a}]
		},
		Shipmates: func(a store.AccountID) []store.AccountID {
			if a == w.ann {
				return []store.AccountID{w.bob}
			}
			return nil
		},
		Key: strings.ToLower,
	})
	return w
}

// add writes a candidate story about who, on the day of at.
func (w *world) add(kind string, who store.AccountID, at time.Time, title string, named ...store.AccountID) store.Story {
	w.n++
	s := store.Story{ID: [16]byte{0, byte(w.n), 0, 0, 0, 0, 0, 0, byte(w.n * 7), byte(w.n * 13)}, Story: kind, At: at.UTC(),
		Score: w.s.cfg.Catalog.StoryScore(catalog.NewsStoryOf(kind)), Account: who, Named: named, Subject: "island", Number: int32(w.n),
		Title: title, What: "an island of the rim", Island: int32(w.n), X: float64(w.n), Y: 2,
		Facts: store.StoryFacts{Boat: "Gull", BoatKind: "jolly-boat"}}
	t := at.In(ny)
	s.Day = time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
	switch kind {
	case store.StoryRecord, store.StoryRun, store.StoryCrew, store.StoryLife, store.StoryMilestone:
		s.Subject, s.Facts.Place, s.Facts.Spot = store.SubjectSailor, title, true
		s.Amount = 8
	}
	w.m.stories = append(w.m.stories, s)
	return s
}

// read is the day's edition as who reads it.
func (w *world) read(who store.AccountID, day time.Time) Edition {
	w.t.Helper()
	w.s.mu.Lock()
	clear(w.s.kept)
	w.s.mu.Unlock()
	e, err := w.s.Edition(context.Background(), who, day)
	if err != nil {
		w.t.Fatal(err)
	}
	return e
}

// TestEditionNames: every name in a story follows the naming rule for its
// reader: a sailor named by their name to one of their age band who may
// read their log, else their boat; a machine sailor always, marked; a
// block either way "a sailor"; a deleted account a former sailor; and
// the reader is told whose logs they may open.
func TestEditionNames(t *testing.T) {
	w := newWorld(t)
	at := w.now.Add(-2 * time.Hour)
	w.add(store.StoryGreat, w.ann, at, "Keyhole Rock")
	w.add(store.StoryRecord, w.tia, at, "Skerries")
	w.add(store.StoryLife, w.gus, at, "Gull Reach")
	w.add(store.StoryFirst, w.gone, at, "Pelican Cove")
	names := func(e Edition) map[string]Name {
		out := map[string]Name{}
		for _, s := range e.Stories {
			out[s.Head] = s.Names[0]
		}
		return out
	}
	byBob := names(w.read(w.bob, time.Time{}))
	if n := byBob["KEYHOLE ROCK"]; n.Kind != NameHuman || n.Name != "Ann Bonny" || !n.Logged {
		t.Errorf("Ann to Bob: %+v", n)
	}
	if n := byBob["OFF SKERRIES"]; n.Kind != NameBoat || n.Name != "Gull" || n.Logged {
		t.Errorf("a teen to an adult: %+v", n)
	}
	if n := byBob["OFF GULL REACH"]; n.Kind != NameMachine || n.Name != "Gus" || !n.Logged {
		t.Errorf("a machine sailor: %+v", n)
	}
	if n := byBob["PELICAN COVE"]; n.Kind != NameFormer {
		t.Errorf("a deleted account: %+v", n)
	}
	byTia := names(w.read(w.tia, time.Time{}))
	if n := byTia["OFF SKERRIES"]; n.Kind != NameHuman || n.Name != "Tia" {
		t.Errorf("Tia to herself: %+v", n)
	}
	if n := byTia["KEYHOLE ROCK"]; n.Kind != NameBoat || n.Name != "Gull" {
		t.Errorf("an adult to a teen: %+v", n)
	}
	w.block[[2]store.AccountID{w.ann, w.bob}] = true
	if n := names(w.read(w.bob, time.Time{}))["KEYHOLE ROCK"]; n.Kind != NameSailor || n.Name != "" {
		t.Errorf("Ann, blocked, to Bob: %+v", n)
	}
	// Ann keeps her log to herself: named to no one but herself.
	p := w.m.people[w.ann]
	p.Shown = store.LogShownMe
	w.m.people[w.ann] = p
	delete(w.block, [2]store.AccountID{w.ann, w.bob})
	if n := names(w.read(w.bob, time.Time{}))["KEYHOLE ROCK"]; n.Kind != NameBoat {
		t.Errorf("Ann's log kept, to Bob: %+v", n)
	}
	if n := names(w.read(w.ann, time.Time{}))["KEYHOLE ROCK"]; n.Kind != NameHuman || !n.Logged {
		t.Errorf("Ann to herself: %+v", n)
	}
}

// TestEditionSet: a day's edition is set once the day is over, with its
// figures; it never changes again, whatever is written after, and reads
// as it was chosen; today's fills; a struck story is gone for everyone;
// the sailors of the recent editions give way.
func TestEditionSet(t *testing.T) {
	w := newWorld(t)
	yesterday := time.Date(2026, 11, 11, 15, 0, 0, 0, ny)
	for i := range 9 {
		w.add(store.StoryCharting, store.AccountID{byte(20 + i)}, yesterday.Add(time.Duration(i)*time.Minute), fmt.Sprintf("Isle %d", i))
		w.m.people[store.AccountID{byte(20 + i)}] = store.LogPerson{ID: store.AccountID{byte(20 + i)}, Kind: store.Human, Born: born(w.now, 30), Name: fmt.Sprintf("Sailor %d", i)}
	}
	great := w.add(store.StoryGreat, w.ann, yesterday, "Keyhole Rock")
	w.m.figures = store.Figures{Boats: 10, Run: 30 * 1852, Charted: 10}
	ctx := context.Background()
	n, err := w.s.Set(ctx, 1)
	if err != nil || n != 4 {
		// Sunday evening's, the world's first, to Wednesday's.
		t.Fatalf("set %d, %v", n, err)
	}
	day := time.Date(2026, 11, 11, 0, 0, 0, 0, ny)
	before := w.read(w.bob, day)
	// A great discovery, and two of the lesser: never more of a kind.
	if !before.Set || len(before.Stories) != 3 || before.Stories[0].Head != "KEYHOLE ROCK" || before.Number != 4 || before.Figures.Boats != 10 {
		t.Fatalf("Wednesday's edition: %+v", before)
	}
	// Written after: a greater story of that day, and new figures.
	w.add(store.StoryRecord, w.bob, yesterday.Add(time.Hour), "Skerries")
	w.m.figures = store.Figures{Boats: 99}
	if n, _ := w.s.Set(ctx, 1); n != 0 {
		t.Errorf("set again: %d", n)
	}
	// The front page and its figures: the reader's own box is worked out
	// as they ask, never set.
	after := w.read(w.bob, day)
	b1, _ := json.Marshal([]any{before.Stories, before.Figures, before.FiguresText})
	b2, _ := json.Marshal([]any{after.Stories, after.Figures, after.FiguresText})
	if string(b1) != string(b2) {
		t.Errorf("a set edition changed:\n%s\n%s", b1, b2)
	}
	if len(after.Shipmates) != 1 || after.Shipmates[0].Kind != store.StoryRecord {
		t.Errorf("Bob's own box, after: %+v", after.Shipmates)
	}
	// Struck: gone for everyone, the rest in their places; the owner
	// reads it, marked, to put it back.
	if _, err := w.s.Strike(ctx, great.ID, true); err != nil {
		t.Fatal(err)
	}
	for _, who := range []store.AccountID{w.ann, w.bob} {
		if e := w.read(who, day); len(e.Stories) != 2 || e.Stories[0].Head == "KEYHOLE ROCK" {
			t.Errorf("struck, to %x: %+v", who[:1], e.Stories)
		}
	}
	if e, err := w.s.ForOwner(ctx, day); err != nil || len(e.Stories) != 3 || !e.Stories[2].Struck || e.Stories[2].Names[0].Name != "Ann Bonny" {
		t.Errorf("the owner's: %+v, %v", e.Stories, err)
	}
	if _, err := w.s.Strike(ctx, [16]byte{99}, true); err != store.ErrNotFound {
		t.Errorf("no such story: %v", err)
	}
	// Today: Ann, in Wednesday's edition (struck, not read), and Bob,
	// who was not, with equal stories: Bob's first.
	for i := range w.m.stories {
		w.m.stories[i].Struck = false
	}
	w.m.figures = store.Figures{}
	w.add(store.StoryCrew, w.ann, w.now.Add(-time.Hour), "Gull Reach")
	w.add(store.StoryCrew, w.bob, w.now.Add(-time.Hour), "Gull Reach")
	today := w.read(w.tia, time.Time{})
	if today.Set || today.Number != 5 || len(today.Stories) != 2 || today.Stories[0].Names[0].Name != "Gull" || today.FiguresText != "A quiet day on the water." {
		t.Errorf("today's edition: %+v", today)
	}
	if ann := w.read(w.ann, time.Time{}); ann.Stories[0].Names[0].Name != "Bob Read" {
		t.Errorf("Ann in the recent editions gives way: %+v", ann.Stories)
	}
	if len(today.Days) != 5 || today.Days[0].Day != "2026-11-12" || today.Days[0].Set || !today.Days[1].Set || today.Days[4].Number != 1 {
		t.Errorf("the days: %+v", today.Days)
	}
	if _, err := w.s.Edition(ctx, w.ann, time.Date(2026, 11, 7, 0, 0, 0, 0, ny)); err != ErrNoEdition {
		t.Errorf("a day before the world: %v", err)
	}
}

// TestShipmatesBox: a reader's box holds the day's stories about their
// shipmates and themselves that did not make the front page, never two
// about one sailor; a reader with none has an empty box.
func TestShipmatesBox(t *testing.T) {
	w := newWorld(t)
	at := w.now.Add(-time.Hour)
	for i, kind := range []string{store.StoryGreat, store.StoryGreat, store.StoryRecord, store.StoryRecord, store.StoryLife, store.StoryLife} {
		id := store.AccountID{byte(40 + i)}
		w.m.people[id] = store.LogPerson{ID: id, Kind: store.Human, Born: born(w.now, 30), Name: fmt.Sprintf("Sailor %d", i)}
		w.add(kind, id, at, fmt.Sprintf("Isle %d", i))
	}
	w.add(store.StoryCharting, w.bob, at, "Bob's Rock")
	w.add(store.StoryCharting, w.bob, at, "Bob's Other Rock")
	w.add(store.StoryCharting, w.ann, at, "Ann's Rock")
	e := w.read(w.ann, time.Time{})
	if len(e.Stories) != 6 {
		t.Fatalf("%d stories", len(e.Stories))
	}
	if len(e.Shipmates) != 2 || e.Shipmates[0].Head != "BOB'S ROCK" || e.Shipmates[1].Head != "ANN'S ROCK" {
		t.Errorf("Ann's box: %+v", e.Shipmates)
	}
	if e := w.read(w.tia, time.Time{}); len(e.Shipmates) != 0 {
		t.Errorf("Tia's box: %+v", e.Shipmates)
	}
}

// TestAbout: the stories naming a sailor, as the card and the log show
// them, only to a reader who may name them.
func TestAbout(t *testing.T) {
	w := newWorld(t)
	w.add(store.StoryGreat, w.ann, w.now.Add(-time.Hour), "Keyhole Rock")
	ctx := context.Background()
	got, err := w.s.About(ctx, w.bob, "Ann Bonny", 5)
	if err != nil || len(got) != 1 || got[0].Head != "KEYHOLE ROCK" || got[0].Day != "2026-11-12" {
		t.Fatalf("about Ann, to Bob: %+v, %v", got, err)
	}
	if got, _ := w.s.About(ctx, w.tia, "Ann Bonny", 5); len(got) != 0 {
		t.Errorf("about Ann, to a teen: %+v", got)
	}
	if got, _ := w.s.About(ctx, w.bob, "Nobody", 5); len(got) != 0 {
		t.Errorf("about nobody: %+v", got)
	}
}

// TestEditionOfTwoHundredBoats: a day of two hundred boats' candidates
// makes an edition of six stories and its figures, the same size as a
// day of two boats', small on a phone's data; and the set edition the job
// writes is the one read.
func TestEditionOfTwoHundredBoats(t *testing.T) {
	for _, boats := range []int{200, 2} {
		w := newWorld(t)
		c := w.s.cfg.Catalog
		start := time.Date(2026, 11, 12, 6, 0, 0, 0, ny)
		cands := day(c, boats, 7)
		for _, x := range cands {
			who := x.About[0]
			if _, ok := w.m.people[who]; !ok {
				w.m.people[who] = store.LogPerson{ID: who, Kind: store.Human, Born: born(w.now, 30), Name: fmt.Sprintf("Sailor %x", who[:2])}
			}
			at := start.Add(time.Duration(x.At-time.Date(2026, 11, 12, 5, 0, 0, 0, time.UTC).UnixMilli()) * time.Millisecond / 4)
			s := w.add(x.Kind, who, at, "A Rather Long Island Name", x.About[1:]...)
			w.m.stories[len(w.m.stories)-1].Amount = x.Amount
			_ = s
		}
		w.m.figures = store.Figures{Boats: boats, Machines: boats / 7, Run: float64(boats) * 9 * 1852, Charted: len(cands) / 2, Over: boats / 5}
		began := time.Now()
		e := w.read(w.ann, time.Time{})
		took := time.Since(began)
		body, _ := json.Marshal(e)
		if boats == 200 && len(e.Stories) != 6 || boats == 2 && (len(e.Stories) == 0 || len(e.Stories) > 2) {
			t.Errorf("%d boats: %d stories", boats, len(e.Stories))
		}
		if len(body) > 8000 {
			t.Errorf("%d boats: the edition is %d bytes of JSON", boats, len(body))
		}
		t.Logf("%d boats, %d candidates: %d stories, %d in the box, %d bytes of JSON, read in %v; %s", boats, len(cands),
			len(e.Stories), len(e.Shipmates), len(body), took, e.FiguresText)
		for _, s := range e.Stories {
			t.Logf("  %s. %s", s.Head, s.Text)
		}
	}
}
