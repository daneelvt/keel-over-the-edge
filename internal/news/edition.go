// SPDX-License-Identifier: AGPL-3.0-only

// Package news makes the world's news a daily edition of chosen stories.
// Whatever could be news is written as a candidate story, with its kind's
// score, by the world's writer (internal/store, from the chart and the
// log's frames). Each day of the world's schedule has one edition: the day
// in figures, never a name; at most a few stories, chosen by Choose, a
// pure function of the day's candidates and the recent editions; a box of
// the reader's own, about their shipmates, the sailors they follow and
// themselves; and the world's notices. Today's fills as the day goes; a
// job sets each day's once it is over, and a set edition never changes. A
// world's first edition opens with its arrival and the last world in
// review. Every name in it follows the log's naming rule (logbook.NameOf).
package news

import (
	"context"
	"encoding/hex"
	"errors"
	"slices"
	"sync"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/logbook"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// ErrNoEdition is a day the world has no edition of: before it began, or
// not yet come.
var ErrNoEdition = errors.New("news: no edition of that day")

// Keep is how long a day's stories, choice and figures are kept before
// they are read again: the news's own cache.
const Keep = 5 * time.Second

// Step is the clock today's choice is made by: the time truncated to it,
// so every server weighs the stories alike.
const Step = 10 * time.Minute

// SetBack is how many days back from yesterday the job sets editions not
// yet set; older days are read as they would be set.
const SetBack = 8

// Store is what the news reads and writes: internal/store.
type Store interface {
	DayStories(ctx context.Context, world [16]byte, day time.Time) ([]store.Story, error)
	RankedStories(ctx context.Context, world [16]byte, days []time.Time) ([]store.Story, error)
	StoriesAbout(ctx context.Context, world [16]byte, account store.AccountID, limit int) ([]store.Story, error)
	Editions(ctx context.Context, world [16]byte) ([]store.Edition, error)
	SetEdition(ctx context.Context, lease int64, world [16]byte, column string, e store.Edition, ranks map[[16]byte]int) error
	WorldNotices(ctx context.Context, world [16]byte) ([]store.WorldNotice, error)
	DayFigures(ctx context.Context, world [16]byte, number int, since, until time.Time) (store.Figures, error)
	LogPeople(ctx context.Context, ids []store.AccountID) (map[store.AccountID]store.LogPerson, error)
	LogSailorByID(ctx context.Context, id store.AccountID) (store.LogSailor, error)
	LogSailorByKey(ctx context.Context, key string) (store.LogSailor, error)
}

var _ Store = (*store.Store)(nil)

// World is the world sailed, whose news it is: its ID and number, and
// when it began.
type World struct {
	ID     [16]byte
	Number int
	Begins time.Time
}

// Config sets up a Service.
type Config struct {
	Store   Store
	Catalog *catalog.Catalog
	World   World
	// Zone is the zone a day is kept in: the world's schedule's.
	Zone *time.Location
	Now  func() time.Time
	// Blocks reports a block between two accounts, either way; nil for
	// none.
	Blocks func(a, b store.AccountID) bool
	// Shipmates are an account's shipmates; nil for none.
	Shipmates func(a store.AccountID) []store.AccountID
	// Follows are the sailors an account follows; nil for none.
	Follows func(ctx context.Context, a store.AccountID) ([]store.AccountID, error)
	// Key is a sailor's name's key (moderation.Key).
	Key func(name string) string
}

// Service reads the news, and sets each day's edition.
type Service struct {
	cfg    Config
	rules  Rules
	words  *words
	column string

	mu   sync.Mutex
	kept map[string]*page
}

// NewService makes a Service.
func NewService(cfg Config) *Service {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Zone == nil {
		cfg.Zone = time.UTC
	}
	s := &Service{cfg: cfg, words: newWords(cfg.Catalog), kept: map[string]*page{}}
	if cfg.Catalog != nil {
		s.rules = RulesOf(cfg.Catalog)
		for _, c := range cfg.Catalog.News.Columns {
			if c.Of == catalog.OfCharting && s.column == "" {
				s.column = string(c.ID)
			}
		}
	}
	return s
}

// Rules are the edition's rules.
func (s *Service) Rules() Rules { return s.rules }

// Column is the column the stories are written in.
func (s *Service) Column() string { return s.column }

// Edition is a day's edition as a reader reads it. Times are ms of UTC;
// distances m.
type Edition struct {
	World  int    `json:"world"`
	Day    string `json:"day"` // its date by the world's schedule, 2006-01-02
	Number int    `json:"number"`
	Zone   string `json:"zone"` // the zone its days are kept in
	// Set is true once the day is over and its edition set: it never
	// changes again. Today's fills as the day goes.
	Set     bool          `json:"set"`
	Figures store.Figures `json:"figures"`
	// FiguresText is the figures in one sentence.
	FiguresText string `json:"figuresText"`
	// Lead are the stories above the front page: on a world's first, its
	// arrival and the last world in review.
	Lead      []Story  `json:"lead"`
	Stories   []Story  `json:"stories"`
	Shipmates []Story  `json:"shipmates"`
	Notices   []Notice `json:"notices"`
	// Days are the world's editions, the newest first.
	Days []DayRef `json:"days"`
}

// Story is a story as a reader reads it: its headword and its text, whose
// slots {0}, {1}, … are its names by their index; a slot opening a
// sentence takes a capital. A story about a place has its subject and
// number, which open the place's box on the chart; one that happened at a
// point has its x and y (m east and north).
type Story struct {
	ID      string   `json:"id"`
	Kind    string   `json:"kind"`
	At      int64    `json:"at"`
	Head    string   `json:"head"`
	Text    string   `json:"text"`
	Names   []Name   `json:"names"`
	Subject string   `json:"subject,omitempty"`
	Number  int32    `json:"number"`
	X       *float64 `json:"x,omitempty"`
	Y       *float64 `json:"y,omitempty"`
	// Day is the date of the edition it is in, for a sailor's own.
	Day string `json:"day,omitempty"`
}

// The kinds of a name in a story.
const (
	NameHuman   = "human"   // a sailor named: Name
	NameMachine = "machine" // a machine sailor, marked as one: Name
	NameBoat    = "boat"    // a sailor not named: their boat, "the Gull", or with no name its kind, "a Jolly boat" (Type)
	NameSailor  = "sailor"  // "a sailor": a block, either way
	NameFormer  = "former"  // "a former sailor": the account deleted
)

// Name is a name in a story. Logged says the reader may open the named
// sailor's log; Boat is a named sailor's boat's name, if the story has
// it. Every name is player-written text but a Type.
type Name struct {
	Kind   string `json:"kind"`
	Name   string `json:"name,omitempty"`
	Boat   string `json:"boat,omitempty"`
	Type   string `json:"type,omitempty"`
	Logged bool   `json:"logged,omitempty"`
}

// Notice is a notice of the world's own: its end, which each reader reads
// in their own time.
type Notice struct {
	ID     string  `json:"id"`
	Head   string  `json:"head"`
	EndsAt int64   `json:"endsAt"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
}

// DayRef is one of the world's editions: its date and number, and whether
// it is set.
type DayRef struct {
	Day    string `json:"day"`
	Number int    `json:"number"`
	Set    bool   `json:"set"`
}

// page is a day as every reader reads it, kept Keep.
type page struct {
	read    time.Time
	day     time.Time
	set     bool
	at      int64
	cands   []store.Story // the day's candidates, struck ones out
	lead    []store.Story
	order   []Candidate
	chosen  []int // indexes of cands, in order
	recent  map[store.AccountID]bool
	figures store.Figures
	notices []store.WorldNotice
	days    []DayRef
}

// dayOf is the day t falls on, its midnight in the zone.
func (s *Service) dayOf(t time.Time) time.Time {
	t = t.In(s.cfg.Zone)
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, s.cfg.Zone)
}

// next is the day after day, midnight.
func (s *Service) next(day time.Time) time.Time {
	return time.Date(day.Year(), day.Month(), day.Day()+1, 0, 0, 0, 0, s.cfg.Zone)
}

// dayText is a day's date.
func dayText(day time.Time) string { return day.Format(time.DateOnly) }

// number is a day's edition's number: the world's first day's is 1.
func (s *Service) number(day time.Time) int {
	first := s.dayOf(s.cfg.World.Begins)
	a := time.Date(first.Year(), first.Month(), first.Day(), 0, 0, 0, 0, time.UTC)
	b := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, time.UTC)
	return int(b.Sub(a)/(24*time.Hour)) + 1
}

// ParseDay is a date's day, or today's for "".
func (s *Service) ParseDay(text string) (time.Time, error) {
	if text == "" {
		return s.dayOf(s.cfg.Now()), nil
	}
	d, err := time.ParseInLocation(time.DateOnly, text, s.cfg.Zone)
	if err != nil {
		return time.Time{}, ErrNoEdition
	}
	return d, nil
}

// page is a day's page, kept Keep.
func (s *Service) page(ctx context.Context, day time.Time) (*page, error) {
	now := s.cfg.Now()
	today := s.dayOf(now)
	first := s.dayOf(s.cfg.World.Begins)
	if day.Before(first) || day.After(today) {
		return nil, ErrNoEdition
	}
	key := dayText(day)
	s.mu.Lock()
	if p, ok := s.kept[key]; ok && now.Sub(p.read) < Keep && now.Sub(p.read) >= 0 {
		s.mu.Unlock()
		return p, nil
	}
	s.mu.Unlock()
	p, err := s.read(ctx, day, now)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	for k, v := range s.kept {
		if now.Sub(v.read) >= Keep {
			delete(s.kept, k)
		}
	}
	s.kept[key] = p
	s.mu.Unlock()
	return p, nil
}

// read reads a day's page at now.
func (s *Service) read(ctx context.Context, day, now time.Time) (*page, error) {
	st := s.cfg.Store
	w := &s.cfg.World
	editions, err := st.Editions(ctx, w.ID)
	if err != nil {
		return nil, err
	}
	setOn := map[string]store.Edition{}
	for _, e := range editions {
		setOn[dayText(e.Day)] = e
	}
	p := &page{read: now, day: day}
	end := s.next(day)
	stories, err := st.DayStories(ctx, w.ID, day)
	if err != nil {
		return nil, err
	}
	for _, x := range stories {
		switch {
		case x.Struck:
		case x.Story == store.StoryArrival || x.Story == store.StoryReview:
			p.lead = append(p.lead, x)
		default:
			p.cands = append(p.cands, x)
		}
	}
	slices.SortStableFunc(p.lead, func(a, b store.Story) int {
		if a.Story == b.Story {
			return 0
		}
		if a.Story == store.StoryArrival {
			return -1
		}
		return 1
	})
	p.recent, err = s.recent(ctx, day)
	if err != nil {
		return nil, err
	}
	p.order = candidates(p.cands)
	if e, ok := setOn[dayText(day)]; ok {
		p.set, p.figures, p.at = true, e.Figures, end.UnixMilli()
		ranked := map[[16]byte]int{}
		for i := range p.cands {
			if r := p.cands[i].Rank; r > 0 {
				ranked[p.cands[i].ID] = r
			}
		}
		for i := range p.cands {
			if ranked[p.cands[i].ID] > 0 {
				p.chosen = append(p.chosen, i)
			}
		}
		slices.SortFunc(p.chosen, func(a, b int) int { return p.cands[a].Rank - p.cands[b].Rank })
	} else {
		at := now.Truncate(Step)
		if !at.Before(end) {
			at = end
		}
		p.at = at.UnixMilli()
		p.chosen = Choose(p.order, p.recent, p.at, &s.rules)
		until := now
		if until.After(end) {
			until = end
		}
		if p.figures, err = st.DayFigures(ctx, w.ID, w.Number, day, until); err != nil {
			return nil, err
		}
		p.figures.Crews = crews(p.cands)
	}
	if p.notices, err = st.WorldNotices(ctx, w.ID); err != nil {
		return nil, err
	}
	today := s.dayOf(now)
	for d := today; !d.Before(s.dayOf(w.Begins)); d = time.Date(d.Year(), d.Month(), d.Day()-1, 0, 0, 0, 0, s.cfg.Zone) {
		_, set := setOn[dayText(d)]
		p.days = append(p.days, DayRef{Day: dayText(d), Number: s.number(d), Set: set})
		if len(p.days) > 400 {
			break
		}
	}
	return p, nil
}

// crews counts the crews in company among a day's candidates.
func crews(cands []store.Story) int {
	n := 0
	for i := range cands {
		if cands[i].Story == store.StoryCrew {
			n++
		}
	}
	return n
}

// candidates are a day's stories as the choice sees them.
func candidates(cands []store.Story) []Candidate {
	out := make([]Candidate, len(cands))
	for i := range cands {
		c := &cands[i]
		out[i] = Candidate{Kind: c.Story, Score: c.Score, At: c.At.UnixMilli(), Amount: c.Amount, Order: i, About: about(c)}
	}
	return out
}

// about are the sailors a story is about: its own first, then those it
// names.
func about(c *store.Story) []store.AccountID {
	var out []store.AccountID
	if c.Account != (store.AccountID{}) {
		out = append(out, c.Account)
	}
	for _, n := range c.Named {
		if n != (store.AccountID{}) && !slices.Contains(out, n) {
			out = append(out, n)
		}
	}
	return out
}

// recent are the sailors in the stories of the editions set of the days
// before day, Recent of them.
func (s *Service) recent(ctx context.Context, day time.Time) (map[store.AccountID]bool, error) {
	out := map[store.AccountID]bool{}
	if s.rules.Recent <= 0 {
		return out, nil
	}
	var days []time.Time
	for i := 1; i <= s.rules.Recent; i++ {
		days = append(days, time.Date(day.Year(), day.Month(), day.Day()-i, 0, 0, 0, 0, s.cfg.Zone))
	}
	ranked, err := s.cfg.Store.RankedStories(ctx, s.cfg.World.ID, days)
	if err != nil {
		return nil, err
	}
	for i := range ranked {
		if ranked[i].Struck {
			continue
		}
		for _, a := range about(&ranked[i]) {
			out[a] = true
		}
	}
	return out, nil
}

// reader is who reads, as the naming rule sees them: an account with no
// sailor is of no known age band.
func (s *Service) reader(ctx context.Context, id store.AccountID) (logbook.Reader, error) {
	r := logbook.Reader{ID: id, Band: aboard.Unknown}
	me, err := s.cfg.Store.LogSailorByID(ctx, id)
	switch {
	case errors.Is(err, store.ErrNotFound):
	case err != nil:
		return r, err
	default:
		r.Band = logbook.BandOf(me.Born, s.cfg.Now())
	}
	return r, nil
}

// Edition is a day's edition as reader reads it: today's for a zero day.
func (s *Service) Edition(ctx context.Context, reader store.AccountID, day time.Time) (Edition, error) {
	if day.IsZero() {
		day = s.dayOf(s.cfg.Now())
	}
	p, err := s.page(ctx, day)
	if err != nil {
		return Edition{}, err
	}
	r, err := s.reader(ctx, reader)
	if err != nil {
		return Edition{}, err
	}
	box := Box(p.order, p.chosen, s.circle(ctx, reader), p.recent, p.at, &s.rules, s.rules.Shipmates)
	var all []*store.Story
	for i := range p.lead {
		all = append(all, &p.lead[i])
	}
	for _, i := range p.chosen {
		all = append(all, &p.cands[i])
	}
	for _, i := range box {
		all = append(all, &p.cands[i])
	}
	people, err := s.people(ctx, all)
	if err != nil {
		return Edition{}, err
	}
	out := Edition{
		World: s.cfg.World.Number, Day: dayText(day), Number: s.number(day), Zone: s.cfg.Zone.String(), Set: p.set,
		Figures: p.figures, FiguresText: FiguresText(&p.figures),
		Lead: []Story{}, Stories: []Story{}, Shipmates: []Story{}, Notices: []Notice{}, Days: p.days,
	}
	for i := range p.lead {
		out.Lead = append(out.Lead, s.story(r, &p.lead[i], people))
	}
	for _, i := range p.chosen {
		out.Stories = append(out.Stories, s.story(r, &p.cands[i], people))
	}
	for _, i := range box {
		out.Shipmates = append(out.Shipmates, s.story(r, &p.cands[i], people))
	}
	end := s.next(day)
	for _, n := range p.notices {
		if n.At.Before(end) {
			out.Notices = append(out.Notices, Notice{ID: hex.EncodeToString(n.ID[:]), Head: n.Title, EndsAt: n.EndsAt.UnixMilli(), X: n.X, Y: n.Y})
		}
	}
	return out, nil
}

// circle are the sailors whose stories go in reader's own box: the
// reader, their shipmates and the sailors they follow.
func (s *Service) circle(ctx context.Context, reader store.AccountID) map[store.AccountID]bool {
	out := map[store.AccountID]bool{reader: true}
	if s.cfg.Shipmates != nil {
		for _, m := range s.cfg.Shipmates(reader) {
			out[m] = true
		}
	}
	if s.cfg.Follows != nil {
		if f, err := s.cfg.Follows(ctx, reader); err == nil {
			for _, a := range f {
				out[a] = true
			}
		}
	}
	return out
}

// people are the accounts the stories name, as the naming rule reads
// them.
func (s *Service) people(ctx context.Context, stories []*store.Story) (map[store.AccountID]store.LogPerson, error) {
	var ids []store.AccountID
	seen := map[store.AccountID]bool{}
	for _, st := range stories {
		for _, a := range about(st) {
			if !seen[a] {
				seen[a] = true
				ids = append(ids, a)
			}
		}
	}
	return s.cfg.Store.LogPeople(ctx, ids)
}

// name is how a sailor is named to r in a story; main is the sailor the
// story is about, who is their boat when not named (boat, of the kind
// kind), where anyone else is counted.
func (s *Service) name(r logbook.Reader, id store.AccountID, people map[store.AccountID]store.LogPerson, main bool, boat, kind string) (Name, logbook.Naming) {
	p, ok := people[id]
	if !ok || p.Name == "" {
		return Name{Kind: NameFormer}, logbook.Former
	}
	sl := logbook.SailorOf(p, s.cfg.Now())
	blocked := s.cfg.Blocks != nil && r.ID != id && s.cfg.Blocks(r.ID, id)
	switch n := logbook.NameOf(r, sl, blocked); n {
	case logbook.Named:
		out := Name{Kind: NameHuman, Name: p.Name, Boat: boat, Logged: logbook.MayRead(r, sl, blocked)}
		if sl.Machine {
			out.Kind = NameMachine
		}
		return out, n
	case logbook.Hidden:
		return Name{Kind: NameSailor}, n
	case logbook.Counted:
		if !main {
			return Name{}, n
		}
		if boat != "" {
			return Name{Kind: NameBoat, Name: boat}, n
		}
		return Name{Kind: NameBoat, Type: s.words.boats[kind]}, n
	default:
		return Name{Kind: NameFormer}, n
	}
}

// story is a story as r reads it.
func (s *Service) story(r logbook.Reader, st *store.Story, people map[store.AccountID]store.LogPerson) Story {
	out := Story{ID: hex.EncodeToString(st.ID[:]), Kind: st.Story, At: st.At.UnixMilli(), Names: []Name{}}
	named, counted := 0, 0
	switch st.Story {
	case store.StoryReview:
		// The finders and the nearest the falls, each in their own slot:
		// one not named is "a sailor".
		for i, id := range st.Named {
			boat := ""
			if i == len(st.Named)-1 && st.Facts.Nearest != nil {
				boat = st.Facts.Nearest.Boat
			}
			n, how := s.name(r, id, people, true, boat, "")
			if how == logbook.Counted {
				n = Name{Kind: NameSailor}
				if boat != "" {
					n = Name{Kind: NameBoat, Name: boat}
				}
			}
			out.Names = append(out.Names, n)
			named++
		}
	case store.StoryArrival:
	default:
		if st.Account != (store.AccountID{}) {
			n, _ := s.name(r, st.Account, people, true, st.Facts.Boat, st.Facts.BoatKind)
			out.Names = append(out.Names, n)
		} else {
			out.Names = append(out.Names, Name{Kind: NameFormer})
		}
		for _, id := range st.Named {
			if id == st.Account {
				continue
			}
			n, how := s.name(r, id, people, false, "", "")
			if how == logbook.Named {
				out.Names = append(out.Names, n)
				named++
			} else {
				counted++
			}
		}
	}
	out.Head, out.Text = s.words.written(st, named, counted)
	if st.Subject != store.SubjectSailor && st.Subject != store.SubjectWorld && st.Story != store.StoryArrival && st.Story != store.StoryReview {
		out.Subject, out.Number = st.Subject, st.Number
	}
	if st.Subject != store.SubjectSailor && st.Story != store.StoryArrival && st.Story != store.StoryReview || st.Facts.Spot {
		x, y := st.X, st.Y
		out.X, out.Y = &x, &y
	}
	if !st.Day.IsZero() {
		out.Day = dayText(st.Day)
	}
	return out
}

// About are the stories this world naming the sailor of a name, the newest
// first, up to limit, as reader reads them: none unless the reader may
// name them (the naming rule), so a sailor not named is never found by
// their name. An unknown name has none.
func (s *Service) About(ctx context.Context, reader store.AccountID, name string, limit int) ([]Story, error) {
	key := name
	if s.cfg.Key != nil {
		key = s.cfg.Key(name)
	}
	if key == "" {
		return []Story{}, nil
	}
	l, err := s.cfg.Store.LogSailorByKey(ctx, key)
	if errors.Is(err, store.ErrNotFound) {
		return []Story{}, nil
	}
	if err != nil {
		return nil, err
	}
	return s.AboutAccount(ctx, reader, l.ID, limit)
}

// AboutAccount are the stories this world naming an account, the newest
// first, up to limit, as reader reads them: none unless the reader may
// name them.
func (s *Service) AboutAccount(ctx context.Context, reader, id store.AccountID, limit int) ([]Story, error) {
	r, err := s.reader(ctx, reader)
	if err != nil {
		return nil, err
	}
	people, err := s.cfg.Store.LogPeople(ctx, []store.AccountID{id})
	if err != nil {
		return nil, err
	}
	if _, how := s.name(r, id, people, false, "", ""); how != logbook.Named {
		return []Story{}, nil
	}
	var found []*store.Story
	// Today's front page as it stands, then the editions set.
	today := s.dayOf(s.cfg.Now())
	if p, err := s.page(ctx, today); err == nil && !p.set {
		for _, i := range p.chosen {
			if slices.Contains(about(&p.cands[i]), id) {
				st := p.cands[i]
				st.Day = today
				found = append(found, &st)
			}
		}
	} else if err != nil && !errors.Is(err, ErrNoEdition) {
		return nil, err
	}
	set, err := s.cfg.Store.StoriesAbout(ctx, s.cfg.World.ID, id, limit)
	if err != nil {
		return nil, err
	}
	for i := range set {
		found = append(found, &set[i])
	}
	if len(found) > limit {
		found = found[:limit]
	}
	people, err = s.people(ctx, found)
	if err != nil {
		return nil, err
	}
	out := make([]Story, 0, len(found))
	for _, st := range found {
		out = append(out, s.story(r, st, people))
	}
	return out, nil
}

// Set sets the edition of each day of the world before today not yet set,
// up to SetBack days back, fenced by the lease's epoch: its figures, and
// its stories in their places, chosen as they would be read at the day's
// end. It returns how many it set.
func (s *Service) Set(ctx context.Context, lease int64) (int, error) {
	now := s.cfg.Now()
	today := s.dayOf(now)
	first := s.dayOf(s.cfg.World.Begins)
	from := time.Date(today.Year(), today.Month(), today.Day()-SetBack, 0, 0, 0, 0, s.cfg.Zone)
	if from.Before(first) {
		from = first
	}
	editions, err := s.cfg.Store.Editions(ctx, s.cfg.World.ID)
	if err != nil {
		return 0, err
	}
	set := map[string]bool{}
	for _, e := range editions {
		set[dayText(e.Day)] = true
	}
	n := 0
	for d := from; d.Before(today); d = s.next(d) {
		if set[dayText(d)] {
			continue
		}
		// Read as it stands at the day's end, by a fresh read.
		p, err := s.read(ctx, d, s.next(d))
		if err != nil {
			return n, err
		}
		ranks := make(map[[16]byte]int, len(p.chosen))
		for rank, i := range p.chosen {
			ranks[p.cands[i].ID] = rank + 1
		}
		err = s.cfg.Store.SetEdition(ctx, lease, s.cfg.World.ID, s.column, store.Edition{Day: d, Number: s.number(d), Figures: p.figures}, ranks)
		if errors.Is(err, store.ErrEditionSet) {
			continue
		}
		if err != nil {
			return n, err
		}
		n++
	}
	s.mu.Lock()
	clear(s.kept)
	s.mu.Unlock()
	return n, nil
}
