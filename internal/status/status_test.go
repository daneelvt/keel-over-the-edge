// SPDX-License-Identifier: AGPL-3.0-only

package status

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"math"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sight"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/watch"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
	"github.com/daneelvt/keel-over-the-edge/internal/worlds"
)

var update = flag.Bool("update", false, "write testdata/seed1.json again")

// seed1 is seed 1's world, made once.
var seed1 = sync.OnceValues(func() (*worldgen.Bundle, error) {
	cat, err := catalog.Load()
	if err != nil {
		return nil, err
	}
	return worldgen.Generate(1, cat)
})

// sea is seed 1's world for a status: its chart, with what is known from
// the start charted; its weather, the catalog's sample week, at a moment
// of it with weather to show; and boats anyone may watch, as given.
type sea struct {
	t     testing.TB
	cat   *catalog.Catalog
	cw    *chart.World
	model *chart.Model
	w     *sim.World
	boats []watch.Seen
	asked int
	now   time.Time
	b     *Builder
}

// stormy is a tick of the sample week with a front crossing the disk and
// eighteen systems on it, a busy sky.
const stormy = 49 * 3600 * physics.StepsPerSecond

func newSea(t testing.TB) *sea {
	t.Helper()
	if testing.Short() {
		t.Skip("makes a whole world")
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := seed1()
	if err != nil {
		t.Fatal(err)
	}
	tl, err := weather.FromCatalog(cat)
	if err != nil {
		t.Fatal(err)
	}
	waves, kinds := cat.Prepare()
	w, err := sim.New(sim.Config{Capacity: 64, Kinds: kinds, Waves: waves, Weather: tl, Tick: stormy})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	w.Tick()
	cw := chart.Build(bundle, cat)
	s := &sea{t: t, cat: cat, cw: cw, model: chart.NewModel(cw, cat, nil), w: w,
		now: time.Date(2026, 11, 17, 21, 30, 0, 0, time.UTC)}
	var known []store.Charting
	for _, i := range cw.Known {
		sub := &cw.Subjects[i]
		known = append(known, store.Charting{Subject: chart.KindWord(sub.Kind), Number: sub.Number, At: s.now.Add(-7 * 24 * time.Hour)})
	}
	s.model.Add(known)
	sched, err := worlds.Parse(worlds.Default)
	if err != nil {
		t.Fatal(err)
	}
	s.b = New(Config{Frames: w.Bus().Frames, Chart: s.model, Catalog: cat, Timeline: tl, Sky: cat.PrepareSky(),
		Epoch: s.now.Add(-6 * 24 * time.Hour), World: 7, Ends: func() time.Time { return time.Date(2026, 11, 22, 23, 0, 0, 0, time.UTC) },
		Schedule: sched, Limit: 12, Now: func() time.Time { return s.now },
		Boats: func(_ context.Context, n int) ([]watch.Seen, error) {
			s.asked++
			return s.boats[:min(n, len(s.boats))], nil
		}})
	return s
}

// chart charts the subjects keep keeps that are not charted yet, each
// credited to a sailor.
func (s *sea) chart(keep func(i int32) bool) {
	var rows []store.Charting
	charted := map[int32]bool{}
	for _, i := range s.model.Charted() {
		charted[i] = true
	}
	for i := range s.cw.Subjects {
		if charted[int32(i)] || !keep(int32(i)) {
			continue
		}
		sub := &s.cw.Subjects[i]
		rows = append(rows, store.Charting{Subject: chart.KindWord(sub.Kind), Number: sub.Number, Credited: true,
			Account: store.AccountID{1}, Sailor: "Ann Bonny", AccountKind: string(store.Human), At: s.now.Add(-time.Hour)})
	}
	s.model.Add(rows)
}

func (s *sea) status() *Status {
	s.t.Helper()
	body, _, err := s.b.JSON(context.Background())
	if err != nil {
		s.t.Fatal(err)
	}
	var st Status
	if err := json.Unmarshal(body, &st); err != nil {
		s.t.Fatal(err)
	}
	return &st
}

// row is a subject of the map's tables, its coast's rings in m.
type row struct {
	subject, name, kind string
	east, north, rank   int
	coast               [][]int
}

// rows are the map's tables' subjects, islands first.
func rows(m *Map) []row {
	var out []row
	for i := range m.Islands.Name {
		r := row{subject: chart.IslandWord, name: m.Islands.Name[i], east: m.Islands.East[i], north: m.Islands.North[i], rank: m.Islands.Rank[i]}
		for _, steps := range m.Islands.Coast[i] {
			r.coast = append(r.coast, points(steps))
		}
		out = append(out, r)
	}
	for i := range m.Places.Name {
		out = append(out, row{subject: chart.PlaceWord, name: m.Places.Name[i], kind: m.Places.Kind[i], east: m.Places.East[i], north: m.Places.North[i], rank: m.Places.Rank[i]})
	}
	for i := range m.Features.Kind {
		out = append(out, row{subject: chart.FeatureWord, kind: m.Features.Kind[i], east: m.Features.East[i], north: m.Features.North[i]})
	}
	return out
}

// points is a ring's points, m east and north in turn, from its steps.
func points(steps []int) []int {
	out := make([]int, len(steps))
	for k, v := range steps {
		out[k] = v * Grain
		if k >= 2 {
			out[k] += out[k-2]
		}
	}
	return out
}

// TestNothingUncharted: with half the world charted, the status holds every
// subject charted and nothing else: no uncharted island, place or
// feature, no name of one, and no coast but a charted island's, every
// point of it within its island's own land's bounds.
func TestNothingUncharted(t *testing.T) {
	s := newSea(t)
	s.chart(func(i int32) bool { return i%2 == 0 })
	st := s.status()
	body, _, _ := s.b.JSON(context.Background())
	charted := map[int32]bool{}
	for _, i := range s.model.Charted() {
		charted[i] = true
	}
	if len(rows(&st.Map)) != len(charted) {
		t.Fatalf("%d places, %d charted", len(rows(&st.Map)), len(charted))
	}
	uncharted := 0
	for i := range s.cw.Subjects {
		sub := &s.cw.Subjects[i]
		if charted[int32(i)] {
			continue
		}
		uncharted++
		for _, word := range []string{sub.Name, sub.Title, sub.Ship} {
			if word != "" && bytes.Contains(body, []byte(`"`+word+`"`)) {
				t.Errorf("uncharted %q is in the status", word)
			}
		}
	}
	if uncharted < 100 {
		t.Fatalf("only %d uncharted subjects: not half the world", uncharted)
	}
	// Every place is a charted subject at its place, and every coast is a
	// charted island's, within its land's bounds and a cell.
	islands := 0
	for _, p := range rows(&st.Map) {
		var found *chart.Subject
		for _, i := range s.model.Charted() {
			sub := &s.cw.Subjects[i]
			if chart.KindWord(sub.Kind) == p.subject && roundTo(sub.X, Grain) == p.east && roundTo(sub.Y, Grain) == p.north {
				found = sub
				break
			}
		}
		if found == nil {
			t.Errorf("a place charted nowhere: %+v", p)
			continue
		}
		if p.coast == nil {
			// Only an island too small to outline at Grain has none.
			if bd := found.Bounds; p.subject == chart.IslandWord && found.Model >= 0 && math.Max(bd[2]-bd[0], bd[3]-bd[1]) > 4*Grain {
				t.Errorf("%s, %.0f × %.0f m, has no coast", found.Name, bd[2]-bd[0], bd[3]-bd[1])
			}
			continue
		}
		islands++
		if p.subject != chart.IslandWord {
			t.Errorf("a coast of a %s", p.subject)
		}
		bd := found.Bounds
		for _, ring := range p.coast {
			for k := 0; k < len(ring); k += 2 {
				e, n := float64(ring[k]), float64(ring[k+1])
				if e < bd[0]-60 || e > bd[2]+60 || n < bd[1]-60 || n > bd[3]+60 {
					t.Fatalf("%s's coast at (%v, %v), beyond its bounds %v", found.Name, e, n, bd)
				}
			}
		}
	}
	if islands < 10 {
		t.Errorf("only %d coasts", islands)
	}
}

// TestCharted: charted counts what the world's sailors charted, not what
// is known from the start.
func TestCharted(t *testing.T) {
	s := newSea(t)
	if st := s.status(); st.Charted != 0 || len(rows(&st.Map)) != len(s.cw.Known) {
		t.Fatalf("at the start: %d charted, %d places, %d known", st.Charted, len(rows(&st.Map)), len(s.cw.Known))
	}
	n := 0
	s.chart(func(i int32) bool {
		if s.cw.Subjects[i].Kind == sight.Island && n < 5 {
			n++
			return true
		}
		return false
	})
	s.now = s.now.Add(Kept)
	if st := s.status(); st.Charted != 5 || len(rows(&st.Map)) != len(s.cw.Known)+5 {
		t.Errorf("five charted: %d charted, %d places", st.Charted, len(rows(&st.Map)))
	}
}

// TestRounded: places and coasts to Grain, boats to BoatGrain and their
// headings to HeadingStep; at most Limit boats, unnamed.
func TestRounded(t *testing.T) {
	s := newSea(t)
	s.chart(func(i int32) bool { return true })
	for i := range 20 {
		s.boats = append(s.boats, watch.Seen{East: 1234.5 + float64(i), North: -987.6, Heading: -0.2 + float64(i), Kind: "skiff", Machine: i%2 == 0})
	}
	st := s.status()
	for _, p := range rows(&st.Map) {
		if p.east%Grain != 0 || p.north%Grain != 0 {
			t.Errorf("%s at (%d, %d)", p.name, p.east, p.north)
		}
		for _, ring := range p.coast {
			for _, v := range ring {
				if v%Grain != 0 {
					t.Fatalf("%s's coast at %d", p.name, v)
				}
			}
		}
	}
	if len(st.Map.Boats) != 12 || s.asked != 1 {
		t.Fatalf("%d boats, asked %d times", len(st.Map.Boats), s.asked)
	}
	for _, b := range st.Map.Boats {
		if b.East != 1200 || b.North != -1000 || b.Heading%HeadingStep != 0 || b.Heading < 0 || b.Heading >= 360 || b.Boat != "skiff" {
			t.Errorf("a boat: %+v", b)
		}
	}
	if b := st.Map.Boats[0]; b.Heading != 345 || !b.Machine {
		t.Errorf("the first boat, heading 349°: %+v", b)
	}
	body, _, _ := s.b.JSON(context.Background())
	var raw map[string]any
	_ = json.Unmarshal(body, &raw)
	boat := raw["map"].(map[string]any)["boats"].([]any)[0].(map[string]any)
	keys := slices.Sorted(func(yield func(string) bool) {
		for k := range boat {
			if !yield(k) {
				return
			}
		}
	})
	if strings.Join(keys, ",") != "boat,east,heading,machine,north" {
		t.Errorf("a boat's fields: %v", keys)
	}
}

// TestKept: the status is built once for every call within Kept.
func TestKept(t *testing.T) {
	s := newSea(t)
	a := s.status()
	s.now = s.now.Add(Kept - time.Second)
	b := s.status()
	if s.asked != 1 || a.At != b.At {
		t.Errorf("built %d times within %v", s.asked, Kept)
	}
	s.now = s.now.Add(time.Second)
	if c := s.status(); s.asked != 2 || c.At == a.At {
		t.Errorf("not built again after %v", Kept)
	}
}

// TestSeed1: seed 1's world at a busy moment, with twelve boats: half of
// it charted, its status is under 40 KB; all of it charted, as no week's
// charting yet has, it is under 40 KB as sent, gzipped. That one is
// written to testdata/seed1.json with -update, for the website's tests.
// The sizes, and how long a status takes to build, cold and with the
// coasts kept, are logged.
func TestSeed1(t *testing.T) {
	s := newSea(t)
	b := s.cw.Subjects[0]
	// Twelve boats, the most shown, of every kind.
	for i := range 12 {
		a := float64(i) * 0.52
		s.boats = append(s.boats, watch.Seen{East: b.X + 400*float64(i+1)*math.Sin(a), North: b.Y + 400*float64(i+1)*math.Cos(a),
			Heading: 2.9 * float64(i), Kind: string(s.cat.Boats[i%len(s.cat.Boats)].ID), Machine: i%3 != 1})
	}
	measure := func(what string) (body, gz []byte) {
		t.Helper()
		s.now = s.now.Add(Kept)
		start := time.Now()
		body, gz, err := s.b.JSON(context.Background())
		cold := time.Since(start)
		if err != nil {
			t.Fatal(err)
		}
		start = time.Now()
		_, _, _ = s.b.JSON(context.Background())
		kept := time.Since(start)
		s.now = s.now.Add(Kept)
		start = time.Now()
		_, _, _ = s.b.JSON(context.Background())
		again := time.Since(start)
		st := s.status()
		rings, points := 0, 0
		for _, p := range rows(&st.Map) {
			rings += len(p.coast)
			for _, r := range p.coast {
				points += len(r) / 2
			}
		}
		t.Logf("%s: %d bytes, %d gzipped; %d places, %d coasts' rings of %d points, %d systems, %d fronts, %d boats; built in %v with new coasts, %v again, %v kept",
			what, len(body), len(gz), len(rows(&st.Map)), rings, points, len(st.Map.Weather.Systems), len(st.Map.Weather.Fronts), len(st.Map.Boats),
			cold.Round(time.Microsecond), again.Round(time.Microsecond), kept.Round(time.Microsecond))
		return body, gz
	}
	s.chart(func(i int32) bool { return i%2 == 0 })
	if body, _ := measure("half charted"); len(body) >= 40<<10 {
		t.Errorf("half charted, %d bytes: not under 40 KB", len(body))
	}
	s.chart(func(i int32) bool { return true })
	body, gz := measure("all charted")
	if len(gz) >= 40<<10 {
		t.Errorf("all charted, %d bytes gzipped: not under 40 KB", len(gz))
	}
	st := s.status()
	wx := st.Map.Weather
	if len(wx.Systems) < 10 || len(wx.Fronts) == 0 || wx.N != GridSide {
		t.Errorf("the weather at a busy moment: %d systems, %d fronts, %d a side", len(wx.Systems), len(wx.Fronts), wx.N)
	}
	for name, f := range map[string]Field{"mean": wx.Mean, "from": wx.From, "gust": wx.Gust, "rain": wx.Rain, "fog": wx.Fog, "pressure": wx.Pressure} {
		if len(f.V) != GridSide*GridSide {
			t.Errorf("the weather's %s: %d values", name, len(f.V))
		}
	}
	if *update {
		// As sent, on one line.
		if err := os.WriteFile("testdata/seed1.json", append(slices.Clone(body), '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// TestFieldJSON: a field's values with their decimals, whole numbers bare,
// NaN as null.
func TestFieldJSON(t *testing.T) {
	b, err := json.Marshal(Field{V: []float64{7.04, 7.06, -0.01, math.NaN(), 12}, Places: 1})
	if err != nil || string(b) != "[7,7.1,0,null,12]" {
		t.Errorf("%s %v", b, err)
	}
	b, _ = json.Marshal(Field{V: []float64{23456, 4}, Step: 10})
	if string(b) != "[23460,0]" {
		t.Errorf("%s", b)
	}
}

// BenchmarkBuild is a status of seed 1 all charted at a busy moment:
// cold, its islands' coasts worked out, as at a world's first call; and
// with them kept, as every 30 s after.
func BenchmarkBuild(bm *testing.B) {
	s := newSea(bm)
	s.chart(func(i int32) bool { return true })
	bm.Run("cold", func(bm *testing.B) {
		for bm.Loop() {
			s.b.coasts = map[int32][][]int{}
			s.now = s.now.Add(Kept)
			_, _, _ = s.b.JSON(context.Background())
		}
	})
	bm.Run("kept", func(bm *testing.B) {
		for bm.Loop() {
			s.now = s.now.Add(Kept)
			_, _, _ = s.b.JSON(context.Background())
		}
	})
}
