// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"context"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/race"
	"github.com/daneelvt/keel-over-the-edge/internal/race/committee"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// A race in the lookout report, and its wakes. While the machine
// sailor's boat races, the report carries what a racer's screen shows: the
// countdown or the race's clock, its place and gap, the seconds added to
// it, the next mark's number, side, bearing and distance (before the
// start, where the line is and which side of it the boat is), the course
// card in words, the calls on it, the fleet's places and where each boat
// is, and its cheers. What happens in the race is told as it happens, and
// wakes a wait for race: the boats placed, the signals, a rounding, a
// call, a finish, the end. The boat placed on the line and the
// committee's question to a boat making no way wake any wait: the boat was
// moved, or will retire.

// raceFacts are the report's race.
type raceFacts struct {
	Name   string `json:"race"`
	Code   string `json:"code,omitempty"`
	Number int    `json:"number"`
	Boats  int    `json:"boats"`
	// State is the boat's: "on the line", "racing", "finished", "retired",
	// "did not start"; Clock the race's, in words.
	State  string    `json:"state"`
	Clock  string    `json:"clock,omitempty"`
	Place  int       `json:"place,omitempty"`
	Gap    int       `json:"gapSeconds,omitempty"`
	Added  int       `json:"addedSeconds,omitempty"`
	Cheers int       `json:"cheers,omitempty"`
	Line   string    `json:"line,omitempty"`
	Next   *markNext `json:"next,omitempty"`
	ToGo   float64   `json:"toGoNM,omitempty"`
	Course string    `json:"course,omitempty"`
	Fleet  []string  `json:"fleet,omitempty"`
	Calls  []string  `json:"calls,omitempty"`
	Result string    `json:"result,omitempty"`
}

// markNext is the next mark, or line, to pass: what it is, its bearing and
// distance from the boat, and which of the course's checks it is.
type markNext struct {
	What    string `json:"what"`
	Bearing int    `json:"bearing"`
	Metres  int    `json:"metres"`
	Of      string `json:"of,omitempty"`
}

// knownRace is what the machine sailor has been told of a race it sails
// in, read once: its name and code, and its boats' skippers as the card
// names them to it, by their race numbers.
type knownRace struct {
	name     string
	code     string
	harbour  bool
	entrants map[int]race.Entrant
}

// mostCalls is how many calls on its boat a report keeps for a race.
const mostCalls = 5

// raceIndexOf is the index in f.Races of the race of key, or −1.
func raceIndexOf(f *bus.Frame, key uint32) int {
	for i := range f.Races {
		if f.Races[i].Key == key {
			return i
		}
	}
	return -1
}

// racerAt is the boat in slot sl as it races, or sails a race just over:
// the indices of its race and of its racer, the newest; or account's,
// whose boat did not start; −1 for none.
func racerAt(f *bus.Frame, sl int32, account bus.Account) (ri, j int) {
	ri, j = -1, -1
	boat := uint64(0)
	if sl >= 0 && int(sl) < len(f.Occupied) && f.Occupied[sl] {
		boat = f.Boat[sl]
	}
	for k := range f.Racers {
		rc := &f.Racers[k]
		mine := boat != 0 && rc.Slot == sl && rc.Boat == boat || rc.Account == account && rc.State == bus.RacerDNS
		if !mine || j >= 0 && f.Racers[j].Race > rc.Race {
			continue
		}
		if i := raceIndexOf(f, rc.Race); i >= 0 {
			ri, j = i, k
		}
	}
	return ri, j
}

// knowRace reads, once, the name, code and boats of the race the helm's
// boat sails in, as its card tells them to the machine sailor.
func (c *Core) knowRace(ctx context.Context, s *Sea, h *helm, f *bus.Frame) {
	if s.Races == nil || len(f.Races) == 0 {
		return
	}
	h.mu.Lock()
	ri, _ := racerAt(f, h.slot, bus.Account(h.account))
	var known bool
	if ri >= 0 {
		_, known = h.raceKnown[f.Races[ri].Key]
	}
	h.mu.Unlock()
	if ri < 0 || known {
		return
	}
	r := &f.Races[ri]
	k := &knownRace{entrants: map[int]race.Entrant{}}
	if card, err := s.Races.CardOf(ctx, race.Sailor{ID: h.account, Machine: true}, r.ID); err == nil {
		k.name, k.code, k.harbour = card.Name, card.Code, card.Harbour
		for _, e := range card.Entrants {
			k.entrants[e.Number] = e
		}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.raceKnown == nil {
		h.raceKnown = map[uint32]*knownRace{}
	}
	for key := range h.raceKnown {
		if raceIndexOf(f, key) < 0 {
			delete(h.raceKnown, key)
			delete(h.raceCalls, key)
		}
	}
	h.raceKnown[r.Key] = k
}

// raceFactsFor is the race of the helm's boat in slot sl, as its racer's
// screen shows it, nil if it sails none. With mu held.
func (h *helm) raceFactsFor(s *Sea, f *bus.Frame, sl int32, brief bool) *raceFacts {
	ri, j := racerAt(f, sl, bus.Account(h.account))
	if ri < 0 {
		return nil
	}
	r, rc := &f.Races[ri], &f.Racers[j]
	k := h.raceKnown[r.Key]
	if k == nil {
		k = &knownRace{}
	}
	out := raceFactsOf(s, f, ri, j, k, brief && h.courseTold == r.Key)
	h.courseTold = r.Key
	if !brief {
		out.Calls = h.raceCalls[r.Key]
	}
	if brief && rc.State == bus.RacerRacing {
		// The leader, and the boats just ahead and behind.
		out.Fleet = briefFleet(out.Fleet, out.Place)
	}
	return out
}

// raceFactsOf are f.Races[ri] as its racer f.Racers[j] is shown it, its
// course card left out when told already.
func raceFactsOf(s *Sea, f *bus.Frame, ri, j int, k *knownRace, told bool) *raceFacts {
	r, rc := &f.Races[ri], &f.Racers[j]
	c := r.Course
	out := &raceFacts{Name: raceNameOf(k), Code: k.code, Number: int(rc.Number),
		Added: int(rc.Added / committee.Second), Cheers: int(rc.Cheers)}
	order := committee.Standings(f, r.Key)
	place := 0
	var lead *bus.Racer
	for n, x := range order {
		o := &f.Racers[x]
		if o.State == bus.RacerDNS {
			continue
		}
		out.Boats++
		if o.State != bus.RacerRetired {
			if lead == nil {
				lead = o
			}
			if x == j {
				place = n + 1
			}
		}
	}
	tick := f.Tick
	switch {
	case r.Phase == bus.RaceEnded:
		out.State = "over"
		out.Result = resultWords(r, rc, out.Boats)
	case rc.State == bus.RacerDNS:
		out.State, out.Clock = "did not start", clockWords(r, tick)
		out.Result = "your boat was not at sea as the boats were placed"
	case rc.State == bus.RacerRetired:
		out.State, out.Clock = "retired", clockWords(r, tick)
	case rc.State == bus.RacerFinished:
		out.State, out.Clock = "finished", clockWords(r, tick)
		out.Place = place
		out.Result = fmt.Sprintf("home %s in %s", ordinal(int32(place)), minSec(committee.Elapsed(r, rc)))
		if r.Closes > tick {
			out.Result += fmt.Sprintf("; the race ends in %s, as its finishing window closes", minSec(float64(r.Closes-tick)/committee.Second))
		}
	case rc.State == bus.RacerPlaced:
		out.State, out.Clock = "on the line", clockWords(r, tick)
	default:
		out.State, out.Clock = "racing", clockWords(r, tick)
		out.Place = place
		if lead != nil {
			out.Gap = int(math.Round(committee.Gap(r, lead, rc)))
		}
	}
	slot := rc.Slot
	at := slot >= 0 && int(slot) < len(f.Occupied) && f.Occupied[slot] && f.Boat[slot] == rc.Boat
	if at && (rc.State == bus.RacerPlaced || rc.State == bus.RacerRacing) {
		st := &f.State[slot]
		if rc.State == bus.RacerPlaced || rc.Next == 0 {
			out.Line = startLineWords(c, r, rc, st.X, st.Y, tick)
		}
		if rc.State == bus.RacerRacing && rc.Next > 0 {
			out.Next = nextWords(s, c, int(rc.Next), st.X, st.Y)
		}
		out.ToGo = math.Round(rc.ToGo/nm*100) / 100
	}
	if !told {
		out.Course = courseCardWords(s, c)
	}
	if at {
		st := &f.State[slot]
		out.Fleet = fleetWords(f, r, order, j, k, st.X, st.Y)
	}
	return out
}

// raceNameOf is a known race's name as told, "the race" if none is
// known.
func raceNameOf(k *knownRace) string {
	if k.name == "" {
		return "the race"
	}
	return raceNameWords(k.name, k.harbour)
}

// clockWords are a race's clock: the countdown to its gun, or how long it
// has run; a trial's run before its crossing, how long is left to cross.
func clockWords(r *bus.Race, tick int64) string {
	switch {
	case r.Trial && r.Start == 0:
		return "cross the start line to start your clock, within " + minSec(float64(r.Warning+committee.TrialWait-tick)/committee.Second)
	case tick < r.Start:
		left := float64(r.Start-tick) / committee.Second
		w := "the gun in " + minSec(left)
		if r.Phase < bus.RacePreparatory {
			w += ", the preparatory signal (bumps called from then) in " + minSec(left-float64(committee.Preparatory)/committee.Second)
		}
		return w
	}
	return "racing " + minSec(float64(tick-r.Start)/committee.Second)
}

// minSec is seconds as "m:ss".
func minSec(secs float64) string {
	n := max(int(math.Floor(secs+0.5)), 0)
	return fmt.Sprintf("%d:%02d", n/60, n%60)
}

// fromBoat is a point's bearing and distance from the boat at (x, y), in
// degrees and whole metres.
func fromBoat(x, y, px, py float64) (int, int) {
	dx, dy := px-x, py-y
	return degrees(physics.Atan2(dx, dy)), int(math.Round(math.Sqrt(dx*dx + dy*dy)))
}

// whereWords are a point's bearing and distance from the boat at (x, y):
// "352° 390 m".
func whereWords(x, y, px, py float64) string {
	b, d := fromBoat(x, y, px, py)
	return three(b) + " " + chart.DistanceText(float64(d))
}

// startLineWords are where the start line is from the boat at (x, y), and on
// which side of it the boat is, before it has crossed it.
func startLineWords(c *bus.RaceCourse, r *bus.Race, rc *bus.Racer, x, y float64, tick int64) string {
	ch := &c.Checks[0]
	dx, dy := ch.X2-ch.X, ch.Y2-ch.Y
	l := math.Sqrt(dx*dx + dy*dy)
	side, along := 0.0, 0.5
	if l > 0 {
		// Positive on the course side: the side it is crossed toward.
		side = (dx*(y-ch.Y) - dy*(x-ch.X)) / l * float64(-ch.Want)
		along = (dx*(x-ch.X) + dy*(y-ch.Y)) / (l * l)
	}
	mx, my := (ch.X+ch.X2)/2, (ch.Y+ch.Y2)/2
	up := three(degrees(c.From))
	var w string
	switch {
	case side > 0 && rc.State == bus.RacerPlaced && !r.Trial && tick < r.Start:
		w = fmt.Sprintf("over the start line by %.0f m: be back below it by the gun, or 10 s are added", side)
	case side > 0:
		w = fmt.Sprintf("above the start line by %.0f m: sail back below it, then cross it", side)
	default:
		w = fmt.Sprintf("below the start line by %.0f m", -side)
	}
	switch {
	case along < 0:
		w += fmt.Sprintf(", beyond its pin end by %.0f m", -along*l)
	case along > 1:
		w += fmt.Sprintf(", beyond its committee boat's end by %.0f m", (along-1)*l)
	}
	return fmt.Sprintf("%s · the line %.0f m long, its middle %s · the committee boat (starboard end) %s · the pin (port end) %s · cross it up the wind, toward %s, after the gun (over it at the gun, or within a fifth of its length beyond an end, adds 10 s)",
		w, l, whereWords(x, y, mx, my), whereWords(x, y, c.Committee[0], c.Committee[1]), whereWords(x, y, c.Pin[0], c.Pin[1]), up)
}

// sideWords is the side a ray check is left to: a mark to port, or to
// starboard.
func sideWords(want int8) string {
	if want > 0 {
		return "starboard"
	}
	return "port"
}

// nextWords are the next check of course c a boat at (x, y) is to pass,
// the k-th.
func nextWords(s *Sea, c *bus.RaceCourse, k int, x, y float64) *markNext {
	k = min(k, len(c.Checks)-1)
	ch := &c.Checks[k]
	last := len(c.Checks) - 1
	n := &markNext{}
	px, py := ch.AtX, ch.AtY
	switch {
	case k == last:
		n.What = "the finish line"
		if !c.Island {
			n.What += ", the start line crossed downwind"
		}
		px, py = (ch.X+ch.X2)/2, (ch.Y+ch.Y2)/2
		n.What += fmt.Sprintf(", between its ends %s and %s, its middle", whereWords(x, y, ch.X, ch.Y), whereWords(x, y, ch.X2, ch.Y2))
	case ch.Line:
		n.What = fmt.Sprintf("gate %d: sail between its two buoys", ch.Mark)
		px, py = (ch.X+ch.X2)/2, (ch.Y+ch.Y2)/2
	case c.Island:
		n.What = fmt.Sprintf("%s, leaving it to %s, by the course's way past it", roundingName(s, c, int(ch.Mark)), sideWords(ch.Want))
	default:
		n.What = fmt.Sprintf("mark %d, leaving it to %s", ch.Mark, sideWords(ch.Want))
		px, py = ch.X, ch.Y
	}
	n.Bearing, n.Metres = fromBoat(x, y, px, py)
	if k < last {
		n.Of = fmt.Sprintf("check %d of %d before the finish", k, last-1)
	}
	return n
}

// islandCourse is the world's island course of a number, as charted, or
// nil.
func islandCourse(s *Sea, number int32) *worldgen.Course {
	if s.Chart == nil {
		return nil
	}
	w := s.Chart.World()
	for i := range w.Courses {
		if w.Courses[i].Number == number {
			return &w.Courses[i]
		}
	}
	return nil
}

// roundingName is what an island course's rounding of a number rounds:
// an island or a place, by its charted name.
func roundingName(s *Sea, c *bus.RaceCourse, mark int) string {
	if ic := islandCourse(s, c.Number); ic != nil && mark >= 1 && mark <= len(ic.Rounds) {
		one := *ic
		one.Rounds = ic.Rounds[mark-1 : mark]
		if w := s.roundsWords(s.Chart.World(), &one); w != "" {
			name, _, _ := strings.Cut(w, " to ")
			return name
		}
	}
	return fmt.Sprintf("rounding %d", mark)
}

// courseCardWords are a course as its card tells it, as laid: its start,
// what it rounds in order and to which side, and its finish.
func courseCardWords(s *Sea, c *bus.RaceCourse) string {
	if c == nil || len(c.Checks) < 2 {
		return ""
	}
	var parts []string
	start := &c.Checks[0]
	parts = append(parts, fmt.Sprintf("Start: the line from the pin (port end, %s) to the committee boat (starboard end, %s), square to the wind from %s, crossed up the wind after the gun.",
		chart.Format(start.X, start.Y), chart.Format(start.X2, start.Y2), three(degrees(c.From))))
	if c.Island {
		if ic := islandCourse(s, c.Number); ic != nil {
			if w := s.roundsWords(s.Chart.World(), ic); w != "" {
				parts = append(parts, ic.Name+": leave "+w+", in that order, sailing round each outside it.")
			}
		}
		fin := &c.Checks[len(c.Checks)-1]
		parts = append(parts, fmt.Sprintf("Finish: the line between %s and %s.", chart.Format(fin.X, fin.Y), chart.Format(fin.X2, fin.Y2)))
	} else {
		for _, m := range c.Marks {
			switch m.Side {
			case bus.MarkGate:
			default:
				parts = append(parts, fmt.Sprintf("Mark %d to %s (%s).", m.Number, sideWords(m.Side), chart.Format(m.X, m.Y)))
			}
		}
		var seen bool
		for _, ch := range c.Checks[1 : len(c.Checks)-1] {
			if ch.Line && !seen {
				seen = true
				parts = append(parts, fmt.Sprintf("Gate %d between laps (%s): sail between its two buoys.", ch.Mark,
					chart.Format((ch.X+ch.X2)/2, (ch.Y+ch.Y2)/2)))
			}
		}
		var order []string
		for _, ch := range c.Checks[1 : len(c.Checks)-1] {
			if ch.Line {
				order = append(order, fmt.Sprintf("gate %d", ch.Mark))
			} else {
				order = append(order, fmt.Sprint(ch.Mark))
			}
		}
		laps := "Once round"
		if c.Laps > 1 {
			laps = fmt.Sprintf("%d laps", c.Laps)
		}
		parts = append(parts, fmt.Sprintf("%s: %s, then the finish: the start line, crossed downwind.", laps, strings.Join(order, ", ")))
	}
	parts = append(parts, fmt.Sprintf("%s in all; about %s for the race's boat in the wind it was laid to.", chart.DistanceText(c.Length),
		durationWords(minutesRound(c.Expected))))
	return strings.Join(parts, " ")
}

// minutesRound is seconds to the nearest minute, at least one.
func minutesRound(secs float64) time.Duration {
	return time.Duration(max(math.Round(secs/60), 1)) * time.Minute
}

// fleetWords are the race's other boats by place, each with where it is
// from the boat at (x, y); before the gun, by number.
func fleetWords(f *bus.Frame, r *bus.Race, order []int, me int, k *knownRace, x, y float64) []string {
	var out []string
	place := 0
	started := r.Start != 0 && f.Tick >= r.Start
	for _, x2 := range order {
		o := &f.Racers[x2]
		if o.State == bus.RacerDNS || o.State == bus.RacerRetired {
			continue
		}
		place++
		if x2 == me {
			continue
		}
		w := fmt.Sprintf("No. %d %s", o.Number, entrantWords(k, int(o.Number), f, o))
		switch {
		case r.Phase == bus.RaceEnded && o.Place > 0:
			w = ordinal(int32(o.Place)) + " " + w
		case started:
			w = ordinal(int32(place)) + " " + w
		}
		switch {
		case o.State == bus.RacerFinished:
			w += " · home"
		case o.Slot >= 0 && int(o.Slot) < len(f.Occupied) && f.Occupied[o.Slot] && f.Boat[o.Slot] == o.Boat:
			st := &f.State[o.Slot]
			w += " · " + whereWords(x, y, st.X, st.Y)
		}
		if o.Added > 0 {
			w += fmt.Sprintf(" · +%d s", o.Added/committee.Second)
		}
		out = append(out, w)
	}
	return out
}

// entrantWords name a race's boat as its card names it to the machine
// sailor: its skipper by name, a person's or a machine's, or its boat.
func entrantWords(k *knownRace, number int, f *bus.Frame, o *bus.Racer) string {
	if e, ok := k.entrants[number]; ok {
		switch {
		case e.Name != nil && e.Machine:
			return playerText(*e.Name) + " (machine)"
		case e.Name != nil:
			return playerText(*e.Name) + " (human)"
		case e.Boat != nil:
			return "the " + playerText(*e.Boat)
		}
	}
	if s := o.Slot; s >= 0 && int(s) < len(f.Occupied) && f.Occupied[s] && f.Boat[s] == o.Boat && f.BoatName[s] != "" {
		return "the " + playerText(f.BoatName[s])
	}
	if o.Machine {
		return "(machine)"
	}
	return "(human)"
}

// briefFleet is the fleet as a brief report gives it, by places: the
// first, the boat ahead and the boat behind.
func briefFleet(fleet []string, place int) []string {
	var out []string
	for i, w := range fleet {
		// The list leaves out the boat itself: those before it are ahead.
		p := i + 1
		if p >= place {
			p++
		}
		if p == 1 || p == place-1 || p == place+1 {
			out = append(out, w)
		}
	}
	return out
}

// resultWords are what a boat came to in a race over.
func resultWords(r *bus.Race, rc *bus.Racer, boats int) string {
	var w string
	switch rc.State {
	case bus.RacerDNS:
		return "did not start"
	case bus.RacerRetired:
		return "retired"
	case bus.RacerFinished:
		w = fmt.Sprintf("%s of %d, home in %s", ordinal(int32(rc.Place)), boats, minSec(committee.Elapsed(r, rc)))
	default:
		w = fmt.Sprintf("%s of %d, placed by progress with %s to go", ordinal(int32(rc.Place)), boats, chart.DistanceText(rc.ToGo))
	}
	if rc.Added > 0 {
		w += fmt.Sprintf(", %d s added", rc.Added/committee.Second)
	}
	if m := committee.MedalName(rc.Medal); m != "" {
		w += ", the " + m + " medal"
	}
	if a := committee.Awards(rc.Awards); len(a) > 0 {
		w += ", awarded " + strings.ReplaceAll(strings.Join(a, ", "), "-", " ")
	}
	return w
}

// text writes the race's lines.
func (r *raceFacts) text(b *strings.Builder) {
	fmt.Fprintf(b, "Race: %s · No. %d of %d · %s", r.Name, r.Number, r.Boats, r.State)
	if r.Clock != "" {
		b.WriteString(" · " + r.Clock)
	}
	if r.Place > 0 && r.State == "racing" {
		fmt.Fprintf(b, " · %s", ordinal(int32(r.Place)))
		if r.Gap > 0 {
			fmt.Fprintf(b, ", %d s behind the first", r.Gap)
		}
	}
	if r.Added > 0 && r.State != "over" {
		fmt.Fprintf(b, " · +%d s", r.Added)
	}
	if r.Cheers > 0 {
		fmt.Fprintf(b, " · cheered %d times", r.Cheers)
	}
	if r.Result != "" {
		b.WriteString(" · " + r.Result)
	}
	b.WriteByte('\n')
	if r.Line != "" {
		b.WriteString("Line: " + r.Line + "\n")
	}
	if n := r.Next; n != nil {
		fmt.Fprintf(b, "Next: %s · %s %s", n.What, three(n.Bearing), chart.DistanceText(float64(n.Metres)))
		if n.Of != "" {
			b.WriteString(" · " + n.Of)
		}
		if r.ToGo > 0 {
			fmt.Fprintf(b, " · %.2f NM to go", r.ToGo)
		}
		b.WriteByte('\n')
	}
	if r.Course != "" {
		b.WriteString("Course: " + r.Course + "\n")
	}
	if len(r.Fleet) > 0 {
		b.WriteString("Fleet: " + strings.Join(r.Fleet, " · ") + "\n")
	}
	if len(r.Calls) > 0 {
		b.WriteString("Calls: " + strings.Join(r.Calls, " · ") + "\n")
	}
}

// raceEvents records each race event of f not recorded yet for the
// machine sailors whose boats race in it, skippers and crew, in a
// racer's words: on the ticking goroutine, from the frame it happened in,
// so none is missed and none outlives its race.
func (r *Recorder) raceEvents(f *bus.Frame, put func(record)) {
	newest := r.raced
	for i := range f.RaceEvents {
		e := &f.RaceEvents[i]
		if e.Tick <= r.raced {
			continue
		}
		newest = max(newest, e.Tick)
		ri := raceIndexOf(f, e.Race)
		if ri < 0 {
			continue
		}
		race := &f.Races[ri]
		for j := range f.Racers {
			rc := &f.Racers[j]
			if rc.Race != e.Race {
				continue
			}
			kind, words, call := raceEventWords(f, race, rc, e)
			if words == "" {
				continue
			}
			for _, a := range racerAccounts(f, rc) {
				put(record{tick: e.Tick, kind: kind, account: a, words: words, race: e.Race, call: call})
			}
		}
	}
	r.raced = newest
}

// racerAccounts are the machine sailors a racer's events are told to:
// its skipper, if a machine sailor, and the machine sailors aboard as
// crew.
func racerAccounts(f *bus.Frame, rc *bus.Racer) []bus.Account {
	var out []bus.Account
	if rc.Machine {
		out = append(out, rc.Account)
	}
	if s := rc.Slot; s >= 0 && int(s) < len(f.Occupied) && f.Occupied[s] && f.Boat[s] == rc.Boat {
		lo, hi := f.CrewOf(s)
		for _, a := range f.Crew[lo:hi] {
			if a.Machine {
				out = append(out, a.Account)
			}
		}
	}
	return out
}

// raceEventWords are race event e as racer rc of race r is told it: its
// kind, its words ("" for one not told to it), and whether it is a call
// on its boat.
func raceEventWords(f *bus.Frame, r *bus.Race, rc *bus.Racer, e *bus.RaceEvent) (evKind, string, bool) {
	me := e.Number == rc.Number
	switch e.Kind {
	case bus.RacePlaced:
		switch {
		case rc.State == bus.RacerDNS:
			return evRacePlaced, "your boat did not start the race: it was not at sea as the boats were placed", false
		case r.Trial:
			return evRacePlaced, fmt.Sprintf("your boat was put behind the start line for your run, its autopilot off: steer and trim, and cross the line within %s to start your clock",
				minSec(float64(committee.TrialWait)/committee.Second)), false
		}
		return evRacePlaced, fmt.Sprintf("warning signal: your boat was put behind the start line, its autopilot off: steer and trim; the gun in %s",
			minSec(float64(r.Start-e.Tick)/committee.Second)), false
	case bus.RaceSignalled:
		switch e.Signal {
		case bus.SignalPreparatory:
			return evRace, "preparatory signal: a minute to the gun; bumps are called from now", false
		case bus.SignalStart:
			if rc.State == bus.RacerDNS {
				return 0, "", false
			}
			return evRace, "the starting gun: the race is on", false
		}
	case bus.RaceRounded:
		if me {
			return evRace, fmt.Sprintf("your boat rounded mark %d, %s", e.Mark, ordinal(int32(e.Place))), false
		}
	case bus.RaceCalled:
		switch {
		case me:
			return evRace, fmt.Sprintf("a call: your boat at fault in the bump with No. %d: %s to you", e.Other, race.CallLine(articleName(e.Article), int(e.Added))), true
		case e.Other == rc.Number:
			return evRace, fmt.Sprintf("a call: No. %d at fault in the bump with your boat: %s to No. %d", e.Number, race.CallLine(articleName(e.Article), int(e.Added)), e.Number), true
		}
	case bus.RaceOverEarly:
		if me {
			return evRace, race.OverEarlyLine(int(e.Added)) + ": sail on, there is no going back", true
		}
	case bus.RaceMissed:
		if me {
			return evRace, race.MissedLine(int(e.Mark)) + " and round it, then finish", true
		}
	case bus.RaceFinished:
		switch {
		case me && r.Trial:
			return evRace, fmt.Sprintf("your boat finished its run in %s", minSec(committee.Elapsed(r, rc))), false
		case me:
			return evRace, fmt.Sprintf("your boat finished, %s home, in %s", ordinal(int32(e.Place)), minSec(committee.Elapsed(r, rc))), false
		case e.Place == 1 && r.Home == e.Tick:
			return evRace, fmt.Sprintf("No. %d finished first: the finishing window closes in %s, then boats still racing are placed by their progress",
				e.Number, minSec(float64(r.Closes-e.Tick)/committee.Second)), false
		}
	case bus.RaceRetired:
		if me {
			return evRace, "your boat retired from the race", false
		}
	case bus.RaceDrifting:
		if me {
			return evRaceAsked, fmt.Sprintf("the committee asks whether you still race: no way made toward the next mark for %s; gain on it within %s or you retire",
				minSec(float64(committee.DriftAfter)/committee.Second), minSec(float64(committee.DriftAnswer)/committee.Second)), false
		}
	case bus.RaceOver:
		boats := 0
		for j := range f.Racers {
			if o := &f.Racers[j]; o.Race == r.Key && o.State != bus.RacerDNS {
				boats++
			}
		}
		return evRace, "the race is over: " + resultWords(r, rc, boats), false
	}
	return 0, "", false
}
