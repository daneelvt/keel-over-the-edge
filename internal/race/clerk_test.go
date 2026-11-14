// SPDX-License-Identifier: AGPL-3.0-only

package race

import (
	"math"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/race/committee"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/sim/loop"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// course is a sea's world to race in: the catalog's boats, ticking from
// the sea's now, with its racing areas laid out off its centre.
type course struct {
	*sea
	w     *sim.World
	epoch time.Time
	clerk *Clerk
}

func newCourse(s *sea) *course {
	s.t.Helper()
	const first = 3_000_000
	c := &course{sea: s, epoch: s.now.Add(-first * time.Second / physics.StepsPerSecond)}
	c.w = c.newWorld(first)
	c.clerk = c.newClerk()
	return c
}

// newWorld is a world of the catalog's boats from tick, with two racing
// areas.
func (c *course) newWorld(tick int64) *sim.World {
	s := c.sea
	_, kinds := s.cat.Prepare()
	st := &committee.Stage{Areas: []committee.Area{{Number: 1, Radius: 450}, {Number: 2, X: 2000, Radius: 450}}}
	for i := range s.cat.Boats {
		st.Kinds = append(st.Kinds, committee.Kind{Polar: s.cat.Polar(i), Length: s.cat.Boats[i].LengthOverall})
	}
	w, err := sim.New(sim.Config{Capacity: 16, Kinds: kinds, Workers: 1, Tick: tick, Capacities: s.cat.Capacities(), Races: st})
	if err != nil {
		s.t.Fatal(err)
	}
	s.t.Cleanup(w.Close)
	return w
}

// newClerk is a clerk of the course's world.
func (c *course) newClerk() *Clerk {
	return c.svc.Clerk(ClerkConfig{Bus: c.w.Bus(), Lease: c.lease,
		TickAt: func(t time.Time) int64 { return loop.TickAt(t, c.epoch) },
		TimeOf: func(tick int64) time.Time { return loop.TimeOf(tick, c.epoch) },
		Rules:  rulesOf(c.sea)})
}

// rulesOf are the news's rules of the sea's catalog.
func rulesOf(s *sea) store.NewsRules {
	r := store.NewsRules{Zone: "UTC"}
	for _, c := range s.cat.News.Columns {
		if c.Of == catalog.OfCharting && r.Column == "" {
			r.Column = string(c.ID)
		}
	}
	return r
}

// tick ticks the world n times, its clock the sea's, with commands sent
// before each tick.
func (c *course) tick(n int, before func()) {
	for range n {
		if before != nil {
			before()
		}
		c.w.Tick()
	}
	c.now = loop.TimeOf(c.w.Now(), c.epoch)
}

// skipTo moves the world on to the tick before t, at once.
func (c *course) skipTo(t time.Time) {
	if n := loop.TickAt(t, c.epoch) - c.w.Now() - 1; n > 0 {
		c.w.Skip(n)
	}
	c.tick(1, nil)
}

// once has the clerk do its work, or fails the test.
func (c *course) once() {
	c.t.Helper()
	if err := c.clerk.Once(c.ctx); err != nil {
		c.t.Fatal(err)
	}
}

// route is a boat's way round course rc: over the start line, round the
// outside of each mark to port, through each gate, and over the finish.
func route(rc *bus.RaceCourse) [][2]float64 {
	us, uc := physics.SinCos(rc.From)
	var out [][2]float64
	for k, ch := range rc.Checks {
		switch {
		case k == 0:
			out = append(out, [2]float64{ch.AtX + 10*us, ch.AtY + 10*uc})
		case ch.Line:
			out = append(out, [2]float64{ch.AtX + 5*us, ch.AtY + 5*uc}, [2]float64{ch.AtX - 15*us, ch.AtY - 15*uc})
		default:
			rx, ry := ch.C, -ch.S
			out = append(out,
				[2]float64{ch.X + 15*rx - 5*ch.S, ch.Y + 15*ry - 5*ch.C},
				[2]float64{ch.X + 15*rx + 15*ch.S, ch.Y + 15*ry + 15*ch.C},
				[2]float64{ch.X - 15*rx + 15*ch.S, ch.Y - 15*ry + 15*ch.C},
				[2]float64{ch.X - 15*rx - 5*ch.S, ch.Y - 15*ry - 5*ch.C})
		}
	}
	return append(out, [2]float64{out[len(out)-1][0] - 20*us, out[len(out)-1][1] - 20*uc})
}

// A race of three boats, made, entered, handed to the committee at its
// warning signal, sailed by scripted boats from the gun to the finish, and
// written: its boats started, everyone's result and track, the records,
// the story of the win, the race finished; and the committee lets it go.
func TestARaceFromMakingToResults(t *testing.T) {
	raceOfThree(t, 0)
}

// A race whose world restarts from its checkpoint half way round, a new
// clerk with it, as a new process: the race runs on and is written once,
// whole. (That the restored world runs the race as the first would have,
// tick for tick, the simulation's own test shows.)
func TestARaceRestarted(t *testing.T) {
	raceOfThree(t, 40)
}

// raceOfThree races three boats, the world restarted from a checkpoint
// after restart seconds of sailing (0 never).
func raceOfThree(t *testing.T, restart int) {
	s := newSea(t)
	c := newCourse(s)
	owner := s.human()
	card := s.make(owner, 10*time.Minute, WhoEveryone)
	sailors := []Sailor{s.human(), s.human(), s.human()}
	for i, sl := range sailors {
		if _, err := s.svc.Enter(s.ctx, sl, card.Code, false); err != nil {
			t.Fatal(err)
		}
		do := make(chan bus.Reply, 1)
		if err := c.w.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.Join, Account: bus.Account(sl.ID), Conn: uint64(i + 1), Reply: do}); err != nil {
			t.Fatal(err)
		}
		c.tick(1, nil)
	}
	start := time.UnixMilli(card.StartsAt).UTC()
	// Nothing before the warning signal.
	c.once()
	c.tick(1, nil)
	if len(c.w.Latest().Races) != 0 {
		t.Fatal("a race handed to the committee before its warning")
	}
	c.skipTo(start.Add(-Warning))
	c.once()
	c.tick(1, nil)
	f := c.w.Latest()
	if len(f.Races) != 1 || len(f.Racers) != 3 {
		t.Fatalf("%d races of %d boats under way", len(f.Races), len(f.Racers))
	}
	c.once()
	r, err := s.db.RaceByCode(s.ctx, card.Code)
	if err != nil || r.State != store.RaceRacing {
		t.Fatalf("the race is %q: %v", r.State, err)
	}
	// Each boat sails the course, the first entered fastest, from the gun.
	rc := f.Races[0].Course
	slots := map[bus.Account]int32{}
	for _, s := range f.Live {
		slots[f.Owner[s]] = s
	}
	gun := f.Races[0].Start
	type boat struct {
		slot  int32
		way   [][2]float64
		at    int
		speed float64
		st    physics.State
	}
	var boats []*boat
	for i, sl := range sailors {
		s := slots[bus.Account(sl.ID)]
		boats = append(boats, &boat{slot: s, way: route(rc), speed: 9 - float64(i), st: f.State[s]})
	}
	dev := c.w.Bus().Commands.Developer()
	sail := func() {
		if c.w.Now()+1 < gun {
			return
		}
		for _, b := range boats {
			if b.at >= len(b.way) {
				continue
			}
			p := b.way[b.at]
			dx, dy := p[0]-b.st.X, p[1]-b.st.Y
			d := math.Hypot(dx, dy)
			step := b.speed / physics.StepsPerSecond
			if d <= step {
				b.st.X, b.st.Y = p[0], p[1]
				b.at++
			} else {
				b.st.X, b.st.Y = b.st.X+dx/d*step, b.st.Y+dy/d*step
			}
			b.st.Heading, b.st.Surge = math.Atan2(dx, dy), 0
			if err := dev.TrySend(bus.Command{Op: bus.Place, Boat: c.w.Latest().Boat[b.slot], State: b.st}); err != nil {
				t.Fatal(err)
			}
		}
	}
	for i := range 40000 {
		c.tick(30, sail)
		c.once()
		if f := c.w.Latest(); len(f.Races) == 0 {
			break
		}
		if i+1 == restart {
			c.restart()
			dev = c.w.Bus().Commands.Developer()
		}
	}
	if f := c.w.Latest(); len(f.Races) != 0 {
		t.Fatalf("the race not let go: phase %d", f.Races[0].Phase)
	}
	r, _ = s.db.RaceByCode(s.ctx, card.Code)
	if r.State != store.RaceFinished {
		t.Errorf("the race is %q", r.State)
	}
	conn, err := pgx.Connect(s.ctx, s.url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(s.ctx)
	rows, err := conn.Query(s.ctx, `SELECT r.account_id, r.place, r.how, r.awards, length(t.samples), r.elapsed
		FROM race_result r JOIN race_track t USING (world_id, race_id, account_id, run) WHERE r.race_id = $1 ORDER BY r.place`, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	type result struct {
		account [16]byte
		place   int16
		how     string
		awards  []string
		track   int
		elapsed float32
	}
	results, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (result, error) {
		var x result
		err := row.Scan(&x.account, &x.place, &x.how, &x.awards, &x.track, &x.elapsed)
		return x, err
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 3 {
		t.Fatalf("%d results", len(results))
	}
	for i, x := range results {
		if x.account != sailors[i].ID || x.place != int16(i+1) || x.how != store.HowFinished || x.track < 100 {
			t.Errorf("result %d: %+v", i, x)
		}
	}
	if aw := results[2].awards; len(aw) != 1 || aw[0] != "spoon" {
		t.Errorf("the last boat's awards: %v", aw)
	}
	var records, owners, stories int
	if err := conn.QueryRow(s.ctx, `SELECT count(*) FILTER (WHERE role = 'skipper'), count(*) FILTER (WHERE role = 'owner')
		FROM race_record WHERE code = $1`, card.Code).Scan(&records, &owners); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(s.ctx, `SELECT count(*) FROM news_item WHERE story = 'race' AND account_id = $1`, sailors[0].ID).Scan(&stories); err != nil {
		t.Fatal(err)
	}
	if records != 3 || owners != 1 || stories != 1 {
		t.Errorf("%d skippers' records, %d owner's, %d stories of the win", records, owners, stories)
	}
	// Written again, nothing changes.
	if err := s.db.EndRace(s.ctx, s.lease, rulesOf(s), &store.RaceEnd{World: s.world.ID, Race: r.ID,
		At: s.now}); err != nil {
		t.Fatal(err)
	}
	for _, x := range results {
		if !(x.elapsed > 60) {
			t.Errorf("a time of %v s", x.elapsed)
		}
	}
}

// restart restarts the course's world from a checkpoint of it, with a
// clerk of its own, as a new process would.
func (c *course) restart() {
	c.t.Helper()
	cp := sim.AppendCheckpoint(nil, c.w.Latest())
	old := c.w
	c.w = c.newWorld(old.Now())
	if err := c.w.Load(cp); err != nil {
		c.t.Fatal(err)
	}
	old.Close()
	c.clerk = c.newClerk()
}

// A time trial's run: asked for by entering, handed to the committee at
// once, timed from its crossing of the line, written with its medal as a
// run of its own; entering again asks for the next.
func TestATrialsRun(t *testing.T) {
	s := newSea(t)
	c := newCourse(s)
	sl := s.human()
	card, err := s.svc.Make(s.ctx, s.human(), Making{Kind: KindTrial, Course: "buoy:windward-leeward:short", Boat: s.jolly(), Who: WhoEveryone})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.w.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.Join, Account: bus.Account(sl.ID), Conn: 1}); err != nil {
		t.Fatal(err)
	}
	c.tick(1, nil)
	if _, err := s.svc.Enter(s.ctx, sl, card.Code, false); err != nil {
		t.Fatal(err)
	}
	c.once()
	c.tick(1, nil)
	f := c.w.Latest()
	if len(f.Races) != 1 || !f.Races[0].Trial || f.Races[0].Run != 1 {
		t.Fatalf("the run handed: %+v", f.Races)
	}
	c.once()
	// Round the course at twice the speed its par asks: the harbourmaster's
	// time.
	rc := f.Races[0].Course
	way := route(rc)
	slot := f.Live[0]
	st := f.State[slot]
	at := 0
	speed := 2 * rc.Length / rc.Expected
	dev := c.w.Bus().Commands.Developer()
	sail := func() {
		if at >= len(way) {
			return
		}
		p := way[at]
		dx, dy := p[0]-st.X, p[1]-st.Y
		d := math.Hypot(dx, dy)
		if step := speed / physics.StepsPerSecond; d <= step {
			st.X, st.Y = p[0], p[1]
			at++
		} else {
			st.X, st.Y = st.X+dx/d*step, st.Y+dy/d*step
		}
		_ = dev.TrySend(bus.Command{Op: bus.Place, Boat: c.w.Latest().Boat[slot], State: st})
	}
	for range 10000 {
		c.tick(30, sail)
		c.once()
		if len(c.w.Latest().Races) == 0 {
			break
		}
	}
	conn, err := pgx.Connect(s.ctx, s.url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(s.ctx)
	var run int16
	var medal string
	var started bool
	if err := conn.QueryRow(s.ctx, `SELECT r.run, r.medal, e.started_at IS NOT NULL FROM race_result r
		JOIN race_entry e USING (world_id, race_id, account_id, run) JOIN race x ON x.id = r.race_id WHERE x.code = $1`, card.Code).
		Scan(&run, &medal, &started); err != nil {
		t.Fatal(err)
	}
	if run != 1 || medal != "harbourmaster" || !started {
		t.Errorf("run %d, medal %q, started %v", run, medal, started)
	}
	runs, err := s.db.PendingRuns(s.ctx, s.world.ID)
	if err != nil || len(runs) != 0 {
		t.Fatalf("runs asked for after the run: %+v %v", runs, err)
	}
	if _, err := s.svc.Enter(s.ctx, sl, card.Code, false); err != nil {
		t.Fatal(err)
	}
	if runs, err = s.db.PendingRuns(s.ctx, s.world.ID); err != nil || len(runs) != 1 || runs[0].Run != 2 {
		t.Errorf("runs asked for: %+v %v", runs, err)
	}
}
