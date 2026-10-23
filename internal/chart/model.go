// SPDX-License-Identifier: AGPL-3.0-only

package chart

import (
	"math"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/sight"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The chart as the game shows it is made from what is written, not from
// the simulation's frames: a credit a phone is shown is in the database,
// and a crash that loses a batch's chartings loses them for everyone, to be
// charted again. The model takes each batch's chartings once written
// (Add), and publishes the chart whole, by an atomic pointer, to its
// readers: the game connection, the news and the world page. A published
// chart never changes; the next shares its entries, appended after its
// own, which its readers never read past.

// Chart is the chart at a moment: each subject charted, in the order it
// was, as the wire carries it, and as it was written.
type Chart struct {
	Entries []*pb.ChartEntry
	Rows    []store.Charting
	// Subjects are the entries' subjects, by their index in the world's
	// sight table.
	Subjects []int32
}

// Len is how many subjects are charted.
func (c *Chart) Len() int { return len(c.Entries) }

// Model is a world's chart, as it is written.
type Model struct {
	world *World
	paths []string // the islands' models' addresses, by World.Models' index
	cat   *catalog.Catalog

	mu      sync.Mutex
	charted []bool
	cur     atomic.Pointer[Chart]
	column  string
	fold    time.Duration
}

// NewModel is world w's chart, empty, its islands' models at the addresses
// paths gives by their index in w.Models.
func NewModel(w *World, cat *catalog.Catalog, paths []string) *Model {
	m := &Model{world: w, paths: paths, cat: cat, charted: make([]bool, len(w.Subjects))}
	for _, c := range cat.News.Columns {
		if c.Of == catalog.OfCharting && m.column == "" {
			m.column = string(c.ID)
		}
	}
	m.fold = time.Duration(cat.News.Fold * float64(time.Minute))
	m.cur.Store(&Chart{})
	return m
}

// World is what can be charted.
func (m *Model) World() *World { return m.world }

// FoldWithin is how long a sailor's news item about an island takes in what
// they chart about it.
func (m *Model) FoldWithin() time.Duration { return m.fold }

// Entries are the chart's entries as it stands: an edge.ChartSource.
func (m *Model) Entries() []*pb.ChartEntry { return m.cur.Load().Entries }

// Load is the chart as it stands.
func (m *Model) Load() *Chart { return m.cur.Load() }

// Add puts what was written on the chart, each subject once, and publishes
// it.
func (m *Model) Add(rows []store.Charting) {
	m.mu.Lock()
	defer m.mu.Unlock()
	old := m.cur.Load()
	next := &Chart{Entries: old.Entries, Rows: old.Rows, Subjects: old.Subjects}
	added := false
	for _, r := range rows {
		i := m.world.Index(KindOf(r.Subject), r.Number)
		if i < 0 || m.charted[i] {
			continue
		}
		m.charted[i] = true
		next.Entries = append(next.Entries, m.entry(i, &r))
		next.Rows = append(next.Rows, r)
		next.Subjects = append(next.Subjects, i)
		added = true
	}
	if added {
		m.cur.Store(next)
	}
}

// Forget takes an account's name off its credits, the account having been
// deleted: they keep their places, read as a former sailor's, as the
// database's do. The chart published from now on carries them so; a
// player's connection already open is sent what is charted next, and sees
// the old credits so when it connects again.
func (m *Model) Forget(account [16]byte) {
	m.mu.Lock()
	defer m.mu.Unlock()
	old := m.cur.Load()
	next := &Chart{Entries: slices.Clone(old.Entries), Rows: slices.Clone(old.Rows), Subjects: old.Subjects}
	changed := false
	for i := range next.Rows {
		r := &next.Rows[i]
		if !r.Credited || r.Account != account || r.Sailor == "" {
			continue
		}
		r.Sailor = ""
		next.Entries[i] = m.entry(next.Subjects[i], r)
		changed = true
	}
	if changed {
		m.cur.Store(next)
	}
}

// Credit is who a charting is credited to, as the chart shows them: the
// sailor's name as it was then; "a former sailor" for an account deleted
// since; "a sailor" for one of the server's own, which has no name.
func Credit(r *store.Charting) string {
	switch {
	case r.Sailor != "":
		return r.Sailor
	case r.AccountKind != "":
		return FormerSailor
	}
	return "a sailor"
}

// FormerSailor is how a credit of an account deleted reads.
const FormerSailor = "a former sailor"

// Charted are the subjects charted, by their index in the sight table.
func (m *Model) Charted() []int32 { return m.cur.Load().Subjects }

// cm is a length in centimetres.
func cm(v float64) int32 { return int32(math.Round(v * 100)) }

// subjectOf is a subject kind on the wire.
func subjectOf(k uint8) pb.ChartSubject {
	switch k {
	case sight.Island:
		return pb.ChartSubject_CHART_SUBJECT_ISLAND
	case sight.Place:
		return pb.ChartSubject_CHART_SUBJECT_PLACE
	case sight.Feature:
		return pb.ChartSubject_CHART_SUBJECT_FEATURE
	}
	return pb.ChartSubject_CHART_SUBJECT_UNSPECIFIED
}

// zoneNumber is a zone as the wire numbers it.
func zoneNumber(z string) uint32 {
	switch z {
	case "middle":
		return 1
	case "rim":
		return 2
	}
	return 0
}

// entry is subject i's entry, charted as r says.
func (m *Model) entry(i int32, r *store.Charting) *pb.ChartEntry {
	w := m.world
	s := &w.Subjects[i]
	e := &pb.ChartEntry{
		Subject: subjectOf(s.Kind), Number: uint32(s.Number), Sort: uint32(s.Sort), Name: s.Name,
		East: cm(s.X), North: cm(s.Y), WhenMs: r.At.UnixMilli(), Worth: uint32(math.Round(s.Worth * 10)),
		Zone: zoneNumber(s.Zone), Ship: s.Ship, Sunk: s.Sunk,
	}
	if r.Credited {
		e.By, e.Ai = Credit(r), r.AccountKind == string(store.AI)
	}
	if s.Island >= 0 {
		e.Island = uint32(w.Subjects[s.Island].Number) + 1
	}
	if s.Kind == sight.Island {
		e.Group, e.Class = s.Group, s.Class
		e.Bounds = []int32{cm(s.Bounds[0]), cm(s.Bounds[1]), cm(s.Bounds[2]), cm(s.Bounds[3])}
		e.Highest = uint32(max(cm(s.Highest), 0))
		if s.Model >= 0 && s.Model < len(m.paths) {
			e.Model = m.paths[s.Model]
		}
	}
	if s.Light >= 0 && s.Light < len(w.Lights) {
		l := &w.Lights[s.Light]
		e.Light, e.Character, e.Focal, e.Range = uint32(l.Number)+1, uint32(l.Character), uint32(max(cm(l.Focal), 0)), uint32(math.Round(l.Range))
	}
	if r.WithSubject != "" {
		e.WithSubject, e.WithNumber = subjectOf(KindOf(r.WithSubject)), uint32(r.WithNumber)
	}
	return e
}

// Charting is a sighting's row, with the news it makes: a persist.Chart.
func (m *Model) Charting(c *bus.Charted) store.Charting {
	w := m.world
	s := &w.Subjects[c.Subject]
	row := store.Charting{
		Subject: KindWord(s.Kind), Number: s.Number, Credited: c.Slot >= 0 && c.Boat != 0,
		Tick: c.Tick, Worth: s.Worth,
	}
	if row.Credited {
		row.Account, row.Boat, row.X, row.Y = c.Owner, c.Boat, c.X, c.Y
	}
	if c.With >= 0 {
		ws := &w.Subjects[c.With]
		row.WithSubject, row.WithNumber = KindWord(ws.Kind), ws.Number
	}
	if row.Credited && c.With < 0 && m.column != "" {
		island := int32(-1)
		switch {
		case s.Kind == sight.Island:
			island = s.Number
		case s.Island >= 0:
			island = w.Subjects[s.Island].Number
		}
		row.News = &store.NewsItem{Column: m.column, Title: s.Title, What: m.what(s), Island: island, Fold: !s.News, X: s.X, Y: s.Y}
	}
	return row
}

// what is what a subject is, as the news says it: "an island of the rim",
// "a lighthouse on Gannet Holm", "a reef of the middle waters".
func (m *Model) what(s *Subject) string {
	w := m.world
	zone := zoneWords(s.Zone)
	switch s.Kind {
	case sight.Island:
		if s.Group != "" {
			return "one of " + s.Group + ", " + strings.TrimPrefix(zone, "of ")
		}
		return "an island " + zone
	case sight.Place:
		kind := article(m.cat.World.Places.Kinds[s.Sort].Name)
		if s.Island >= 0 {
			return kind + " on " + w.Subjects[s.Island].Name
		}
		return kind + " " + zone
	}
	if s.Island >= 0 {
		return "on " + w.Subjects[s.Island].Name
	}
	return zone
}

// zoneWords is a zone as the news says where a subject is.
func zoneWords(z string) string {
	switch z {
	case "middle":
		return "of the middle waters"
	case "rim":
		return "of the rim"
	}
	return "of the inner waters"
}
