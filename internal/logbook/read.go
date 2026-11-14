// SPDX-License-Identifier: AGPL-3.0-only

package logbook

import (
	"context"
	"errors"
	"math"
	"slices"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// ErrNotFound is a log that is not there to be read: no such sailor, or
// one whose log the reader may not read. The two are answered alike, so a
// refusal tells nothing.
var ErrNotFound = errors.New("logbook: no such log")

// LoggedFromShown is how long a log says from when distance was logged: a
// world's week.
const LoggedFromShown = 7 * 24 * time.Hour

// ErrShown is a setting of who may read a log that is not one.
var ErrShown = errors.New("logbook: who may read a log is sailors or me")

// Store is what a log is read from: internal/store.
type Store interface {
	LogSailorByKey(ctx context.Context, key string) (store.LogSailor, error)
	LogSailorByID(ctx context.Context, id store.AccountID) (store.LogSailor, error)
	LogPeople(ctx context.Context, ids []store.AccountID) (map[store.AccountID]store.LogPerson, error)
	SetLogShown(ctx context.Context, id store.AccountID, shown string) error
	LogTotals(ctx context.Context, id store.AccountID) (store.LogTotals, error)
	LogWorlds(ctx context.Context, id store.AccountID) ([]store.LogWorld, error)
	LogVoyages(ctx context.Context, id store.AccountID, world int) ([]store.LogVoyage, error)
	LogEntries(ctx context.Context, id store.AccountID, world int) ([]store.LogEntry, error)
	LogFinds(ctx context.Context, id store.AccountID) ([]store.LogKept, error)
	LogFrom(ctx context.Context) (time.Time, error)
	LogFigures(ctx context.Context, ids []store.AccountID) (map[store.AccountID]store.LogFigures, error)
	RaceRibbonsOf(ctx context.Context, id store.AccountID, skip, most int) ([]store.RaceRecord, error)
	RaceCountsOf(ctx context.Context, id store.AccountID) (store.RaceCounts, error)
}

var _ Store = (*store.Store)(nil)

// Looks resolves a sailor's look as the game shows it: looks.Book.
type Looks interface {
	Resolve(id store.AccountID, l store.Look) store.Look
}

// ServiceConfig sets up a Service.
type ServiceConfig struct {
	Store   Store
	Catalog *catalog.Catalog
	// Looks, if not nil, resolves the portrait's look.
	Looks Looks
	// Blocks reports a block between two accounts, either way; nil for
	// none.
	Blocks func(a, b store.AccountID) bool
	// Key is a sailor's name's key (moderation.Key).
	Key func(name string) string
	// World is the number of the world sailed now, 0 for none.
	World func() int
	// Zone is the zone a log's days are kept in: the world's schedule's.
	Zone *time.Location
	Now  func() time.Time
}

// Service reads logs.
type Service struct {
	cfg    ServiceConfig
	groups []groupKinds
}

// groupKinds is a group of the collection and its kinds, in order.
type groupKinds struct {
	id    string
	kinds []string
}

// NewService makes a Service.
func NewService(cfg ServiceConfig) *Service {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Zone == nil {
		cfg.Zone = time.UTC
	}
	if cfg.World == nil {
		cfg.World = func() int { return 0 }
	}
	return &Service{cfg: cfg, groups: Groups(cfg.Catalog)}
}

// Groups are the collection's groups and their kinds, from the catalog
// but the weather's and the edge's, which are the log's own.
func Groups(c *catalog.Catalog) []groupKinds {
	var islands, sizes, features, places, life, boats []string
	if c != nil {
		for _, b := range c.World.Biomes {
			islands = append(islands, string(b.ID))
		}
		for _, s := range c.World.Sizes {
			sizes = append(sizes, s.Class)
		}
		for _, k := range c.World.Features.Kinds {
			features = append(features, string(k.ID))
		}
		for _, k := range c.World.Places.Kinds {
			places = append(places, string(k.ID))
		}
		for _, k := range c.Life.Kinds {
			life = append(life, k.ID)
		}
		for _, b := range c.Boats {
			boats = append(boats, string(b.ID))
		}
	}
	var edge []string
	for _, r := range Ladder {
		edge = append(edge, Rung(r))
	}
	return []groupKinds{
		{GroupIslands, islands}, {GroupSizes, sizes}, {GroupFeatures, features}, {GroupPlaces, places},
		{GroupLife, life}, {GroupWeather, slices.Clone(Weather)}, {GroupEdge, edge}, {GroupBoats, boats},
	}
}

// Log is a sailor's log as the game shows it, one world's days at a time.
// Times are Unix milliseconds; distances metres.
type Log struct {
	Name    string     `json:"name"`
	Machine bool       `json:"machine"`
	Look    store.Look `json:"look"`
	Since   int64      `json:"since"`
	// Own: the reader's own log, or their machine sailor's. Shown, in
	// one's own, is who may read it (sailors, me) and Chosen whether it
	// was chosen rather than the age band's default.
	Own    bool   `json:"own"`
	Shown  string `json:"shown,omitempty"`
	Chosen bool   `json:"chosen,omitempty"`
	// LoggedFrom is when distance and weather began to be logged, for a
	// week after; 0 after.
	LoggedFrom int64 `json:"loggedFrom,omitempty"`
	// Abstract is the four figures at the log's head; Record every count,
	// over every world.
	Abstract []Figure `json:"abstract"`
	Record   Record   `json:"record"`
	// Worlds are the worlds of the log, the newest first; World the one
	// whose days are given, the newest unless asked.
	Worlds []WorldRef `json:"worlds"`
	World  *WorldDays `json:"world"`
	Groups []Group    `json:"collection"`
	Zone   string     `json:"zone"`
	// Now is the number of the world sailed now, 0 for none.
	Now int `json:"worldNow,omitempty"`
	// Ribbons are the races sailed, over every world: their counts; the
	// races themselves are read by the page (Service.Ribbons).
	Ribbons *Ribbons `json:"ribbons"`
}

// A Figure of the abstract: Kind is distance (m), voyages, charted,
// closest (m), gales or kinds.
type Figure struct {
	Kind  string  `json:"kind"`
	Value float64 `json:"value"`
}

// The abstract's kinds of figure.
const (
	FigureDistance = "distance"
	FigureVoyages  = "voyages"
	FigureCharted  = "charted"
	FigureClosest  = "closest"
	FigureGales    = "gales"
	FigureKinds    = "kinds"
)

// Record is every count of a log, over every world.
type Record struct {
	DistanceM float64  `json:"distanceM"`
	Voyages   int      `json:"voyages"`
	Aboard    int      `json:"aboard"`
	Crewed    int      `json:"crewed"`
	Worlds    int      `json:"worlds"`
	Falls     int      `json:"falls"`
	ClosestM  *float64 `json:"closestM"`
	BumpsAt   int      `json:"bumpsAtFault"`
	Bumps     int      `json:"bumps"`
	Gales     int      `json:"gales"`
	Storms    int      `json:"storms"`
	Fogs      int      `json:"fogs"`
	Nights    int      `json:"nights"`
	Charted   int      `json:"charted"`
	Sighted   int      `json:"sighted"`
	Met       int      `json:"met"`
	Kinds     int      `json:"kinds"`
	Of        int      `json:"of"`
}

// WorldRef is a world of a log: its number, the first and last time of
// it, and whether it is the world sailed now.
type WorldRef struct {
	Number  int   `json:"number"`
	First   int64 `json:"first"`
	Last    int64 `json:"last"`
	Current bool  `json:"current,omitempty"`
}

// WorldDays is a world's days in a log, the newest first.
type WorldDays struct {
	WorldRef
	Days []Day `json:"days"`
}

// Day is a day of a log, in its zone: its date (2026-11-12), the distance
// run that day, m, its voyages in the order they ended and its entries in
// theirs.
type Day struct {
	Date    string   `json:"date"`
	RunM    float64  `json:"runM"`
	Voyages []Voyage `json:"voyages"`
	Entries []Entry  `json:"entries"`
}

// Voyage is a voyage of a day, or a time aboard another's boat (Aboard,
// with its Skipper): the boat's kind and name, when, how it ended (as the
// store says) and where, the distance run (nil where not logged), the
// closest approach to the lip survived, its bumps, the weather met (its
// kinds: gale, storm, gale-ridden-out, storm-ridden-out, landfall-in-fog,
// night-at-sea) and where; those aboard with the sailor, named by the
// rule, and how many more were not named.
type Voyage struct {
	Boat      string   `json:"boat"`
	BoatName  string   `json:"boatName,omitempty"`
	Began     int64    `json:"began"`
	Ended     int64    `json:"ended"`
	How       string   `json:"how"`
	Place     string   `json:"place,omitempty"`
	RunM      *float64 `json:"runM"`
	ClosestM  *float64 `json:"closestM,omitempty"`
	BumpsAt   int      `json:"bumpsAtFault,omitempty"`
	BumpsNot  int      `json:"bumpsNotAtFault,omitempty"`
	Met       []string `json:"met,omitempty"`
	GalePlace string   `json:"galePlace,omitempty"`
	FogPlace  string   `json:"fogPlace,omitempty"`
	Aboard    bool     `json:"aboard,omitempty"`
	Skipper   *Person  `json:"skipper,omitempty"`
	Crew      []Person `json:"crew"`
	Counted   int      `json:"counted,omitempty"`
}

// The kinds of weather a voyage met, on the wire.
const (
	MetGale      = "gale"
	MetStorm     = "storm"
	MetRodeGale  = WeatherGale
	MetRodeStorm = WeatherStorm
	MetFog       = WeatherFog
	MetNight     = WeatherNight
)

// Person is a sailor named in a log: by name (Machine for a machine
// sailor; Logged if the reader may open their log), or Hidden ("a
// sailor", a block) or Former ("a former sailor"). Seconds is their time
// aboard, where it counts.
type Person struct {
	Name    string `json:"name,omitempty"`
	Machine bool   `json:"machine,omitempty"`
	Logged  bool   `json:"logged,omitempty"`
	Hidden  bool   `json:"hidden,omitempty"`
	Former  bool   `json:"former,omitempty"`
	Seconds int    `json:"s,omitempty"`
}

// Entry is a notable thing of a day: Kind is charted, sighted (from
// Other's boat, OtherBoat), found (the first of Group's Find), met (a
// kind of the sea's life, Find, the day's first meeting of it, Times the
// day's meetings) or bump (with Other's boat OtherBoat, by Article, Fault
// mine, theirs or none). Other is nil where not named.
type Entry struct {
	At        int64   `json:"at"`
	Kind      string  `json:"kind"`
	Times     int     `json:"times,omitempty"`
	Title     string  `json:"title,omitempty"`
	What      string  `json:"what,omitempty"`
	Worth     float64 `json:"worth,omitempty"`
	Group     string  `json:"group,omitempty"`
	Find      string  `json:"find,omitempty"`
	Place     string  `json:"place,omitempty"`
	X         float64 `json:"x,omitempty"`
	Y         float64 `json:"y,omitempty"`
	Other     *Person `json:"other,omitempty"`
	OtherBoat string  `json:"otherBoat,omitempty"`
	Article   string  `json:"article,omitempty"`
	Fault     string  `json:"fault,omitempty"`
}

// Group is a group of the collection: its kinds, in the catalog's order,
// and how many are found.
type Group struct {
	ID    string `json:"id"`
	Found int    `json:"found"`
	Kinds []Kind `json:"kinds"`
}

// Kind is a kind of the collection: how many times found over every
// world (0 for not yet), whether found in the world sailed now, and where
// and when first.
type Kind struct {
	ID        string `json:"id"`
	Count     int    `json:"count"`
	ThisWorld bool   `json:"thisWorld,omitempty"`
	First     *First `json:"first,omitempty"`
}

// First is where and when a kind was first found.
type First struct {
	World int    `json:"world"`
	At    int64  `json:"at"`
	Place string `json:"place,omitempty"`
}

func ms(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

// reader is the reader of an account signed in: they need a sailor.
func (s *Service) reader(ctx context.Context, id store.AccountID) (Reader, error) {
	me, err := s.cfg.Store.LogSailorByID(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return Reader{}, ErrNotFound
	}
	if err != nil {
		return Reader{}, err
	}
	return Reader{ID: id, Band: BandOf(me.Born, s.cfg.Now())}, nil
}

func (s *Service) blocks(a, b store.AccountID) bool {
	return s.cfg.Blocks != nil && a != b && s.cfg.Blocks(a, b)
}

// sailorOf is the log's sailor as the rules see them.
func (s *Service) sailorOf(l *store.LogSailor) Sailor {
	return Sailor{ID: l.ID, Machine: l.Kind == store.AI, Owner: l.Owner, Band: BandOf(l.Born, s.cfg.Now()), Shown: l.Shown}
}

// Who is whose log is read: a sailor's by Name, one of the reader's
// machine sailors by Machine, or else the reader's own.
type Who struct {
	Name    string
	Machine store.AccountID
}

// Own is the log of a reader's own sailor, world 0 for the newest.
func (s *Service) Own(ctx context.Context, reader store.AccountID, world int) (Log, error) {
	return s.readOf(ctx, reader, Who{}, world)
}

// ByName is the log of the sailor of a name, as reader may read it;
// ErrNotFound for no such sailor, or one reader may not read.
func (s *Service) ByName(ctx context.Context, reader store.AccountID, name string, world int) (Log, error) {
	if name == "" {
		return Log{}, ErrNotFound
	}
	return s.readOf(ctx, reader, Who{Name: name}, world)
}

// Machine is the log of one of a player's machine sailors; ErrNotFound if
// it is not theirs.
func (s *Service) Machine(ctx context.Context, owner, machine store.AccountID, world int) (Log, error) {
	return s.readOf(ctx, owner, Who{Machine: machine}, world)
}

// Ribbons are a page of the races of who's log, as reader may read it,
// from the newest: the counts, and the races after the first from.
func (s *Service) Ribbons(ctx context.Context, reader store.AccountID, who Who, from int) (Ribbons, error) {
	r, l, err := s.open(ctx, reader, who)
	if err != nil {
		return Ribbons{}, err
	}
	return s.ribbons(ctx, r, l.ID, max(from, 0))
}

// readOf reads who's log for reader, world 0 for the newest.
func (s *Service) readOf(ctx context.Context, reader store.AccountID, who Who, world int) (Log, error) {
	r, l, err := s.open(ctx, reader, who)
	if err != nil {
		return Log{}, err
	}
	return s.read(ctx, r, &l, world)
}

// open finds who's log for reader, as they may read it: ErrNotFound for
// none, and for one not theirs to read.
func (s *Service) open(ctx context.Context, reader store.AccountID, who Who) (Reader, store.LogSailor, error) {
	r, err := s.reader(ctx, reader)
	if err != nil {
		return Reader{}, store.LogSailor{}, err
	}
	switch {
	case who.Name != "":
		key := who.Name
		if s.cfg.Key != nil {
			key = s.cfg.Key(who.Name)
		}
		if key == "" {
			return Reader{}, store.LogSailor{}, ErrNotFound
		}
		l, err := s.cfg.Store.LogSailorByKey(ctx, key)
		if errors.Is(err, store.ErrNotFound) {
			return Reader{}, store.LogSailor{}, ErrNotFound
		}
		if err != nil {
			return Reader{}, store.LogSailor{}, err
		}
		sl := s.sailorOf(&l)
		if l.Stopped && !Own(r, sl) || !MayRead(r, sl, s.blocks(r.ID, l.ID)) {
			return Reader{}, store.LogSailor{}, ErrNotFound
		}
		return r, l, nil
	case who.Machine != (store.AccountID{}):
		l, err := s.cfg.Store.LogSailorByID(ctx, who.Machine)
		if errors.Is(err, store.ErrNotFound) {
			return Reader{}, store.LogSailor{}, ErrNotFound
		}
		if err != nil {
			return Reader{}, store.LogSailor{}, err
		}
		if l.Kind != store.AI || l.Owner != reader {
			return Reader{}, store.LogSailor{}, ErrNotFound
		}
		return r, l, nil
	}
	l, err := s.cfg.Store.LogSailorByID(ctx, reader)
	if err != nil {
		return Reader{}, store.LogSailor{}, err
	}
	return r, l, nil
}

// ForOwner is any account's log as the game's owner reads it: every name
// shown.
func (s *Service) ForOwner(ctx context.Context, id store.AccountID, world int) (Log, error) {
	l, err := s.cfg.Store.LogSailorByID(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return Log{}, ErrNotFound
	}
	if err != nil {
		return Log{}, err
	}
	return s.read(ctx, Reader{All: true}, &l, world)
}

// Abstract is an account's log in its abstract and record, as the
// owner's page shows it, with who may read it.
func (s *Service) Abstract(ctx context.Context, id store.AccountID) (Log, error) {
	l, err := s.cfg.Store.LogSailorByID(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return Log{}, ErrNotFound
	}
	if err != nil {
		return Log{}, err
	}
	out := s.header(Reader{All: true}, &l)
	if err := s.totals(ctx, &out, l.ID); err != nil {
		return Log{}, err
	}
	out.Shown, out.Chosen = Shown(s.sailorOf(&l)), l.Shown != store.LogShownDefault
	return out, nil
}

// Figures are the logs of the accounts of ids in a few figures, as the
// owner's list of accounts shows them.
func (s *Service) Figures(ctx context.Context, ids []store.AccountID) (map[store.AccountID]store.LogFigures, error) {
	return s.cfg.Store.LogFigures(ctx, ids)
}

// SetShown sets who may read a human's own log: store.LogShownSailors or
// store.LogShownMe.
func (s *Service) SetShown(ctx context.Context, id store.AccountID, shown string) error {
	if shown != store.LogShownSailors && shown != store.LogShownMe {
		return ErrShown
	}
	err := s.cfg.Store.SetLogShown(ctx, id, shown)
	if errors.Is(err, store.ErrNotFound) {
		return ErrNotFound
	}
	return err
}

// header is what a log shows of its sailor.
func (s *Service) header(r Reader, l *store.LogSailor) Log {
	out := Log{Name: l.Name, Machine: l.Kind == store.AI, Look: l.Look, Since: ms(l.Since), Zone: s.cfg.Zone.String(),
		Now: s.cfg.World(), Own: !r.All && Own(r, s.sailorOf(l))}
	if s.cfg.Looks != nil {
		out.Look = s.cfg.Looks.Resolve(l.ID, l.Look)
	}
	return out
}

// read reads l's log for r: its world's days, world 0 for the newest.
func (s *Service) read(ctx context.Context, r Reader, l *store.LogSailor, world int) (Log, error) {
	out := s.header(r, l)
	if out.Own {
		out.Shown, out.Chosen = Shown(s.sailorOf(l)), l.Shown != store.LogShownDefault
	}
	if err := s.totals(ctx, &out, l.ID); err != nil {
		return Log{}, err
	}
	worlds, err := s.cfg.Store.LogWorlds(ctx, l.ID)
	if err != nil {
		return Log{}, err
	}
	out.Worlds = make([]WorldRef, len(worlds))
	for i, w := range worlds {
		out.Worlds[i] = WorldRef{Number: w.Number, First: ms(w.First), Last: ms(w.Last), Current: w.Number == out.Now}
	}
	at := -1
	for i, w := range worlds {
		if world == 0 && i == 0 || w.Number == world {
			at = i
			break
		}
	}
	if at >= 0 {
		days, err := s.days(ctx, r, l, worlds[at].Number)
		if err != nil {
			return Log{}, err
		}
		out.World = &WorldDays{WorldRef: out.Worlds[at], Days: days}
	}
	// The counts alone: the Ribbons tab reads its races by the page.
	rb, err := s.ribbons(ctx, r, l.ID, -1)
	if err != nil {
		return Log{}, err
	}
	out.Ribbons = &rb
	return out, nil
}

// totals sets out's abstract, record and collection.
func (s *Service) totals(ctx context.Context, out *Log, id store.AccountID) error {
	t, err := s.cfg.Store.LogTotals(ctx, id)
	if err != nil {
		return err
	}
	finds, err := s.cfg.Store.LogFinds(ctx, id)
	if err != nil {
		return err
	}
	out.Groups = s.collection(finds, out.Now)
	kinds, of := 0, 0
	for _, g := range out.Groups {
		kinds += g.Found
		of += len(g.Kinds)
	}
	rec := Record{
		DistanceM: math.Round(t.Run), Voyages: t.Voyages, Aboard: t.Aboard, Crewed: t.Crewed, Worlds: t.Worlds, Falls: t.Falls,
		BumpsAt: t.BumpsAt, Bumps: t.BumpsAt + t.BumpsNot, Gales: t.Gales, Storms: t.Storms, Fogs: t.Fogs, Nights: t.Nights,
		Charted: t.Charted, Sighted: t.Sighted, Met: t.Met, Kinds: kinds, Of: of,
	}
	if t.Survived {
		least := math.Round(t.Least*10) / 10
		rec.ClosestM = &least
	}
	out.Record = rec
	out.Abstract = abstract(&rec)
	if from, err := s.cfg.Store.LogFrom(ctx); err == nil && !from.IsZero() && s.cfg.Now().Sub(from) < LoggedFromShown {
		out.LoggedFrom = ms(from)
	}
	return nil
}

// abstract is a log's four figures: the distance and the voyages, then
// the two most notable of the places charted, the closest approach
// survived, the gales ridden out and the kinds found, in that order of
// note, those the sailor has.
func abstract(r *Record) []Figure {
	out := []Figure{{FigureDistance, r.DistanceM}, {FigureVoyages, float64(r.Voyages + r.Aboard)}}
	if r.Charted > 0 {
		out = append(out, Figure{FigureCharted, float64(r.Charted)})
	}
	if r.ClosestM != nil {
		out = append(out, Figure{FigureClosest, *r.ClosestM})
	}
	if r.Gales > 0 && len(out) < 4 {
		out = append(out, Figure{FigureGales, float64(r.Gales)})
	}
	if len(out) < 4 {
		out = append(out, Figure{FigureKinds, float64(r.Kinds)})
	}
	return out[:min(len(out), 4)]
}

// collection is the collection's groups with the finds given marked, the
// world sailed now's number now.
func (s *Service) collection(finds []store.LogKept, now int) []Group {
	by := make(map[store.LogFind]*store.LogKept, len(finds))
	for i := range finds {
		by[finds[i].LogFind] = &finds[i]
	}
	out := make([]Group, len(s.groups))
	for i, g := range s.groups {
		out[i] = Group{ID: g.id, Kinds: make([]Kind, len(g.kinds))}
		for j, k := range g.kinds {
			kd := Kind{ID: k}
			if f := by[store.LogFind{Group: g.id, Kind: k}]; f != nil {
				kd.Count = f.Count
				kd.ThisWorld = now > 0 && f.LastWorld == now
				kd.First = &First{World: f.FirstWorld, At: ms(f.FirstAt), Place: f.FirstPlace}
				out[i].Found++
			}
			out[i].Kinds[j] = kd
		}
	}
	return out
}

// days are l's days in a world, the newest first, every name in them as
// r may see it.
func (s *Service) days(ctx context.Context, r Reader, l *store.LogSailor, world int) ([]Day, error) {
	voyages, err := s.cfg.Store.LogVoyages(ctx, l.ID, world)
	if err != nil {
		return nil, err
	}
	entries, err := s.cfg.Store.LogEntries(ctx, l.ID, world)
	if err != nil {
		return nil, err
	}
	names, err := s.namer(ctx, r, l.ID, voyages, entries)
	if err != nil {
		return nil, err
	}
	var days []Day
	day := func(t time.Time) *Day {
		d := t.In(s.cfg.Zone).Format(time.DateOnly)
		for i := range days {
			if days[i].Date == d {
				return &days[i]
			}
		}
		days = append(days, Day{Date: d, Voyages: []Voyage{}, Entries: []Entry{}})
		return &days[len(days)-1]
	}
	for i := range voyages {
		v := &voyages[i]
		d := day(v.Ended)
		out := Voyage{
			Boat: v.BoatKind, BoatName: v.BoatName, Began: ms(v.Began), Ended: ms(v.Ended), How: v.How, Place: v.Place,
			BumpsAt: v.BumpsAt, BumpsNot: v.BumpsNot, Met: metKinds(v.Met), GalePlace: v.GalePlace, FogPlace: v.FogPlace,
			Aboard: v.Aboard, Crew: []Person{},
		}
		if v.Logged {
			run := math.Round(v.Run)
			out.RunM = &run
			d.RunM += run
		}
		if v.Survived {
			least := math.Round(v.Least*10) / 10
			out.ClosestM = &least
		}
		if v.Aboard {
			p := names(v.Skipper, v.SkipperName, v.SkipperMachine, 0)
			if p == nil {
				p = &Person{}
			}
			out.Skipper = p
		}
		for _, m := range v.Crew {
			if p := names(m.ID, m.Name, m.Machine, m.Seconds); p != nil {
				out.Crew = append(out.Crew, *p)
			} else {
				out.Counted++
			}
		}
		d.Voyages = append(d.Voyages, out)
	}
	// A kind of life met again the same day is counted on the day's first.
	met := map[[2]string]int{}
	for i := range entries {
		e := &entries[i]
		d := day(e.At)
		if e.Kind == store.LogMet {
			k := [2]string{d.Date, e.Find}
			if j, ok := met[k]; ok {
				d.Entries[j].Times++
				continue
			}
			met[k] = len(d.Entries)
		}
		out := Entry{
			At: ms(e.At), Kind: e.Kind, Title: e.Title, What: e.What, Worth: e.Worth, Group: e.Group, Find: e.Find,
			Place: e.Place, X: math.Round(e.X), Y: math.Round(e.Y), OtherBoat: e.OtherBoat, Article: e.Article, Fault: e.Fault,
		}
		if e.Kind == store.LogSighted || e.Kind == store.LogBump {
			out.Other = names(e.Other, e.OtherName, e.OtherMachine, 0)
		}
		if e.Kind == store.LogMet {
			out.Times = 1
			out.X, out.Y = 0, 0
		}
		d.Entries = append(d.Entries, out)
	}
	slices.SortFunc(days, func(a, b Day) int {
		switch {
		case a.Date > b.Date:
			return -1
		case a.Date < b.Date:
			return 1
		}
		return 0
	})
	return days, nil
}

// metKinds are the kinds of weather a voyage's flags say it met.
func metKinds(m int) []string {
	var out []string
	for _, f := range [...]struct {
		bit  int
		kind string
	}{
		{store.LogMetGale, MetGale}, {store.LogMetStorm, MetStorm}, {store.LogRodeGale, MetRodeGale},
		{store.LogRodeStorm, MetRodeStorm}, {store.LogMetFog, MetFog}, {store.LogMetNight, MetNight},
	} {
		if m&f.bit != 0 {
			out = append(out, f.kind)
		}
	}
	return out
}

// namer is how the sailors named in a log's rows are named to r, the log
// being owner's: a function of a sailor copied (their account, zero for a
// former sailor; the name copied; whether a machine; their seconds
// aboard) to the person shown, or nil for one counted, not named.
func (s *Service) namer(ctx context.Context, r Reader, owner store.AccountID, voyages []store.LogVoyage, entries []store.LogEntry) (
	func(id store.AccountID, name string, machine bool, secs int) *Person, error) {
	seen := map[store.AccountID]bool{}
	var ids []store.AccountID
	add := func(id store.AccountID) {
		if id != (store.AccountID{}) && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	for i := range voyages {
		add(voyages[i].Skipper)
		for _, m := range voyages[i].Crew {
			add(m.ID)
		}
	}
	for i := range entries {
		add(entries[i].Other)
	}
	people, err := s.cfg.Store.LogPeople(ctx, ids)
	if err != nil {
		return nil, err
	}
	now := s.cfg.Now()
	return func(id store.AccountID, name string, machine bool, secs int) *Person {
		var sl Sailor
		if p, ok := people[id]; ok && id != (store.AccountID{}) {
			sl = SailorOf(p, now)
		} else {
			sl = Sailor{ID: id, Machine: machine, Gone: true}
		}
		blocked := !r.All && (s.blocks(r.ID, id) || s.blocks(owner, id))
		switch NameOf(r, sl, blocked) {
		case Named:
			if name == "" {
				// A name not copied, as a backfill may leave: the sailor,
				// by no name.
				return &Person{Hidden: true, Machine: sl.Machine, Seconds: secs}
			}
			return &Person{Name: name, Machine: sl.Machine, Logged: MayRead(r, sl, blocked), Seconds: secs}
		case Hidden:
			return &Person{Hidden: true, Seconds: secs}
		case Former:
			return &Person{Former: true, Seconds: secs}
		}
		return nil
	}, nil
}
