// SPDX-License-Identifier: AGPL-3.0-only

package logbook

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// fakeLogs is a store of a few sailors and their logs.
type fakeLogs struct {
	sailors map[store.AccountID]store.LogSailor
	voyages []store.LogVoyage
	entries []store.LogEntry
	finds   map[store.AccountID][]store.LogKept
	totals  map[store.AccountID]store.LogTotals
	races   map[store.AccountID][]store.RaceRecord
	from    time.Time
}

func (f *fakeLogs) LogSailorByKey(_ context.Context, key string) (store.LogSailor, error) {
	for _, s := range f.sailors {
		if strings.ToLower(s.Name) == key {
			return s, nil
		}
	}
	return store.LogSailor{}, store.ErrNotFound
}

func (f *fakeLogs) LogSailorByID(_ context.Context, id store.AccountID) (store.LogSailor, error) {
	s, ok := f.sailors[id]
	if !ok {
		return s, store.ErrNotFound
	}
	return s, nil
}

func (f *fakeLogs) LogPeople(_ context.Context, ids []store.AccountID) (map[store.AccountID]store.LogPerson, error) {
	out := map[store.AccountID]store.LogPerson{}
	for _, id := range ids {
		if s, ok := f.sailors[id]; ok {
			out[id] = store.LogPerson{ID: id, Kind: s.Kind, Owner: s.Owner, Born: s.Born, Shown: s.Shown}
		}
	}
	return out, nil
}

func (f *fakeLogs) SetLogShown(_ context.Context, id store.AccountID, shown string) error {
	s, ok := f.sailors[id]
	if !ok || s.Kind != store.Human {
		return store.ErrNotFound
	}
	s.Shown = shown
	f.sailors[id] = s
	return nil
}

func (f *fakeLogs) LogTotals(_ context.Context, id store.AccountID) (store.LogTotals, error) {
	return f.totals[id], nil
}

func (f *fakeLogs) LogWorlds(_ context.Context, id store.AccountID) ([]store.LogWorld, error) {
	seen := map[int]bool{}
	var out []store.LogWorld
	for _, v := range f.voyages {
		if v.Account == id && !seen[v.World] {
			seen[v.World] = true
			out = append(out, store.LogWorld{Number: v.World, First: v.Began, Last: v.Ended})
		}
	}
	return out, nil
}

func (f *fakeLogs) LogVoyages(_ context.Context, id store.AccountID, world int) ([]store.LogVoyage, error) {
	var out []store.LogVoyage
	for _, v := range f.voyages {
		if v.Account == id && v.World == world {
			out = append(out, v)
		}
	}
	return out, nil
}

func (f *fakeLogs) LogEntries(_ context.Context, id store.AccountID, world int) ([]store.LogEntry, error) {
	var out []store.LogEntry
	for _, e := range f.entries {
		if e.Account == id && e.World == world {
			out = append(out, e)
		}
	}
	return out, nil
}

func (f *fakeLogs) LogFinds(_ context.Context, id store.AccountID) ([]store.LogKept, error) {
	return f.finds[id], nil
}

func (f *fakeLogs) LogFrom(context.Context) (time.Time, error) { return f.from, nil }

func (f *fakeLogs) LogFigures(context.Context, []store.AccountID) (map[store.AccountID]store.LogFigures, error) {
	return nil, nil
}

func (f *fakeLogs) RaceRibbonsOf(_ context.Context, id store.AccountID, skip, most int) ([]store.RaceRecord, error) {
	var rs []store.RaceRecord
	for _, r := range f.races[id] {
		if r.Role != store.RoleOwner {
			rs = append(rs, r)
		}
	}
	rs = rs[min(skip, len(rs)):]
	return rs[:min(most, len(rs))], nil
}

func (f *fakeLogs) PrizesOf(_ context.Context, world int, ids []store.AccountID, _ int) (map[store.AccountID]store.RacePrizes, error) {
	out := map[store.AccountID]store.RacePrizes{}
	for _, id := range ids {
		for _, r := range f.races[id] {
			if r.World == world && r.Role != store.RoleOwner && r.Kind == "race" && r.Fleet >= 3 && r.Place == 1 {
				p := out[id]
				p.Wins = append(p.Wins, r.Code)
				out[id] = p
			}
		}
	}
	return out, nil
}

func (f *fakeLogs) RaceCountsOf(_ context.Context, id store.AccountID) (store.RaceCounts, error) {
	var c store.RaceCounts
	for _, r := range f.races[id] {
		if r.Role == store.RoleOwner {
			c.Ran++
			continue
		}
		c.Sailed++
		if r.Kind == "race" && r.Place >= 1 && r.Place <= 3 {
			c.Top3++
		}
		if r.Kind == "race" && r.Place == 1 {
			c.Wins++
		}
		for _, a := range r.Awards {
			if a == "spoon" {
				c.Spoons++
			}
		}
	}
	return c, nil
}

// The sailors of the tests: Ann an adult, Tom an adult who keeps his log,
// Kit a teen, Jo a teen who opened hers, Iron Mary Ann's machine sailor,
// Rob an adult stopped, Bea an adult.
var (
	ann, tom, kit, jo, mary, rob, bea = id(1), id(2), id(3), id(4), id(5), id(6), id(7)
	gone                              = id(9)
)

const (
	bornAdult = 199001
	bornTeen  = 201101
)

func testLogs(t testing.TB) (*Service, *fakeLogs, map[[2]store.AccountID]bool) {
	t.Helper()
	now := time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC)
	sailor := func(id store.AccountID, name string, born int32) store.LogSailor {
		return store.LogSailor{ID: id, Kind: store.Human, Name: name, Born: born, Since: now.AddDate(0, -1, 0)}
	}
	f := &fakeLogs{sailors: map[store.AccountID]store.LogSailor{
		ann: sailor(ann, "Ann", bornAdult), tom: sailor(tom, "Tom", bornAdult), kit: sailor(kit, "Kit", bornTeen),
		jo:  sailor(jo, "Jo", bornTeen),
		rob: sailor(rob, "Rob", bornAdult), bea: sailor(bea, "Bea", bornAdult),
	}, from: now.Add(-48 * time.Hour)}
	f.sailors[mary] = store.LogSailor{ID: mary, Kind: store.AI, Owner: ann, Name: "Iron Mary", Born: bornAdult}
	s := f.sailors[tom]
	s.Shown = store.LogShownMe
	f.sailors[tom] = s
	s = f.sailors[jo]
	s.Shown = store.LogShownSailors
	f.sailors[jo] = s
	s = f.sailors[rob]
	s.Stopped = true
	f.sailors[rob] = s
	blocks := map[[2]store.AccountID]bool{{bea, ann}: true}
	svc := NewService(ServiceConfig{
		Store: f, Catalog: testCatalog(t), Key: strings.ToLower, World: func() int { return 14 }, Zone: time.UTC,
		Now: func() time.Time { return now },
		Blocks: func(a, b store.AccountID) bool {
			return blocks[[2]store.AccountID{a, b}] || blocks[[2]store.AccountID{b, a}]
		},
	})
	return svc, f, blocks
}

// A log is read by its sailor, its machine sailor's player, and those its
// setting lets; no such sailor and a log refused are the same 404.
func TestReadingALog(t *testing.T) {
	svc, _, _ := testLogs(t)
	ctx := context.Background()
	for _, c := range []struct {
		reader store.AccountID
		name   string
		ok     bool
	}{
		{ann, "Tom", false},      // keeps his log
		{ann, "Kit", false},      // a teen's, by default
		{kit, "Jo", true},        // a teen who opened hers
		{ann, "Jo", true},        // to an adult too
		{kit, "Ann", true},       // an adult's
		{kit, "Iron Mary", true}, // a machine sailor's
		{tom, "Tom", true},       // one's own
		{ann, "Rob", false},      // stopped
		{rob, "Rob", true},       // stopped, his own
		{bea, "Ann", false},      // a block
		{ann, "Bea", false},      // a block, the other way
		{bea, "Iron Mary", true}, // Bea blocks Ann, not her machine sailor
		{ann, "Nobody", false},
		{gone, "Ann", false}, // a reader with no sailor
	} {
		_, err := svc.ByName(ctx, c.reader, c.name, 0)
		want := error(nil)
		if !c.ok {
			want = ErrNotFound
		}
		if !errors.Is(err, want) {
			t.Errorf("%v reads %s: %v", c.reader[15], c.name, err)
		}
	}
	if _, err := svc.Machine(ctx, ann, mary, 0); err != nil {
		t.Errorf("Ann reads her machine sailor's log: %v", err)
	}
	if _, err := svc.Machine(ctx, tom, mary, 0); !errors.Is(err, ErrNotFound) {
		t.Errorf("Tom reads Ann's machine sailor's log from the panel: %v", err)
	}
	if _, err := svc.ForOwner(ctx, kit, 0); err != nil {
		t.Errorf("the owner reads a teen's log: %v", err)
	}
	l, err := svc.Own(ctx, kit, 0)
	if err != nil || !l.Own || l.Shown != store.LogShownMe || l.Chosen {
		t.Errorf("Kit's own log: %+v, %v", l, err)
	}
	if err := svc.SetShown(ctx, kit, store.LogShownSailors); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ByName(ctx, ann, "Kit", 0); err != nil {
		t.Errorf("Kit's log, opened: %v", err)
	}
	if err := svc.SetShown(ctx, kit, "everyone"); !errors.Is(err, ErrShown) {
		t.Errorf("a setting of everyone: %v", err)
	}
	if err := svc.SetShown(ctx, mary, store.LogShownMe); !errors.Is(err, ErrNotFound) {
		t.Errorf("a machine sailor's log kept: %v", err)
	}
}

// A log's days name its companions by the rule: adults whose logs may be
// read by an adult, machine sailors always, the rest counted; a block "a
// sailor"; a deleted account a former sailor.
func TestLogDays(t *testing.T) {
	svc, f, _ := testLogs(t)
	ctx := context.Background()
	t0 := time.Date(2026, 11, 12, 15, 0, 0, 0, time.UTC)
	f.voyages = []store.LogVoyage{
		{Account: ann, World: 14, Boat: 10, BoatKind: "jolly-boat", BoatName: "Gull", Began: t0, Ended: t0.Add(time.Hour), How: store.LogReturned,
			Run: 8400.4, Logged: true, Met: store.LogMetGale | store.LogRodeGale, GalePlace: "Gull Reach",
			Crew: []store.LogMate{{ID: tom, Name: "Tom"}, {ID: kit, Name: "Kit"}, {ID: mary, Name: "Iron Mary", Machine: true},
				{ID: bea, Name: "Bea"}, {Name: ""}, {ID: jo, Name: "Jo"}}},
		{Account: ann, World: 14, Boat: 11, Began: t0.Add(-26 * time.Hour), Ended: t0.Add(-25 * time.Hour), How: store.LogOver, Survived: true, Least: 12.25},
		{Account: ann, World: 13, Boat: 3, Began: t0.Add(-200 * time.Hour), Ended: t0.Add(-199 * time.Hour), How: store.LogTaken},
	}
	f.entries = []store.LogEntry{{Account: ann, World: 14, At: t0.Add(time.Minute), Kind: store.LogBump, Other: kit, OtherName: "Kit",
		OtherBoat: "Kittiwake", Article: "10", Fault: store.FaultMine},
		{Account: ann, World: 14, At: t0.Add(2 * time.Minute), Kind: store.LogMet, Group: GroupLife, Find: "gull", Title: "Gull"},
		{Account: ann, World: 14, At: t0.Add(3 * time.Minute), Kind: store.LogMet, Group: GroupLife, Find: "gull", Title: "Gull"}}
	f.totals = map[store.AccountID]store.LogTotals{ann: {Voyages: 3, Run: 8400.4, Worlds: 2, Survived: true, Least: 12.25, Charted: 4}}
	l, err := svc.ByName(ctx, kit, "Ann", 0)
	if err != nil {
		t.Fatal(err)
	}
	if l.Own || l.Shown != "" || l.World == nil || l.World.Number != 14 || !l.World.Current || len(l.Worlds) != 2 {
		t.Fatalf("Ann's log to Kit: %+v", l)
	}
	if len(l.World.Days) != 2 || l.World.Days[0].Date != "2026-11-12" || l.World.Days[1].Date != "2026-11-11" {
		t.Fatalf("the days: %+v", l.World.Days)
	}
	v := l.World.Days[0].Voyages[0]
	// To Kit, a teen: Tom (an adult) counted; Kit herself named; Iron
	// Mary named; Bea a sailor (she blocks Ann); a former sailor; Jo (a
	// teen whose log is open) named.
	names := []string{}
	for _, p := range v.Crew {
		switch {
		case p.Hidden:
			names = append(names, "a sailor")
		case p.Former:
			names = append(names, "a former sailor")
		default:
			names = append(names, p.Name)
		}
	}
	if strings.Join(names, ", ") != "Kit, Iron Mary, a sailor, a former sailor, Jo" || v.Counted != 1 || *v.RunM != 8400 ||
		strings.Join(v.Met, " ") != "gale gale-ridden-out" || l.World.Days[0].RunM != 8400 {
		t.Errorf("the voyage to Kit: %v, %d counted; %+v", names, v.Counted, v)
	}
	if e := l.World.Days[0].Entries[0]; e.Other == nil || e.Other.Name != "Kit" || e.Fault != store.FaultMine {
		t.Errorf("the bump: %+v", e)
	}
	// Life met twice in a day is one entry, counted.
	if es := l.World.Days[0].Entries; len(es) != 2 || es[1].Kind != store.LogMet || es[1].Times != 2 {
		t.Errorf("the day's entries: %+v", es)
	}
	if o := l.World.Days[1].Voyages[0]; o.ClosestM == nil || *o.ClosestM != 12.3 && *o.ClosestM != 12.2 || o.RunM != nil {
		t.Errorf("the fall: %+v", o)
	}
	// To Ann, Tom is counted too (he keeps his log); Kit and Jo are
	// teens; Bea is a sailor.
	l, err = svc.Own(ctx, ann, 0)
	if err != nil {
		t.Fatal(err)
	}
	if v := l.World.Days[0].Voyages[0]; len(v.Crew) != 3 || v.Counted != 3 {
		t.Errorf("the voyage to Ann: %+v", v)
	}
	if l.LoggedFrom == 0 || !l.Own || l.Shown != store.LogShownSailors {
		t.Errorf("Ann's own log: %+v", l)
	}
	// An older world, asked for.
	l, err = svc.Own(ctx, ann, 13)
	if err != nil || l.World == nil || l.World.Number != 13 || l.World.Current {
		t.Errorf("world 13: %+v, %v", l.World, err)
	}
	// The abstract: distance, voyages, places charted, closest.
	kinds := []string{}
	for _, fg := range l.Abstract {
		kinds = append(kinds, fg.Kind)
	}
	if strings.Join(kinds, " ") != "distance voyages charted closest" {
		t.Errorf("the abstract: %+v", l.Abstract)
	}
	// The owner sees every name.
	l, err = svc.ForOwner(ctx, ann, 0)
	if err != nil {
		t.Fatal(err)
	}
	if v := l.World.Days[0].Voyages[0]; v.Counted != 0 || len(v.Crew) != 6 {
		t.Errorf("the voyage to the owner: %+v", v)
	}
	if b, err := json.Marshal(l); err != nil || len(b) > 20000 {
		t.Errorf("the log as JSON: %d bytes, %v", len(b), err)
	}
}

// The collection: every kind of every group, the catalog's and the log's
// own, those found with their counts and where first, this world marked.
func TestCollection(t *testing.T) {
	svc, f, _ := testLogs(t)
	cat := testCatalog(t)
	life := cat.Life.Kinds[0].ID
	f.finds = map[store.AccountID][]store.LogKept{ann: {
		{LogFind: store.LogFind{Group: GroupLife, Kind: life}, Count: 3, FirstWorld: 12, FirstAt: time.Unix(100, 0), FirstPlace: "Gannet Holm", LastWorld: 14},
		{LogFind: store.LogFind{Group: GroupWeather, Kind: WeatherFog}, Count: 1, FirstWorld: 13, LastWorld: 13},
		{LogFind: store.LogFind{Group: GroupBoats, Kind: "no-such-boat"}, Count: 1, FirstWorld: 13, LastWorld: 13},
	}}
	l, err := svc.Own(context.Background(), ann, 0)
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]Group{}
	for _, g := range l.Groups {
		by[g.ID] = g
	}
	if len(by) != 8 || len(by[GroupLife].Kinds) != len(cat.Life.Kinds) || len(by[GroupBoats].Kinds) != len(cat.Boats) ||
		len(by[GroupEdge].Kinds) != len(Ladder) || len(by[GroupWeather].Kinds) != 4 || len(by[GroupIslands].Kinds) != len(cat.World.Biomes) {
		t.Fatalf("the groups: %+v", l.Groups)
	}
	k := by[GroupLife].Kinds[0]
	if k.Count != 3 || !k.ThisWorld || k.First == nil || k.First.World != 12 || k.First.Place != "Gannet Holm" || by[GroupLife].Found != 1 {
		t.Errorf("the first life: %+v", k)
	}
	if by[GroupWeather].Found != 1 || by[GroupWeather].Kinds[2].ThisWorld || by[GroupBoats].Found != 0 {
		t.Errorf("weather and boats: %+v %+v", by[GroupWeather], by[GroupBoats])
	}
	if l.Record.Kinds != 2 || l.Record.Of < 50 {
		t.Errorf("the record's kinds: %d of %d", l.Record.Kinds, l.Record.Of)
	}
}

// A log's ribbons: its races newest first, the counts over every world,
// the races its sailor ran counted and not listed, and a crew's skipper
// named as the log names anyone.
func TestRibbons(t *testing.T) {
	svc, f, _ := testLogs(t)
	ctx := context.Background()
	at := time.Date(2026, 11, 12, 18, 0, 0, 0, time.UTC)
	f.races = map[store.AccountID][]store.RaceRecord{
		jo: {
			{Account: jo, World: 14, At: at, RaceName: "The Noon Gun", Kind: "race", CourseName: "Short triangle", Boat: "b", Fleet: 7,
				Harbour: true, Role: store.RoleCrew, Place: 2, How: store.HowFinished, Awards: []string{}, Skipper: tom, SkipperName: "Tom"},
			{Account: jo, World: 14, At: at.Add(-time.Hour), RaceName: "Jo's Dash", Kind: "race", Role: store.RoleOwner},
			{Account: jo, World: 13, At: at.Add(-48 * time.Hour), RaceName: "The Lantern Race", Kind: "race", Fleet: 5,
				Role: store.RoleSkipper, Place: 5, How: store.HowPlaced, Awards: []string{"spoon"}},
		},
	}
	l, err := svc.ByName(ctx, ann, "Jo", 0)
	if err != nil {
		t.Fatal(err)
	}
	// The log carries the counts alone; its races come by the page.
	if l.Ribbons == nil || l.Ribbons.Counts.Sailed != 2 || l.Ribbons.Races != nil || l.Ribbons.More {
		t.Fatalf("the log's ribbons: %+v", l.Ribbons)
	}
	// No win in the world sailed now: no cockade in the portrait. A win
	// in a world gone keeps its ribbon but not the cockade; a win in this
	// one gives it.
	if l.Cockade {
		t.Error("a cockade without a win")
	}
	f.races[jo][2].Place = 1
	if l, err := svc.ByName(ctx, ann, "Jo", 0); err != nil || l.Cockade {
		t.Errorf("a cockade for a win in a world gone: %v", err)
	}
	f.races[jo][0].Place = 1
	if l, err := svc.ByName(ctx, ann, "Jo", 0); err != nil || !l.Cockade {
		t.Errorf("no cockade for a win in this world: %v", err)
	}
	f.races[jo][0].Place, f.races[jo][2].Place = 2, 5
	ribbons := func(reader store.AccountID, who Who) Ribbons {
		t.Helper()
		r, err := svc.Ribbons(ctx, reader, who, 0)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	r := ribbons(ann, Who{Name: "Jo"})
	if r.Counts.Sailed != 2 || r.Counts.Top3 != 1 || r.Counts.Wins != 0 || r.Counts.Ran != 1 || r.Counts.Awards["spoon"] != 1 {
		t.Fatalf("the counts: %+v", r)
	}
	if len(r.Races) != 2 || r.Races[0].Name != "The Noon Gun" || r.Races[1].Name != "The Lantern Race" || r.Races[1].Awards[0] != "spoon" {
		t.Fatalf("the races: %+v", r.Races)
	}
	// Tom, an adult, crewed for by a teen: his name is not the reader's
	// to see unless his log is (he keeps it), and a teen's reader sees
	// him by the same rule.
	if k := r.Races[0].Skipper; k != nil && k.Name != "" {
		t.Errorf("Tom named to Ann: %+v", k)
	}
	f.races[jo][0].Skipper, f.races[jo][0].SkipperName = bea, "Bea"
	if k := ribbons(kit, Who{Name: "Jo"}).Races[0].Skipper; k != nil && k.Name != "" {
		t.Errorf("an adult named to a teen: %+v", k)
	}
	if k := ribbons(tom, Who{Name: "Jo"}).Races[0].Skipper; k == nil || k.Name != "Bea" {
		t.Errorf("Bea named to Tom: %+v", k)
	}
	if r := ribbons(ann, Who{}); r.Counts.Sailed != 0 || len(r.Races) != 0 || r.More {
		t.Errorf("a log with no races: %+v", r)
	}
	// The ribbons are read by the log's own rule.
	if _, err := svc.Ribbons(ctx, ann, Who{Name: "Nobody"}, 0); !errors.Is(err, ErrNotFound) {
		t.Errorf("an unknown sailor's ribbons: %v", err)
	}
	if _, err := svc.Ribbons(ctx, ann, Who{Machine: jo}, 0); !errors.Is(err, ErrNotFound) {
		t.Errorf("another's sailor as a machine: %v", err)
	}
}

// A log's ribbons come a page at a time, the newest first, with more
// said while older ones follow; the owner's records never among them.
func TestRibbonsByThePage(t *testing.T) {
	svc, f, _ := testLogs(t)
	ctx := context.Background()
	at := time.Date(2026, 11, 12, 18, 0, 0, 0, time.UTC)
	var rs []store.RaceRecord
	for i := range RibbonsPage + 5 {
		rs = append(rs, store.RaceRecord{Account: jo, World: 14, At: at.Add(-time.Duration(i) * time.Hour), RaceName: fmt.Sprint("Race ", i),
			Kind: "race", Fleet: 4, Role: store.RoleSkipper, Place: 2, How: store.HowFinished})
		if i%7 == 0 {
			rs = append(rs, store.RaceRecord{Account: jo, World: 14, At: at, RaceName: "Run by Jo", Kind: "race", Role: store.RoleOwner})
		}
	}
	f.races = map[store.AccountID][]store.RaceRecord{jo: rs}
	first, err := svc.Ribbons(ctx, ann, Who{Name: "Jo"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Races) != RibbonsPage || !first.More || first.Races[0].Name != "Race 0" || first.Counts.Sailed != RibbonsPage+5 {
		t.Fatalf("the first page: %d races, more %v, counts %+v", len(first.Races), first.More, first.Counts)
	}
	next, err := svc.Ribbons(ctx, ann, Who{Name: "Jo"}, RibbonsPage)
	if err != nil {
		t.Fatal(err)
	}
	if len(next.Races) != 5 || next.More || next.Races[4].Name != fmt.Sprint("Race ", RibbonsPage+4) {
		t.Fatalf("the last page: %+v", next.Races)
	}
	if past, err := svc.Ribbons(ctx, ann, Who{Name: "Jo"}, 1000); err != nil || len(past.Races) != 0 || past.More {
		t.Errorf("past the last: %+v, %v", past, err)
	}
}
