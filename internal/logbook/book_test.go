// SPDX-License-Identifier: AGPL-3.0-only

package logbook

import (
	"slices"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sight"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// testCatalog is the game's catalog.
func testCatalog(t testing.TB) *catalog.Catalog {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	return cat
}

// testChart is a chart of an island, Keyhole Rock, charted, with a sea
// arch on it, and a cove off it not yet charted.
func testChart(t testing.TB, cat *catalog.Catalog) *chart.Model {
	t.Helper()
	arch := 1 // a feature kind
	w := chart.WorldOf([]chart.Subject{
		{Subject: sight.Subject{Kind: sight.Island, Number: 7, Island: -1, X: 1000, Y: 1000}, Name: "Keyhole Rock", Title: "Keyhole Rock",
			Sort: 2, Zone: "rim", Biome: string(cat.World.Biomes[3].ID), Worth: 24},
		{Subject: sight.Subject{Kind: sight.Feature, Number: 3, Island: 0, X: 1100, Y: 1000}, Title: "a sea arch on Keyhole Rock", Sort: arch, Worth: 2},
		{Subject: sight.Subject{Kind: sight.Place, Number: 200, Island: -1, X: -3000, Y: 0}, Name: "Pelican Cove", Title: "Pelican Cove", Sort: 4},
	})
	m := chart.NewModel(w, cat, nil)
	m.Add([]store.Charting{{Subject: chart.IslandWord, Number: 7, Written: true}})
	return m
}

// frameOf is a frame with boats of accounts 1… at sea in slots 0…, each at
// x, y.
func frameOf(tick int64, boats ...[2]float64) *bus.Frame {
	f := bus.NewFrame(8)
	f.Tick = tick
	for i, at := range boats {
		s := int32(i)
		f.Live = append(f.Live, s)
		f.Occupied[s] = true
		f.Boat[s] = uint64(10 + i)
		f.Owner[s] = acc(byte(i + 1))
		f.State[s] = physics.State{X: at[0], Y: at[1]}
		f.Voyage[s].Log.Began = 30
	}
	return f
}

func acc(n byte) bus.Account { return bus.Account{15: n} }

func id(n byte) store.AccountID { return store.AccountID(acc(n)) }

func findsOf(fs []store.LogFind) map[string]string {
	out := map[string]string{}
	for _, f := range fs {
		out[f.Group] += f.Kind + " "
	}
	return out
}

// A voyage ended is its sailor's row: its run, how and where it ended,
// those aboard on it, and the kinds it adds; a placed one is none.
func TestBookVoyages(t *testing.T) {
	cat := testCatalog(t)
	epoch := time.Date(2026, 11, 9, 23, 0, 0, 0, time.UTC)
	b := NewBook(Config{World: 14, Epoch: epoch, Chart: testChart(t, cat), Catalog: cat, Boats: []string{"jolly-boat", "keelboat"}})

	// Tom comes aboard Ann's boat at tick 600 and goes ashore at 2400.
	f := frameOf(2400, [2]float64{1000, 1500})
	f.AboardEnds = append(f.AboardEnds, bus.AboardEnded{Tick: 2400, Account: acc(2), Slot: 0, Boat: 10, Skipper: acc(1), Kind: 1,
		BoatName: "Gull", Since: 600, Run: 412, Met: bus.MetNight, How: bus.EndAshore, X: 1000, Y: 1500})
	rows := b.Rows(f, nil)
	if rows == nil || len(rows.Voyages) != 1 {
		t.Fatalf("Tom's time aboard: %+v", rows)
	}
	a := rows.Voyages[0]
	if a.Account != id(2) || !a.Aboard || a.Skipper != id(1) || a.BoatKind != "keelboat" || a.Run != 412 || a.How != store.LogAshore ||
		a.Source != "a:14:10:600" || !a.Began.Equal(epoch.Add(20*time.Second)) || a.Place != "Keyhole Rock" || a.Met != store.LogMetNight {
		t.Errorf("Tom's time aboard: %+v", a)
	}
	if fs := findsOf(a.Finds); fs[GroupBoats] != "keelboat " || fs[GroupWeather] != WeatherNight+" " {
		t.Errorf("Tom's finds: %v", fs)
	}

	// Ann's voyage ends over the lip at 9000, Mira still aboard since
	// 3000: the voyage keeps both, with their time aboard.
	f = frameOf(9000, [2]float64{8000, 0})
	f.Crew = append(f.Crew, bus.Aboard{Slot: 0, Boat: 10, Seat: 1, Account: acc(3), Since: 3000, Machine: true})
	lg := bus.VoyageLog{Began: 30, Run: 5000, BumpsAt: 1, Met: bus.MetGale | bus.RodeGale, GaleX: 1000, GaleY: 900}
	f.VoyageEnds = append(f.VoyageEnds, bus.VoyageEnded{Tick: 9000, Slot: 0, Boat: 10, Owner: acc(1), Kind: 1, BoatName: "Gull",
		How: bus.EndOver, X: 8000, Y: 0, Survived: true, Least: 42, Log: lg})
	rows = b.Rows(f, nil)
	if rows == nil || len(rows.Voyages) != 1 {
		t.Fatalf("Ann's voyage: %+v", rows)
	}
	v := rows.Voyages[0]
	if v.Account != id(1) || v.Aboard || v.How != store.LogOver || v.Run != 5000 || v.Least != 42 || !v.Survived || v.BumpsAt != 1 ||
		v.Source != "v:14:10:30" || v.Place != "" || v.GalePlace != "Keyhole Rock" || v.Met != store.LogMetGale|store.LogRodeGale {
		t.Errorf("Ann's voyage: %+v", v)
	}
	want := []store.LogMate{{ID: id(2), Seconds: 60}, {ID: id(3), Machine: true, Seconds: 200}}
	if !slices.Equal(v.Crew, want) {
		t.Errorf("Ann's crew: %+v, want %+v", v.Crew, want)
	}
	fs := findsOf(v.Finds)
	if fs[GroupBoats] != "keelboat " || fs[GroupWeather] != WeatherGale+" " || fs[GroupEdge] != Rung(50)+" "+Rung(100)+" "+Rung(200)+" "+Rung(500)+" " &&
		fs[GroupEdge] != Rung(500)+" "+Rung(200)+" "+Rung(100)+" "+Rung(50)+" " {
		t.Errorf("Ann's finds: %v", fs)
	}

	// A voyage the owner's tools placed is not in the log.
	f = frameOf(9100, [2]float64{0, 0})
	f.VoyageEnds = append(f.VoyageEnds, bus.VoyageEnded{Tick: 9100, Slot: 0, Boat: 10, Owner: acc(1), How: bus.EndReturned, Placed: true,
		Log: bus.VoyageLog{Began: 9000, Run: 30}})
	if rows := b.Rows(f, nil); rows != nil {
		t.Errorf("a placed voyage: %+v", rows)
	}
}

// A place charted is the skipper's entry and, sighted, the entry of each
// aboard; what is charted with it adds its kinds.
func TestBookCharted(t *testing.T) {
	cat := testCatalog(t)
	m := testChart(t, cat)
	b := NewBook(Config{World: 14, Epoch: time.Unix(0, 0), Chart: m, Catalog: cat})
	f := frameOf(900, [2]float64{900, 900})
	f.Crew = append(f.Crew, bus.Aboard{Slot: 0, Boat: 10, Seat: 1, Account: acc(2), Since: 600})
	f.Machine[0], f.BoatName[0] = true, "Iron Mary"
	f.Charted = append(f.Charted,
		bus.Charted{Tick: 900, Subject: 2, With: -1, Slot: 0, Boat: 10, Owner: acc(1), X: 900, Y: 900},
		bus.Charted{Tick: 900, Subject: 1, With: 2, Slot: 0, Boat: 10, Owner: acc(1), X: 900, Y: 900})
	charts := []store.Charting{m.Charting(&f.Charted[0]), m.Charting(&f.Charted[1])}
	rows := b.Rows(f, charts)
	if rows == nil || len(rows.Entries) != 2 {
		t.Fatalf("the entries: %+v", rows)
	}
	e, s := rows.Entries[0], rows.Entries[1]
	if e.Account != id(1) || e.Kind != store.LogCharted || e.Title != "Pelican Cove" || e.Source != "c:14:place:200" ||
		e.Charting == nil || *e.Charting != (store.ChartKey{Subject: chart.PlaceWord, Number: 200}) || e.What == "" {
		t.Errorf("the skipper's: %+v", e)
	}
	if s.Account != id(2) || s.Kind != store.LogSighted || s.Other != id(1) || !s.OtherMachine || s.OtherBoat != "Iron Mary" || s.Source != e.Source {
		t.Errorf("the one aboard: %+v", s)
	}
	fs := findsOf(e.Finds)
	if fs[GroupPlaces] == "" || fs[GroupFeatures] == "" {
		t.Errorf("the finds: %v", fs)
	}
}

// A bump is an entry of both sailors', whose fault from each one's side;
// a placed voyage's side is left out.
func TestBookBumps(t *testing.T) {
	b := NewBook(Config{World: 3, Epoch: time.Unix(0, 0)})
	f := frameOf(300, [2]float64{0, 0}, [2]float64{5, 0})
	f.BoatName[1] = "Kittiwake"
	f.Machine[1] = true
	f.Bumps = append(f.Bumps, bus.Bump{Tick: 300, A: 0, B: 1, BoatA: 10, BoatB: 11, OwnerA: acc(1), OwnerB: acc(2), Fault: physics.Second, Article: 1},
		bus.Bump{Tick: 270, A: 0, B: 1, BoatA: 10, BoatB: 11, OwnerA: acc(1), OwnerB: acc(2)})
	rows := b.Rows(f, nil)
	if rows == nil || len(rows.Entries) != 2 {
		t.Fatalf("the bump's entries: %+v", rows)
	}
	a, o := rows.Entries[0], rows.Entries[1]
	if a.Account != id(1) || a.Fault != store.FaultTheirs || a.Other != id(2) || !a.OtherMachine || a.OtherBoat != "Kittiwake" || a.Source != "b:3:300:10:11" {
		t.Errorf("Ann's: %+v", a)
	}
	if o.Account != id(2) || o.Fault != store.FaultMine || o.Other != id(1) || o.Source != a.Source {
		t.Errorf("Tom's: %+v", o)
	}
	f.Voyage[1].Placed = true
	if rows := b.Rows(f, nil); rows == nil || len(rows.Entries) != 1 || rows.Entries[0].Account != id(1) {
		t.Errorf("with Tom's voyage placed: %+v", rows)
	}
}

// The sea's life within 300 m of a boat is met by all aboard, once a kind
// a voyage; a group farther off is not.
func TestBookLife(t *testing.T) {
	cat := testCatalog(t)
	b := NewBook(Config{World: 3, Epoch: time.Unix(0, 0), Catalog: cat})
	life := func(tick int64) *bus.Frame {
		f := frameOf(tick, [2]float64{0, 0}, [2]float64{2000, 0})
		f.Crew = append(f.Crew, bus.Aboard{Slot: 0, Boat: 10, Seat: 1, Account: acc(3), Since: 60})
		buildGrid(f)
		f.Life = append(f.Life, bus.LifeEncounter{ID: 1, Kind: 2, Start: 0, End: 10000, East: 200, North: 100, Slot: -1},
			bus.LifeEncounter{ID: 2, Kind: 3, Start: 0, End: 10000, East: 1000, North: 0, Slot: -1})
		return f
	}
	rows := b.Rows(life(90), nil)
	if rows == nil || len(rows.Entries) != 2 {
		t.Fatalf("the life met: %+v", rows)
	}
	for _, e := range rows.Entries {
		if e.Kind != store.LogMet || e.Find != cat.Life.Kinds[2].ID || e.Group != GroupLife || e.Account != id(1) && e.Account != id(3) {
			t.Errorf("met: %+v", e)
		}
	}
	if rows := b.Rows(life(120), nil); rows != nil {
		t.Errorf("met again in the same voyage: %+v", rows)
	}
	if rows := b.Rows(life(121), nil); rows != nil {
		t.Errorf("looked between seconds: %+v", rows)
	}
}

// buildGrid sorts f's boats into the grid, as the simulation does.
func buildGrid(f *bus.Frame) {
	clear(f.Grid.Start)
	f.Grid.Slots = f.Grid.Slots[:0]
	cells := make([][]int32, bus.Cells)
	for _, s := range f.Live {
		c := physics.Cell(f.State[s].X, f.State[s].Y)
		cells[c] = append(cells[c], s)
	}
	for c := range cells {
		f.Grid.Start[c] = int32(len(f.Grid.Slots))
		f.Grid.Slots = append(f.Grid.Slots, cells[c]...)
	}
	f.Grid.Start[bus.Cells] = int32(len(f.Grid.Slots))
}

// The frames' candidate stories of the news: a rare creature met, the
// skipper's, naming those aboard; an approach to the lip within the
// record's reach, to be written if it is nearer than any; a voyage's run,
// and a crew in company of four aboard together long enough; none of a
// common creature, a far approach, or a crew too short aboard.
func TestBookStories(t *testing.T) {
	cat := testCatalog(t)
	rare, common := -1, -1
	for i, k := range cat.Life.Kinds {
		switch {
		case k.News != nil && *k.News && rare < 0:
			rare = i
		case (k.News == nil || !*k.News) && common < 0:
			common = i
		}
	}
	b := NewBook(Config{World: 3, Epoch: time.Unix(0, 0), Catalog: cat, Chart: testChart(t, cat), Boats: []string{"a", "b"}})
	f := frameOf(90, [2]float64{1000, 1500})
	f.BoatName[0] = "Gull"
	f.Crew = append(f.Crew, bus.Aboard{Slot: 0, Boat: 10, Seat: 1, Account: acc(3), Since: 60})
	buildGrid(f)
	f.Life = append(f.Life, bus.LifeEncounter{ID: 1, Kind: uint16(rare), Start: 0, End: 10000, East: 1000, North: 1600, Slot: -1},
		bus.LifeEncounter{ID: 2, Kind: uint16(common), Start: 0, End: 10000, East: 1000, North: 1600, Slot: -1})
	f.Edges = append(f.Edges, bus.EdgeEvent{Tick: 90, Kind: bus.EdgeApproach, Slot: 0, Boat: 10, Owner: acc(1), X: 9000, Y: 0, Distance: 37.26},
		bus.EdgeEvent{Tick: 90, Kind: bus.EdgeApproach, Slot: 0, Boat: 10, Owner: acc(1), X: 9000, Y: 0, Distance: 340})
	rows := b.Rows(f, nil)
	if rows == nil || len(rows.Stories) != 2 {
		t.Fatalf("the stories: %+v", rows)
	}
	life, rec := rows.Stories[0], rows.Stories[1]
	if life.Story != store.StoryLife || life.Account != id(1) || life.Facts.Life != cat.Life.Kinds[rare].ID || !slices.Equal(life.Named, []store.AccountID{id(3)}) ||
		life.Facts.Boat != "Gull" || life.Title != "Keyhole Rock" || !life.Facts.Spot || life.Score != cat.StoryScore(catalog.NewsStoryOfLife) {
		t.Errorf("the creature met: %+v", life)
	}
	if rec.Story != store.StoryRecord || !rec.Record || rec.Amount != 37.3 || rec.Account != id(1) || rec.Source == "" {
		t.Errorf("the record: %+v", rec)
	}
	// Ann's voyage ends: 3 NM run, three aboard with her for an hour,
	// one for a minute.
	f = frameOf(200000, [2]float64{1000, 1500})
	for i, since := range []int64{60, 60, 60, 199000} {
		f.Crew = append(f.Crew, bus.Aboard{Slot: 0, Boat: 10, Seat: uint8(i + 1), Account: acc(byte(4 + i)), Since: since})
	}
	f.VoyageEnds = append(f.VoyageEnds, bus.VoyageEnded{Tick: 200000, Slot: 0, Boat: 10, Owner: acc(1), Kind: 1, BoatName: "Gull",
		How: bus.EndReturned, X: 1000, Y: 1500, Log: bus.VoyageLog{Began: 30, Run: 3 * 1852}})
	rows = b.Rows(f, nil)
	if rows == nil || len(rows.Stories) != 2 {
		t.Fatalf("the voyage's stories: %+v", rows)
	}
	run, crew := rows.Stories[0], rows.Stories[1]
	if run.Story != store.StoryRun || run.Amount != 5556 || run.Facts.BoatKind != "b" {
		t.Errorf("the run: %+v", run)
	}
	if crew.Story != store.StoryCrew || crew.Facts.Aboard != 4 || !slices.Equal(crew.Named, []store.AccountID{id(4), id(5), id(6)}) {
		t.Errorf("the crew: %+v", crew)
	}
}
