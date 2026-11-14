// SPDX-License-Identifier: AGPL-3.0-only

package race

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/logbook"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Store is what races are kept in: internal/store.
type Store interface {
	RaceSettings(ctx context.Context) (store.RaceSettings, error)
	MakeRace(ctx context.Context, r *store.NewRace, since, from, until time.Time, decide func(store.RaceMaking, *store.NewRace) error) (string, error)
	MakeHarbourRaces(ctx context.Context, lease int64, races []store.NewRace) (int, error)
	RaceByCode(ctx context.Context, code string) (store.Race, error)
	HarbourRaces(ctx context.Context, world [16]byte, number int, after time.Time, most int) ([]store.Race, error)
	RacesOf(ctx context.Context, world [16]byte, number int, id store.AccountID) ([]store.Race, error)
	RaceEntrants(ctx context.Context, r *store.Race) ([]store.RaceEntrant, error)
	RaceEntryOf(ctx context.Context, r *store.Race, id store.AccountID) (store.RaceEntry, bool, error)
	EntriesOf(ctx context.Context, id store.AccountID, since time.Time) ([]store.EntryStart, error)
	RacesBy(ctx context.Context, owner store.AccountID, since time.Time) ([]time.Time, int, error)
	EnterRace(ctx context.Context, r *store.Race, id store.AccountID, machine, crew bool, at, since time.Time, decide func(store.RaceEntering) error) error
	WithdrawEntry(ctx context.Context, r *store.Race, id store.AccountID, at time.Time) (bool, error)
	RemoveEntry(ctx context.Context, r *store.Race, number int) (store.AccountID, error)
	SetRaceState(ctx context.Context, r *store.Race, state string, was []string, at time.Time) (bool, error)
	MoveRace(ctx context.Context, r *store.Race, at time.Time) (bool, error)
	RacesSailed(ctx context.Context, id store.AccountID) (int, error)
	HarbourDays(ctx context.Context, world [16]byte) ([]store.HarbourDay, error)
	SetHarbourDays(ctx context.Context, lease int64, world [16]byte, days []store.HarbourDay) error
	BusyAreas(ctx context.Context, world [16]byte, since, until time.Time) ([]store.BuoyStart, error)
	LogPeople(ctx context.Context, ids []store.AccountID) (map[store.AccountID]store.LogPerson, error)
	// What the races' clerk asks.
	DueRaces(ctx context.Context, world [16]byte, number int, since, until time.Time) ([]store.Race, error)
	RaceIn(ctx context.Context, world [16]byte, number int, id [16]byte) (store.Race, error)
	PendingRuns(ctx context.Context, world [16]byte) ([]store.PendingRun, error)
	StartRace(ctx context.Context, lease int64, r *store.RaceStart) error
	EndRace(ctx context.Context, lease int64, rules store.NewsRules, e *store.RaceEnd) error
	// The wooden spoon hung by a sailor's choice.
	HangSpoon(ctx context.Context, id store.AccountID, world int, code string, hung bool) error
}

var _ Store = (*store.Store)(nil)

// Area is a racing area off Port Royal, by its number, its centre m east
// and north of the world's.
type Area struct {
	Number int
	X, Y   float64
}

// Course is an island course open to races: its number in the world, its
// kind and name, its length, m, its way, m east and north, and the boats
// it is offered to, by the catalog's ids, with their expected times, s.
type Course struct {
	Number int
	Kind   string
	Name   string
	Length float64
	Way    [][2]float64
	Boats  map[string]float64
}

// Courses are the world's racing areas and its island courses open now.
type Courses struct {
	Areas  []Area
	Island []Course
}

// World is the world sailed: its ID, number and seed, and when it began.
type World struct {
	ID     [16]byte
	Number int
	Seed   uint64
	Begins time.Time
}

// Config sets up a Service.
type Config struct {
	Store   Store
	Catalog *catalog.Catalog
	World   World
	// Ends is when the world ends, zero for none known.
	Ends func() time.Time
	// Courses are the racing areas and the island courses open now.
	Courses func() Courses
	// Blocks reports a block between two accounts, either way; nil for
	// none.
	Blocks func(a, b store.AccountID) bool
	// BoatOf, if not nil, is the kind of boat, by the catalog's id, a
	// sailor sails now, "" for none: a race's boat by default.
	BoatOf func(id store.AccountID) string
	// Origin is the play origin a race's link is made at.
	Origin string
	// Zone is the world's schedule's zone: the harbour races' hours and
	// the days of names.
	Zone *time.Location
	Now  func() time.Time
}

// Service is a world's races ashore.
type Service struct {
	cfg   Config
	boats map[string]int // the catalog's boats' places, by id
	port  string         // Port Royal's name
}

// New makes a Service.
func New(cfg Config) *Service {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Zone == nil {
		cfg.Zone = time.UTC
	}
	if cfg.Ends == nil {
		cfg.Ends = func() time.Time { return time.Time{} }
	}
	if cfg.Courses == nil {
		cfg.Courses = func() Courses { return Courses{} }
	}
	s := &Service{cfg: cfg, boats: map[string]int{}, port: cfg.Catalog.World.MainPort.Name}
	for i := range cfg.Catalog.Boats {
		s.boats[string(cfg.Catalog.Boats[i].ID)] = i
	}
	return s
}

// boat is the catalog's boat of an id, or nil.
func (s *Service) boat(id string) *catalog.Boat {
	i, ok := s.boats[id]
	if !ok {
		return nil
	}
	return &s.cfg.Catalog.Boats[i]
}

// inAreas reports whether boat b races buoy courses: whether she is no
// longer than the racing areas were made for, and there are areas.
func (s *Service) inAreas(b *catalog.Boat, c *Courses) bool {
	return b != nil && len(c.Areas) > 0 && b.LengthOverall <= s.cfg.Catalog.World.Courses.Areas.Longest
}

// latest is the last time a race may start in the world, zero for none
// known.
func (s *Service) latest(limits store.RaceSettings) time.Time {
	ends := s.cfg.Ends()
	if ends.IsZero() {
		return time.Time{}
	}
	return ends.Add(-limits.Cutoff)
}

// link is a race's link.
func (s *Service) link(code string) string { return s.cfg.Origin + "/?r=" + code }

// courseRef is a course as asked for: buoy's shape and length, or an
// island course's number.
type courseRef struct {
	kind   string
	shape  string
	long   bool
	number int
}

// CourseID is a course's ID as the API asks for it: "buoy:triangle:short",
// "island:3".
func CourseID(kind, shape string, long bool, number int) string {
	if kind == CourseBuoy {
		l := "short"
		if long {
			l = "long"
		}
		return "buoy:" + shape + ":" + l
	}
	return "island:" + strconv.Itoa(number)
}

// parseCourse reads a course's ID.
func parseCourse(id string) (courseRef, bool) {
	parts := strings.Split(id, ":")
	switch {
	case len(parts) == 3 && parts[0] == CourseBuoy:
		if _, ok := shapeNames[parts[1]]; !ok || parts[2] != "short" && parts[2] != "long" {
			return courseRef{}, false
		}
		return courseRef{kind: CourseBuoy, shape: parts[1], long: parts[2] == "long"}, true
	case len(parts) == 2 && parts[0] == CourseIsland:
		n, err := strconv.Atoi(parts[1])
		if err != nil || n < 0 || n > 1<<20 {
			return courseRef{}, false
		}
		return courseRef{kind: CourseIsland, number: n}, true
	}
	return courseRef{}, false
}

// island is the open island course of a number, or nil.
func (c *Courses) island(n int) *Course {
	for i := range c.Island {
		if c.Island[i].Number == n {
			return &c.Island[i]
		}
	}
	return nil
}

// minutesOf is how many minutes a race on its course is expected to take
// its boat.
func (s *Service) minutesOf(r *store.Race, c *Courses) int {
	if r.CourseKind == CourseBuoy {
		if r.Long {
			return LongMinutes
		}
		return ShortMinutes
	}
	if ic := c.island(r.Course); ic != nil {
		if e, ok := ic.Boats[r.Boat]; ok {
			return int(math.Round(e / 60))
		}
	}
	return 0
}

// Making is a race to make: a race or a trial, its course's ID, its boat
// by the catalog's id, its start (a race's), who may enter and its name,
// "" for the name suggested.
type Making struct {
	Kind   string
	Course string
	Boat   string
	At     time.Time
	Who    string
	Name   string
}

// whoFor are the choices of who may enter a race a sailor makes: a
// machine sailor never makes a race it could not enter.
func whoFor(by Sailor) []string {
	if by.Machine {
		return []string{WhoEveryone, WhoMachines}
	}
	return []string{WhoEveryone, WhoHumans, WhoMachines, WhoNewcomers}
}

// Make makes a race and answers its card, or why not (a *Refusal).
func (s *Service) Make(ctx context.Context, by Sailor, m Making) (Card, error) {
	now := s.cfg.Now()
	limits, err := s.cfg.Store.RaceSettings(ctx)
	if err != nil {
		return Card{}, err
	}
	r, err := s.making(by, m, now, limits)
	if err != nil {
		return Card{}, err
	}
	code, err := s.make(ctx, r, limits, now)
	if err != nil {
		return Card{}, err
	}
	return s.Card(ctx, by, code)
}

// making checks what is asked to be made and is the race to make.
func (s *Service) making(by Sailor, m Making, now time.Time, limits store.RaceSettings) (*store.NewRace, error) {
	if m.Kind != KindRace && m.Kind != KindTrial {
		return nil, refuse(RefuseKind)
	}
	b := s.boat(m.Boat)
	if b == nil {
		return nil, refuse(RefuseBoat)
	}
	if !contains(whoFor(by), m.Who) {
		return nil, refuse(RefuseWho)
	}
	ref, ok := parseCourse(m.Course)
	if !ok {
		return nil, refuse(RefuseCourse)
	}
	courses := s.cfg.Courses()
	r := &store.NewRace{World: s.cfg.World.ID, Owner: by.ID, HasOwner: true, Kind: m.Kind, CourseKind: ref.kind,
		Boat: m.Boat, Who: m.Who, Harbour: -1, MadeAt: now}
	var courseName string
	switch ref.kind {
	case CourseBuoy:
		if !s.inAreas(b, &courses) {
			return nil, refuse(RefuseCourse)
		}
		r.Shape, r.Long = ref.shape, ref.long
		courseName = BuoyName(ref.shape, ref.long, s.port)
	case CourseIsland:
		ic := courses.island(ref.number)
		if ic == nil {
			return nil, refuse(RefuseCourse)
		}
		if _, ok := ic.Boats[m.Boat]; !ok {
			return nil, refuse(RefuseCourse)
		}
		r.Course, courseName = ref.number, ic.Name
	}
	latest := s.latest(limits)
	if m.Kind == KindTrial {
		r.StartsAt = now
		if !latest.IsZero() && now.After(latest) {
			return nil, refuse(RefuseLate)
		}
	} else {
		r.StartsAt = m.At.Truncate(time.Second)
		if r.StartsAt.Before(now.Add(Lead)) {
			return nil, refuseUntil(RefuseSoon, now.Add(Lead))
		}
		if !latest.IsZero() && r.StartsAt.After(latest) {
			return nil, refuseUntil(RefuseLate, latest)
		}
	}
	name := strings.TrimSpace(m.Name)
	if name == "" {
		name = s.suggest(m.Kind, ref, courseName, r.StartsAt, uint64(now.UnixNano()))
	}
	checked, err := moderation.CheckTitle(name)
	if err != nil {
		var refused *moderation.Refusal
		if errors.As(err, &refused) {
			return nil, &Refusal{Reason: RefuseName, Name: string(refused.Reason)}
		}
		return nil, err
	}
	r.Name = checked.Display
	return r, nil
}

// suggest is a name for a race, one that passes the word filter's rules.
func (s *Service) suggest(kind string, ref courseRef, courseName string, start time.Time, seed uint64) string {
	for i := range uint64(4) {
		name := Suggest(kind, ref.kind, ref.shape, courseName, s.port, start, s.cfg.Zone, seed+i)
		if _, err := moderation.CheckTitle(name); err == nil {
			return name
		}
	}
	return start.In(s.cfg.Zone).Weekday().String() + " Race"
}

// make makes race r, counting its owner's limits and finding its racing
// area as it is made: its code.
func (s *Service) make(ctx context.Context, r *store.NewRace, limits store.RaceSettings, now time.Time) (string, error) {
	courses := s.cfg.Courses()
	return s.cfg.Store.MakeRace(ctx, r, now.Add(-Day), r.StartsAt.Add(-AreaApart), r.StartsAt.Add(AreaApart),
		func(m store.RaceMaking, r *store.NewRace) error {
			if err := refusedMaking(m, limits); err != nil {
				return err
			}
			if r.CourseKind != CourseBuoy {
				return nil
			}
			if r.Kind == KindTrial {
				// A trial's course is laid in an area at each run.
				r.Course = 0
				return nil
			}
			area, ok := freeArea(courses.Areas, m.Busy, r.StartsAt)
			if !ok {
				return refuse(RefuseAreas)
			}
			r.Course = area
			return nil
		})
}

// SuggestName is a name for a race to make: a suggestion, changed at each
// asking.
func (s *Service) SuggestName(kind, course string, start time.Time) (string, error) {
	ref, ok := parseCourse(course)
	if !ok {
		return "", refuse(RefuseCourse)
	}
	if kind != KindTrial {
		kind = KindRace
	}
	name := BuoyName(ref.shape, ref.long, s.port)
	if ref.kind == CourseIsland {
		c := s.cfg.Courses()
		ic := c.island(ref.number)
		if ic == nil {
			return "", refuse(RefuseCourse)
		}
		name = ic.Name
	}
	if start.IsZero() {
		start = s.cfg.Now()
	}
	return s.suggest(kind, ref, name, start, uint64(s.cfg.Now().UnixNano())), nil
}

// find is the race of a code.
func (s *Service) find(ctx context.Context, code string) (store.Race, error) {
	if !validCode(code) {
		return store.Race{}, ErrNotFound
	}
	r, err := s.cfg.Store.RaceByCode(ctx, code)
	if errors.Is(err, store.ErrNotFound) {
		return store.Race{}, ErrNotFound
	}
	return r, err
}

// validCode reports whether code may be a race's: ten characters of
// lower-case base32.
func validCode(code string) bool {
	if len(code) != 10 {
		return false
	}
	for _, c := range code {
		if !(c >= 'a' && c <= 'z' || c >= '2' && c <= '7') {
			return false
		}
	}
	return true
}

// Enter enters the asking sailor's boat in a race, with those aboard if
// crew, and answers its card, or why not (a *Refusal).
func (s *Service) Enter(ctx context.Context, by Sailor, code string, crew bool) (Card, error) {
	r, err := s.find(ctx, code)
	if err != nil {
		return Card{}, err
	}
	if r.WorldNumber != s.cfg.World.Number {
		return Card{}, refuse(RefuseFinished)
	}
	in, err := s.entering(ctx, &r, by)
	if err != nil {
		return Card{}, err
	}
	if err := s.cfg.Store.EnterRace(ctx, &r, by.ID, by.Machine, crew, in.now, in.now.Add(-Day-time.Hour), in.refusedEntry); err != nil {
		return Card{}, err
	}
	return s.Card(ctx, by, code)
}

// entering is what entering race r is judged by, for the sailor by.
func (s *Service) entering(ctx context.Context, r *store.Race, by Sailor) (*entering, error) {
	limits, err := s.cfg.Store.RaceSettings(ctx)
	if err != nil {
		return nil, err
	}
	in := &entering{race: r, sailor: by, limits: limits, now: s.cfg.Now(), latest: s.latest(limits), newcomer: true}
	if b := s.boat(r.Boat); b != nil {
		in.most = b.Racers
	}
	if r.Who == WhoNewcomers {
		n, err := s.cfg.Store.RacesSailed(ctx, by.ID)
		if err != nil {
			return nil, err
		}
		in.newcomer = n < Newcomer
	}
	if r.HasOwner && s.cfg.Blocks != nil && r.Owner != by.ID {
		in.blocked = s.cfg.Blocks(by.ID, r.Owner) || by.Machine && s.cfg.Blocks(by.Owner, r.Owner)
	}
	return in, nil
}

// canEnter is whether the sailor by may enter race r now, as its rows
// stand: a dry run of Enter.
func (s *Service) canEnter(ctx context.Context, r *store.Race, by Sailor, mine []store.EntryStart) (Can, error) {
	if r.WorldNumber != s.cfg.World.Number {
		return Can{Reason: RefuseFinished}, nil
	}
	in, err := s.entering(ctx, r, by)
	if err != nil {
		return Can{}, err
	}
	entry, has, err := s.cfg.Store.RaceEntryOf(ctx, r, by.ID)
	if err != nil {
		return Can{}, err
	}
	e := store.RaceEntering{State: r.State, StartsAt: r.StartsAt, Kind: r.Kind, Entered: r.Entered, Entry: entry, HasEntry: has, Mine: mine}
	return canOf(in.refusedEntry(e)), nil
}

// Withdraw withdraws the asking sailor's boat from a race before its
// warning signal.
func (s *Service) Withdraw(ctx context.Context, by Sailor, code string) (Card, error) {
	r, err := s.find(ctx, code)
	if err != nil {
		return Card{}, err
	}
	if err := s.beforeWarning(&r); err != nil {
		return Card{}, err
	}
	ok, err := s.cfg.Store.WithdrawEntry(ctx, &r, by.ID, s.cfg.Now())
	if err != nil {
		return Card{}, err
	}
	if !ok {
		return Card{}, refuse(RefuseNotEntered)
	}
	return s.Card(ctx, by, code)
}

// beforeWarning is why race r may no longer be changed: it has started,
// is over or cancelled, or its world has ended; nil if it may.
func (s *Service) beforeWarning(r *store.Race) error {
	switch {
	case r.WorldNumber != s.cfg.World.Number, r.State == store.RaceFinished:
		return refuse(RefuseFinished)
	case r.State == store.RaceCancelled:
		return refuse(RefuseCancelled)
	case r.State == store.RaceRacing:
		return refuse(RefuseStarted)
	case r.Kind == KindRace && !s.cfg.Now().Before(r.StartsAt.Add(-Warning)):
		return refuse(RefuseStarted)
	}
	return nil
}

// owned is the race of a code, if the sailor by owns it and it may still
// be changed.
func (s *Service) owned(ctx context.Context, by Sailor, code string) (store.Race, error) {
	r, err := s.find(ctx, code)
	if err != nil {
		return r, err
	}
	if !r.HasOwner || r.Owner != by.ID {
		return r, ErrNotOwner
	}
	return r, s.beforeWarning(&r)
}

// Close closes a race to entry, at its owner's word: a trial's runs end.
func (s *Service) Close(ctx context.Context, by Sailor, code string) (Card, error) {
	return s.setState(ctx, by, code, store.RaceClosed, []string{store.RaceOpen})
}

// Cancel calls a race off, at its owner's word, before its warning
// signal; its entrants find it so on its card.
func (s *Service) Cancel(ctx context.Context, by Sailor, code string) (Card, error) {
	return s.setState(ctx, by, code, store.RaceCancelled, []string{store.RaceOpen, store.RaceClosed})
}

func (s *Service) setState(ctx context.Context, by Sailor, code, state string, was []string) (Card, error) {
	r, err := s.owned(ctx, by, code)
	if err != nil {
		return Card{}, err
	}
	ok, err := s.cfg.Store.SetRaceState(ctx, &r, state, was, s.cfg.Now())
	if err != nil {
		return Card{}, err
	}
	if !ok && r.State != state {
		return Card{}, refuse(RefuseClosed)
	}
	return s.Card(ctx, by, code)
}

// Remove removes a boat from a race by its number, at its owner's word,
// before its warning signal; the boat's skipper cannot enter it again.
func (s *Service) Remove(ctx context.Context, by Sailor, code string, number int) (Card, error) {
	r, err := s.owned(ctx, by, code)
	if err != nil {
		return Card{}, err
	}
	if _, err := s.cfg.Store.RemoveEntry(ctx, &r, number); errors.Is(err, store.ErrNotFound) {
		return Card{}, refuse(RefuseNotEntered)
	} else if err != nil {
		return Card{}, err
	}
	return s.Card(ctx, by, code)
}

// Move moves a race's start, once, at its owner's word, before its
// warning signal, within the bounds a race is made in.
func (s *Service) Move(ctx context.Context, by Sailor, code string, at time.Time) (Card, error) {
	r, err := s.owned(ctx, by, code)
	if err != nil {
		return Card{}, err
	}
	if r.Kind == KindTrial {
		return Card{}, refuse(RefuseKind)
	}
	if r.Moved {
		return Card{}, refuse(RefuseMoved)
	}
	limits, err := s.cfg.Store.RaceSettings(ctx)
	if err != nil {
		return Card{}, err
	}
	now := s.cfg.Now()
	at = at.Truncate(time.Second)
	if at.Before(now.Add(Lead)) {
		return Card{}, refuseUntil(RefuseSoon, now.Add(Lead))
	}
	if latest := s.latest(limits); !latest.IsZero() && at.After(latest) {
		return Card{}, refuseUntil(RefuseLate, latest)
	}
	ok, err := s.cfg.Store.MoveRace(ctx, &r, at)
	if err != nil {
		return Card{}, err
	}
	if !ok {
		return Card{}, refuse(RefuseMoved)
	}
	return s.Card(ctx, by, code)
}

// Again makes a finished race again at its owner's word: the same
// course, boat and who may enter, starting in Lead.
func (s *Service) Again(ctx context.Context, by Sailor, code string) (Card, error) {
	r, err := s.find(ctx, code)
	if err != nil {
		return Card{}, err
	}
	if !r.HasOwner || r.Owner != by.ID {
		return Card{}, ErrNotOwner
	}
	if r.State != store.RaceFinished || r.WorldNumber != s.cfg.World.Number {
		return Card{}, refuse(RefuseNotFinished)
	}
	now := s.cfg.Now()
	limits, err := s.cfg.Store.RaceSettings(ctx)
	if err != nil {
		return Card{}, err
	}
	m := Making{Kind: r.Kind, Course: CourseID(r.CourseKind, r.Shape, r.Long, r.Course), Boat: r.Boat,
		At: now.Add(Lead), Who: r.Who, Name: r.Name}
	nr, err := s.making(by, m, now, limits)
	if err != nil {
		return Card{}, err
	}
	nr.AgainOf, nr.HasAgainOf = r.ID, true
	code, err = s.make(ctx, nr, limits, now)
	if err != nil {
		return Card{}, err
	}
	return s.Card(ctx, by, code)
}

// Spoon hangs the wooden spoon by was given in the race of code from
// their boats' sterns for the rest of the world, or takes it down: a
// race of the world sailed now only. ErrNotFound for no such race, or no
// spoon of theirs in it.
func (s *Service) Spoon(ctx context.Context, by Sailor, code string, hang bool) error {
	r, err := s.find(ctx, code)
	if err != nil {
		return err
	}
	if r.WorldNumber != s.cfg.World.Number {
		return ErrNotFound
	}
	err = s.cfg.Store.HangSpoon(ctx, by.ID, r.WorldNumber, r.Code, hang)
	if errors.Is(err, store.ErrNotFound) {
		return ErrNotFound
	}
	return err
}

// Calendar is a race's calendar file and its file's name.
func (s *Service) Calendar(ctx context.Context, by Sailor, code string) ([]byte, string, error) {
	c, err := s.Card(ctx, by, code)
	if err != nil {
		return nil, "", err
	}
	what := c.Course.Name + " · " + c.Boat.Name
	host := strings.TrimPrefix(strings.TrimPrefix(s.cfg.Origin, "https://"), "http://")
	uid := fmt.Sprintf("%s-%d@%s", c.Code, s.cfg.World.Number, host)
	file := Calendar(uid, time.UnixMilli(c.StartsAt), c.Minutes, c.Name, what, c.Link, s.cfg.Now())
	return file, fileName(c.Name) + ".ics", nil
}

// fileName is a race's name as a file's: letters and digits, the rest
// hyphens.
func fileName(name string) string {
	var b strings.Builder
	dash := false
	for _, r := range name {
		if r < 128 && (r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			b.WriteRune(r)
			dash = false
		} else if !dash && b.Len() > 0 {
			b.WriteByte('-')
			dash = true
		}
	}
	out := strings.TrimSuffix(b.String(), "-")
	if out == "" {
		return "race"
	}
	return out
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// readerOf is the reader of a card as the log's rules name sailors to
// them.
func readerOf(id store.AccountID, people map[store.AccountID]store.LogPerson, now time.Time) logbook.Reader {
	r := logbook.Reader{ID: id}
	if p, ok := people[id]; ok {
		r.Band = logbook.SailorOf(p, now).Band
	}
	return r
}
