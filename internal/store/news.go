// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/daneelvt/keel-over-the-edge/internal/store/db"
)

// The news is a daily edition (migration 00034): whatever could be news is
// written to the world's news_item as a candidate story, with its kind and
// score and the day it belongs to; a day's edition, once set, keeps the
// stories chosen for it in their places, and its figures. The news reads
// the world sailed only: its rows go with its world's partitions.

// The kinds of story.
const (
	StoryGreat     = "great"     // a great discovery first sighted
	StoryRecord    = "record"    // a record at the falls
	StoryLife      = "life"      // a rare creature met
	StoryCrew      = "crew"      // a crew in company
	StoryFirst     = "first"     // a sailor's first charting ever
	StoryRun       = "run"       // a run, the day's longest told
	StoryMilestone = "milestone" // a milestone of a sailor's log
	StoryCharting  = "charting"  // any other charting
	StoryArrival   = "arrival"   // a new world: its first edition opens with it
	StoryReview    = "review"    // the last world in review, in a new world's first edition
	StoryCourse    = "course"    // an island course opened by charting
	storyEdition   = "edition"   // a day's edition set
)

// The owner's actions on the news: a story struck from it, and put back.
const (
	ActionStrike   = "strike"
	ActionUnstrike = "unstrike"
)

// SubjectSailor is a story's subject when it is about a sailor, not a
// place.
const SubjectSailor = "sailor"

// SubjectCourse is a story's subject when it is about an island course,
// by its number in the world.
const SubjectCourse = "course"

// The kinds of a sailor's milestone.
const (
	MilestoneDistance = "distance" // nautical miles sailed
	MilestoneWorlds   = "worlds"   // worlds sailed
	MilestonePlaces   = "places"   // places charted
)

// StoryFacts are what a story's words need, as copies: the sailor's boat,
// its name and kind's id; the place named nearest where it happened ("" for
// open water) and whether it happened at a point (Spot; a story about a
// place always does); a kind of life's id; how many aboard; a milestone,
// its kind and value; for the world's arrival, its islands to find; for
// the last world's review, its number, sailors, distance, islands charted
// of how many, its greatest finds and who came nearest the falls; and for
// an edition, its figures; for a time trial's run, its medal.
type StoryFacts struct {
	Boat      string       `json:"boat,omitempty"`
	BoatKind  string       `json:"boatKind,omitempty"`
	Place     string       `json:"place,omitempty"`
	Spot      bool         `json:"spot,omitempty"`
	Life      string       `json:"life,omitempty"`
	Aboard    int          `json:"aboard,omitempty"`
	Milestone string       `json:"milestone,omitempty"`
	Value     float64      `json:"value,omitempty"`
	Boats     []string     `json:"boats,omitempty"`
	World     int          `json:"world,omitempty"`
	Sailors   int          `json:"sailors,omitempty"`
	Run       float64      `json:"run,omitempty"`
	Islands   int          `json:"islands,omitempty"`
	Of        int          `json:"of,omitempty"`
	Finds     []ReviewFind `json:"finds,omitempty"`
	Nearest   *Nearest     `json:"nearest,omitempty"`
	Figures   *Figures     `json:"figures,omitempty"`
	Medal     string       `json:"medal,omitempty"`
}

// ReviewFind is one of a world's greatest finds as its review copies it:
// its title and what it was, and whether a sailor found it (the story's
// named, in order, are its finders').
type ReviewFind struct {
	Title string  `json:"title"`
	What  string  `json:"what"`
	Worth float64 `json:"worth"`
}

// Nearest is who came nearest the falls in a world and lived: how near,
// m, and their boat (the review's last named is its sailor).
type Nearest struct {
	Least    float64 `json:"least"`
	Boat     string  `json:"boat,omitempty"`
	BoatKind string  `json:"boatKind,omitempty"`
}

// Figures are a day of the world in counts, never names: the boats
// sailed (each sailor once) and the machine sailors among them, the
// distance run, m, the places charted, the crews in company, the falls
// and the races run.
type Figures struct {
	Boats    int     `json:"boats"`
	Machines int     `json:"machines"`
	Run      float64 `json:"run"`
	Charted  int     `json:"charted"`
	Crews    int     `json:"crews"`
	Over     int     `json:"over"`
	Races    int     `json:"races,omitempty"`
}

// Story is a story of the news: a candidate, or one chosen. Account is the
// sailor it is about, zero for none (with Sailor and AccountKind as they
// were copied, Sailor "" once the account is deleted); Named the others it
// names, in order. Subject and Number are the place it is about, or
// SubjectSailor; Island the island it is on, −1 for none. Amount is what
// it turns on, with Record it is written only if nearer than any of its
// kind this world. Source writes it once. Day is its day (read only), Rank
// its place in its day's edition once set, 0 for none, and Struck the
// owner's hand.
type Story struct {
	ID          [16]byte
	Story       string
	Score       int
	At          time.Time
	Day         time.Time
	Account     AccountID
	Sailor      string
	AccountKind string
	Named       []AccountID
	Subject     string
	Number      int32
	Title, What string
	Island      int32
	Worth       float64
	X, Y        float64
	Amount      float64
	Record      bool
	Facts       StoryFacts
	Source      string
	Rank        int
	Struck      bool
}

// NewsRules are how the world's writes make candidates: the zone a day is
// kept in (the world's schedule's), the stories' column, and the
// milestones: a sailor's first charting ever's score, a milestone's, and
// the multiples of distance (m), worlds and places that make one.
type NewsRules struct {
	Zone           string
	Column         string
	FirstScore     int
	MilestoneScore int
	Distance       float64
	Worlds         int
	Places         int
}

// newsWrite is what a fenced batch writes the news with: its world and
// rules.
type newsWrite struct {
	world pgtype.UUID
	rules *NewsRules
}

// insertStory writes a candidate story, unless it was written already or,
// a record, is not one; and reports whether it did.
func insertStory(ctx context.Context, q *db.Queries, nw *newsWrite, s *Story) (bool, error) {
	facts, err := json.Marshal(s.Facts)
	if err != nil {
		return false, err
	}
	named := make([]pgtype.UUID, len(s.Named))
	for i, id := range s.Named {
		named[i] = uuidOf(id)
	}
	column := nw.rules.Column
	p := db.InsertStoryParams{
		WorldID: nw.world, NewsColumn: column, Subject: s.Subject, Number: s.Number, Title: s.Title, What: s.What,
		IslandNumber: pgtype.Int4{Int32: s.Island, Valid: s.Island >= 0}, Worth: s.Worth, X: s.X, Y: s.Y,
		At: s.At, Story: s.Story, Score: int16(min(max(s.Score, 0), 100)), Zone: nw.rules.Zone, Named: named,
		Facts: facts, Source: text(s.Source),
	}
	if s.Account != (AccountID{}) {
		p.AccountID = uuidOf(s.Account)
	}
	if s.Amount != 0 || s.Record {
		p.Amount = pgtype.Float8{Float64: s.Amount, Valid: true}
	}
	if s.Record {
		p.Nearer = p.Amount
	}
	n, err := q.InsertStory(ctx, p)
	if err != nil {
		return false, fmt.Errorf("a story of the news: %w", err)
	}
	return n > 0, nil
}

// chartingStory writes the candidate a charting written makes: a great
// discovery's, or the sailor's first charting ever, or any other; first
// says which accounts' first chartings this batch has written already.
func chartingStory(ctx context.Context, q *db.Queries, nw *newsWrite, c *Charting, first map[AccountID]bool) error {
	n := c.News
	s := Story{
		Story: n.Story, Score: n.Score, At: c.At, Account: c.Account, Subject: c.Subject, Number: c.Number,
		Title: n.Title, What: n.What, Island: n.Island, Worth: c.Worth, X: n.X, Y: n.Y,
		Facts:  StoryFacts{Boat: n.Boat, BoatKind: n.BoatKind},
		Source: fmt.Sprintf("c:%s:%d", c.Subject, c.Number),
	}
	if s.Story != StoryGreat && nw.rules.FirstScore > 0 && !first[c.Account] {
		before, err := q.ChartedBefore(ctx, uuidOf(c.Account))
		if err != nil {
			return err
		}
		if !before {
			s.Story, s.Score = StoryFirst, nw.rules.FirstScore
		}
	}
	first[c.Account] = true
	_, err := insertStory(ctx, q, nw, &s)
	return err
}

// courseStory writes the candidate a course opened by a charting makes,
// about the course, naming the sailor whose charting opened it.
func courseStory(ctx context.Context, q *db.Queries, nw *newsWrite, c *Charting, o *CourseOpen) error {
	s := Story{
		Story: StoryCourse, Score: o.Score, At: c.At, Account: c.Account, Subject: SubjectCourse, Number: o.Number,
		Title: o.Title, What: o.What, Island: -1, X: o.X, Y: o.Y,
		Source: fmt.Sprintf("course:%d", o.Number),
	}
	if n := c.News; n != nil {
		s.Facts = StoryFacts{Boat: n.Boat, BoatKind: n.BoatKind}
	}
	_, err := insertStory(ctx, q, nw, &s)
	return err
}

// milestone is a milestone story: an account's, of a kind and value,
// where it was reached.
func milestone(account AccountID, kind string, value float64, at time.Time, place string, x, y float64, spot bool, score int) Story {
	return Story{
		Story: StoryMilestone, Score: score, At: at, Account: account, Subject: SubjectSailor, Title: place, Island: -1, X: x, Y: y,
		Facts:  StoryFacts{Milestone: kind, Value: value, Place: place, Spot: spot},
		Source: fmt.Sprintf("milestone:%s:%x:%g", kind, account[:], value),
	}
}

// voyageMilestones writes the milestones a voyage of the log just written
// reaches: its sailor's distance passing a multiple, or their first voyage
// in a world that makes a multiple of worlds.
func voyageMilestones(ctx context.Context, q *db.Queries, nw *newsWrite, v *LogVoyage) error {
	r := nw.rules
	var out []Story
	if v.Logged && v.Run > 0 && r.Distance > 0 {
		total, err := q.LogRunOf(ctx, uuidOf(v.Account))
		if err != nil {
			return err
		}
		if k := math.Floor(total / r.Distance); k >= 1 && k > math.Floor((total-v.Run)/r.Distance) {
			nm := k * r.Distance / 1852
			out = append(out, milestone(v.Account, MilestoneDistance, math.Round(nm), v.Ended, v.Place, 0, 0, false, r.MilestoneScore))
		}
	}
	if r.Worlds > 0 {
		w, err := q.LogWorldsOf(ctx, db.LogWorldsOfParams{AccountID: uuidOf(v.Account), World: int32(v.World)})
		if err != nil {
			return err
		}
		if w.Here == 1 && w.Worlds > 0 && int(w.Worlds)%r.Worlds == 0 {
			out = append(out, milestone(v.Account, MilestoneWorlds, float64(w.Worlds), v.Ended, v.Place, 0, 0, false, r.MilestoneScore))
		}
	}
	for i := range out {
		if _, err := insertStory(ctx, q, nw, &out[i]); err != nil {
			return err
		}
	}
	return nil
}

// chartedMilestone writes the milestone a place charted just written
// reaches: its sailor's places charted making a multiple.
func chartedMilestone(ctx context.Context, q *db.Queries, nw *newsWrite, e *LogEntry) error {
	r := nw.rules
	if r.Places <= 0 {
		return nil
	}
	n, err := q.LogChartedOf(ctx, uuidOf(e.Account))
	if err != nil {
		return err
	}
	if n == 0 || int(n)%r.Places != 0 {
		return nil
	}
	s := milestone(e.Account, MilestonePlaces, float64(n), e.At, e.Title, e.X, e.Y, e.X != 0 || e.Y != 0, r.MilestoneScore)
	_, err = insertStory(ctx, q, nw, &s)
	return err
}

// storyRow is a story as each query reads it.
type storyRow struct {
	ID          pgtype.UUID
	Story       string
	Score       int16
	AccountID   pgtype.UUID
	Sailor      pgtype.Text
	AccountKind pgtype.Text
	Named       []pgtype.UUID
	Subject     string
	Number      int32
	Title       string
	What        string
	Worth       float64
	X           float64
	Y           float64
	Amount      pgtype.Float8
	Facts       []byte
	Rank        pgtype.Int2
	Struck      bool
	WrittenAt   time.Time
	Day         pgtype.Date
}

func storyOf(r *storyRow) (Story, error) {
	s := Story{
		ID: r.ID.Bytes, Story: r.Story, Score: int(r.Score), At: r.WrittenAt.UTC(), Account: r.AccountID.Bytes,
		Sailor: r.Sailor.String, AccountKind: r.AccountKind.String, Subject: r.Subject, Number: r.Number,
		Title: r.Title, What: r.What, Island: -1, Worth: r.Worth, X: r.X, Y: r.Y, Amount: r.Amount.Float64,
		Rank: int(r.Rank.Int16), Struck: r.Struck,
	}
	if r.Day.Valid {
		s.Day = r.Day.Time
	}
	for _, n := range r.Named {
		s.Named = append(s.Named, n.Bytes)
	}
	if err := json.Unmarshal(r.Facts, &s.Facts); err != nil {
		return Story{}, fmt.Errorf("a story's facts: %w", err)
	}
	return s, nil
}

// dateOf is a day as the database keeps it: its date, whatever its zone.
func dateOf(day time.Time) pgtype.Date {
	return pgtype.Date{Time: time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, time.UTC), Valid: true}
}

// DayStories are the stories of a world's day, its candidates and those
// chosen, the oldest first.
func (s *Store) DayStories(ctx context.Context, world [16]byte, day time.Time) ([]Story, error) {
	rows, err := s.q.DayStories(ctx, db.DayStoriesParams{WorldID: pgtype.UUID{Bytes: world, Valid: true}, Day: dateOf(day)})
	if err != nil {
		return nil, err
	}
	out := make([]Story, 0, len(rows))
	for _, r := range rows {
		st, err := storyOf(&storyRow{ID: r.ID, Story: r.Story, Score: r.Score, AccountID: r.AccountID, Sailor: r.Sailor,
			AccountKind: r.AccountKind, Named: r.Named, Subject: r.Subject, Number: r.Number, Title: r.Title, What: r.What,
			Worth: r.Worth, X: r.X, Y: r.Y, Amount: r.Amount, Facts: r.Facts, Rank: r.Rank, Struck: r.Struck, WrittenAt: r.WrittenAt,
			Day: dateOf(day)})
		if err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, nil
}

// RankedStories are the stories chosen for the set editions of days of a
// world, by day and place.
func (s *Store) RankedStories(ctx context.Context, world [16]byte, days []time.Time) ([]Story, error) {
	ds := make([]pgtype.Date, len(days))
	for i, d := range days {
		ds[i] = dateOf(d)
	}
	rows, err := s.q.RankedStories(ctx, db.RankedStoriesParams{WorldID: pgtype.UUID{Bytes: world, Valid: true}, Days: ds})
	if err != nil {
		return nil, err
	}
	out := make([]Story, 0, len(rows))
	for _, r := range rows {
		st, err := storyOf((*storyRow)(&r))
		if err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, nil
}

// StoriesAbout are up to limit stories of a world's set editions naming an
// account, the newest first, struck ones left out.
func (s *Store) StoriesAbout(ctx context.Context, world [16]byte, account AccountID, limit int) ([]Story, error) {
	rows, err := s.q.StoriesAbout(ctx, db.StoriesAboutParams{WorldID: pgtype.UUID{Bytes: world, Valid: true}, AccountID: uuidOf(account), Lim: int32(limit)})
	if err != nil {
		return nil, err
	}
	out := make([]Story, 0, len(rows))
	for _, r := range rows {
		st, err := storyOf((*storyRow)(&r))
		if err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, nil
}

// Edition is a day's edition, set: its day, its number from the world's
// first, and its figures.
type Edition struct {
	Day     time.Time
	Number  int
	Figures Figures
}

// Editions are the editions set of a world, the oldest first.
func (s *Store) Editions(ctx context.Context, world [16]byte) ([]Edition, error) {
	rows, err := s.q.Editions(ctx, pgtype.UUID{Bytes: world, Valid: true})
	if err != nil {
		return nil, err
	}
	out := make([]Edition, 0, len(rows))
	for _, r := range rows {
		var f StoryFacts
		if err := json.Unmarshal(r.Facts, &f); err != nil {
			return nil, fmt.Errorf("an edition's figures: %w", err)
		}
		e := Edition{Day: r.Day.Time, Number: int(r.Number)}
		if f.Figures != nil {
			e.Figures = *f.Figures
		}
		out = append(out, e)
	}
	return out, nil
}

// ErrEditionSet is an edition set already: a set edition never changes.
var ErrEditionSet = errors.New("store: the day's edition is set already")

// SetEdition sets a day's edition, fenced by the lease's epoch: its number
// and figures, and each story chosen in its place, ranks by the stories'
// IDs, the first 1. A day set already is left as it is: ErrEditionSet.
func (s *Store) SetEdition(ctx context.Context, lease int64, world [16]byte, column string, e Edition, ranks map[[16]byte]int) error {
	return s.fenced(ctx, lease, func(q *db.Queries) error {
		facts, err := json.Marshal(StoryFacts{Figures: &e.Figures})
		if err != nil {
			return err
		}
		w := pgtype.UUID{Bytes: world, Valid: true}
		day := dateOf(e.Day)
		n, err := q.InsertEdition(ctx, db.InsertEditionParams{
			WorldID: w, NewsColumn: column, Number: int32(e.Number), Day: day, Facts: facts,
			Source: text("edition:" + day.Time.Format(time.DateOnly)),
		})
		if err != nil {
			return err
		}
		if n == 0 {
			return ErrEditionSet
		}
		for id, rank := range ranks {
			if _, err := q.RankStory(ctx, db.RankStoryParams{WorldID: w, ID: pgtype.UUID{Bytes: id, Valid: true}, Rank: pgtype.Int2{Int16: int16(rank), Valid: true}}); err != nil {
				return err
			}
		}
		return nil
	})
}

// WriteStories writes stories of the news about the world itself, fenced
// by the lease's epoch: its arrival and the last world's review. Each is
// written once, by its source.
func (s *Store) WriteStories(ctx context.Context, lease int64, world [16]byte, rules NewsRules, stories []Story) error {
	return s.fenced(ctx, lease, func(q *db.Queries) error {
		nw := &newsWrite{world: pgtype.UUID{Bytes: world, Valid: true}, rules: &rules}
		for i := range stories {
			if _, err := insertStory(ctx, q, nw, &stories[i]); err != nil {
				return err
			}
		}
		return nil
	})
}

// WorldNotice is a notice of the world's own in the news: its end.
type WorldNotice struct {
	ID          [16]byte
	Column      string
	Title, What string
	X, Y        float64
	At          time.Time
	EndsAt      time.Time
}

// WorldNotices are the world's own notices, the oldest first.
func (s *Store) WorldNotices(ctx context.Context, world [16]byte) ([]WorldNotice, error) {
	rows, err := s.q.WorldNotices(ctx, pgtype.UUID{Bytes: world, Valid: true})
	if err != nil {
		return nil, err
	}
	out := make([]WorldNotice, len(rows))
	for i, r := range rows {
		out[i] = WorldNotice{ID: r.ID.Bytes, Column: r.NewsColumn, Title: r.Title, What: r.What, X: r.X, Y: r.Y,
			At: r.WrittenAt.UTC(), EndsAt: timeOf(r.EndsAt)}
	}
	return out, nil
}

// DayFigures are a world's figures between since and until, but its crews
// in company, which are its stories': the world of the id and number
// given.
func (s *Store) DayFigures(ctx context.Context, world [16]byte, number int, since, until time.Time) (Figures, error) {
	v, err := s.q.DayVoyageFigures(ctx, db.DayVoyageFiguresParams{World: int32(number), Since: since, Until: until})
	if err != nil {
		return Figures{}, err
	}
	c, err := s.q.DayCharted(ctx, db.DayChartedParams{WorldID: pgtype.UUID{Bytes: world, Valid: true}, Since: since, Until: until})
	if err != nil {
		return Figures{}, err
	}
	races, err := s.q.DayRaces(ctx, db.DayRacesParams{WorldID: pgtype.UUID{Bytes: world, Valid: true}, Since: stamp(since), Until: stamp(until)})
	if err != nil {
		return Figures{}, err
	}
	return Figures{Boats: int(v.Boats), Machines: int(v.Machines), Run: v.Run, Over: int(v.Over), Charted: int(c), Races: int(races)}, nil
}

// Review is a whole world in review: its sailors, the distance its boats
// ran, m, the islands charted, its greatest finds by sailors (the greatest
// first), and who came nearest the falls and lived, in which boat
// (Nearest zero for no one).
type Review struct {
	Sailors      int
	Run          float64
	Islands      int
	Finds        []Story
	Nearest      AccountID
	NearestLeast float64
	NearestBoat  string
	NearestKind  string
	// Arrival is what the world's own arrival told, if it was.
	Arrival *StoryFacts
}

// WorldReview reads a world in review, of the id and number given, its
// finds up to finds.
func (s *Store) WorldReview(ctx context.Context, world [16]byte, number, finds int) (Review, error) {
	id := pgtype.UUID{Bytes: world, Valid: true}
	v, err := s.q.WorldVoyageFigures(ctx, int32(number))
	if err != nil {
		return Review{}, err
	}
	out := Review{Sailors: int(v.Sailors), Run: v.Run}
	if out.Islands, err = s.chartedIslands(ctx, id); err != nil {
		return Review{}, err
	}
	near, err := s.q.NearestTheFalls(ctx, int32(number))
	if err != nil {
		return Review{}, err
	}
	if len(near) > 0 {
		n := near[0]
		out.Nearest, out.NearestLeast, out.NearestBoat, out.NearestKind = n.AccountID.Bytes, n.Least, n.BoatName, n.BoatKind
	}
	rows, err := s.q.GreatestFinds(ctx, db.GreatestFindsParams{WorldID: id, Lim: int32(finds)})
	if err != nil {
		return Review{}, err
	}
	for _, r := range rows {
		out.Finds = append(out.Finds, Story{Account: r.AccountID.Bytes, Sailor: r.Sailor.String, AccountKind: r.AccountKind.String,
			Subject: r.Subject, Number: r.Number, Title: r.Title, What: r.What, Worth: r.Worth})
	}
	facts, err := s.q.ArrivalFacts(ctx, id)
	if err != nil {
		return Review{}, err
	}
	if len(facts) > 0 {
		var f StoryFacts
		if err := json.Unmarshal(facts[0], &f); err == nil {
			out.Arrival = &f
		}
	}
	return out, nil
}

func (s *Store) chartedIslands(ctx context.Context, world pgtype.UUID) (int, error) {
	n, err := s.q.ChartedIslands(ctx, world)
	return int(n), err
}

// Struck is a story struck from the news, or put back: who it was about,
// as copied, its title and kind.
type Struck struct {
	Account AccountID
	Sailor  string
	Title   string
	Story   string
}

// StrikeStory strikes a story of a world from the news, or puts it back;
// ErrNotFound for no such story.
func (s *Store) StrikeStory(ctx context.Context, world, id [16]byte, struck bool) (Struck, error) {
	r, err := s.q.StrikeStory(ctx, db.StrikeStoryParams{WorldID: pgtype.UUID{Bytes: world, Valid: true}, ID: pgtype.UUID{Bytes: id, Valid: true}, Struck: struck})
	if errors.Is(err, pgx.ErrNoRows) {
		return Struck{}, ErrNotFound
	}
	if err != nil {
		return Struck{}, err
	}
	return Struck{Account: r.AccountID.Bytes, Sailor: r.Sailor.String, Title: r.Title, Story: r.Story}, nil
}
