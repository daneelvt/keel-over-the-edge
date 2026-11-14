// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/race"
	"github.com/daneelvt/keel-over-the-edge/internal/race/committee"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// A race ashore for the tests: the races kept in memory as race.Service
// keeps them in the database, by the same rules where the tests need
// them, and a clerk that hands each to the world's committee at its
// warning signal.

// fakeRace is a race kept by fakeRaces.
type fakeRace struct {
	id       [16]byte
	code     string
	name     string
	kind     string
	course   string
	boat     string
	who      string
	owner    store.AccountID
	starts   time.Time
	entrants []store.AccountID
	sent     bool
	written  bool
}

// fakeRaces are a world's races in memory.
type fakeRaces struct {
	mu      sync.Mutex
	cat     *catalog.Catalog
	races   []*fakeRace
	refuse  *race.Refusal // the refusal every enter answers, if not nil
	courses []race.CourseChoice
	// early brings each race's start this much nearer than asked, so a
	// test waits less for its gun.
	early time.Duration
}

func newFakeRaces(cat *catalog.Catalog) *fakeRaces {
	jolly := string(cat.Boats[0].ID)
	return &fakeRaces{cat: cat, courses: []race.CourseChoice{
		{CourseCard: race.CourseCard{ID: "island:1", Kind: race.CourseIsland, Number: 1, Name: "Round the Spar", Length: 720},
			Boats: map[string]int{jolly: 6}},
	}}
}

func (r *fakeRaces) find(code string) *fakeRace {
	for _, x := range r.races {
		if x.code == code {
			return x
		}
	}
	return nil
}

func (r *fakeRaces) phase(x *fakeRace) string {
	now := time.Now()
	switch {
	case x.written:
		return race.PhaseFinished
	case x.sent:
		return race.PhaseRacing
	case x.kind == race.KindRace && !now.Before(x.starts.Add(-time.Duration(committee.Warning/committee.Second)*time.Second)):
		return race.PhaseStarting
	}
	return race.PhaseOpen
}

func (r *fakeRaces) card(by race.Sailor, x *fakeRace) race.Card {
	boat := r.cat.Boats[0]
	c := race.Card{Code: x.code, Link: "https://play.example/?r=" + x.code, Name: x.name, Kind: x.kind, Phase: r.phase(x), Who: x.who,
		Course: race.CourseCard{ID: x.course, Kind: race.CourseIsland, Number: 1, Name: "Round the Spar", Length: 720},
		Boat:   race.BoatRef{ID: string(boat.ID), Name: boat.Name}, StartsAt: x.starts.UnixMilli(), Minutes: 6, Most: boat.Racers,
		Entrants: []race.Entrant{}, Enter: race.Can{OK: true}}
	c.Mine.Owner = x.owner == by.ID
	for i, a := range x.entrants {
		name := fmt.Sprintf("Sailor %d", i+1)
		c.Entrants = append(c.Entrants, race.Entrant{Number: i + 1, Name: &name, Machine: true, Me: a == by.ID})
		if a == by.ID {
			c.Mine.Entered, c.Mine.Number = true, i+1
		}
	}
	return c
}

func (r *fakeRaces) Board(ctx context.Context, by race.Sailor) (race.Board, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	b := race.Board{Make: race.MakeChoices{Can: race.Can{OK: true}, Who: []string{race.WhoEveryone, race.WhoMachines},
		Boat: string(r.cat.Boats[0].ID), Courses: r.courses}}
	for _, k := range r.cat.Boats {
		b.Make.Boats = append(b.Make.Boats, race.BoatChoice{ID: string(k.ID), Name: k.Name, Most: k.Racers})
	}
	for _, x := range r.races {
		c := r.card(by, x)
		if c.Phase == race.PhaseFinished || !c.Mine.Entered && !c.Mine.Owner {
			continue
		}
		b.Mine = append(b.Mine, race.Summary{Code: x.code, Name: x.name, Kind: x.kind, Phase: c.Phase, Who: x.who, Boat: c.Boat,
			StartsAt: c.StartsAt, Entered: len(x.entrants), Most: c.Most,
			Mine: race.SummaryMine{Owner: c.Mine.Owner, Entered: c.Mine.Entered}, Enter: race.Can{Reason: race.RefuseEntered}})
	}
	return b, nil
}

func (r *fakeRaces) Card(ctx context.Context, by race.Sailor, code string) (race.Card, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if x := r.find(code); x != nil {
		return r.card(by, x), nil
	}
	return race.Card{}, race.ErrNotFound
}

func (r *fakeRaces) CardOf(ctx context.Context, by race.Sailor, id [16]byte) (race.Card, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, x := range r.races {
		if x.id == id {
			return r.card(by, x), nil
		}
	}
	return race.Card{}, race.ErrNotFound
}

func (r *fakeRaces) Enter(ctx context.Context, by race.Sailor, code string, crew bool) (race.Card, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.refuse != nil {
		return race.Card{}, r.refuse
	}
	x := r.find(code)
	if x == nil {
		return race.Card{}, race.ErrNotFound
	}
	if r.phase(x) != race.PhaseOpen {
		return race.Card{}, &race.Refusal{Reason: race.RefuseStarted}
	}
	for _, a := range x.entrants {
		if a == by.ID {
			return race.Card{}, &race.Refusal{Reason: race.RefuseEntered}
		}
	}
	x.entrants = append(x.entrants, by.ID)
	return r.card(by, x), nil
}

func (r *fakeRaces) Make(ctx context.Context, by race.Sailor, m race.Making) (race.Card, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch {
	case m.Who != race.WhoEveryone && m.Who != race.WhoMachines:
		return race.Card{}, &race.Refusal{Reason: race.RefuseWho}
	case m.Kind == race.KindRace && m.At.Before(time.Now().Add(race.Lead)):
		return race.Card{}, &race.Refusal{Reason: race.RefuseSoon, Until: time.Now().Add(race.Lead)}
	}
	n := len(r.races) + 1
	name := m.Name
	if name == "" {
		name = "the Spar Sprint"
	}
	x := &fakeRace{id: [16]byte{0xaa, byte(n)}, code: fmt.Sprintf("abcdefgh%c%c", 'a'+n/26, 'a'+n%26), name: name, kind: m.Kind,
		course: m.Course, boat: m.Boat, who: m.Who, owner: by.ID, starts: m.At.Add(-r.early)}
	if m.Kind == race.KindTrial {
		x.starts = time.Now()
	}
	r.races = append(r.races, x)
	return r.card(by, x), nil
}

func (r *fakeRaces) Withdraw(ctx context.Context, by race.Sailor, code string) (race.Card, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	x := r.find(code)
	if x == nil {
		return race.Card{}, race.ErrNotFound
	}
	for i, a := range x.entrants {
		if a == by.ID {
			x.entrants = append(x.entrants[:i], x.entrants[i+1:]...)
			return r.card(by, x), nil
		}
	}
	return race.Card{}, &race.Refusal{Reason: race.RefuseNotEntered}
}

// clerk hands each race to the world's committee at its warning signal,
// and lets it go once it has ended, once a second until ctx ends.
func (r *fakeRaces) clerk(ctx context.Context, b *bus.Bus) {
	send := b.Commands.Server()
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
		f := b.Frames.Acquire()
		tick := f.Tick
		ended := map[[16]byte]bool{}
		for i := range f.Races {
			if f.Races[i].Phase == bus.RaceEnded {
				ended[f.Races[i].ID] = true
			}
		}
		f.Release()
		r.mu.Lock()
		now := time.Now()
		for _, x := range r.races {
			warning := x.starts.Add(-time.Duration(committee.Warning/committee.Second) * time.Second)
			switch {
			case !x.sent && len(x.entrants) > 0 && (x.kind == race.KindTrial || !now.Before(warning)):
				call := &bus.RaceCall{ID: x.id, Trial: x.kind == race.KindTrial, Island: true, Course: 1}
				if !call.Trial {
					call.Start = tick + int64(x.starts.Sub(now).Seconds()*physics.StepsPerSecond)
				}
				for i, a := range x.entrants {
					call.Entrants = append(call.Entrants, bus.RaceEntrant{Account: bus.Account(a), Number: int16(i + 1), Machine: true})
				}
				if send.TrySend(bus.Command{Op: bus.RacePlace, Race: call}) == nil {
					x.sent = true
				}
			case x.sent && !x.written && ended[x.id]:
				if send.TrySend(bus.Command{Op: bus.RaceWritten, Race: &bus.RaceCall{ID: x.id}}) == nil {
					x.written = true
				}
			}
		}
		r.mu.Unlock()
	}
}

// spar is a stage of one island course: from a line at (0, −100) north
// round a spar at (0, 80), left to starboard, and home to the line;
// some 450 m.
func spar(cat *catalog.Catalog) *committee.Stage {
	st := &committee.Stage{Areas: []committee.Area{{Number: 1, X: 0, Y: 2000, Radius: 450}}}
	for i := range cat.Boats {
		st.Kinds = append(st.Kinds, committee.Kind{Polar: cat.Polar(i), Length: cat.Boats[i].LengthOverall})
	}
	way := [][2]float64{{0, -100}, {-30, 80}, {0, 110}, {30, 80}, {0, -100}}
	length := 0.0
	for i := 1; i < len(way); i++ {
		length += math.Sqrt(math.Pow(way[i][0]-way[i-1][0], 2) + math.Pow(way[i][1]-way[i-1][1], 2))
	}
	up := math.Sqrt(30*30+180*180) + math.Sqrt(30*30+30*30)
	st.Courses = []committee.Course{{Number: 1, Start: committee.Site{X: 0, Y: -100, Room: 160}, Finish: committee.Site{X: 0, Y: -100, Room: 160},
		Rays: []committee.Ray{{X: 0, Y: 80, Bearing: 0, Crossings: 1, Along: up, Mark: 1}}, Way: way, Length: length}}
	return st
}

// shortSignals shortens the signals before the start for a test.
func shortSignals(t *testing.T) {
	warning, prep := committee.Warning, committee.Preparatory
	committee.Warning, committee.Preparatory = 30*committee.Second, 15*committee.Second
	t.Cleanup(func() { committee.Warning, committee.Preparatory = warning, prep })
}

// raceHarness is a harness whose world runs the spar's races, kept by
// fakeRaces, with a clerk at work.
func raceHarness(t *testing.T) (*harness, *fakeRaces) {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	races := newFakeRaces(cat)
	races.early = 4 * time.Minute
	// The wind from the east: the way out north is a reach.
	h := newHarnessWith(t, harnessWith{limit: 8, knots: 12, from: 90, stage: spar(cat), races: races})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		races.clerk(ctx, h.w.Bus())
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return h, races
}

// boatAt is where sailor a's boat is, and its heading, degrees.
func (h *harness) boatAt(a *oauth.Accepted) (x, y float64, ok bool) {
	f := h.w.Bus().Frames.Acquire()
	defer f.Release()
	for _, s := range f.Live {
		if f.Owner[s] == bus.Account(a.Account) {
			return f.State[s].X, f.State[s].Y, true
		}
	}
	return 0, 0, false
}

// raceWait observes, waiting for the race, until the report has want, or
// fails after most seconds of the world's.
func (h *harness) raceWait(t *testing.T, a *oauth.Accepted, want string, most time.Duration) string {
	t.Helper()
	end := time.Now().Add(most)
	var all strings.Builder
	for time.Now().Before(end) {
		text, refused := h.call(t, a, "observe", map[string]any{"wait": 25, "wake_on": []string{"race"}})
		if refused {
			t.Fatalf("observe refused: %s", text)
		}
		all.WriteString(text + "\n")
		if strings.Contains(text, want) {
			return text
		}
	}
	t.Fatalf("no %q in %s:\n%s", want, most, all.String())
	return ""
}

func TestAMachineSailorMakesEntersAndRaces(t *testing.T) {
	shortSignals(t)
	synctest.Test(t, func(t *testing.T) {
		h, _ := raceHarness(t)
		a := sailor(1, "Iron Mary")
		h.call(t, a, "observe", nil)

		text, refused := h.call(t, a, "race", nil)
		if refused || !strings.Contains(text, "Your races (entered or made, not over):\n none") || !strings.Contains(text, "island:1: Round the Spar") {
			t.Fatalf("the list: %v %s", refused, text)
		}
		text, refused = h.call(t, a, "race", map[string]any{"action": "make", "course": "Round the Spar", "in": 5, "name": "Spar Dash"})
		if refused || !strings.Contains(text, "Made «Spar Dash»") || !strings.Contains(text, "?r=") {
			t.Fatalf("made: %v %s", refused, text)
		}
		code := text[strings.Index(text, "(code ")+6:][:10]
		text, refused = h.call(t, a, "race", map[string]any{"action": "enter", "race": "https://play.example/?r=" + code})
		if refused || !strings.Contains(text, "Entered «Spar Dash") || !strings.Contains(text, "You are No. 1") {
			t.Fatalf("entered: %v %s", refused, text)
		}
		text, _ = h.call(t, a, "race", nil)
		if !strings.Contains(text, "«Spar Dash» · code "+code) || !strings.Contains(text, "you are entered") {
			t.Fatalf("listed: %s", text)
		}

		// Placed at the warning signal, the line before it.
		text = h.raceWait(t, a, "woke: race: placed on the line", 2*time.Minute)
		for _, want := range []string{"Race: «Spar Dash» · No. 1 of 1 · on the line · the gun in", "Line: below the start line by",
			"Course: Start: the line from the pin", "the committee boat (starboard end)"} {
			if !strings.Contains(text, want) {
				t.Fatalf("no %q on the line:\n%s", want, text)
			}
		}
		// Hold below the line, head to wind, until the gun.
		h.call(t, a, "steer", map[string]any{"heading": 90, "boom": 10})
		h.raceWait(t, a, "the starting gun", time.Minute)

		// Up the west side of the spar, round it to starboard, and home.
		h.call(t, a, "steer", map[string]any{"heading": 352, "boom": 45})
		for {
			text, _ = h.call(t, a, "observe", map[string]any{"wait": 5})
			if _, y, _ := h.boatAt(a); y > 135 {
				break
			}
			if strings.Contains(text, "the race is over") {
				t.Fatalf("over on the way up:\n%s", text)
			}
		}
		if !strings.Contains(text, "Next: rounding 1, leaving it to starboard, by the course's way past it") {
			t.Fatalf("the next mark on the way up:\n%s", text)
		}
		// East across the top of it, past its ray, then tack for home.
		h.call(t, a, "steer", map[string]any{"heading": 30, "boom": 25})
		var round strings.Builder
		for range 40 {
			text, _ = h.call(t, a, "observe", map[string]any{"wait": 3})
			round.WriteString(text)
			if x, _, _ := h.boatAt(a); x > 25 {
				break
			}
		}
		h.call(t, a, "steer", map[string]any{"heading": 180, "side": "port", "via": "tack", "boom": 45})
		for range 40 {
			text, _ = h.call(t, a, "observe", map[string]any{"wait": 5, "wake_on": []string{"race"}})
			round.WriteString(text)
			if strings.Contains(text, "Next: the finish line") {
				break
			}
		}
		if !strings.Contains(round.String(), "your boat rounded mark 1, 1st") || !strings.Contains(text, "Next: the finish line") {
			t.Fatalf("no rounding:\n%s", round.String())
		}
		for range 60 {
			x, y, _ := h.boatAt(a)
			b := degrees(physics.Atan2(-x, -100-y))
			h.call(t, a, "steer", map[string]any{"heading": b, "boom": 50})
			text, _ = h.call(t, a, "observe", map[string]any{"wait": 10, "wake_on": []string{"race"}})
			if strings.Contains(text, "your boat finished") {
				break
			}
		}
		if !strings.Contains(text, "your boat finished, 1st home") {
			t.Fatalf("no finish:\n%s", text)
		}
		if !strings.Contains(text, "the race is over: 1st of 1, home in") {
			text = h.raceWait(t, a, "the race is over: 1st of 1, home in", time.Minute)
		}
		if strings.Contains(text, "Race:") && !strings.Contains(text, "· over · 1st of 1") {
			t.Fatalf("the race block after the race:\n%s", text)
		}
	})
}

func TestRaceRefusalsSayWhatToDo(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h, races := raceHarness(t)
		a := sailor(1, "Iron Mary")
		for _, c := range []struct {
			args map[string]any
			want string
		}{
			{map[string]any{"action": "make", "in": 2}, "Too soon: a race starts at least 5 minutes after it is made. Give in 5 or more."},
			{map[string]any{"action": "make", "who": "humans"}, "who is everyone or machines"},
			{map[string]any{"action": "make", "course": "Round the Moon"}, "No course open called «Round the Moon». The courses: island:1."},
			{map[string]any{"action": "make", "boat": "galleon"}, "No boat of the kind «galleon» races."},
			{map[string]any{"action": "enter"}, "Say which race"},
			{map[string]any{"action": "enter", "race": "the Noon Gun"}, "No race called «the Noon Gun»"},
			{map[string]any{"action": "enter", "race": "zzzzzzzzzz"}, "No race has that code."},
			{map[string]any{"action": "list", "course": "island:1"}, "are make's"},
			{map[string]any{"action": "retire"}, "You are in no race"},
		} {
			time.Sleep(time.Second)
			text, refused := h.call(t, a, "race", c.args)
			if !refused || !strings.Contains(text, c.want) {
				t.Errorf("%v: %v %q", c.args, refused, text)
			}
		}
		text, _ := h.call(t, a, "race", map[string]any{"action": "make"})
		code := text[strings.Index(text, "(code ")+6:][:10]
		races.mu.Lock()
		races.refuse = &race.Refusal{Reason: race.RefuseDaily, Until: time.Now().Add(42 * time.Minute)}
		races.mu.Unlock()
		time.Sleep(time.Second)
		text, refused := h.call(t, a, "race", map[string]any{"action": "enter", "race": code})
		if !refused || !strings.Contains(text, "You have raced as often in a day as a sailor may. Your next race may start in 42 min (") {
			t.Fatalf("daily: %q", text)
		}
		// Every reason has its words, each a sentence.
		for _, reason := range []string{race.RefuseFull, race.RefuseClosed, race.RefuseStarted, race.RefuseCancelled, race.RefuseFinished,
			race.RefuseHumans, race.RefuseMachines, race.RefuseNewcomers, race.RefuseBlocked, race.RefuseAhead, race.RefuseDaily,
			race.RefuseEntered, race.RefuseClash, race.RefuseLate, race.RefuseMade, race.RefuseOwned, race.RefuseSoon, race.RefuseCourse,
			race.RefuseAreas, race.RefuseWho, race.RefuseBoat, race.RefuseKind, race.RefuseName, race.RefuseMoved, race.RefuseNotEntered,
			race.RefuseNotFinished} {
			w := raceRefusalWords(&race.Refusal{Reason: reason, Until: time.Now().Add(time.Hour)}, time.Now())
			if strings.Contains(w, "no words yet") || !strings.HasSuffix(w, ".") {
				t.Errorf("%s: %q", reason, w)
			}
		}
	})
}

func TestRetiringAndWithdrawing(t *testing.T) {
	shortSignals(t)
	synctest.Test(t, func(t *testing.T) {
		h, _ := raceHarness(t)
		a := sailor(1, "Iron Mary")
		h.call(t, a, "observe", nil)
		text, _ := h.call(t, a, "race", map[string]any{"action": "make", "in": 5})
		code := text[strings.Index(text, "(code ")+6:][:10]
		h.call(t, a, "race", map[string]any{"action": "enter", "race": "the Spar Sprint"})
		text, refused := h.call(t, a, "race", map[string]any{"action": "retire"})
		if refused || !strings.Contains(text, "Withdrawn from «the Spar Sprint» before its start") {
			t.Fatalf("withdrawn: %v %q", refused, text)
		}
		h.call(t, a, "race", map[string]any{"action": "enter", "race": code})
		h.raceWait(t, a, "woke: race: placed on the line", 2*time.Minute)
		text, refused = h.call(t, a, "race", map[string]any{"action": "retire"})
		if refused || !strings.Contains(text, "Retired from «the Spar Sprint»") {
			t.Fatalf("retired: %v %q", refused, text)
		}
		text, _ = h.call(t, a, "observe", map[string]any{"detail": "full", "wait": 2, "wake_on": []string{"race"}})
		// The race may be let go already: one boat, retired, is over.
		if strings.Contains(text, "Race:") && !strings.Contains(text, "· over · retired") || !strings.Contains(text, "your boat retired from the race") ||
			!strings.Contains(text, "the race is over: retired") {
			t.Fatalf("after retiring:\n%s", text)
		}
	})
}

func TestRaceBlockJSON(t *testing.T) {
	shortSignals(t)
	synctest.Test(t, func(t *testing.T) {
		h, _ := raceHarness(t)
		a := sailor(1, "Iron Mary")
		h.call(t, a, "observe", nil)
		h.call(t, a, "race", map[string]any{"action": "make", "in": 5})
		h.call(t, a, "race", map[string]any{"action": "enter", "race": "the Spar Sprint"})
		h.raceWait(t, a, "woke: race: placed on the line", 2*time.Minute)
		text, _ := h.call(t, a, "observe", map[string]any{"format": "json"})
		var rep struct {
			Race *raceFacts `json:"race"`
		}
		if err := json.Unmarshal([]byte(text), &rep); err != nil || rep.Race == nil {
			t.Fatalf("%v: %s", err, text)
		}
		if r := rep.Race; r.Number != 1 || r.State != "on the line" || r.Line == "" || r.Code == "" || r.Name != "«the Spar Sprint»" {
			t.Fatalf("%+v", r)
		}
	})
}

// raceBlockGolden holds the race block of a report at three moments of a
// race, as text.
const raceBlockGolden = "testdata/race_block.golden.txt"

// TestRaceBlock: the race in a report on the line before the gun, racing
// in a fleet of four, brief and full, and over, against the golden file.
func TestRaceBlock(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	st := &committee.Stage{Areas: []committee.Area{{Number: 1, X: 0, Y: 600, Radius: 450}}}
	for i := range cat.Boats {
		st.Kinds = append(st.Kinds, committee.Kind{Polar: cat.Polar(i), Length: cat.Boats[i].LengthOverall})
	}
	f := bus.NewFrame(16)
	f.Tick = 90000
	me := bus.Account{0x01, 0x9a, 1}
	call := &bus.RaceCall{ID: [16]byte{0xaa, 1}, Triangle: true, Course: 1, Start: f.Tick + 120*physics.StepsPerSecond}
	var placed []committee.Placing
	for s := range 4 {
		f.Occupied[s] = true
		f.Live = append(f.Live, int32(s))
		f.Boat[s] = uint64(s + 1)
		f.Owner[s] = bus.Account{byte(s + 10)}
		if s == 0 {
			f.Owner[s] = me
		}
		f.BoatName[s] = []string{"", "Gull", "", "Kittiwake"}[s]
		call.Entrants = append(call.Entrants, bus.RaceEntrant{Account: f.Owner[s], Number: int16(s + 1), Machine: s == 0 || s == 2})
		placed = append(placed, committee.Placing{Slot: int32(s), Boat: f.Boat[s], Placed: true})
	}
	course := st.Lay(f, call, 5, 0, 4)
	if course == nil {
		t.Fatal("no course laid")
	}
	committee.Begin(f, call, course, placed)
	spots := committee.Spots(course, 2*3.5)
	for s := range 4 {
		f.State[s] = spots[s]
	}
	k := &knownRace{name: "Tuesday Triangle", code: "abcdefghij", entrants: map[int]race.Entrant{}}
	for n, name := range []string{"Iron Mary", "", "Brass Monkey", "Mira"} {
		e := race.Entrant{Number: n + 1, Machine: n == 0 || n == 2}
		if name != "" && n != 3 {
			e.Name = &name
		}
		if n == 1 {
			boat := "Gull"
			e.Boat = &boat
		}
		k.entrants[n+1] = e
	}
	m := "Mira"
	e := k.entrants[4]
	e.Name = &m
	k.entrants[4] = e
	s := &Sea{}
	h := &helm{account: [16]byte(me), raceKnown: map[uint32]*knownRace{f.Races[0].Key: k}}
	var b strings.Builder
	block := func(title string, brief bool) {
		b.WriteString("## " + title + "\n")
		if r := h.raceFactsFor(s, f, 0, brief); r != nil {
			r.text(&b)
		}
	}
	f.Tick += 30 * physics.StepsPerSecond
	block("on the line, 90 s before the gun", false)

	// Four minutes in: the boat second, rounding mark 1, a call on it.
	r := &f.Races[0]
	r.Phase = bus.RaceStarted
	f.Tick = r.Start + 240*physics.StepsPerSecond
	ch := course.Checks
	at := func(s int, k int, back, side float64) {
		c := &ch[k]
		f.State[s].X, f.State[s].Y = c.AtX+side, c.AtY-back
		f.State[s].Heading = 0.7
	}
	at(0, 1, 60, 10)
	at(1, 1, 30, -5)
	at(2, 1, 140, 40)
	at(3, 2, 200, -100)
	for j := range f.Racers {
		rc := &f.Racers[j]
		rc.State, rc.Crossed = bus.RacerRacing, r.Start+3*physics.StepsPerSecond
		rc.Next = 1
		st := &f.State[rc.Slot]
		c := &ch[rc.Next]
		rc.ToGo = math.Hypot(st.X-c.AtX, st.Y-c.AtY) + course.Length - c.Along
	}
	f.Racers[3].Next = 2
	f.Racers[3].ToGo = math.Hypot(f.State[3].X-ch[2].AtX, f.State[3].Y-ch[2].AtY) + course.Length - ch[2].Along
	f.Racers[0].Added, f.Racers[0].Cheers = 10*committee.Second, 3
	h.raceCalls = map[uint32][]string{r.Key: {"a call: your boat at fault in the bump with No. 2: " + race.CallLine("10", 10) + " to you"}}
	block("racing, brief, first look", true)
	block("racing, brief, the course told", true)
	block("racing, full", false)

	// Over: the boat home second.
	r.Phase, r.Ended = bus.RaceEnded, f.Tick
	for j, place := range []int{2, 3, 4, 1} {
		f.Racers[j].State, f.Racers[j].Place = bus.RacerFinished, int16(place)
		f.Racers[j].Home = r.Start + int64(570+30*place)*physics.StepsPerSecond
	}
	f.Racers[0].Added = 0
	f.Racers[0].Awards = bus.AwardBestStart
	block("over", true)

	got := b.String()
	if *update {
		if err := os.WriteFile(raceBlockGolden, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(raceBlockGolden)
	if err != nil {
		t.Fatal(err)
	}
	if got != string(want) {
		t.Fatalf("the race block differs from %s (write it with -update):\n%s", raceBlockGolden, got)
	}
}

func TestRaceRecordsInTheLog(t *testing.T) {
	at := time.Date(2026, time.November, 14, 15, 0, 0, 0, time.UTC)
	recs := []store.RaceRecord{
		{RaceName: "the Noon Gun", Harbour: true, At: at, Kind: race.KindRace, CourseName: "Short triangle off Port Royal", Boat: "Jolly boat",
			Fleet: 5, Role: store.RoleSkipper, Place: 1, How: store.HowFinished, Awards: []string{"best-start"}, World: 4},
		{RaceName: "Spar Dash", At: at.Add(-time.Hour), Kind: race.KindRace, CourseName: "Round Gannet Holm", Boat: "Skiff", Fleet: 3,
			Role: store.RoleCrew, Place: 3, How: store.HowPlaced, Awards: []string{"spoon"}, SkipperName: "Mira", World: 4},
		{RaceName: "the Gannet Holm Challenge", At: at.Add(-2 * time.Hour), Kind: race.KindTrial, CourseName: "Round Gannet Holm",
			Boat: "Skiff", Fleet: 1, Role: store.RoleSkipper, Place: 1, How: store.HowFinished, Medal: "gold", World: 4},
		{RaceName: "Spar Dash", At: at.Add(-3 * time.Hour), Kind: race.KindRace, Role: store.RoleOwner, World: 4},
	}
	got := raceRecordWords(recs, func(id string) string { return id })
	for _, want := range []string{
		"Races: 3 races sailed · 1 won · 3 in the top three · 1 gold · 1 best start · 1 spoon.",
		"\n Saturday 14 November · the Noon Gun · 1st of 5 · best start · Short triangle off Port Royal, Jolly boat, world 4",
		"\n Saturday 14 November · «Spar Dash» · 3rd of 3 · spoon · crewing for «Mira» (human) · Round Gannet Holm, Skiff, world 4",
		"· a time trial run · gold ·",
		"· made by you ·",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("no %q in:\n%s", want, got)
		}
	}
}
