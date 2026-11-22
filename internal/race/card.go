// SPDX-License-Identifier: AGPL-3.0-only

package race

import (
	"context"
	"errors"
	"math"
	"slices"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/certs"
	"github.com/daneelvt/keel-over-the-edge/internal/logbook"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// A race's card, as its link shows it, and the board of races a sailor is
// shown: the next harbour races, their own, and what they may make.

// Card is a race as a reader is shown it. Times are Unix milliseconds.
type Card struct {
	Code     string     `json:"code"`
	Link     string     `json:"link"`
	Name     string     `json:"name"`
	Kind     string     `json:"kind"`
	Phase    string     `json:"phase"`
	Harbour  bool       `json:"harbour"`
	Who      string     `json:"who"`
	Course   CourseCard `json:"course"`
	Boat     BoatRef    `json:"boat"`
	StartsAt int64      `json:"startsAt"`
	Minutes  int        `json:"minutes"`
	// Owner is the race's owner, nil for the Harbourmaster's; Standing,
	// one of the Harbourmaster's standing trials.
	Owner    *Person   `json:"owner"`
	Standing bool      `json:"standing,omitempty"`
	Most     int       `json:"most"`
	Entrants []Entrant `json:"entrants"`
	Mine     Mine      `json:"mine"`
	Enter    Can       `json:"enter"`
	// CalledOff is why a race was called off at its warning signal
	// (CalledOffStorm), "" for one that was not.
	CalledOff string `json:"calledOff,omitempty"`
}

// CourseCard is a race's course: its ID and kind; a buoy course's shape
// and length; an island course's number, length, m, and way, m east and
// north in pairs; its name; and whether it wears the upwind sign: a beat
// in it, or an island course's start up the wind that day.
type CourseCard struct {
	ID     string  `json:"id"`
	Kind   string  `json:"kind"`
	Shape  string  `json:"shape,omitempty"`
	Long   bool    `json:"long"`
	Number int     `json:"number,omitempty"`
	Name   string  `json:"name"`
	Length float64 `json:"length,omitempty"`
	Way    []int32 `json:"way,omitempty"`
	Upwind bool    `json:"upwind,omitempty"`
}

// BoatRef is a kind of boat: the catalog's id and name.
type BoatRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Person is a sailor as a card names them: Name nil for one not named to
// the reader.
type Person struct {
	Name    *string `json:"name"`
	Machine bool    `json:"machine"`
}

// Entrant is a boat entered, by its race number: its skipper's name, nil
// for one not named to the reader, who is shown the boat's name instead
// (nil for none); whether a machine sailor's, a newcomer's (the green
// ribbon) or the reader's own.
type Entrant struct {
	Number   int     `json:"number"`
	Name     *string `json:"name"`
	Boat     *string `json:"boat"`
	Machine  bool    `json:"machine"`
	Newcomer bool    `json:"newcomer"`
	Me       bool    `json:"me"`
}

// Mine is the reader's part in a race: its owner, entered (with those
// aboard), their boat's number; and whether its start was moved.
type Mine struct {
	Owner    bool `json:"owner"`
	Entered  bool `json:"entered"`
	WithCrew bool `json:"withCrew"`
	Number   int  `json:"number,omitempty"`
	Moved    bool `json:"moved"`
}

// Can is whether the reader may do something now, and if not, why and
// until when; for a boat the reader may not sail, the certificate that
// opens her; for a limit reached, the limit.
type Can struct {
	OK     bool   `json:"ok"`
	Reason string `json:"reason,omitempty"`
	Until  int64  `json:"until,omitempty"`
	Needs  string `json:"needs,omitempty"`
	Most   int    `json:"most,omitempty"`
}

// canOf is what an error refusing something says of it.
func canOf(err error) Can {
	if err == nil {
		return Can{OK: true}
	}
	if r, ok := RefusalOf(err); ok {
		c := Can{Reason: r.Reason, Needs: r.Needs, Most: r.Most}
		if !r.Until.IsZero() {
			c.Until = r.Until.UnixMilli()
		}
		return c
	}
	return Can{Reason: "unavailable"}
}

// Summary is a race on a list: as its card, without its course and
// entrants.
type Summary struct {
	Code     string      `json:"code"`
	Name     string      `json:"name"`
	Kind     string      `json:"kind"`
	Phase    string      `json:"phase"`
	Harbour  bool        `json:"harbour"`
	Who      string      `json:"who"`
	Boat     BoatRef     `json:"boat"`
	StartsAt int64       `json:"startsAt"`
	Entered  int         `json:"entered"`
	Most     int         `json:"most"`
	Mine     SummaryMine `json:"mine"`
	Enter    Can         `json:"enter"`
	// Standing: one of the Harbourmaster's standing trials. Toward is the
	// certificate a run of it sailed alone would count toward for the
	// reader, by name, "" for none; Course its course as a certificate's
	// task names it.
	Standing bool   `json:"standing,omitempty"`
	Toward   string `json:"toward,omitempty"`
	Course   string `json:"course,omitempty"`
	// Upwind: its course wears the upwind sign. CalledOff is why it was
	// called off at its warning signal, "" for none.
	Upwind    bool   `json:"upwind,omitempty"`
	CalledOff string `json:"calledOff,omitempty"`
}

// SummaryMine is the reader's part in a race on a list.
type SummaryMine struct {
	Owner   bool `json:"owner"`
	Entered bool `json:"entered"`
}

// Board is a sailor's races: the next harbour races, the week's
// newcomers' harbour races' starts, the Harbourmaster's standing trials
// in the boat they sail, their own races not over (and those of the last
// hour a storm called off), what they may make, and whether they are a
// newcomer, wearing the green ribbon.
type Board struct {
	Harbour   []Summary   `json:"harbour"`
	Greenhorn []int64     `json:"greenhorn"`
	Trials    []Summary   `json:"trials"`
	Mine      []Summary   `json:"mine"`
	Make      MakeChoices `json:"make"`
	Newcomer  bool        `json:"newcomer"`
}

// MakeChoices are what a sailor may make a race of: whether they may make
// one now; the start's bounds; who may enter; their own boat by default;
// the boats; and the courses open, each with the boats it is offered to
// and their expected minutes.
type MakeChoices struct {
	Can      Can            `json:"can"`
	Earliest int64          `json:"earliest"`
	Latest   int64          `json:"latest"`
	Who      []string       `json:"who"`
	Boat     string         `json:"boat"`
	Boats    []BoatChoice   `json:"boats"`
	Courses  []CourseChoice `json:"courses"`
}

// BoatChoice is a kind of boat to race: the most boats of it in a race,
// and whether it races buoy courses (a tall ship does not).
type BoatChoice struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Most  int    `json:"most"`
	Buoys bool   `json:"buoys"`
}

// CourseChoice is a course to race on, as CourseCard, with the boats it
// is offered to and their expected minutes; TrialOnly, a course with a
// beat in it, made as a time trial only.
type CourseChoice struct {
	CourseCard
	Boats     map[string]int `json:"boats"`
	TrialOnly bool           `json:"trialOnly,omitempty"`
}

// wayOf is a course's way, m east and north in pairs, rounded.
func wayOf(way [][2]float64) []int32 {
	out := make([]int32, 0, 2*len(way))
	for _, p := range way {
		out = append(out, int32(math.Round(p[0])), int32(math.Round(p[1])))
	}
	return out
}

// courseCard is race r's course as its card shows it, its upwind sign
// as it stands at at.
func (s *Service) courseCard(r *store.Race, c *Courses, at time.Time) CourseCard {
	if r.CourseKind == CourseBuoy {
		return CourseCard{ID: CourseID(CourseBuoy, r.Shape, r.Long, 0), Kind: CourseBuoy, Shape: r.Shape, Long: r.Long,
			Name: BuoyName(r.Shape, r.Long, s.port), Upwind: UpwindShape(r.Shape)}
	}
	out := CourseCard{ID: CourseID(CourseIsland, "", false, r.Course), Kind: CourseIsland, Number: r.Course, Upwind: s.upwind(r, at)}
	if ic := c.island(r.Course); ic != nil {
		out.Name, out.Length, out.Way = ic.Name, math.Round(ic.Length), wayOf(ic.Way)
	}
	return out
}

func (s *Service) boatRef(id string) (BoatRef, int) {
	if b := s.boat(id); b != nil {
		return BoatRef{ID: id, Name: b.Name}, b.Racers
	}
	return BoatRef{ID: id}, 0
}

// Card is a race's card as the sailor by is shown it.
func (s *Service) Card(ctx context.Context, by Sailor, code string) (Card, error) {
	r, err := s.find(ctx, code)
	if err != nil {
		return Card{}, err
	}
	now := s.cfg.Now()
	limits, err := s.cfg.Store.RaceSettings(ctx)
	if err != nil {
		return Card{}, err
	}
	courses := s.cfg.Courses()
	boat, most := s.boatRef(r.Boat)
	c := Card{Code: r.Code, Link: s.link(r.Code), Name: r.Name, Kind: r.Kind,
		Phase: phaseOf(&r, now, s.cfg.World.Number, s.latest(limits)), Harbour: r.Harbour >= 0, Who: r.Who,
		Course: s.courseCard(&r, &courses, signAt(&r, now)), Boat: boat, StartsAt: r.StartsAt.UnixMilli(), Minutes: s.minutesOf(&r, &courses),
		Most: most, Entrants: []Entrant{}, Standing: !r.HasOwner && r.Kind == KindTrial, CalledOff: r.CalledOff}
	entrants, err := s.cfg.Store.RaceEntrants(ctx, &r)
	if err != nil {
		return Card{}, err
	}
	ids := []store.AccountID{by.ID}
	if r.HasOwner {
		ids = append(ids, r.Owner)
	}
	for _, e := range entrants {
		ids = append(ids, e.Account)
	}
	people, err := s.cfg.Store.LogPeople(ctx, ids)
	if err != nil {
		return Card{}, err
	}
	reader := readerOf(by.ID, people, now)
	if r.HasOwner {
		c.Owner = s.person(reader, r.Owner, people, now)
		c.Mine.Owner = r.Owner == by.ID
	}
	c.Mine.Moved = r.Moved
	for _, e := range entrants {
		x := Entrant{Number: e.Number, Machine: e.Machine, Me: e.Account == by.ID}
		p := s.person(reader, e.Account, people, now)
		x.Name = p.Name
		if p.Name == nil && e.BoatName != "" {
			name := e.BoatName
			x.Boat = &name
		}
		n, err := s.cfg.Store.RacesSailed(ctx, e.Account)
		if err != nil {
			return Card{}, err
		}
		x.Newcomer = n < Newcomer
		if x.Me {
			c.Mine.Entered, c.Mine.WithCrew, c.Mine.Number = true, e.WithCrew, e.Number
		}
		c.Entrants = append(c.Entrants, x)
	}
	mine, err := s.cfg.Store.EntriesOf(ctx, by.ID, now.Add(-Day-time.Hour))
	if err != nil {
		return Card{}, err
	}
	if c.Enter, err = s.canEnter(ctx, &r, by, mine); err != nil {
		return Card{}, err
	}
	return c, nil
}

// signAt is when race r's upwind sign is read: a race's at its start, a
// trial's now.
func signAt(r *store.Race, now time.Time) time.Time {
	if r.Kind == KindRace && r.StartsAt.After(now) {
		return r.StartsAt
	}
	return now
}

// CardOf is the card of the race of an ID in the world sailed, as the
// sailor by is shown it: a race under way in the world, by its row's ID.
func (s *Service) CardOf(ctx context.Context, by Sailor, id [16]byte) (Card, error) {
	w := &s.cfg.World
	r, err := s.cfg.Store.RaceIn(ctx, w.ID, w.Number, id)
	if errors.Is(err, store.ErrNotFound) {
		return Card{}, ErrNotFound
	}
	if err != nil {
		return Card{}, err
	}
	return s.Card(ctx, by, r.Code)
}

// person is a sailor of id as reader is shown them: by name by the log's
// rule, otherwise not named.
func (s *Service) person(reader logbook.Reader, id store.AccountID, people map[store.AccountID]store.LogPerson, now time.Time) *Person {
	p, ok := people[id]
	if !ok {
		// An account deleted: a former sailor, not named.
		return &Person{}
	}
	sailor := logbook.SailorOf(p, now)
	blocked := s.cfg.Blocks != nil && id != reader.ID && s.cfg.Blocks(reader.ID, id)
	out := &Person{Machine: sailor.Machine}
	if logbook.NameOf(reader, sailor, blocked) == logbook.Named && p.Name != "" {
		name := p.Name
		out.Name = &name
	}
	return out
}

// summary is race r on a list for the sailor by.
func (s *Service) summary(ctx context.Context, r *store.Race, by Sailor, now time.Time, latest time.Time, mine []store.EntryStart) (Summary, error) {
	boat, most := s.boatRef(r.Boat)
	out := Summary{Code: r.Code, Name: r.Name, Kind: r.Kind, Phase: phaseOf(r, now, s.cfg.World.Number, latest),
		Harbour: r.Harbour >= 0, Who: r.Who, Boat: boat, StartsAt: r.StartsAt.UnixMilli(), Entered: r.Entered, Most: most,
		Upwind: s.upwind(r, signAt(r, now)), CalledOff: r.CalledOff}
	out.Mine.Owner = r.HasOwner && r.Owner == by.ID
	for _, m := range mine {
		if m.Race == r.ID && m.World == r.World {
			out.Mine.Entered = true
		}
	}
	var err error
	out.Enter, err = s.canEnter(ctx, r, by, mine)
	return out, err
}

// Board is the sailor by's races: the next harbour races, the week's
// newcomers' ones, their own, and what they may make.
func (s *Service) Board(ctx context.Context, by Sailor) (Board, error) {
	now := s.cfg.Now()
	limits, err := s.cfg.Store.RaceSettings(ctx)
	if err != nil {
		return Board{}, err
	}
	latest := s.latest(limits)
	w := &s.cfg.World
	out := Board{Harbour: []Summary{}, Greenhorn: []int64{}, Trials: []Summary{}, Mine: []Summary{}}
	mine, err := s.cfg.Store.EntriesOf(ctx, by.ID, now.Add(-Day-time.Hour))
	if err != nil {
		return Board{}, err
	}
	harbour, err := s.cfg.Store.HarbourRaces(ctx, w.ID, w.Number, now.Add(Warning), HarbourShown)
	if err != nil {
		return Board{}, err
	}
	for i := range harbour {
		sm, err := s.summary(ctx, &harbour[i], by, now, latest, mine)
		if err != nil {
			return Board{}, err
		}
		out.Harbour = append(out.Harbour, sm)
	}
	var st certs.Standing
	if s.cfg.Standing != nil {
		if st, err = s.cfg.Standing(ctx, by.ID); err != nil {
			return Board{}, err
		}
	}
	if out.Trials, err = s.trials(ctx, by, now, latest, mine, &st); err != nil {
		return Board{}, err
	}
	days, err := s.cfg.Store.HarbourDays(ctx, w.ID)
	if err != nil {
		return Board{}, err
	}
	for _, d := range days {
		out.Greenhorn = append(out.Greenhorn, at(d.Day, d.Hour, s.cfg.Zone).UnixMilli())
	}
	// A race a storm called off stays on the list for its hour, so its
	// entrants hear of it.
	own, err := s.cfg.Store.RacesOf(ctx, w.ID, w.Number, by.ID, now.Add(-time.Hour))
	if err != nil {
		return Board{}, err
	}
	for i := range own {
		sm, err := s.summary(ctx, &own[i], by, now, latest, mine)
		if err != nil {
			return Board{}, err
		}
		if own[i].Kind == KindTrial {
			sm.Toward = st.Toward(recordCourse(&own[i]))
		}
		out.Mine = append(out.Mine, sm)
	}
	n, err := s.cfg.Store.RacesSailed(ctx, by.ID)
	if err != nil {
		return Board{}, err
	}
	out.Newcomer = n < Newcomer
	out.Make, err = s.choices(ctx, by, now, limits, latest)
	return out, err
}

// trials are the Harbourmaster's standing trials for the sailor by, in
// the boat they sail now (or the one each sailor brings), each with the
// certificate it would count toward: the buoy courses, short then long,
// and the island courses by number.
func (s *Service) trials(ctx context.Context, by Sailor, now, latest time.Time, mine []store.EntryStart, st *certs.Standing) ([]Summary, error) {
	boat := ""
	if s.cfg.BoatOf != nil {
		boat = s.cfg.BoatOf(by.ID)
	}
	if s.boat(boat) == nil {
		boat = s.sailorBoat()
	}
	w := &s.cfg.World
	rows, err := s.cfg.Store.StandingTrials(ctx, w.ID, w.Number, boat)
	if err != nil || len(rows) == 0 {
		return []Summary{}, err
	}
	slices.SortStableFunc(rows, func(a, b store.Race) int { return standingOrder(&a) - standingOrder(&b) })
	out := make([]Summary, 0, len(rows))
	for i := range rows {
		sm, err := s.summary(ctx, &rows[i], by, now, latest, mine)
		if err != nil {
			return nil, err
		}
		sm.Standing, sm.Course = true, recordCourse(&rows[i])
		sm.Toward = st.Toward(sm.Course)
		out = append(out, sm)
	}
	// Easy first: the courses with the upwind sign last, each in its order.
	slices.SortStableFunc(out, func(a, b Summary) int { return boolOrder(a.Upwind) - boolOrder(b.Upwind) })
	return out, nil
}

// CourseTrials are the codes of the Harbourmaster's standing trials in
// the boat the sailor of id sails now (or the one each sailor brings), by
// their courses (store.CourseShort …): the first of each on the board.
func (s *Service) CourseTrials(ctx context.Context, id store.AccountID) (map[string]string, error) {
	boat := ""
	if s.cfg.BoatOf != nil {
		boat = s.cfg.BoatOf(id)
	}
	if s.boat(boat) == nil {
		boat = s.sailorBoat()
	}
	w := &s.cfg.World
	rows, err := s.cfg.Store.StandingTrials(ctx, w.ID, w.Number, boat)
	if err != nil {
		return nil, err
	}
	slices.SortStableFunc(rows, func(a, b store.Race) int { return standingOrder(&a) - standingOrder(&b) })
	out := map[string]string{}
	for i := range rows {
		if c := recordCourse(&rows[i]); out[c] == "" {
			out[c] = rows[i].Code
		}
	}
	return out, nil
}

// boolOrder is 1 for true: what sorts it after false.
func boolOrder(b bool) int {
	if b {
		return 1
	}
	return 0
}

// standingOrder is a standing trial's place on the board: the reach, the
// Dash, the short windward–leeward, the short triangle, the long
// windward–leeward, the long triangle, then the island courses by number;
// the board puts those with the upwind sign last.
func standingOrder(r *store.Race) int {
	switch recordCourse(r) {
	case store.CourseReach:
		return 0
	case store.CourseDash:
		return 1
	case store.CourseShort:
		return 2
	case store.CourseTriangle:
		return 3
	case store.CourseLong:
		return 4
	case store.CourseLongTriangle:
		return 5
	}
	return 6 + r.Course
}

// sailorBoat is the catalog's id of the boat each sailor brings to the
// fleet.
func (s *Service) sailorBoat() string {
	for i := range s.cfg.Catalog.Boats {
		if s.cfg.Catalog.Boats[i].Fleet == catalog.FleetSailor {
			return string(s.cfg.Catalog.Boats[i].ID)
		}
	}
	return ""
}

// choices are what the sailor by may make a race of now.
func (s *Service) choices(ctx context.Context, by Sailor, now time.Time, limits store.RaceSettings, latest time.Time) (MakeChoices, error) {
	made, owned, err := s.cfg.Store.RacesBy(ctx, by.ID, now.Add(-Day))
	if err != nil {
		return MakeChoices{}, err
	}
	out := MakeChoices{Can: canOf(refusedMaking(store.RaceMaking{Made: made, Owned: owned}, limits)),
		Earliest: now.Add(Lead).UnixMilli(), Who: whoFor(by), Boats: []BoatChoice{}, Courses: []CourseChoice{}}
	if !latest.IsZero() {
		out.Latest = latest.UnixMilli()
		if now.After(latest) {
			out.Can = canOf(refuseUntil(RefuseLate, latest))
		}
	}
	courses := s.cfg.Courses()
	buoys := map[string]int{}
	long := map[string]int{}
	dash := map[string]int{}
	for i := range s.cfg.Catalog.Boats {
		b := &s.cfg.Catalog.Boats[i]
		in := s.inAreas(b, &courses)
		out.Boats = append(out.Boats, BoatChoice{ID: string(b.ID), Name: b.Name, Most: b.Racers, Buoys: in})
		if in {
			buoys[string(b.ID)], long[string(b.ID)], dash[string(b.ID)] = ShortMinutes, LongMinutes, DashMinutes
		}
	}
	if s.cfg.BoatOf != nil {
		out.Boat = s.cfg.BoatOf(by.ID)
	}
	if s.boat(out.Boat) == nil && len(out.Boats) > 0 {
		out.Boat = out.Boats[0].ID
	}
	// Easy first: the Dash, then the island courses (those whose start is
	// up the wind today last), then the courses with a beat in them, made
	// as time trials only.
	if len(buoys) > 0 {
		out.Courses = append(out.Courses, CourseChoice{
			CourseCard: CourseCard{ID: CourseID(CourseBuoy, ShapeDash, false, 0), Kind: CourseBuoy, Shape: ShapeDash,
				Name: BuoyName(ShapeDash, false, "")},
			Boats: dash})
	}
	island := slices.Clone(courses.Island)
	slices.SortStableFunc(island, func(a, b Course) int { return a.Number - b.Number })
	var islands []CourseChoice
	for _, ic := range island {
		boats := map[string]int{}
		for id, e := range ic.Boats {
			boats[id] = int(math.Round(e / 60))
		}
		islands = append(islands, CourseChoice{
			CourseCard: CourseCard{ID: CourseID(CourseIsland, "", false, ic.Number), Kind: CourseIsland, Number: ic.Number,
				Name: ic.Name, Length: math.Round(ic.Length), Way: wayOf(ic.Way),
				Upwind: s.cfg.StartsUpwind != nil && s.cfg.StartsUpwind(ic.Number, now)},
			Boats: boats})
	}
	slices.SortStableFunc(islands, func(a, b CourseChoice) int { return boolOrder(a.Upwind) - boolOrder(b.Upwind) })
	out.Courses = append(out.Courses, islands...)
	if len(buoys) > 0 {
		for _, l := range []bool{false, true} {
			for _, shape := range []string{ShapeWindwardLeeward, ShapeTriangle} {
				minutes := buoys
				if l {
					minutes = long
				}
				out.Courses = append(out.Courses, CourseChoice{
					CourseCard: CourseCard{ID: CourseID(CourseBuoy, shape, l, 0), Kind: CourseBuoy, Shape: shape, Long: l,
						Name: BuoyName(shape, l, ""), Upwind: true},
					Boats: minutes, TrialOnly: true})
			}
		}
	}
	return out, nil
}
