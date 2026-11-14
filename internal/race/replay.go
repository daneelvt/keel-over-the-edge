// SPDX-License-Identifier: AGPL-3.0-only

package race

import (
	"context"
	"errors"
	"math"
	"slices"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/logbook"
	"github.com/daneelvt/keel-over-the-edge/internal/race/committee"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// A race's replay, as its link shows it after the race: each run as its
// committee laid it, every boat's result, crew and track, the tracks
// small enough for a phone's data (whole metres, each sample its change
// from the one before). A time trial's runs come together, the best of
// each sailor's with their tracks unless others are asked for. The
// tracks go with the world: after it, the link shows the results and the
// awards alone, from the lasting records.

// MostReplayRuns is the most runs of a time trial a replay draws at once:
// one colour each.
const MostReplayRuns = 8

// MostTrialRuns is the most runs of a time trial a replay lists, the
// fastest.
const MostTrialRuns = 100

// ErrNotFinished is a race not yet over: no replay yet.
var ErrNotFinished = errors.New("race: not finished")

// Replay is a race as its replay shows it to a reader. At is when it
// ended (a trial's latest run), Unix ms. Kept: its world sails on and its
// runs' courses and tracks are given; else its results alone. Second is
// a second's world ticks.
type Replay struct {
	Code      string      `json:"code"`
	Link      string      `json:"link"`
	Name      string      `json:"name"`
	Kind      string      `json:"kind"`
	Boat      BoatRef     `json:"boat"`
	Course    string      `json:"course"`
	World     int         `json:"world"`
	Harbour   bool        `json:"harbour"`
	Newcomers bool        `json:"newcomers"`
	At        int64       `json:"at"`
	Kept      bool        `json:"kept"`
	Second    int         `json:"second"`
	Runs      []ReplayRun `json:"runs"`
}

// ReplayRun is a race's run (a race's only run is 0): its warning signal,
// its gun and its end, world ticks, and its course, when kept; whether its
// prizes were given (three boats sailed by three sailors); and its boats.
type ReplayRun struct {
	Run     int               `json:"run"`
	Warning int64             `json:"warning,omitempty"`
	Start   int64             `json:"start,omitempty"`
	Ended   int64             `json:"ended,omitempty"`
	Course  *store.LaidCourse `json:"course,omitempty"`
	Prizes  bool              `json:"prizes"`
	Boats   []ReplayBoat      `json:"boats"`
}

// ReplayBoat is a boat of a race as the reader is shown it: its race
// number; its skipper's name, nil where not named to the reader, who is
// shown the boat's name instead (nil for none); a machine sailor's, the
// reader's own; its place (0 none), how it ended, its time from the start,
// s (−1 none), the seconds added, the marks rounded and the way still to
// go, m (−1 none), a trial's medal and the awards; those aboard; and its
// track, when kept and asked.
type ReplayBoat struct {
	Number  int          `json:"number"`
	Name    *string      `json:"name"`
	Boat    *string      `json:"boat"`
	Machine bool         `json:"machine"`
	Me      bool         `json:"me,omitempty"`
	Place   int          `json:"place"`
	How     string       `json:"how"`
	Elapsed float64      `json:"elapsed"`
	Added   float64      `json:"added"`
	Marks   int          `json:"marks"`
	ToGo    float64      `json:"toGo"`
	Medal   string       `json:"medal,omitempty"`
	Awards  []string     `json:"awards"`
	Crew    []Person     `json:"crew,omitempty"`
	Track   *ReplayTrack `json:"track,omitempty"`
}

// ReplayTrack is a boat's track: the tick of its first sample and the
// ticks between samples; P the first sample's east and north, whole
// metres, then each sample's change from the one before.
type ReplayTrack struct {
	First int64   `json:"first"`
	Every int64   `json:"every"`
	P     []int32 `json:"p"`
}

// runAccount is a sailor's boat in a run.
type runAccount struct {
	run int
	id  store.AccountID
}

// TrackOf is a coded track as a replay sends it: nil for none or one that
// cannot be read.
func TrackOf(coded []byte) *ReplayTrack {
	ss, err := committee.Samples(coded)
	if err != nil || len(ss) == 0 {
		return nil
	}
	every := int64(committee.TrackEvery)
	if len(ss) > 1 {
		every = ss[1].Tick - ss[0].Tick
	}
	out := &ReplayTrack{First: ss[0].Tick, Every: every, P: make([]int32, 0, 2*len(ss))}
	var x, y int32
	for _, s := range ss {
		sx, sy := int32(math.Round(s.East)), int32(math.Round(s.North))
		out.P = append(out.P, sx-x, sy-y)
		x, y = sx, sy
	}
	return out
}

// Replay is the race of a code as its replay shows the sailor by: a time
// trial's runs asked for (runs, at most MostReplayRuns) drawn, or else
// the best of each sailor's. ErrNotFound for no such race, ErrNotFinished
// for a race not over, a *Refusal ("cancelled") for one cancelled.
func (s *Service) Replay(ctx context.Context, by Sailor, code string, runs []int) (Replay, error) {
	if !validCode(code) {
		return Replay{}, ErrNotFound
	}
	r, err := s.find(ctx, code)
	switch {
	case errors.Is(err, ErrNotFound):
		return s.recorded(ctx, by, code)
	case err != nil:
		return Replay{}, err
	case r.WorldNumber != s.cfg.World.Number:
		// Its world has gone: the results alone.
		if r.State == store.RaceCancelled {
			return Replay{}, refuse(PhaseCancelled)
		}
		return s.recorded(ctx, by, code)
	case r.State == store.RaceCancelled:
		return Replay{}, refuse(PhaseCancelled)
	case r.Kind == KindRace && r.State != store.RaceFinished:
		return Replay{}, ErrNotFinished
	}
	return s.kept(ctx, by, &r, runs)
}

// kept is race r of the world sailed now, as its replay shows the sailor
// by, with its courses and tracks.
func (s *Service) kept(ctx context.Context, by Sailor, r *store.Race, asked []int) (Replay, error) {
	results, err := s.cfg.Store.RaceResults(ctx, r.World, r.ID)
	if err != nil {
		return Replay{}, err
	}
	laid, err := s.cfg.Store.RaceRuns(ctx, r.World, r.ID)
	if err != nil {
		return Replay{}, err
	}
	courses := s.cfg.Courses()
	boat, _ := s.boatRef(r.Boat)
	out := Replay{Code: r.Code, Link: s.link(r.Code), Name: r.Name, Kind: r.Kind, Boat: boat, Course: s.courseName(r, &courses),
		World: r.WorldNumber, Harbour: r.Harbour >= 0, Newcomers: r.Who == WhoNewcomers, Kept: true, Second: committee.Second,
		Runs: []ReplayRun{}}
	if r.Kind == KindTrial {
		results = trialRuns(results, by.ID)
	}
	drawn := drawnRuns(r.Kind, results, asked)
	// The names: every skipper's and everyone aboard's, as the reader may
	// see them; the boats' names from the records, as they raced.
	ids := []store.AccountID{by.ID}
	for i := range results {
		ids = append(ids, results[i].Account)
		for _, c := range results[i].Crew {
			ids = append(ids, c.Account)
		}
	}
	people, err := s.cfg.Store.LogPeople(ctx, slices.Compact(ids))
	if err != nil {
		return Replay{}, err
	}
	records, err := s.cfg.Store.RaceRecordsByCode(ctx, r.Code)
	if err != nil {
		return Replay{}, err
	}
	boatNames := map[runAccount]string{}
	for i := range records {
		if x := &records[i]; x.World == r.WorldNumber && x.Role == store.RoleSkipper {
			boatNames[runAccount{x.Run, x.Account}] = x.BoatName
		}
	}
	now := s.cfg.Now()
	reader := readerOf(by.ID, people, now)
	laidOf := map[int]*store.RaceLaid{}
	for i := range laid {
		laidOf[laid[i].Run] = &laid[i]
	}
	for i := range results {
		x := &results[i]
		if len(out.Runs) == 0 || out.Runs[len(out.Runs)-1].Run != x.Run {
			run := ReplayRun{Run: x.Run, Boats: []ReplayBoat{}}
			if l := laidOf[x.Run]; l != nil {
				run.Warning, run.Start, run.Ended, run.Course = l.Warning, l.Start, l.Ended, &l.Course
			}
			out.Runs = append(out.Runs, run)
		}
		run := &out.Runs[len(out.Runs)-1]
		b := ReplayBoat{Number: x.Number, Machine: x.Machine, Me: x.Account == by.ID, Place: x.Place, How: x.How,
			Elapsed: x.Elapsed, Added: x.Added, Marks: x.Marks, ToGo: x.ToGo, Medal: x.Medal, Awards: x.Awards}
		if b.Awards == nil {
			b.Awards = []string{}
		}
		s.nameBoat(&b, reader, x.Account, boatNames[runAccount{x.Run, x.Account}], people, now)
		for _, c := range x.Crew {
			b.Crew = append(b.Crew, *s.person(reader, c.Account, people, now))
		}
		if drawn[x.Run] {
			b.Track = TrackOf(x.Track)
		}
		run.Boats = append(run.Boats, b)
	}
	for i := range out.Runs {
		out.Runs[i].Prizes = r.Kind == KindRace && started(out.Runs[i].Boats) >= 3
	}
	for i := range records {
		if x := &records[i]; x.World == r.WorldNumber {
			out.At = max(out.At, x.At.UnixMilli())
		}
	}
	return out, nil
}

// nameBoat names boat b, of the skipper id, to reader: by name by the
// log's rule, or by its boat's name.
func (s *Service) nameBoat(b *ReplayBoat, reader logbook.Reader, id store.AccountID, boat string,
	people map[store.AccountID]store.LogPerson, now time.Time) {
	p := s.person(reader, id, people, now)
	b.Name, b.Machine = p.Name, b.Machine || p.Machine
	if p.Name == nil && boat != "" {
		b.Boat = &boat
	}
}

// started is how many of boats started.
func started(boats []ReplayBoat) int {
	n := 0
	for i := range boats {
		if boats[i].How != store.HowDNS {
			n++
		}
	}
	return n
}

// trialRuns are a trial's runs as its replay lists them: home ones by
// time, then the rest, at most MostTrialRuns, the reader's own best kept
// among them.
func trialRuns(results []store.RaceRun, me store.AccountID) []store.RaceRun {
	home := func(x *store.RaceRun) bool { return x.How == store.HowFinished && x.Elapsed >= 0 }
	slices.SortStableFunc(results, func(a, b store.RaceRun) int {
		switch ha, hb := home(&a), home(&b); {
		case ha && !hb:
			return -1
		case hb && !ha:
			return 1
		case ha && hb && a.Elapsed+a.Added != b.Elapsed+b.Added:
			if a.Elapsed+a.Added < b.Elapsed+b.Added {
				return -1
			}
			return 1
		}
		return a.Run - b.Run
	})
	if len(results) > MostTrialRuns {
		mine := slices.IndexFunc(results, func(x store.RaceRun) bool { return x.Account == me })
		kept := results[:MostTrialRuns]
		if mine >= MostTrialRuns {
			kept[MostTrialRuns-1] = results[mine]
		}
		results = kept
	}
	return results
}

// drawnRuns are the runs whose tracks a replay sends: a race's every run;
// a trial's runs asked (at most MostReplayRuns of those listed), or the
// best of each sailor's, the fastest first.
func drawnRuns(kind string, results []store.RaceRun, asked []int) map[int]bool {
	out := map[int]bool{}
	if kind != KindTrial {
		for i := range results {
			out[results[i].Run] = true
		}
		return out
	}
	for _, a := range asked {
		if len(out) == MostReplayRuns {
			break
		}
		if slices.ContainsFunc(results, func(x store.RaceRun) bool { return x.Run == a }) {
			out[a] = true
		}
	}
	if len(out) > 0 {
		return out
	}
	seen := map[store.AccountID]bool{}
	for i := range results {
		x := &results[i]
		if len(out) == MostReplayRuns || seen[x.Account] {
			continue
		}
		seen[x.Account] = true
		out[x.Run] = true
	}
	return out
}

// recorded is the race of a code whose world has gone, as its lasting
// records keep it: its results and awards alone. ErrNotFound for none.
func (s *Service) recorded(ctx context.Context, by Sailor, code string) (Replay, error) {
	records, err := s.cfg.Store.RaceRecordsByCode(ctx, code)
	if err != nil {
		return Replay{}, err
	}
	if len(records) == 0 {
		return Replay{}, ErrNotFound
	}
	ids := []store.AccountID{by.ID}
	for i := range records {
		ids = append(ids, records[i].Account)
	}
	people, err := s.cfg.Store.LogPeople(ctx, slices.Compact(ids))
	if err != nil {
		return Replay{}, err
	}
	now := s.cfg.Now()
	reader := readerOf(by.ID, people, now)
	first := &records[0]
	boat := BoatRef{ID: first.Boat}
	if b := s.boat(first.Boat); b != nil {
		boat.Name = b.Name
	}
	out := Replay{Code: first.Code, Link: s.link(first.Code), Name: first.RaceName, Kind: first.Kind, Boat: boat,
		Course: first.CourseName, World: first.World, Harbour: first.Harbour, Newcomers: first.Newcomers, Second: committee.Second,
		Runs: []ReplayRun{}}
	// The skippers' records are the boats; the crews' are those aboard.
	at := map[runAccount]int{}
	for i := range records {
		x := &records[i]
		out.At = max(out.At, x.At.UnixMilli())
		if x.Role != store.RoleSkipper {
			continue
		}
		if len(out.Runs) == 0 || out.Runs[len(out.Runs)-1].Run != x.Run {
			out.Runs = append(out.Runs, ReplayRun{Run: x.Run, Boats: []ReplayBoat{}})
		}
		run := &out.Runs[len(out.Runs)-1]
		b := ReplayBoat{Number: x.Number, Place: x.Place, How: x.How, Elapsed: -1, Added: x.Added, ToGo: -1, Medal: x.Medal, Awards: x.Awards}
		if x.Elapsed > 0 {
			b.Elapsed = x.Elapsed
		}
		if b.Awards == nil {
			b.Awards = []string{}
		}
		s.nameBoat(&b, reader, x.Account, x.BoatName, people, now)
		b.Me = x.Account == by.ID
		at[runAccount{x.Run, x.Account}] = len(run.Boats)
		run.Boats = append(run.Boats, b)
	}
	for i := range records {
		x := &records[i]
		if x.Role != store.RoleCrew {
			continue
		}
		for k := range out.Runs {
			if out.Runs[k].Run != x.Run {
				continue
			}
			if j, ok := at[runAccount{x.Run, x.Skipper}]; ok {
				b := &out.Runs[k].Boats[j]
				b.Crew = append(b.Crew, *s.person(reader, x.Account, people, now))
			}
		}
	}
	for i := range out.Runs {
		out.Runs[i].Prizes = out.Kind == KindRace && started(out.Runs[i].Boats) >= 3
	}
	if out.Kind == KindTrial {
		// The fastest runs first, as the runs' table ranks them.
		slices.SortStableFunc(out.Runs, func(a, b ReplayRun) int {
			ea, eb := runTime(&a), runTime(&b)
			switch {
			case ea < eb:
				return -1
			case ea > eb:
				return 1
			}
			return a.Run - b.Run
		})
		if len(out.Runs) > MostTrialRuns {
			out.Runs = out.Runs[:MostTrialRuns]
		}
	}
	return out, nil
}

// runTime is a trial's run's time, s, for ranking: unfinished last.
func runTime(r *ReplayRun) float64 {
	if len(r.Boats) == 0 || r.Boats[0].Elapsed < 0 {
		return math.Inf(1)
	}
	return r.Boats[0].Elapsed + r.Boats[0].Added
}

// courseName is race r's course's name.
func (s *Service) courseName(r *store.Race, c *Courses) string {
	if r.CourseKind == CourseIsland {
		if ic := c.island(r.Course); ic != nil {
			return ic.Name
		}
		return "an island course"
	}
	return BuoyName(r.Shape, r.Long, s.port)
}
