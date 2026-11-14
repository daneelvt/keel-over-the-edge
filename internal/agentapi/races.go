// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/race"
	"github.com/daneelvt/keel-over-the-edge/internal/race/committee"
)

// The race tool: a machine sailor's door to the world's races, as the race
// card and the Make a race panel are a person's. It lists the races the
// machine sailor has entered or made and the next harbour races, the only
// races found without a link; enters one by its code, its link or its
// name; makes one, for everyone or for machine sailors only, and answers
// with its link for the agent's owner to pass on; and retires from one,
// or withdraws before its start. A machine sailor is held to the limits
// every sailor is, and is told why when a race is refused, in words it can
// act on.

// Races are the world's races as a machine sailor reaches them:
// race.Service.
type Races interface {
	Board(ctx context.Context, by race.Sailor) (race.Board, error)
	Card(ctx context.Context, by race.Sailor, code string) (race.Card, error)
	CardOf(ctx context.Context, by race.Sailor, id [16]byte) (race.Card, error)
	Enter(ctx context.Context, by race.Sailor, code string, crew bool) (race.Card, error)
	Make(ctx context.Context, by race.Sailor, m race.Making) (race.Card, error)
	Withdraw(ctx context.Context, by race.Sailor, code string) (race.Card, error)
}

var _ Races = (*race.Service)(nil)

// The race tool's actions.
const (
	raceList   = "list"
	raceEnter  = "enter"
	raceMake   = "make"
	raceRetire = "retire"
)

// raceArgs are race's.
type raceArgs struct {
	Action string `json:"action,omitempty"`
	Race   string `json:"race,omitempty"`
	Course string `json:"course,omitempty"`
	Boat   string `json:"boat,omitempty"`
	In     *int   `json:"in,omitempty"`
	Who    string `json:"who,omitempty"`
	Trial  bool   `json:"trial,omitempty"`
	Name   string `json:"name,omitempty"`
}

// makes reports whether a's arguments are make's alone.
func (a *raceArgs) makes() bool {
	return a.Course != "" || a.Boat != "" || a.In != nil || a.Who != "" || a.Trial || a.Name != ""
}

// defaultIn is how many minutes ahead a race is made to start when the
// agent does not say.
const defaultIn = 10

// refusedRace is a race refused by its rules: full, closed, a limit.
const refusedRace refusalKind = "race"

// race answers the race tool.
func (c *Core) race(ctx context.Context, h *helm, a *raceArgs) (string, any, *refusal) {
	s := c.sea.Load()
	if s == nil {
		return "", nil, refuse(refusedNoWorld, wordsNoWorld)
	}
	if s.Races == nil {
		return "No races are run in this world.", nil, nil
	}
	action := a.Action
	if action == "" {
		action = raceList
		if a.makes() {
			action = raceMake
		}
	}
	if action != raceMake && a.makes() {
		return "", nil, refuse(refusedArgs, "course, boat, in, who, trial and name are make's: send action make with them.")
	}
	by := race.Sailor{ID: h.account, Machine: true}
	if s.OwnerOf != nil {
		if owner, err := s.OwnerOf(ctx, h.account); err == nil {
			by.Owner = owner
		}
	}
	now := time.Now()
	switch action {
	case raceList:
		b, err := s.Races.Board(ctx, by)
		if err != nil {
			return "", nil, raceError(err, now)
		}
		return boardWords(&b, now), nil, nil
	case raceEnter:
		code, r := raceCodeOf(ctx, s, by, a.Race)
		if r != nil {
			return "", nil, r
		}
		card, err := s.Races.Enter(ctx, by, code, true)
		if err != nil {
			return "", nil, raceError(err, now)
		}
		return enteredWords(&card, now), nil, nil
	case raceMake:
		return c.makeRace(ctx, s, by, a, now)
	case raceRetire:
		return c.retire(ctx, s, h, by, a.Race, now)
	}
	return "", nil, refuse(refusedArgs, "action is list, enter, make or retire.")
}

// makeRace makes the race a asks for.
func (c *Core) makeRace(ctx context.Context, s *Sea, by race.Sailor, a *raceArgs, now time.Time) (string, any, *refusal) {
	switch a.Who {
	case "", race.WhoEveryone, race.WhoMachines:
	default:
		return "", nil, refuse(refusedArgs, raceRefusalWords(&race.Refusal{Reason: race.RefuseWho}, now))
	}
	b, err := s.Races.Board(ctx, by)
	if err != nil {
		return "", nil, raceError(err, now)
	}
	boat := b.Make.Boat
	if a.Boat != "" {
		boat = boatChoice(b.Make.Boats, a.Boat)
		if boat == "" {
			return "", nil, refuse(refusedArgs, fmt.Sprintf("No boat of the kind %s races. The kinds: %s.", playerText(a.Boat), boatNames(b.Make.Boats)))
		}
	}
	course := ""
	switch {
	case a.Course != "":
		course = courseChoice(b.Make.Courses, a.Course)
		if course == "" {
			return "", nil, refuse(refusedArgs, fmt.Sprintf("No course open called %s. The courses: %s.", playerText(a.Course), courseIDs(b.Make.Courses)))
		}
	case len(b.Make.Courses) > 0:
		// The first a boat of the kind may race: a short triangle where
		// buoy courses are laid.
		for _, cc := range b.Make.Courses {
			if _, ok := cc.Boats[boat]; ok {
				course = cc.ID
				break
			}
		}
	}
	if course == "" {
		return "", nil, refuse(refusedRace, raceRefusalWords(&race.Refusal{Reason: race.RefuseCourse}, now))
	}
	in := defaultIn
	if a.In != nil {
		in = *a.In
	}
	m := race.Making{Kind: race.KindRace, Course: course, Boat: boat, At: now.Add(time.Duration(in) * time.Minute), Who: a.Who, Name: a.Name}
	if m.Who == "" {
		m.Who = race.WhoEveryone
	}
	if a.Trial {
		m.Kind = race.KindTrial
	}
	card, err := s.Races.Make(ctx, by, m)
	if err != nil {
		return "", nil, raceError(err, now)
	}
	return madeWords(&card, now), nil, nil
}

// retire retires the machine sailor's boat from the race it sails in, or
// withdraws it from a race it has entered that has not started: the one
// named, or its only one.
func (c *Core) retire(ctx context.Context, s *Sea, h *helm, by race.Sailor, named string, now time.Time) (string, any, *refusal) {
	f := s.Bus.Frames.Acquire()
	j := committee.RacerOf(f, bus.Account(h.account))
	key := uint32(0)
	if j >= 0 {
		key = f.Racers[j].Race
	}
	f.Release()
	if j >= 0 && named == "" {
		reply := make(chan bus.Reply, 1)
		if err := send(ctx, s, bus.Command{Op: bus.RaceRetire, Account: bus.Account(h.account), Reply: reply}); err != nil {
			return "", nil, refuse(refusedBusy, wordsBusy)
		}
		select {
		case r := <-reply:
			if r.Result != bus.Done {
				return "You are in no race now: it ended, or you had retired already.", nil, nil
			}
			// Retired once a frame shows it: the next report finds it so.
			for f := s.Bus.Frames.Acquire(); f.Tick < r.Tick; f = s.Bus.Frames.Acquire() {
				f.Release()
				select {
				case <-ctx.Done():
					return "", nil, nil
				case <-time.After(time.Second / 60):
				}
			}
		case <-time.After(joinWait):
			return "", nil, refuse(refusedBusy, wordsBusy)
		case <-ctx.Done():
			return "", nil, nil
		}
		name := "the race"
		h.mu.Lock()
		if k := h.raceKnown[key]; k != nil && k.name != "" {
			name = raceNameWords(k.name, k.harbour)
		}
		h.mu.Unlock()
		return fmt.Sprintf("Retired from %s: you are out of the order, written RET. Sail where you like; the race goes on without you.", name), nil, nil
	}
	code := ""
	if named != "" {
		var r *refusal
		if code, r = raceCodeOf(ctx, s, by, named); r != nil {
			return "", nil, r
		}
	} else {
		b, err := s.Races.Board(ctx, by)
		if err != nil {
			return "", nil, raceError(err, now)
		}
		var entered []string
		for _, sm := range b.Mine {
			if sm.Mine.Entered && (sm.Phase == race.PhaseOpen || sm.Phase == race.PhaseClosed) {
				entered = append(entered, sm.Code)
			}
		}
		switch len(entered) {
		case 0:
			return "", nil, refuse(refusedRace, "You are in no race, and entered in none not yet started.")
		case 1:
			code = entered[0]
		default:
			return "", nil, refuse(refusedArgs, "You are entered in more than one race: say which with race, its code ("+strings.Join(entered, ", ")+").")
		}
	}
	if j >= 0 {
		// Named while racing: retire from the race sailed if it is that one.
		card, err := s.Races.Card(ctx, by, code)
		if err == nil && card.Phase == race.PhaseRacing && card.Mine.Entered {
			return c.retire(ctx, s, h, by, "", now)
		}
	}
	card, err := s.Races.Withdraw(ctx, by, code)
	if err != nil {
		return "", nil, raceError(err, now)
	}
	return fmt.Sprintf("Withdrawn from %s before its start: it counts against none of your races.", raceNameWords(card.Name, card.Harbour)), nil, nil
}

// raceCodeOf is the code of the race an agent names: its code, its link,
// or its name among its own races and the next harbour races.
func raceCodeOf(ctx context.Context, s *Sea, by race.Sailor, named string) (string, *refusal) {
	named = strings.TrimSpace(named)
	if named == "" {
		return "", refuse(refusedArgs, "Say which race: race, its code, link or name. list shows yours and the next harbour races.")
	}
	if code, ok := codeOf(named); ok {
		return code, nil
	}
	b, err := s.Races.Board(ctx, by)
	if err != nil {
		return "", raceError(err, time.Now())
	}
	want := plainName(named)
	for _, list := range [][]race.Summary{b.Mine, b.Harbour} {
		for _, sm := range list {
			if plainName(sm.Name) == want {
				return sm.Code, nil
			}
		}
	}
	return "", refuse(refusedArgs, fmt.Sprintf("No race called %s among yours and the next harbour races: give its code or its link. list shows them.", playerText(named)))
}

// codeOf is a race's code in a code or a link: ten letters and digits of
// base32, lower case, or a link's r.
func codeOf(s string) (string, bool) {
	if strings.Contains(s, "r=") {
		raw := s
		if i := strings.IndexByte(raw, '?'); i >= 0 {
			raw = raw[i+1:]
		}
		if q, err := url.ParseQuery(raw); err == nil {
			s = q.Get("r")
		}
	}
	s = strings.ToLower(strings.TrimSpace(s))
	if len(s) != 10 {
		return "", false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= '2' && c <= '7') {
			return "", false
		}
	}
	return s, true
}

// plainName is a race's name as names are matched: lower case, without
// "the" before it.
func plainName(s string) string {
	s = strings.ToLower(strings.Join(strings.Fields(s), " "))
	return strings.TrimPrefix(s, "the ")
}

// boatChoice is the catalog's id of the kind of boat an agent names, by
// its id or its name, "" for none.
func boatChoice(boats []race.BoatChoice, named string) string {
	want := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(named)), "s")
	for _, b := range boats {
		if strings.EqualFold(b.ID, named) || strings.TrimSuffix(strings.ToLower(b.Name), "s") == want {
			return b.ID
		}
	}
	return ""
}

// boatNames are the kinds of boat that race, by name.
func boatNames(boats []race.BoatChoice) string {
	var out []string
	for _, b := range boats {
		out = append(out, b.Name)
	}
	return strings.Join(out, ", ")
}

// courseChoice is the ID of the course an agent names: by its ID, its
// name, a buoy course's shape and length in words ("long triangle",
// "windward-leeward"), or an island course's number; "" for none.
func courseChoice(courses []race.CourseChoice, named string) string {
	want := strings.ToLower(strings.Join(strings.Fields(strings.ReplaceAll(named, "–", "-")), " "))
	long := strings.Contains(want, "long")
	shape := ""
	switch {
	case strings.Contains(want, "triangle"):
		shape = race.ShapeTriangle
	case strings.Contains(want, "windward"), strings.Contains(want, "sausage"):
		shape = race.ShapeWindwardLeeward
	}
	n, numbered := strconv.Atoi(strings.TrimPrefix(want, "island "))
	for _, cc := range courses {
		switch {
		case cc.ID == want, plainName(cc.Name) == plainName(want):
			return cc.ID
		case cc.Kind == race.CourseBuoy && shape != "" && cc.Shape == shape && cc.Long == long && !strings.Contains(want, ":"):
			return cc.ID
		case cc.Kind == race.CourseIsland && numbered == nil && cc.Number == n:
			return cc.ID
		}
	}
	return ""
}

// courseIDs are the courses open, by their IDs.
func courseIDs(courses []race.CourseChoice) string {
	var out []string
	for _, cc := range courses {
		out = append(out, cc.ID)
	}
	if len(out) == 0 {
		return "none open"
	}
	return strings.Join(out, ", ")
}

// raceError is a race's error as a refusal: its refusal's words, or
// another error's.
func raceError(err error, now time.Time) *refusal {
	if r, ok := race.RefusalOf(err); ok {
		return refuse(refusedRace, raceRefusalWords(r, now))
	}
	switch {
	case errors.Is(err, race.ErrNotFound):
		return refuse(refusedArgs, "No race has that code. Check the code or link your owner gave you; list shows yours and the next harbour races.")
	case errors.Is(err, race.ErrNotOwner):
		return refuse(refusedRace, "Only the race's owner may do that.")
	case errors.Is(err, race.ErrNoWorld):
		return refuse(refusedNoWorld, wordsNoWorld)
	}
	return refuse(refusedBusy, wordsBusy)
}

// raceRefusalWords are why a race was refused, in words an agent can act
// on: when it would not be, if a time says so.
func raceRefusalWords(r *race.Refusal, now time.Time) string {
	until := ""
	if !r.Until.IsZero() {
		until = whenWords(r.Until, now)
	}
	switch r.Reason {
	case race.RefuseFull:
		return "That race is full: it has the most boats its kind races. Enter another, or make one."
	case race.RefuseClosed:
		return "Its owner closed that race to entry."
	case race.RefuseStarted:
		return "Too late: entry closes at the warning signal, two minutes before the start."
	case race.RefuseCancelled:
		return "That race was called off by its owner."
	case race.RefuseFinished:
		return "That race is over, or its world has ended."
	case race.RefuseHumans:
		return "That race is for people only: machine sailors may not enter it."
	case race.RefuseMachines:
		return "That race is for machine sailors only."
	case race.RefuseNewcomers:
		return fmt.Sprintf("That race is for newcomers, sailors with fewer than %d races sailed, and you have sailed more.", race.Newcomer)
	case race.RefuseBlocked:
		return "You may not enter that race: there is a block between its owner and you or your owner."
	case race.RefuseAhead:
		return "You are entered in as many races not yet started as a sailor may be. You may enter another once the sooner of them starts" + spaced(until) + "."
	case race.RefuseDaily:
		return "You have raced as often in a day as a sailor may. Your next race may start" + spaced(until) + "."
	case race.RefuseEntered:
		return "You are already entered in that race."
	case race.RefuseClash:
		return "Another race you entered starts within 20 minutes of this one, and a boat sails one race at a time. Withdraw from it first (retire with its code), or choose another."
	case race.RefuseLate:
		if until != "" {
			return "Too late in the world for a race then: the latest start is" + spaced(until) + ". Give a smaller in."
		}
		return "Too late: the world ends soon, and its last hours have no races."
	case race.RefuseMade:
		return "You have made as many races in a day as a sailor may. You may make another" + spaced(until) + "."
	case race.RefuseOwned:
		return "You own as many races not yet finished as a sailor may. Make another once one of them is over."
	case race.RefuseSoon:
		return fmt.Sprintf("Too soon: a race starts at least %d minutes after it is made. Give in %d or more.",
			int(race.Lead/time.Minute), int(race.Lead/time.Minute))
	case race.RefuseCourse:
		return "That course is not open to that kind of boat. list shows each course and the boats it is offered to."
	case race.RefuseAreas:
		return "Every racing area off Port Royal has a race within 10 minutes of that start. Give another in, an island course, or make a time trial."
	case race.RefuseWho:
		return "A machine sailor makes a race for everyone or for machine sailors only: who is everyone or machines."
	case race.RefuseBoat:
		return "No boat of that kind races. list shows the kinds."
	case race.RefuseKind:
		return "A race or a time trial (trial true)."
	case race.RefuseName:
		return nameRefusalWords(r.Name)
	case race.RefuseNotEntered:
		return "You are not entered in that race."
	case race.RefuseMoved, race.RefuseNotFinished:
		return "Not now: that race cannot be changed so."
	}
	return "That race refused, for a reason with no words yet: " + r.Reason + "."
}

// nameRefusalWords are why a race's name was refused.
func nameRefusalWords(reason string) string {
	switch reason {
	case "short":
		return "That name is too short: 3 characters at least. Or leave name out for one suggested."
	case "long":
		return "That name is too long: 40 characters at most. Or leave name out for one suggested."
	case "characters":
		return "That name has a character a name may not have: letters and digits, with single spaces, hyphens, full stops and apostrophes between them. Or leave name out."
	case "scripts":
		return "That name mixes the letters of two alphabets. Or leave name out for one suggested."
	}
	return "That name has a word that is not allowed. Choose another, or leave name out for one suggested."
}

// spaced is w after a space, "" for none.
func spaced(w string) string {
	if w == "" {
		return ""
	}
	return " " + w
}

// whenWords are a time to come as words: "in 42 min (15:30 UTC)", "in 3
// h 10 min (Tuesday 15:30 UTC)".
func whenWords(t, now time.Time) string {
	d := t.Sub(now)
	at := t.UTC().Format("15:04 UTC")
	if t.UTC().YearDay() != now.UTC().YearDay() {
		at = t.UTC().Format("Monday 15:04 UTC")
	}
	if d <= 0 {
		return "now (" + at + ")"
	}
	mins := int((d + time.Minute - 1) / time.Minute)
	if mins < 60 {
		return fmt.Sprintf("in %d min (%s)", mins, at)
	}
	return fmt.Sprintf("in %d h %d min (%s)", mins/60, mins%60, at)
}

// raceNameWords is a race's name as told: a player's in «», the
// Harbourmaster's as written.
func raceNameWords(name string, harbour bool) string {
	if harbour {
		return name
	}
	return playerText(name)
}

// whoWords are who may enter a race.
func whoWords(who string) string {
	switch who {
	case race.WhoHumans:
		return "people only"
	case race.WhoMachines:
		return "machine sailors only"
	case race.WhoNewcomers:
		return "newcomers only"
	}
	return "everyone"
}

// kindWords are a race's kind and boat: "a race for Jolly boats", "a time
// trial in a Skiff".
func kindWords(kind, boat string) string {
	if kind == race.KindTrial {
		return "a time trial in " + article(boat)
	}
	return "a race for " + race.Plural(boat)
}

// summaryWords are a race on a list.
func summaryWords(sm *race.Summary, now time.Time) string {
	parts := []string{raceNameWords(sm.Name, sm.Harbour), "code " + sm.Code, kindWords(sm.Kind, sm.Boat.Name)}
	start := time.UnixMilli(sm.StartsAt)
	switch sm.Phase {
	case race.PhaseOpen, race.PhaseClosed:
		if sm.Kind == race.KindTrial {
			parts = append(parts, "open for runs")
		} else {
			parts = append(parts, "starts "+whenWords(start, now))
		}
		if sm.Phase == race.PhaseClosed {
			parts = append(parts, "closed to entry")
		}
	case race.PhaseStarting:
		parts = append(parts, "starting: the boats are on the line, the gun "+whenWords(start, now))
	default:
		parts = append(parts, sm.Phase)
	}
	if sm.Kind != race.KindTrial {
		parts = append(parts, fmt.Sprintf("%d of %d entered", sm.Entered, sm.Most))
	}
	if sm.Who != race.WhoEveryone {
		parts = append(parts, "for "+whoWords(sm.Who))
	}
	var mine []string
	if sm.Mine.Entered {
		mine = append(mine, "you are entered")
	}
	if sm.Mine.Owner {
		mine = append(mine, "you made it")
	}
	if !sm.Mine.Entered {
		if sm.Enter.OK {
			mine = append(mine, "you may enter")
		} else if sm.Enter.Reason != "" && sm.Enter.Reason != race.RefuseEntered {
			mine = append(mine, "not open to you: "+strings.TrimSuffix(raceRefusalWords(&race.Refusal{Reason: sm.Enter.Reason, Until: untilOf(sm.Enter.Until)}, now), "."))
		}
	}
	parts = append(parts, mine...)
	return strings.Join(parts, " · ")
}

// untilOf is a time in Unix ms as a time, zero for 0.
func untilOf(ms int64) time.Time {
	if ms == 0 {
		return time.Time{}
	}
	return time.UnixMilli(ms)
}

// boardWords answer list: the machine sailor's races, the next harbour
// races, and what it may make a race of.
func boardWords(b *race.Board, now time.Time) string {
	var w strings.Builder
	w.WriteString("Your races (entered or made, not over):\n")
	if len(b.Mine) == 0 {
		w.WriteString(" none\n")
	}
	for i := range b.Mine {
		w.WriteString(" " + summaryWords(&b.Mine[i], now) + "\n")
	}
	w.WriteString("The next harbour races off Port Royal:\n")
	if len(b.Harbour) == 0 {
		w.WriteString(" none on the board yet\n")
	}
	for i := range b.Harbour {
		w.WriteString(" " + summaryWords(&b.Harbour[i], now) + "\n")
	}
	m := &b.Make
	if !m.Can.OK {
		w.WriteString("Make a race: not now. " + raceRefusalWords(&race.Refusal{Reason: m.Can.Reason, Until: untilOf(m.Can.Until)}, now) + "\n")
	} else {
		fmt.Fprintf(&w, "Make a race: action make with course, boat (default yours, %s), in (minutes to the start, %d or more; default %d), who (everyone or machines), trial (true: a time trial), name (default suggested).\n",
			boatName(m.Boats, m.Boat), int(race.Lead/time.Minute), defaultIn)
	}
	w.WriteString(coursesWords(m))
	return strings.TrimRight(w.String(), "\n")
}

// boatName is a kind of boat's name, by its id.
func boatName(boats []race.BoatChoice, id string) string {
	for _, b := range boats {
		if b.ID == id {
			return b.Name
		}
	}
	return id
}

// coursesWords are the courses open to race on, each with its ID and the
// boats it is offered to.
func coursesWords(m *race.MakeChoices) string {
	var w strings.Builder
	var buoys []string
	var island []race.CourseChoice
	for _, cc := range m.Courses {
		if cc.Kind == race.CourseBuoy {
			buoys = append(buoys, fmt.Sprintf("%s (%d min)", cc.ID, minutesOf(cc.Boats)))
		} else {
			island = append(island, cc)
		}
	}
	if len(buoys) > 0 {
		var kinds []string
		for _, b := range m.Boats {
			if b.Buoys {
				kinds = append(kinds, race.Plural(b.Name))
			}
		}
		fmt.Fprintf(&w, "Buoy courses, laid to the wind in a racing area off Port Royal as each race begins, for %s: %s.\n",
			strings.Join(kinds, ", "), strings.Join(buoys, ", "))
	}
	if len(island) == 0 {
		w.WriteString("Island courses: none open yet (each opens once the places it names are charted).\n")
	}
	for _, cc := range island {
		var boats []string
		ids := make([]string, 0, len(cc.Boats))
		for id := range cc.Boats {
			ids = append(ids, id)
		}
		slices.Sort(ids)
		for _, id := range ids {
			boats = append(boats, fmt.Sprintf("%s %d min", boatName(m.Boats, id), cc.Boats[id]))
		}
		fmt.Fprintf(&w, "%s: %s, %.1f NM · %s\n", cc.ID, cc.Name, cc.Length/nm, strings.Join(boats, ", "))
	}
	return w.String()
}

// minutesOf is a buoy course's minutes, the same for every boat.
func minutesOf(boats map[string]int) int {
	for _, m := range boats {
		return m
	}
	return 0
}

// courseWords are a card's course: its name, its length.
func courseWords(c *race.CourseCard) string {
	if c.Kind == race.CourseIsland && c.Length > 0 {
		return fmt.Sprintf("%s, %.1f NM", c.Name, c.Length/nm)
	}
	return c.Name
}

// startWords are when a card's race starts, and what happens before: the
// warning signal, when the boats are placed.
func startWords(c *race.Card, now time.Time) string {
	if c.Kind == race.KindTrial {
		return fmt.Sprintf("Your run: in a moment your boat is put behind its start line, its autopilot off, wherever it is at sea; your clock starts as you cross the line, which you must within %s. Keep your boat at sea (observe with wait keeps it there).",
			durationWords(time.Duration(committee.TrialWait/committee.Second)*time.Second))
	}
	start := time.UnixMilli(c.StartsAt)
	return fmt.Sprintf("The gun is %s. The warning signal, %s before it, puts every entrant at sea on the start line, wherever it is, its autopilot off; one not at sea then does not start. Keep your boat at sea until then (observe with wait keeps it there): the race wakes you.",
		whenWords(start, now), durationWords(race.Warning))
}

// enteredWords answer enter.
func enteredWords(c *race.Card, now time.Time) string {
	var w strings.Builder
	fmt.Fprintf(&w, "Entered %s (code %s): %s on the %s, about %d min.", raceNameWords(c.Name, c.Harbour), c.Code,
		kindWords(c.Kind, c.Boat.Name), courseWords(&c.Course), c.Minutes)
	if c.Kind != race.KindTrial {
		fmt.Fprintf(&w, " You are No. %d; %d of %d entered.", c.Mine.Number, len(c.Entrants), c.Most)
	}
	w.WriteString(" " + startWords(c, now))
	w.WriteString(" Everyone can watch you while you race. handbook races tells how a race goes.")
	return w.String()
}

// madeWords answer make.
func madeWords(c *race.Card, now time.Time) string {
	var w strings.Builder
	fmt.Fprintf(&w, "Made %s: %s on the %s, about %d min", raceNameWords(c.Name, c.Harbour), kindWords(c.Kind, c.Boat.Name),
		courseWords(&c.Course), c.Minutes)
	if c.Kind != race.KindTrial {
		fmt.Fprintf(&w, ", its gun %s", whenWords(time.UnixMilli(c.StartsAt), now))
	}
	fmt.Fprintf(&w, ", for %s. Its link: %s (code %s): give it to your owner to pass on. ", whoWords(c.Who), c.Link, c.Code)
	if c.Kind == race.KindTrial {
		w.WriteString("You have not sailed a run: race enter with its code puts you on its line.")
	} else {
		w.WriteString("You are not entered: race enter with its code enters you.")
	}
	return w.String()
}
