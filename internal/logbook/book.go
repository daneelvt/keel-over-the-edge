// SPDX-License-Identifier: AGPL-3.0-only

// Package logbook keeps every sailor's log: what they did at sea, from
// world to world. Book turns what the simulation's frames tell of it into
// the log's rows, which the world's writer writes with the events that
// cause them (internal/persist), in the same fenced transaction: each
// voyage and each time aboard another's boat as it ends, each place
// charted (credited to the skipper, sighted by those aboard), each bump,
// and each kind of the sea's life met. Service reads a log, as its sailor
// and other sailors may, naming the sailors in it by one rule (NameOf),
// which the news follows too. The backfill copies into the log what the
// worlds still kept recorded before it was kept (Backfill).
package logbook

import (
	"fmt"
	"math"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/sight"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The log's numbers.
const (
	// NearLife is how near a boat a group of the sea's life is met, m: the
	// near band of the life's reach.
	NearLife = 300.0
	// PlaceReach is how far from a charted island or place the log names
	// it, "off" it, m: two nautical miles.
	PlaceReach = 2 * 1852.0
)

// The groups of the collection, each a list of the catalog's kinds but the
// log's own: the weather met and the edge's ladder.
const (
	GroupIslands  = "islands"  // the islands' biomes
	GroupSizes    = "sizes"    // the islands' size classes
	GroupFeatures = "features" // the features of islands, the colonies among them
	GroupPlaces   = "places"   // the kinds of place
	GroupLife     = "life"     // the sea's life
	GroupWeather  = "weather"  // the weather met: Weather's kinds
	GroupEdge     = "edge"     // the closest approaches survived: Ladder's rungs
	GroupBoats    = "boats"    // the boats sailed
)

// The weather group's kinds.
const (
	WeatherGale  = "gale-ridden-out"
	WeatherStorm = "storm-ridden-out"
	WeatherFog   = "landfall-in-fog"
	WeatherNight = "night-at-sea"
)

// Weather is the weather group's kinds, in their order.
var Weather = []string{WeatherGale, WeatherStorm, WeatherFog, WeatherNight}

// Ladder is the edge group's rungs: a voyage that survives an approach to
// the lip within a rung, m, finds it.
var Ladder = []int{500, 200, 100, 50, 20, 10}

// Rung is the edge group's kind for a rung of the ladder.
func Rung(m int) string { return fmt.Sprintf("within-%dm", m) }

// Book turns frames into the log's rows: a persist.Logbook. It is used on
// the ticking goroutine only.
type Book struct {
	world  int
	epoch  time.Time
	model  *chart.Model
	boats  []string // the boats' kinds' IDs, by the world's index
	life   []catalog.LifeKind
	places []string // the place kinds' IDs, by the catalog's index
	feats  []string // the feature kinds' IDs, by the catalog's index
	sizes  []string // the size classes, by the catalog's index

	// met are the kinds of life met already, by whom and in which voyage
	// or time aboard; mates those who were aboard each boat this voyage.
	met   map[metKey]struct{}
	mates map[uint64][]mate
	near  []int32
}

// metKey is a kind of life met by an account in a voyage, or a time
// aboard, begun at a tick.
type metKey struct {
	account bus.Account
	began   int64
	kind    uint16
}

// mate is someone who was aboard a boat, from since to until.
type mate struct {
	account      bus.Account
	machine      bool
	since, until int64
}

// Config sets up a Book.
type Config struct {
	World   int       // the world's number
	Epoch   time.Time // its epoch, when its tick 0 was
	Chart   *chart.Model
	Catalog *catalog.Catalog
	// Boats are the boats' kinds' IDs, by the world's index of kinds.
	Boats []string
}

// NewBook makes a Book.
func NewBook(cfg Config) *Book {
	b := &Book{world: cfg.World, epoch: cfg.Epoch, model: cfg.Chart, boats: cfg.Boats,
		met: map[metKey]struct{}{}, mates: map[uint64][]mate{}}
	if c := cfg.Catalog; c != nil {
		b.life = c.Life.Kinds
		for _, k := range c.World.Places.Kinds {
			b.places = append(b.places, string(k.ID))
		}
		for _, k := range c.World.Features.Kinds {
			b.feats = append(b.feats, string(k.ID))
		}
		for _, s := range c.World.Sizes {
			b.sizes = append(b.sizes, s.Class)
		}
	}
	return b
}

// At is the time of a tick of the world.
func (b *Book) At(tick int64) time.Time {
	return b.epoch.Add(time.Duration(tick) * time.Second / physics.StepsPerSecond).UTC()
}

// Rows makes the rows of the log that frame f tells of, charts its
// chartings' rows, or nil if none.
func (b *Book) Rows(f *bus.Frame, charts []store.Charting) *store.LogRows {
	var out *store.LogRows
	rows := func() *store.LogRows {
		if out == nil {
			out = &store.LogRows{}
		}
		return out
	}
	for i := range f.AboardEnds {
		b.aboardEnded(f, &f.AboardEnds[i], rows)
	}
	for i := range f.VoyageEnds {
		b.voyageEnded(f, &f.VoyageEnds[i], rows)
	}
	if len(f.Charted) > 0 && len(charts) == len(f.Charted) {
		b.charted(f, charts, rows)
	}
	for i := range f.Bumps {
		if bp := &f.Bumps[i]; bp.Tick == f.Tick {
			b.bumped(f, bp, rows)
		}
	}
	if f.Tick%bus.LogEvery == 0 && len(f.Life) > 0 {
		b.lifeMet(f, rows)
	}
	return out
}

// kindID is the ID of the world's boat kind k.
func (b *Book) kindID(k uint16) string {
	if int(k) < len(b.boats) {
		return b.boats[k]
	}
	return ""
}

// how is a voyage's end as the log keeps it.
func how(h uint8) string {
	switch h {
	case bus.EndReturned:
		return store.LogReturned
	case bus.EndExpired:
		return store.LogExpired
	case bus.EndOver:
		return store.LogOver
	case bus.EndTaken:
		return store.LogTaken
	case bus.EndAboard:
		return store.LogAboard
	case bus.EndLanded:
		return store.LogLanded
	}
	return store.LogAshore
}

// met is the weather a voyage met as the log keeps it.
func met(m uint8) int {
	var out int
	for _, f := range [...][2]int{
		{bus.MetGale, store.LogMetGale}, {bus.MetStorm, store.LogMetStorm}, {bus.RodeGale, store.LogRodeGale},
		{bus.RodeStorm, store.LogRodeStorm}, {bus.MetFog, store.LogMetFog}, {bus.MetNight, store.LogMetNight},
	} {
		if int(m)&f[0] != 0 {
			out |= f[1]
		}
	}
	return out
}

// weatherFinds are the weather group's kinds of what a voyage met.
func weatherFinds(m uint8, dst []store.LogFind) []store.LogFind {
	if m&bus.RodeGale != 0 {
		dst = append(dst, store.LogFind{Group: GroupWeather, Kind: WeatherGale})
	}
	if m&bus.RodeStorm != 0 {
		dst = append(dst, store.LogFind{Group: GroupWeather, Kind: WeatherStorm})
	}
	if m&bus.MetFog != 0 {
		dst = append(dst, store.LogFind{Group: GroupWeather, Kind: WeatherFog})
	}
	if m&bus.MetNight != 0 {
		dst = append(dst, store.LogFind{Group: GroupWeather, Kind: WeatherNight})
	}
	return dst
}

// ladderFinds are the edge group's rungs an approach survived least m
// from the lip reaches.
func ladderFinds(least float64, dst []store.LogFind) []store.LogFind {
	for _, r := range Ladder {
		if least <= float64(r) {
			dst = append(dst, store.LogFind{Group: GroupEdge, Kind: Rung(r)})
		}
	}
	return dst
}

// voyageEnded makes a voyage's row, unless the owner's tools placed it.
func (b *Book) voyageEnded(f *bus.Frame, e *bus.VoyageEnded, rows func() *store.LogRows) {
	lg := &e.Log
	began := lg.Began
	crew := b.crewOf(f, e.Slot, e.Boat, began, e.Tick)
	delete(b.mates, e.Boat)
	b.forget(e.Owner)
	if e.Placed {
		return
	}
	v := store.LogVoyage{
		Account: store.AccountID(e.Owner), Source: fmt.Sprintf("v:%d:%d:%d", b.world, e.Boat, began), World: b.world,
		Boat: e.Boat, BoatKind: b.kindID(e.Kind), BoatName: e.BoatName, Began: b.At(began), Ended: b.At(e.Tick),
		How: how(e.How), Run: lg.Run, Logged: true, Place: b.Place(e.X, e.Y), Least: e.Least, Survived: e.Survived,
		BumpsAt: int(lg.BumpsAt), BumpsNot: int(lg.BumpsNot), Met: met(lg.Met), Crew: crew,
	}
	if lg.Met&(bus.MetGale|bus.MetStorm) != 0 {
		v.GalePlace = b.Place(lg.GaleX, lg.GaleY)
	}
	if lg.Met&bus.MetFog != 0 {
		v.FogPlace = b.Place(lg.FogX, lg.FogY)
	}
	if v.BoatKind != "" {
		v.Finds = append(v.Finds, store.LogFind{Group: GroupBoats, Kind: v.BoatKind})
	}
	v.Finds = weatherFinds(lg.Met, v.Finds)
	if e.Survived {
		v.Finds = ladderFinds(e.Least, v.Finds)
	}
	r := rows()
	r.Voyages = append(r.Voyages, v)
}

// crewOf are those who were aboard the boat in slot s, boat, between
// tick began and end: those who went ashore meanwhile, and those still
// aboard, each once with their time aboard in it.
func (b *Book) crewOf(f *bus.Frame, s int32, boat uint64, began, end int64) []store.LogMate {
	all := b.mates[boat]
	if s >= 0 && int(s) < f.Capacity() && f.Occupied[s] && f.Boat[s] == boat {
		lo, hi := f.CrewOf(s)
	crew:
		for _, a := range f.Crew[lo:hi] {
			for _, m := range all {
				if m.account == a.Account && m.since == a.Since {
					// Gone ashore this tick, as the world ended.
					continue crew
				}
			}
			all = append(all[:len(all):len(all)], mate{account: a.Account, machine: a.Machine, since: a.Since, until: end})
		}
	}
	var out []store.LogMate
	for _, m := range all {
		from, to := max(m.since, began), min(m.until, end)
		if to <= from {
			continue
		}
		secs := int((to - from) / physics.StepsPerSecond)
		found := false
		for i := range out {
			if out[i].ID == store.AccountID(m.account) {
				out[i].Seconds += secs
				found = true
			}
		}
		if !found {
			out = append(out, store.LogMate{ID: store.AccountID(m.account), Machine: m.machine, Seconds: secs})
		}
	}
	return out
}

// aboardEnded makes a time aboard's row, unless the owner's tools placed
// the boat's voyage, and keeps who was aboard for the skipper's.
func (b *Book) aboardEnded(f *bus.Frame, a *bus.AboardEnded, rows func() *store.LogRows) {
	b.mates[a.Boat] = append(b.mates[a.Boat], mate{account: a.Account, machine: a.Machine, since: a.Since, until: a.Tick})
	b.forget(a.Account)
	if a.Placed {
		return
	}
	// The others aboard: those still aboard, and those going ashore
	// with them.
	var others []store.LogMate
	add := func(id bus.Account, machine bool, since int64) {
		if id == a.Account {
			return
		}
		for _, o := range others {
			if o.ID == store.AccountID(id) {
				return
			}
		}
		from := max(since, a.Since)
		others = append(others, store.LogMate{ID: store.AccountID(id), Machine: machine, Seconds: int(max(a.Tick-from, 0) / physics.StepsPerSecond)})
	}
	if s := a.Slot; s >= 0 && int(s) < f.Capacity() && f.Occupied[s] && f.Boat[s] == a.Boat {
		lo, hi := f.CrewOf(s)
		for _, c := range f.Crew[lo:hi] {
			add(c.Account, c.Machine, c.Since)
		}
	}
	for i := range f.AboardEnds {
		if o := &f.AboardEnds[i]; o.Boat == a.Boat {
			add(o.Account, o.Machine, o.Since)
		}
	}
	v := store.LogVoyage{
		Account: store.AccountID(a.Account), Source: fmt.Sprintf("a:%d:%d:%d", b.world, a.Boat, a.Since), World: b.world, Aboard: true,
		Boat: a.Boat, BoatKind: b.kindID(a.Kind), BoatName: a.BoatName, Began: b.At(a.Since), Ended: b.At(a.Tick),
		How: how(a.How), Run: a.Run, Logged: true, Place: b.Place(a.X, a.Y), Met: met(a.Met),
		Skipper: store.AccountID(a.Skipper), SkipperMachine: a.SkipperMachine, Crew: others,
	}
	if v.BoatKind != "" {
		v.Finds = append(v.Finds, store.LogFind{Group: GroupBoats, Kind: v.BoatKind})
	}
	v.Finds = weatherFinds(a.Met, v.Finds)
	r := rows()
	r.Voyages = append(r.Voyages, v)
}

// forget lets go of the kinds of life an account met in a voyage or a
// time aboard just ended.
func (b *Book) forget(account bus.Account) {
	for k := range b.met {
		if k.account == account {
			delete(b.met, k)
		}
	}
}

// findsOf are the kinds of the collection subject i of the world is.
func (b *Book) findsOf(i int32, dst []store.LogFind) []store.LogFind {
	w := b.model.World()
	s := &w.Subjects[i]
	switch s.Kind {
	case sight.Island:
		if s.Biome != "" {
			dst = append(dst, store.LogFind{Group: GroupIslands, Kind: s.Biome})
		}
		if s.Sort >= 0 && s.Sort < len(b.sizes) {
			dst = append(dst, store.LogFind{Group: GroupSizes, Kind: b.sizes[s.Sort]})
		}
	case sight.Place:
		if s.Sort >= 0 && s.Sort < len(b.places) {
			dst = append(dst, store.LogFind{Group: GroupPlaces, Kind: b.places[s.Sort]})
		}
	case sight.Feature:
		if s.Sort >= 0 && s.Sort < len(b.feats) {
			dst = append(dst, store.LogFind{Group: GroupFeatures, Kind: b.feats[s.Sort]})
		}
	}
	return dst
}

// charted makes the entries of the subjects f charted: for the skipper
// credited, charted; for each aboard their boat, sighted aboard. What is
// charted with a subject adds its kinds to the collection with it.
func (b *Book) charted(f *bus.Frame, charts []store.Charting, rows func() *store.LogRows) {
	if b.model == nil {
		return
	}
	w := b.model.World()
	for i := range f.Charted {
		c := &f.Charted[i]
		if c.Slot < 0 || c.Boat == 0 || c.With >= 0 || int(c.Subject) >= len(w.Subjects) {
			continue
		}
		s := &w.Subjects[c.Subject]
		finds := b.findsOf(c.Subject, nil)
		for j := range f.Charted {
			if w := &f.Charted[j]; w.With == c.Subject && int(w.Subject) < len(b.model.World().Subjects) {
				finds = b.findsOf(w.Subject, finds)
			}
		}
		key := &store.ChartKey{Subject: charts[i].Subject, Number: charts[i].Number}
		at := b.At(c.Tick)
		e := store.LogEntry{
			Account: store.AccountID(c.Owner), Source: fmt.Sprintf("c:%d:%s:%d", b.world, key.Subject, key.Number), World: b.world, At: at,
			Kind: store.LogCharted, Title: s.Title, What: b.model.What(c.Subject), Worth: s.Worth, X: s.X, Y: s.Y,
			Place: b.Place(s.X, s.Y), Charting: key, Finds: finds,
		}
		r := rows()
		r.Entries = append(r.Entries, e)
		sl := c.Slot
		if int(sl) >= f.Capacity() || !f.Occupied[sl] || f.Boat[sl] != c.Boat {
			continue
		}
		lo, hi := f.CrewOf(sl)
		for _, a := range f.Crew[lo:hi] {
			x := e
			x.Account, x.Kind = store.AccountID(a.Account), store.LogSighted
			x.Other, x.OtherMachine, x.OtherBoat = store.AccountID(c.Owner), f.Machine[sl], f.BoatName[sl]
			r.Entries = append(r.Entries, x)
		}
	}
}

// bumped makes a bump's entries, one for each boat's sailor, unless the
// owner's tools placed its voyage.
func (b *Book) bumped(f *bus.Frame, bp *bus.Bump, rows func() *store.LogRows) {
	art := protocol.ArticleName(bp.Article)
	place := b.Place(bp.X, bp.Y)
	lo, hi := min(bp.BoatA, bp.BoatB), max(bp.BoatA, bp.BoatB)
	src := fmt.Sprintf("b:%d:%d:%d:%d", b.world, bp.Tick, lo, hi)
	for side := range 2 {
		s, o := bp.A, bp.B
		own, other := bp.OwnerA, bp.OwnerB
		mine, theirs := uint8(physics.First), uint8(physics.Second)
		if side == 1 {
			s, o, own, other, mine, theirs = bp.B, bp.A, bp.OwnerB, bp.OwnerA, theirs, mine
		}
		if f.Voyage[s].Placed {
			continue
		}
		fault := store.FaultNone
		switch bp.Fault {
		case mine:
			fault = store.FaultMine
		case theirs:
			fault = store.FaultTheirs
		}
		r := rows()
		r.Entries = append(r.Entries, store.LogEntry{
			Account: store.AccountID(own), Source: src, World: b.world, At: b.At(bp.Tick), Kind: store.LogBump,
			X: bp.X, Y: bp.Y, Place: place, Other: store.AccountID(other), OtherMachine: f.Machine[o], OtherBoat: f.BoatName[o],
			Article: art, Fault: fault,
		})
	}
}

// lifeMet makes the entries of the sea's life met: each group within
// NearLife of a boat afloat is met by everyone aboard, once a kind a
// voyage or a time aboard.
func (b *Book) lifeMet(f *bus.Frame, rows func() *store.LogRows) {
	for i := range f.Life {
		e := &f.Life[i]
		if f.Tick < e.Start || f.Tick > e.End || int(e.Kind) >= len(b.life) {
			continue
		}
		x, y := e.East, e.North
		if e.Speed > 0 {
			sin, cos := math.Sincos(e.Heading)
			d := e.Speed * float64(f.Tick-e.Start) / physics.StepsPerSecond
			x, y = x+d*sin, y+d*cos
		}
		b.near = b.near[:0]
		if s := e.Slot; s >= 0 && int(s) < f.Capacity() && f.Occupied[s] && f.Boat[s] == e.Boat {
			b.near = append(b.near, s)
		} else {
			b.near = boatsNear(f, x, y, NearLife, b.near)
		}
		for _, s := range b.near {
			b.met1(f, s, e.Kind, rows)
		}
	}
}

// met1 has everyone aboard the boat in slot s meet a kind of life.
func (b *Book) met1(f *bus.Frame, s int32, kind uint16, rows func() *store.LogRows) {
	v := &f.Voyage[s]
	if v.Falling() || v.Placed || f.Stay[s] {
		return
	}
	k := &b.life[kind]
	st := &f.State[s]
	place := ""
	try := func(account bus.Account, began int64) {
		key := metKey{account: account, began: began, kind: kind}
		if _, ok := b.met[key]; ok {
			return
		}
		b.met[key] = struct{}{}
		if place == "" {
			place = b.Place(st.X, st.Y)
		}
		r := rows()
		r.Entries = append(r.Entries, store.LogEntry{
			Account: store.AccountID(account), Source: fmt.Sprintf("m:%d:%d:%d:%s", b.world, f.Boat[s], began, k.ID), World: b.world,
			At: b.At(f.Tick), Kind: store.LogMet, Title: k.Name, Group: GroupLife, Find: k.ID, X: st.X, Y: st.Y, Place: place,
			Finds: []store.LogFind{{Group: GroupLife, Kind: k.ID}},
		})
	}
	try(f.Owner[s], v.Log.Began)
	lo, hi := f.CrewOf(s)
	for _, a := range f.Crew[lo:hi] {
		try(a.Account, a.Since)
	}
}

// boatsNear appends the live boats of f within r m of (x, y) to dst.
func boatsNear(f *bus.Frame, x, y, r float64, dst []int32) []int32 {
	c0, c1 := physics.CellOf(x-r), physics.CellOf(x+r)
	r0, r1 := physics.CellOf(y-r), physics.CellOf(y+r)
	for row := r0; row <= r1; row++ {
		for col := c0; col <= c1; col++ {
			for _, s := range f.Grid.Boats(row*physics.GridCells + col) {
				st := &f.State[s]
				dx, dy := st.X-x, st.Y-y
				if dx*dx+dy*dy <= r*r {
					dst = append(dst, s)
				}
			}
		}
	}
	return dst
}

// Place is the name of the charted island or place nearest (x, y), within
// PlaceReach, or "" for open water.
func (b *Book) Place(x, y float64) string {
	if b.model == nil {
		return ""
	}
	return NearestPlace(b.model.World(), b.model.Charted(), x, y)
}

// NearestPlace is the name of the island or place among charted, subjects
// of w, nearest (x, y) within PlaceReach; "" for none.
func NearestPlace(w *chart.World, charted []int32, x, y float64) string {
	best, near := "", PlaceReach*PlaceReach
	for _, i := range charted {
		if int(i) >= len(w.Subjects) {
			continue
		}
		s := &w.Subjects[i]
		if s.Name == "" || s.Kind == sight.Feature {
			continue
		}
		dx, dy := s.X-x, s.Y-y
		if d := dx*dx + dy*dy; d < near {
			best, near = s.Name, d
		}
	}
	return best
}
