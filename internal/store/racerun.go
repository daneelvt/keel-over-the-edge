// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/daneelvt/keel-over-the-edge/internal/store/db"
)

// Races run: the world's committee takes each race from its warning signal
// (or a trial's run as its sailor asks for it), and what it came to is
// written here once it ends, fenced by the lease as every write of the
// world is: each boat's result and track, the lasting record of everyone
// who raced and of the race's owner, the news's stories, and the race
// finished. Each write is made once, whatever is written again after a
// restart.

// The ways a boat's race ends, RaceResult.How.
const (
	HowFinished = "finished" // home
	HowPlaced   = "placed"   // still racing at the end: placed by its progress
	HowDNS      = "dns"      // did not start: not at sea as the boats were placed
	HowRetired  = "ret"      // retired
	HowRemoved  = "removed"  // removed by the race's owner
)

// The parts a sailor has in a race, RaceRecord.Role.
const (
	RoleSkipper = "skipper"
	RoleCrew    = "crew"
	RoleOwner   = "owner"
)

// StorySubjectRace is a story's subject when it is about a race.
const StorySubjectRace = "race"

// The kinds of race story.
const (
	StoryRace  = "race"  // a race won
	StoryTrial = "trial" // a gold, or the harbourmaster's time, in a time trial
)

// DueRaces are a world's races, not trials, open or closed, starting after
// since and up to until.
func (s *Store) DueRaces(ctx context.Context, world [16]byte, number int, since, until time.Time) ([]Race, error) {
	ids, err := s.q.DueRaces(ctx, db.DueRacesParams{WorldID: pgtype.UUID{Bytes: world, Valid: true}, Since: since, Until: until})
	if err != nil {
		return nil, err
	}
	return s.racesOf(ctx, world, number, ids)
}

// RaceIn is a world's race of an ID.
func (s *Store) RaceIn(ctx context.Context, world [16]byte, number int, id [16]byte) (Race, error) {
	r, err := s.q.RaceIn(ctx, db.RaceInParams{WorldID: pgtype.UUID{Bytes: world, Valid: true}, ID: pgtype.UUID{Bytes: id, Valid: true}})
	if errors.Is(err, pgx.ErrNoRows) {
		return Race{}, ErrNotFound
	}
	if err != nil {
		return Race{}, err
	}
	return Race{World: world, WorldNumber: number, ID: id, Code: r.Code, Owner: r.OwnerID.Bytes,
		HasOwner: r.OwnerID.Bytes != [16]byte{}, Kind: r.Kind, CourseKind: r.CourseKind, Course: int(r.Course),
		Shape: r.Shape, Long: r.Long, Boat: r.Boat, Who: r.Who, Name: r.Name, StartsAt: r.StartsAt.UTC(),
		Moved: r.Moved, State: r.State, Harbour: int(r.Harbour), MadeAt: r.MadeAt.UTC(), Entered: int(r.Entered)}, nil
}

// PendingRun is a trial's sailor who asked for a run: the trial, the
// sailor's entry, and the run they sail next.
type PendingRun struct {
	Race     [16]byte
	Account  AccountID
	Number   int
	Machine  bool
	WithCrew bool
	Run      int
}

// PendingRuns are a world's open trials' sailors who asked for a run and
// have none under way, the longest waiting first.
func (s *Store) PendingRuns(ctx context.Context, world [16]byte) ([]PendingRun, error) {
	rows, err := s.q.PendingRuns(ctx, pgtype.UUID{Bytes: world, Valid: true})
	if err != nil {
		return nil, err
	}
	out := make([]PendingRun, len(rows))
	for i, r := range rows {
		out[i] = PendingRun{Race: r.RaceID.Bytes, Account: r.AccountID.Bytes, Number: int(r.Number), Machine: r.Machine,
			WithCrew: r.WithCrew, Run: int(r.NextRun)}
	}
	return out, nil
}

// RaceStart is a race, or a trial's run, under way: its boats placed on
// its line, and those that did not start.
type RaceStart struct {
	World [16]byte
	Race  [16]byte
	Run   int
	Trial bool
	At    time.Time
	// Placed are the boats placed; Missed the trial's sailors not at sea
	// as their run was to begin.
	Placed []RaceStarter
	Missed []AccountID
}

// RaceStarter is a boat placed on a race's line.
type RaceStarter struct {
	Account  AccountID
	Number   int
	Machine  bool
	WithCrew bool
}

// StartRace writes a race under way, fenced: a race racing, its boats
// placed started; a trial's run begun as an entry of its own, or not
// begun, its sailor's entry no longer asking for one.
func (s *Store) StartRace(ctx context.Context, lease int64, r *RaceStart) error {
	world, race := pgtype.UUID{Bytes: r.World, Valid: true}, pgtype.UUID{Bytes: r.Race, Valid: true}
	return s.fenced(ctx, lease, func(q *db.Queries) error {
		if r.Trial {
			for _, p := range r.Placed {
				if err := q.InsertRun(ctx, db.InsertRunParams{WorldID: world, RaceID: race, AccountID: uuidOf(p.Account), Run: int16(r.Run),
					Number: int16(p.Number), Machine: p.Machine, WithCrew: p.WithCrew, At: r.At}); err != nil {
					return err
				}
			}
			for _, a := range r.Missed {
				if err := q.WithdrawRun(ctx, db.WithdrawRunParams{WorldID: world, RaceID: race, AccountID: uuidOf(a), At: stamp(r.At)}); err != nil {
					return err
				}
			}
			return nil
		}
		if err := q.RacingState(ctx, db.RacingStateParams{WorldID: world, ID: race}); err != nil {
			return err
		}
		ids := make([]pgtype.UUID, len(r.Placed))
		for i, p := range r.Placed {
			ids[i] = uuidOf(p.Account)
		}
		return q.StartEntries(ctx, db.StartEntriesParams{WorldID: world, RaceID: race, Accounts: ids, At: stamp(r.At)})
	})
}

// RaceEnd is a race, or a trial's run, ended: what its boats came to, the
// lasting records, the news's stories, and the run as laid for its
// replay (nil for none).
type RaceEnd struct {
	World   [16]byte
	Race    [16]byte
	Run     int
	Trial   bool
	At      time.Time
	Results []RaceResult
	Records []RaceRecord
	Stories []Story
	Laid    *RaceLaid
}

// RaceLaid is a race's run as its committee laid it, for its replay: its
// warning signal, its gun and its end, world ticks, and its course.
type RaceLaid struct {
	Run                   int
	Warning, Start, Ended int64
	Course                LaidCourse
}

// LaidCourse is a course as the chart draws it, whole metres east and
// north of the world's centre: the start line's ends (the pin's, then the
// committee boat's) and the finish line's; each mark laid (east, north,
// its number, the side it is left to: 1 starboard, −1 port, 0 a gate's);
// the way sailed, in pairs; each leg a boat makes for (the mark's number,
// 0 a line, and the point); where the course lies and how far it reaches;
// its laps; and how long its boat was expected to take, s.
type LaidCourse struct {
	Line     [4]int32   `json:"line"`
	Finish   [4]int32   `json:"finish"`
	Marks    [][4]int32 `json:"marks"`
	Way      []int32    `json:"way"`
	Legs     [][3]int32 `json:"legs"`
	East     int32      `json:"east"`
	North    int32      `json:"north"`
	Reach    int32      `json:"reach"`
	Laps     int32      `json:"laps"`
	Expected float64    `json:"expected"`
}

// RaceResult is what a boat came to: its place (0 none), its time from
// the start, s (negative for none), the seconds added, the marks rounded
// and the way still to go, m (negative for none), how it ended, its medal
// and awards, those aboard, and its track.
type RaceResult struct {
	Account AccountID
	Place   int
	Elapsed float64
	Added   float64
	Marks   int
	ToGo    float64
	How     string
	Medal   string
	Awards  []string
	Crew    []RaceCrew
	Track   []byte
}

// RaceCrew is someone aboard a boat as it raced, as a copy.
type RaceCrew struct {
	Account AccountID `json:"account"`
	Name    string    `json:"name"`
	Machine bool      `json:"machine,omitempty"`
}

// RaceRecord is a race in a sailor's lasting record, written once by its
// source: the race as it was, and the sailor's part in it.
type RaceRecord struct {
	Account    AccountID
	Source     string
	World      int
	At         time.Time
	Code       string
	RaceName   string
	Kind       string
	CourseName string
	Boat       string
	BoatName   string
	Fleet      int
	Harbour    bool
	Newcomers  bool
	Role       string
	Place      int
	How        string
	Medal      string
	Awards     []string
	// The skipper of a crew's boat: none for a skipper's own record, nor
	// an owner's.
	Skipper        AccountID
	SkipperName    string
	SkipperMachine bool
	// Hung: the wooden spoon of the race hung from the sailor's sterns
	// for the rest of its world, by their choice.
	Hung bool
	// Number is the boat's race number, Elapsed its time from the start,
	// s, 0 for none, and Added the seconds added to it; Run the run of the
	// race (a trial's from 1), from Source. Read by RaceRecordsByCode
	// alone.
	Number  int
	Elapsed float64
	Added   float64
	Run     int
}

// EndRace writes a race, or a trial's run, ended, fenced: each boat's
// result and track, the records and the stories, once each; a race
// finished, and a trial's sailor's entry no longer asking for a run.
func (s *Store) EndRace(ctx context.Context, lease int64, rules NewsRules, e *RaceEnd) error {
	world, race := pgtype.UUID{Bytes: e.World, Valid: true}, pgtype.UUID{Bytes: e.Race, Valid: true}
	return s.fenced(ctx, lease, func(q *db.Queries) error {
		for i := range e.Results {
			r := &e.Results[i]
			crew := r.Crew
			if crew == nil {
				crew = []RaceCrew{}
			}
			people, err := json.Marshal(crew)
			if err != nil {
				return err
			}
			awards := r.Awards
			if awards == nil {
				awards = []string{}
			}
			p := db.PutRaceResultParams{WorldID: world, RaceID: race, AccountID: uuidOf(r.Account), Run: int16(e.Run),
				Added: float32(r.Added), Marks: int16(r.Marks), How: r.How, Medal: text(r.Medal), Awards: awards, Crew: people}
			if r.Place > 0 {
				p.Place = pgtype.Int2{Int16: int16(r.Place), Valid: true}
			}
			if r.Elapsed >= 0 {
				p.Elapsed = pgtype.Float4{Float32: float32(r.Elapsed), Valid: true}
			}
			if r.ToGo >= 0 {
				p.ToGo = pgtype.Float4{Float32: float32(r.ToGo), Valid: true}
			}
			if err := q.PutRaceResult(ctx, p); err != nil {
				return fmt.Errorf("a race's result: %w", err)
			}
			if len(r.Track) > 0 {
				if err := q.PutRaceTrack(ctx, db.PutRaceTrackParams{WorldID: world, RaceID: race, AccountID: uuidOf(r.Account),
					Run: int16(e.Run), Samples: r.Track}); err != nil {
					return fmt.Errorf("a race's track: %w", err)
				}
			}
			if e.Trial {
				if err := q.WithdrawRun(ctx, db.WithdrawRunParams{WorldID: world, RaceID: race, AccountID: uuidOf(r.Account), At: stamp(e.At)}); err != nil {
					return err
				}
			}
		}
		for i := range e.Records {
			if err := putRecord(ctx, q, &e.Records[i]); err != nil {
				return fmt.Errorf("a race's record: %w", err)
			}
		}
		if l := e.Laid; l != nil {
			course, err := json.Marshal(l.Course)
			if err != nil {
				return err
			}
			if err := q.PutRaceRun(ctx, db.PutRaceRunParams{WorldID: world, RaceID: race, Run: int16(e.Run), Warning: l.Warning,
				Start: l.Start, Ended: l.Ended, Course: course}); err != nil {
				return fmt.Errorf("a race's run: %w", err)
			}
		}
		nw := &newsWrite{world: world, rules: &rules}
		for i := range e.Stories {
			if _, err := insertStory(ctx, q, nw, &e.Stories[i]); err != nil {
				return err
			}
		}
		if e.Trial {
			return nil
		}
		return q.FinishRace(ctx, db.FinishRaceParams{WorldID: world, ID: race, At: stamp(e.At)})
	})
}

// putRecord writes a race record, once.
func putRecord(ctx context.Context, q *db.Queries, r *RaceRecord) error {
	awards := r.Awards
	if awards == nil {
		awards = []string{}
	}
	p := db.PutRaceRecordParams{AccountID: uuidOf(r.Account), Source: r.Source, World: int32(r.World), At: r.At, Code: r.Code,
		RaceName: r.RaceName, Kind: r.Kind, CourseName: r.CourseName, Boat: r.Boat, BoatName: text(r.BoatName),
		Fleet: int16(r.Fleet), Harbour: r.Harbour, Newcomers: r.Newcomers, Role: r.Role, How: text(r.How), Medal: text(r.Medal),
		Awards: awards, SkipperName: text(r.SkipperName), SkipperMachine: r.SkipperMachine}
	if r.Place > 0 {
		p.Place = pgtype.Int2{Int16: int16(r.Place), Valid: true}
	}
	if r.Skipper != (AccountID{}) {
		p.SkipperID = uuidOf(r.Skipper)
	}
	if r.Number > 0 {
		p.Number = pgtype.Int2{Int16: int16(r.Number), Valid: true}
	}
	if r.Elapsed > 0 {
		p.Elapsed = pgtype.Float4{Float32: float32(r.Elapsed), Valid: true}
	}
	p.Added = float32(max(r.Added, 0))
	return q.PutRaceRecord(ctx, p)
}

// RaceRun is what a boat came to in a race, or in a trial's run, as kept:
// its run, its race number and whether a machine sailor's (0 and false for
// an entry not kept), and its result with its track.
type RaceRun struct {
	Run     int
	Number  int
	Machine bool
	RaceResult
}

// RaceResults are what a race's boats came to, or a trial's runs, with
// their tracks: by run, then place, those unplaced last.
func (s *Store) RaceResults(ctx context.Context, world, race [16]byte) ([]RaceRun, error) {
	rows, err := s.q.RaceResults(ctx, db.RaceResultsParams{WorldID: pgtype.UUID{Bytes: world, Valid: true},
		RaceID: pgtype.UUID{Bytes: race, Valid: true}})
	if err != nil {
		return nil, err
	}
	out := make([]RaceRun, len(rows))
	for i, r := range rows {
		x := RaceRun{Run: int(r.Run), Number: int(r.Number), Machine: r.Machine, RaceResult: RaceResult{Account: r.AccountID.Bytes, Place: int(r.Place), Elapsed: float64(r.Elapsed),
			Added: float64(r.Added), Marks: int(r.Marks), ToGo: float64(r.ToGo), How: r.How, Medal: r.Medal, Awards: r.Awards,
			Track: r.Samples}}
		if err := json.Unmarshal(r.Crew, &x.Crew); err != nil {
			return nil, fmt.Errorf("a race result's crew: %w", err)
		}
		out[i] = x
	}
	return out, nil
}

// RaceRuns are a race's runs as their committee laid them, by run.
func (s *Store) RaceRuns(ctx context.Context, world, race [16]byte) ([]RaceLaid, error) {
	rows, err := s.q.RaceRuns(ctx, db.RaceRunsParams{WorldID: pgtype.UUID{Bytes: world, Valid: true},
		RaceID: pgtype.UUID{Bytes: race, Valid: true}})
	if err != nil {
		return nil, err
	}
	out := make([]RaceLaid, len(rows))
	for i, r := range rows {
		out[i] = RaceLaid{Run: int(r.Run), Warning: r.Warning, Start: r.Start, Ended: r.Ended}
		if err := json.Unmarshal(r.Course, &out[i].Course); err != nil {
			return nil, fmt.Errorf("a race's run's course: %w", err)
		}
	}
	return out, nil
}

// RaceRecordsByCode are the lasting records of the boats of a race and
// their crews, by its link's code, of the newest world that raced one: by
// run, then place. None for no such race.
func (s *Store) RaceRecordsByCode(ctx context.Context, code string) ([]RaceRecord, error) {
	rows, err := s.q.RaceRecordsByCode(ctx, code)
	if err != nil {
		return nil, err
	}
	out := make([]RaceRecord, len(rows))
	for i, r := range rows {
		out[i] = RaceRecord{Account: r.AccountID.Bytes, Source: r.Source, World: int(r.World), At: r.At.UTC(), Code: r.Code,
			RaceName: r.RaceName, Kind: r.Kind, CourseName: r.CourseName, Boat: r.Boat, BoatName: r.BoatName, Fleet: int(r.Fleet),
			Harbour: r.Harbour, Newcomers: r.Newcomers, Role: r.Role, Place: int(r.Place), How: r.How, Medal: r.Medal, Awards: r.Awards,
			Skipper: r.SkipperID.Bytes, SkipperName: r.SkipperName, SkipperMachine: r.SkipperMachine, Number: int(r.Number),
			Elapsed: max(float64(r.Elapsed), 0), Added: float64(r.Added), Run: runOfSource(r.Source)}
	}
	return out, nil
}

// runOfSource is the run of a race record's source, "race:<code>:<run>".
func runOfSource(source string) int {
	i := strings.LastIndexByte(source, ':')
	if i < 0 {
		return 0
	}
	n, err := strconv.Atoi(source[i+1:])
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// RaceRecordsOf are a sailor's lasting race records, the newest first, at
// most most.
func (s *Store) RaceRecordsOf(ctx context.Context, id AccountID, most int) ([]RaceRecord, error) {
	rows, err := s.q.RaceRecordsOf(ctx, db.RaceRecordsOfParams{AccountID: uuidOf(id), Most: int32(most)})
	if err != nil {
		return nil, err
	}
	return raceRecordsOf(id, rows), nil
}

// RaceRibbonsOf are a sailor's lasting records of the races they sailed,
// skipper or crew, the newest first: at most most after the first skip.
func (s *Store) RaceRibbonsOf(ctx context.Context, id AccountID, skip, most int) ([]RaceRecord, error) {
	rows, err := s.q.RaceRibbonsOf(ctx, db.RaceRibbonsOfParams{AccountID: uuidOf(id), Skip: int32(skip), Most: int32(most)})
	if err != nil {
		return nil, err
	}
	same := make([]db.RaceRecordsOfRow, len(rows))
	for i, r := range rows {
		same[i] = db.RaceRecordsOfRow(r)
	}
	return raceRecordsOf(id, same), nil
}

// raceRecordsOf are id's race records as read.
func raceRecordsOf(id AccountID, rows []db.RaceRecordsOfRow) []RaceRecord {
	out := make([]RaceRecord, len(rows))
	for i, r := range rows {
		out[i] = RaceRecord{Account: id, Source: r.Source, World: int(r.World), At: r.At.UTC(), Code: r.Code, RaceName: r.RaceName,
			Kind: r.Kind, CourseName: r.CourseName, Boat: r.Boat, BoatName: r.BoatName, Fleet: int(r.Fleet), Harbour: r.Harbour,
			Newcomers: r.Newcomers, Role: r.Role, Place: int(r.Place), How: r.How, Medal: r.Medal, Awards: r.Awards,
			Skipper: r.SkipperID.Bytes, SkipperName: r.SkipperName, SkipperMachine: r.SkipperMachine, Hung: r.Hung}
	}
	return out
}

// RaceCounts are a sailor's races counted over every world: sailed,
// skipper or crew; top three places and wins in races; each award and
// medal given; races run as their owner.
type RaceCounts struct {
	Sailed, Top3, Wins                                   int
	BestStarts, Comebacks, PhotoFinishes, Crowds, Spoons int
	Harbourmasters, Golds, Silvers, Bronzes              int
	Ran                                                  int
}

// RaceCountsOf are id's races counted over every world.
func (s *Store) RaceCountsOf(ctx context.Context, id AccountID) (RaceCounts, error) {
	r, err := s.q.RaceCountsOf(ctx, uuidOf(id))
	if err != nil {
		return RaceCounts{}, err
	}
	return RaceCounts{Sailed: int(r.Sailed), Top3: int(r.Top3), Wins: int(r.Wins), BestStarts: int(r.BestStarts),
		Comebacks: int(r.Comebacks), PhotoFinishes: int(r.PhotoFinishes), Crowds: int(r.Crowds), Spoons: int(r.Spoons),
		Harbourmasters: int(r.Harbourmasters), Golds: int(r.Golds), Silvers: int(r.Silvers), Bronzes: int(r.Bronzes),
		Ran: int(r.Ran)}, nil
}

// HangSpoon hangs the wooden spoon id was given in world's race of code
// from their boats' sterns, or takes it down; ErrNotFound if they were
// given none there.
func (s *Store) HangSpoon(ctx context.Context, id AccountID, world int, code string, hung bool) error {
	n, err := s.q.HangSpoon(ctx, db.HangSpoonParams{Hung: hung, AccountID: uuidOf(id), World: int32(world), Code: code})
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// SpoonsHung is how many wooden spoons id hangs from their sterns in
// world.
func (s *Store) SpoonsHung(ctx context.Context, id AccountID, world int) (int, error) {
	n, err := s.q.SpoonsHung(ctx, db.SpoonsHungParams{AccountID: uuidOf(id), World: int32(world)})
	return int(n), err
}

// RacePrizes are what a sailor's races in a world show on the water while
// it lasts: the races they sailed, skipper or crew, the links' codes of
// those they won, the newest first, the wooden spoons they hang, and the
// races they ran. Only races of three boats or more count.
type RacePrizes struct {
	Sailed int
	Wins   []string
	Spoons int
	Ran    int
}

// PrizesOf are the prizes of the sailors of ids in world, each with at
// most wins of their wins; a sailor with none is left out.
func (s *Store) PrizesOf(ctx context.Context, world int, ids []AccountID, wins int) (map[AccountID]RacePrizes, error) {
	out := make(map[AccountID]RacePrizes, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	us := make([]pgtype.UUID, len(ids))
	for i, id := range ids {
		us[i] = uuidOf(id)
	}
	rows, err := s.q.PrizesOf(ctx, db.PrizesOfParams{Most: int32(max(wins, 0)), Ids: us, World: int32(world)})
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[AccountID(r.AccountID.Bytes)] = RacePrizes{Sailed: int(r.Sailed), Wins: r.Wins, Spoons: int(r.Hung), Ran: int(r.Ran)}
	}
	return out, nil
}
