// SPDX-License-Identifier: AGPL-3.0-only

package race

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/race/committee"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The races' clerk goes between the races ashore and the committee in the
// world: once a second it hands the committee each race whose warning
// signal has come (bus.RacePlace, a server's command, so the input log
// keeps it and a replay runs the same race), and each time trial's run a
// sailor has asked for; it writes each race's boats started as the
// committee places them; and when a race ends it writes what everyone
// came to, the tracks, the lasting records and the news's stories, then
// lets the committee drop it (bus.RaceWritten). A race stays in the world,
// and in its checkpoint, until it is written, so a restart loses nothing:
// every write is made once, however often it is made again.

// ClerkConfig sets up a Clerk.
type ClerkConfig struct {
	// Bus is the world's.
	Bus *bus.Bus
	// Lease is the epoch the world's writes are fenced by.
	Lease int64
	// TickAt is the world's tick at a time, TimeOf the time of a tick.
	TickAt func(time.Time) int64
	TimeOf func(int64) time.Time
	// Fleet is a sailor's boat of a kind (its index in the catalog) from
	// their fleet, its look code and name: for a skipper who races
	// another kind than they sail.
	Fleet func(ctx context.Context, id store.AccountID, kind int) (uint32, string)
	// Rules are the news's, for the races' stories.
	Rules store.NewsRules
	Log   *slog.Logger
}

// Clerk is the races' clerk of a world.
type Clerk struct {
	s    *Service
	cfg  ClerkConfig
	send bus.Sender
	// sent are the races and runs handed to the committee, and when;
	// started and written those whose start and end are written.
	sent    map[runKey]time.Time
	started map[runKey]bool
	written map[runKey]bool
}

// runKey is a race's run: a race's is 0.
type runKey struct {
	id  [16]byte
	run int32
}

// resend is how long the clerk waits for the committee to take a race it
// handed it before handing it again.
const resend = 15 * time.Second

// Clerk makes the races' clerk of the service's world.
func (s *Service) Clerk(cfg ClerkConfig) *Clerk {
	if cfg.Log == nil {
		cfg.Log = slog.New(slog.DiscardHandler)
	}
	return &Clerk{s: s, cfg: cfg, send: cfg.Bus.Commands.Server(), sent: map[runKey]time.Time{}, started: map[runKey]bool{},
		written: map[runKey]bool{}}
}

// Run keeps the clerk at work, once a second, until ctx ends.
func (c *Clerk) Run(ctx context.Context) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		if err := c.Once(ctx); err != nil && ctx.Err() == nil {
			c.cfg.Log.Warn("the races' clerk", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Once does the clerk's work once: the races whose warning has come and
// the runs asked for handed to the committee, and what the committee has
// placed and ended written.
func (c *Clerk) Once(ctx context.Context) error {
	if err := c.write(ctx); err != nil {
		return err
	}
	return c.hand(ctx)
}

// held are the races and runs the world holds, and the accounts racing.
func (c *Clerk) held() (map[runKey]bool, map[bus.Account]bool) {
	f := c.cfg.Bus.Frames.Acquire()
	defer f.Release()
	races := map[runKey]bool{}
	for i := range f.Races {
		races[runKey{f.Races[i].ID, f.Races[i].Run}] = true
	}
	racing := map[bus.Account]bool{}
	for i := range f.Racers {
		if st := f.Racers[i].State; st == bus.RacerPlaced || st == bus.RacerRacing {
			racing[f.Racers[i].Account] = true
		}
	}
	return races, racing
}

// hand hands the committee the races whose warning signal has come, and
// the runs asked for.
func (c *Clerk) hand(ctx context.Context) error {
	now := c.s.cfg.Now()
	w := c.s.cfg.World
	held, racing := c.held()
	for k, at := range c.sent {
		if now.Sub(at) > resend {
			delete(c.sent, k)
		}
	}
	due, err := c.s.cfg.Store.DueRaces(ctx, w.ID, w.Number, now.Add(-time.Hour), now.Add(Warning))
	if err != nil {
		return err
	}
	for i := range due {
		r := &due[i]
		k := runKey{r.ID, 0}
		if held[k] || !c.sent[k].IsZero() {
			continue
		}
		entrants, err := c.s.cfg.Store.RaceEntrants(ctx, r)
		if err != nil {
			return err
		}
		call, ok := c.callOf(r, 0)
		if !ok {
			continue
		}
		for _, e := range entrants {
			look, name := c.boatOf(ctx, e.Account, int(call.Kind), e.BoatName)
			call.Entrants = append(call.Entrants, bus.RaceEntrant{Account: bus.Account(e.Account), Number: int16(e.Number),
				Machine: e.Machine, Crew: e.WithCrew, BoatLook: look, BoatName: name})
		}
		if c.hand1(call) {
			c.sent[k] = now
		}
	}
	runs, err := c.s.cfg.Store.PendingRuns(ctx, w.ID)
	if err != nil {
		return err
	}
	trials := map[[16]byte]store.Race{}
	for _, p := range runs {
		k := runKey{p.Race, int32(p.Run)}
		if held[k] || !c.sent[k].IsZero() || racing[bus.Account(p.Account)] {
			continue
		}
		r, ok := trials[p.Race]
		if !ok {
			if r, err = c.s.cfg.Store.RaceIn(ctx, w.ID, w.Number, p.Race); err != nil {
				return err
			}
			trials[p.Race] = r
		}
		call, ok := c.callOf(&r, int32(p.Run))
		if !ok {
			continue
		}
		look, name := c.boatOf(ctx, p.Account, int(call.Kind), "")
		call.Entrants = []bus.RaceEntrant{{Account: bus.Account(p.Account), Number: int16(p.Number), Machine: p.Machine,
			Crew: p.WithCrew, BoatLook: look, BoatName: name}}
		if c.hand1(call) {
			c.sent[k] = now
		}
	}
	return nil
}

// hand1 hands the committee one race: false if the queue is full.
func (c *Clerk) hand1(call *bus.RaceCall) bool {
	if err := c.send.TrySend(bus.Command{Op: bus.RacePlace, Race: call}); err != nil {
		c.cfg.Log.Warn("handing a race to the committee", "err", err)
		return false
	}
	return true
}

// callOf is race r's run as the committee is handed it, its entrants
// still to add: false for a boat the catalog does not have.
func (c *Clerk) callOf(r *store.Race, run int32) (*bus.RaceCall, bool) {
	kind, ok := c.s.boats[r.Boat]
	if !ok {
		return nil, false
	}
	call := &bus.RaceCall{ID: r.ID, Run: run, Trial: r.Kind == KindTrial, Island: r.CourseKind == CourseIsland,
		Course: int32(r.Course), Triangle: r.Shape == ShapeTriangle, Long: r.Long, Kind: uint16(kind)}
	if !call.Trial {
		call.Start = c.cfg.TickAt(r.StartsAt)
	}
	return call, true
}

// boatOf is a skipper's boat of a kind from their fleet, or by name.
func (c *Clerk) boatOf(ctx context.Context, id store.AccountID, kind int, name string) (uint32, string) {
	if c.cfg.Fleet == nil {
		return 0, name
	}
	look, n := c.cfg.Fleet(ctx, id, kind)
	if n == "" {
		n = name
	}
	return look, n
}

// run is a race run as the clerk copies it from a frame: the race, its
// boats, and for each boat those aboard and its boat's name.
type run struct {
	race   bus.Race
	racers []bus.Racer
	crews  [][]store.RaceCrew
	names  []string
}

// runs are the races of the latest frame, copied: their tracks are only
// ever appended to, so what a copy holds stays as it was.
func (c *Clerk) runs() []run {
	f := c.cfg.Bus.Frames.Acquire()
	defer f.Release()
	out := make([]run, 0, len(f.Races))
	for i := range f.Races {
		r := run{race: f.Races[i]}
		for j := range f.Racers {
			rc := f.Racers[j]
			if rc.Race != r.race.Key {
				continue
			}
			var crew []store.RaceCrew
			name := ""
			if s := rc.Slot; s >= 0 && f.Occupied[s] && f.Boat[s] == rc.Boat {
				name = f.BoatName[s]
				lo, hi := f.CrewOf(s)
				for _, a := range f.Crew[lo:hi] {
					crew = append(crew, store.RaceCrew{Account: store.AccountID(a.Account), Name: a.Name, Machine: a.Machine})
				}
			}
			r.racers = append(r.racers, rc)
			r.crews = append(r.crews, crew)
			r.names = append(r.names, name)
		}
		out = append(out, r)
	}
	return out
}

// write writes the races the committee has placed and ended.
func (c *Clerk) write(ctx context.Context) error {
	runs := c.runs()
	now := map[runKey]bool{}
	for i := range runs {
		r := &runs[i]
		k := runKey{r.race.ID, r.race.Run}
		now[k] = true
		if !c.started[k] {
			if err := c.start(ctx, r); err != nil {
				return err
			}
			c.started[k] = true
		}
		if r.race.Phase == bus.RaceEnded && !c.written[k] {
			if err := c.end(ctx, r); err != nil {
				return err
			}
			c.written[k] = true
			if err := c.send.TrySend(bus.Command{Op: bus.RaceWritten, Race: &bus.RaceCall{ID: k.id, Run: k.run}}); err != nil {
				// Written again, and let go, next time.
				c.written[k] = false
			}
		}
	}
	for k := range c.started {
		if !now[k] {
			delete(c.started, k)
			delete(c.written, k)
		}
	}
	return nil
}

// start writes run r's boats placed on its line.
func (c *Clerk) start(ctx context.Context, r *run) error {
	w := c.s.cfg.World
	st := &store.RaceStart{World: w.ID, Race: r.race.ID, Run: int(r.race.Run), Trial: r.race.Trial, At: c.cfg.TimeOf(r.race.Warning)}
	for _, rc := range r.racers {
		if rc.State == bus.RacerDNS {
			st.Missed = append(st.Missed, store.AccountID(rc.Account))
			continue
		}
		st.Placed = append(st.Placed, store.RaceStarter{Account: store.AccountID(rc.Account), Number: int(rc.Number), Machine: rc.Machine,
			WithCrew: rc.Crew})
	}
	return c.s.cfg.Store.StartRace(ctx, c.cfg.Lease, st)
}

// end writes what run r came to.
func (c *Clerk) end(ctx context.Context, r *run) error {
	w := c.s.cfg.World
	row, err := c.s.cfg.Store.RaceIn(ctx, w.ID, w.Number, r.race.ID)
	if errors.Is(err, store.ErrNotFound) {
		// A race the world no longer keeps: nothing to write.
		return nil
	}
	if err != nil {
		return err
	}
	e, err := c.endOf(ctx, &row, r)
	if err != nil {
		return err
	}
	return c.s.cfg.Store.EndRace(ctx, c.cfg.Lease, c.cfg.Rules, e)
}

// endOf is what run r of race row came to, as the store keeps it.
func (c *Clerk) endOf(ctx context.Context, row *store.Race, r *run) (*store.RaceEnd, error) {
	w := c.s.cfg.World
	at := c.cfg.TimeOf(r.race.Ended)
	e := &store.RaceEnd{World: w.ID, Race: row.ID, Run: int(r.race.Run), Trial: r.race.Trial, At: at}
	course := c.courseName(row)
	fleet := 0
	for _, rc := range r.racers {
		if rc.State != bus.RacerDNS {
			fleet++
		}
	}
	// The names copied into the records: every skipper's.
	ids := make([]store.AccountID, 0, len(r.racers))
	for _, rc := range r.racers {
		ids = append(ids, store.AccountID(rc.Account))
	}
	people, err := c.s.cfg.Store.LogPeople(ctx, ids)
	if err != nil {
		return nil, err
	}
	source := fmt.Sprintf("race:%s:%d", row.Code, r.race.Run)
	record := func(id store.AccountID, role string) store.RaceRecord {
		return store.RaceRecord{Account: id, Source: source, World: w.Number, At: at, Code: row.Code, RaceName: row.Name, Kind: row.Kind,
			CourseName: course, Boat: row.Boat, Fleet: fleet, Harbour: row.Harbour >= 0, Newcomers: row.Who == WhoNewcomers, Role: role}
	}
	var winner *store.RaceResult
	var winnerCrew []store.AccountID
	var winnerName string
	for i, rc := range r.racers {
		res := store.RaceResult{Account: store.AccountID(rc.Account), Place: int(rc.Place), Elapsed: -1, ToGo: -1,
			Added: float64(rc.Added) / committee.Second, Marks: marksRounded(r.race.Course, rc.Next), How: howOf(rc.State),
			Medal: committee.MedalName(rc.Medal), Awards: committee.Awards(rc.Awards), Crew: r.crews[i], Track: rc.Track}
		if rc.State == bus.RacerFinished {
			res.Elapsed = committee.Elapsed(&r.race, &rc)
		} else if rc.State != bus.RacerDNS {
			res.ToGo = rc.ToGo
		}
		e.Results = append(e.Results, res)
		if rc.State == bus.RacerDNS {
			continue
		}
		rec := record(res.Account, store.RoleSkipper)
		rec.BoatName, rec.Place, rec.How, rec.Medal, rec.Awards = r.names[i], res.Place, res.How, res.Medal, res.Awards
		e.Records = append(e.Records, rec)
		skipper := people[res.Account]
		for _, a := range r.crews[i] {
			cr := rec
			cr.Account, cr.Role = a.Account, store.RoleCrew
			cr.Skipper, cr.SkipperName, cr.SkipperMachine = res.Account, skipper.Name, rc.Machine
			e.Records = append(e.Records, cr)
		}
		if res.Place == 1 && rc.State == bus.RacerFinished {
			winner, winnerName = &e.Results[len(e.Results)-1], r.names[i]
			for _, a := range r.crews[i] {
				winnerCrew = append(winnerCrew, a.Account)
			}
		}
		if r.race.Trial && (rc.Medal == bus.MedalGold || rc.Medal == bus.MedalHarbourmaster) {
			e.Stories = append(e.Stories, c.trialStory(row, course, &res, r.names[i], [2]float64{r.race.Course.X, r.race.Course.Y}, at))
		}
	}
	if row.HasOwner && !r.race.Trial && fleet > 0 {
		rec := record(row.Owner, store.RoleOwner)
		rec.Source = "ran:" + row.Code
		e.Records = append(e.Records, rec)
	}
	if !r.race.Trial && winner != nil && fleet >= 2 {
		e.Stories = append(e.Stories, c.raceStory(row, course, winner, winnerCrew, winnerName, fleet, r.race.Course, at))
	}
	return e, nil
}

// marksRounded is how many of course c's marks a boat whose next check is
// next has rounded.
func marksRounded(c *bus.RaceCourse, next int16) int {
	n := 0
	for k := 0; k < int(next) && k < len(c.Checks); k++ {
		if c.Checks[k].Mark > 0 {
			n++
		}
	}
	return n
}

// howOf is how a boat in a state ended its race.
func howOf(state uint8) string {
	switch state {
	case bus.RacerFinished:
		return store.HowFinished
	case bus.RacerDNS:
		return store.HowDNS
	case bus.RacerRetired:
		return store.HowRetired
	}
	return store.HowPlaced
}

// courseName is race row's course's name.
func (c *Clerk) courseName(row *store.Race) string {
	if row.CourseKind == CourseIsland {
		courses := c.s.cfg.Courses()
		if ic := courses.island(row.Course); ic != nil {
			return ic.Name
		}
		return "an island course"
	}
	return BuoyName(row.Shape, row.Long, c.s.port)
}

// raceStory is the news's story of a race won: by its winner, its crew
// named, its fleet's size and its course; a harbour race, or one of more
// boats, scores higher.
func (c *Clerk) raceStory(row *store.Race, course string, winner *store.RaceResult, crew []store.AccountID, boat string, fleet int,
	laid *bus.RaceCourse, at time.Time) store.Story {
	score := c.s.cfg.Catalog.StoryScore(catalog.NewsStoryOfRace)
	if row.Harbour >= 0 {
		score++
	}
	if fleet >= 6 {
		score++
	}
	s := store.Story{Story: store.StoryRace, Score: score, At: at, Account: winner.Account, Named: crew, Subject: store.StorySubjectRace,
		Title: row.Name, What: course, Island: -1, Facts: store.StoryFacts{Boat: boat, BoatKind: row.Boat, Of: fleet},
		Source: "race:" + row.Code}
	if laid != nil {
		s.X, s.Y = laid.X, laid.Y
	}
	return s
}

// trialStory is the news's story of a time trial's gold, or its
// harbourmaster's time.
func (c *Clerk) trialStory(row *store.Race, course string, res *store.RaceResult, boat string, x [2]float64, at time.Time) store.Story {
	score := c.s.cfg.Catalog.StoryScore(catalog.NewsStoryOfTrial)
	if res.Medal == committee.MedalName(bus.MedalHarbourmaster) {
		score++
	}
	return store.Story{Story: store.StoryTrial, Score: score, At: at, Account: res.Account, Subject: store.StorySubjectRace,
		Title: row.Name, What: course, Island: -1, X: x[0], Y: x[1],
		Facts:  store.StoryFacts{Boat: boat, BoatKind: row.Boat, Medal: res.Medal},
		Source: fmt.Sprintf("trial:%s:%s:%s", row.Code, res.Account.String(), res.Medal)}
}

// Names are racers as reader is shown them, in order: by name by the log's
// rule, "" for one not named to them (shown by their boat and number).
func (s *Service) Names(ctx context.Context, reader store.AccountID, racers []store.AccountID) ([]string, error) {
	ids := append([]store.AccountID{reader}, racers...)
	people, err := s.cfg.Store.LogPeople(ctx, slices.Compact(slices.Clone(ids)))
	if err != nil {
		return nil, err
	}
	now := s.cfg.Now()
	r := readerOf(reader, people, now)
	out := make([]string, len(racers))
	for i, id := range racers {
		if p := s.person(r, id, people, now); p.Name != nil {
			out[i] = *p.Name
		}
	}
	return out, nil
}
