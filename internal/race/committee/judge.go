// SPDX-License-Identifier: AGPL-3.0-only

package committee

import (
	"math"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Running a race, tick by tick, in the simulation's rules phase.
//
// The sequence is short: the warning signal as the boats are placed, the
// preparatory a minute before the start, the start two minutes after the
// warning, each a gun. A boat on the course side of the line at the gun is
// over early: ten seconds are added and it sails on. Every other boat
// starts as it crosses the line. A trial's run has no sequence: its clock
// starts as its boat crosses the line.
//
// Each boat passes the course's checks in order, judged on its track from
// each tick to the next: a line crossed the right way between its ends; a
// rounding ray crossed, on the whole, the right number of times and way. A
// boat that crosses the finish with a mark still to round is told it
// missed it, and must go back for it before it can finish. A bump between
// two of a race's boats from the preparatory signal on, with a boat at
// fault by the Articles, adds ten seconds to that boat; bumps with
// passers-by are no one's business here.
//
// Once a boat is home the finishing window opens for the rest, for half
// the winner's time or five minutes, whichever is longer; with no boat
// home by twice the course's expected time, the race ends there. Either
// way everyone is placed: those home by their time and the seconds added,
// then those still racing by their progress, the marks rounded and then
// the way still to go. A boat whose boat leaves the water, goes over the
// lip, or makes no progress for five minutes and a minute more after being
// asked, retires; a sailor may retire at any time.

// Placing is an entrant as the simulation placed it: its boat's slot and
// ID, and whether it was placed at all (it was at sea).
type Placing struct {
	Slot   int32
	Boat   uint64
	Placed bool
}

// Begin puts the race of call, its course laid as c, under way in f from
// its warning signal: its entrants as placed, by call's order (their
// numbers'). It returns the race's key.
func Begin(f *bus.Frame, call *bus.RaceCall, c *bus.RaceCourse, placed []Placing) uint32 {
	key := max(f.NextRace, 1)
	f.NextRace = key + 1
	r := bus.Race{Key: key, ID: call.ID, Run: call.Run, Trial: call.Trial, Long: call.Long, Kind: call.Kind, Course: c,
		Warning: f.Tick, Phase: bus.RaceWarning}
	if !call.Trial {
		r.Start = max(call.Start, f.Tick+Warning)
	}
	var accounts []bus.Account
	n := 0
	for i := range call.Entrants {
		e := &call.Entrants[i]
		p := placed[i]
		rc := bus.Racer{Race: key, Account: e.Account, Number: e.Number, Machine: e.Machine, Crew: e.Crew, Slot: -1, State: bus.RacerDNS}
		if p.Placed {
			rc.Slot, rc.Boat, rc.State = p.Slot, p.Boat, bus.RacerPlaced
			n++
			if !slices.Contains(accounts, e.Account) {
				accounts = append(accounts, e.Account)
			}
		}
		f.Racers = append(f.Racers, rc)
	}
	lo, hi := racersOf(f, key)
	slices.SortFunc(f.Racers[lo:hi], func(a, b bus.Racer) int { return int(a.Number) - int(b.Number) })
	r.Prizes = !call.Trial && len(accounts) >= 3
	f.Races = append(f.Races, r)
	event(f, bus.RaceEvent{Race: key, Kind: bus.RacePlaced, Number: int16(n)})
	if !call.Trial && n > 0 {
		event(f, bus.RaceEvent{Race: key, Kind: bus.RaceSignalled, Signal: bus.SignalWarning, Gun: true})
	}
	for j := lo; j < hi; j++ {
		if rc := &f.Racers[j]; rc.State == bus.RacerPlaced {
			sample(rc, &f.State[rc.Slot], f.Tick)
		}
	}
	if n == 0 {
		end(f, len(f.Races)-1)
	}
	return key
}

// Step runs every race of f, the next frame, one tick on from cur, the
// current: the frame before it.
func Step(f, cur *bus.Frame) {
	for i := 0; i < len(f.Races); i++ {
		if f.Races[i].Phase != bus.RaceEnded {
			step(f, cur, i)
		}
	}
	calls(f)
}

// step runs f.Races[i] one tick.
func step(f, cur *bus.Frame, i int) {
	r := &f.Races[i]
	c := r.Course
	tick := f.Tick
	lo, hi := racersOf(f, r.Key)
	if !r.Trial {
		// The signals, each at its tick, or the first after it if the
		// world skipped it.
		if r.Phase == bus.RaceWarning && tick >= r.Start-Preparatory && tick < r.Start {
			r.Phase = bus.RacePreparatory
			event(f, bus.RaceEvent{Race: r.Key, Kind: bus.RaceSignalled, Signal: bus.SignalPreparatory, Gun: true})
		}
		if r.Phase < bus.RaceStarted && tick >= r.Start {
			r.Phase = bus.RaceStarted
			event(f, bus.RaceEvent{Race: r.Key, Kind: bus.RaceSignalled, Signal: bus.SignalStart, Gun: true})
			recall := false
			for j := lo; j < hi; j++ {
				rc := &f.Racers[j]
				if rc.State != bus.RacerPlaced {
					continue
				}
				rc.State = bus.RacerRacing
				if st := &f.State[rc.Slot]; over(&c.Checks[0], st.X, st.Y) {
					rc.Over, rc.Crossed, rc.Next, rc.Added = true, tick, 1, rc.Added+Penalty
					event(f, bus.RaceEvent{Race: r.Key, Kind: bus.RaceOverEarly, Number: rc.Number, Added: Penalty / Second})
					recall = true
				}
			}
			if recall {
				event(f, bus.RaceEvent{Race: r.Key, Kind: bus.RaceSignalled, Signal: bus.SignalRecall, Gun: true})
			}
		}
	}
	second := tick%Second == 0
	for j := lo; j < hi; j++ {
		rc := &f.Racers[j]
		if rc.State != bus.RacerPlaced && rc.State != bus.RacerRacing {
			continue
		}
		s := rc.Slot
		if !f.Occupied[s] || f.Boat[s] != rc.Boat || f.Voyage[s].Falling() {
			retire(f, r, rc)
			continue
		}
		st := &f.State[s]
		if cur != nil && tick != r.Warning && cur.Occupied[s] && cur.Boat[s] == rc.Boat {
			p := &cur.State[s]
			if hypot(st.X-p.X, st.Y-p.Y) < jumpLeast {
				judge(f, r, rc, p.X, p.Y, st.X, st.Y)
				r = &f.Races[i]
			}
		}
		if rc.State != bus.RacerPlaced && rc.State != bus.RacerRacing {
			continue
		}
		if second {
			progress(f, r, rc, st.X, st.Y)
			if rc.State != bus.RacerPlaced && rc.State != bus.RacerRacing {
				continue
			}
		}
		if tick-rc.Sampled >= TrackEvery {
			sample(rc, st, tick)
		}
	}
	if ends(f, r, lo, hi) {
		end(f, i)
	}
}

// jumpLeast is a move in a tick no boat sails, m: a boat put somewhere
// crosses nothing on its way.
const jumpLeast = 5

// over reports whether (x, y) is on the course side of the start line ch
// at the gun: past it, and between its ends or near them.
func over(ch *bus.RaceCheck, x, y float64) bool {
	dx, dy := ch.X2-ch.X, ch.Y2-ch.Y
	l2 := float64(dx*dx) + float64(dy*dy)
	if !(l2 > 0) {
		return false
	}
	side := float64(dx*(y-ch.Y)) - float64(dy*(x-ch.X))
	// The course side is the side it is crossed toward: left for −1.
	if float64(side*float64(ch.Want)) >= 0 {
		return false
	}
	t := (float64(dx*(x-ch.X)) + float64(dy*(y-ch.Y))) / l2
	return t > -overEnds && t < 1+overEnds
}

// overEnds is how far beyond its ends the line's course side counts for
// an early start, as a share of its length.
const overEnds = 0.2

// judge judges racer rc of race r on its way from (ax, ay) to (bx, by)
// this tick.
func judge(f *bus.Frame, r *bus.Race, rc *bus.Racer, ax, ay, bx, by float64) {
	c := r.Course
	last := int16(len(c.Checks) - 1)
	if rc.State == bus.RacerPlaced {
		if !r.Trial || lineCross(&c.Checks[0], ax, ay, bx, by) != c.Checks[0].Want {
			return
		}
		// A trial's run starts as its boat crosses the line.
		r.Start, r.Phase = f.Tick, bus.RaceStarted
		rc.State, rc.Crossed, rc.Next = bus.RacerRacing, f.Tick, 1
		return
	}
	ch := &c.Checks[rc.Next]
	passed := false
	if ch.Line {
		passed = lineCross(ch, ax, ay, bx, by) == ch.Want
	} else if d := rayCross(ch, ax, ay, bx, by); d != 0 {
		rc.Net += d
		passed = rc.Net == ch.Want
	}
	if !passed {
		// Over the finish with a mark still to round.
		fin := &c.Checks[last]
		if rc.Next < last && upCourse(c, rc) && lineCross(fin, ax, ay, bx, by) == fin.Want {
			event(f, bus.RaceEvent{Race: r.Key, Kind: bus.RaceMissed, Number: rc.Number, Mark: c.Checks[rc.Next].Mark})
		}
		return
	}
	k := rc.Next
	rc.Next, rc.Net = k+1, 0
	if k == 0 {
		rc.Crossed = f.Tick
		return
	}
	if k == last {
		finish(f, r, rc)
		return
	}
	if ch.Mark > 0 {
		place := int16(0)
		lo, hi := racersOf(f, r.Key)
		for j := lo; j < hi; j++ {
			if f.Racers[j].Next > k {
				place++
			}
		}
		if rc.First == 0 && firstMark(c) == k {
			rc.First = place
		}
		event(f, bus.RaceEvent{Race: r.Key, Kind: bus.RaceRounded, Number: rc.Number, Mark: ch.Mark, Place: place})
	}
}

// upCourse reports whether racer rc has been far enough up course c that
// crossing its finish means it missed a mark, not that it dipped back
// over its start line: half way up its first leg, at least.
func upCourse(c *bus.RaceCourse, rc *bus.Racer) bool {
	if rc.Next < 1 || rc.LeastAt == 0 {
		return false
	}
	return rc.Least <= c.Length-float64(0.5*c.Checks[1].Along)
}

// firstMark is the index of a course's first rounding.
func firstMark(c *bus.RaceCourse) int16 {
	for k := 1; k < len(c.Checks); k++ {
		if c.Checks[k].Mark > 0 {
			return int16(k)
		}
	}
	return 0
}

// finish finishes racer rc of race r at this tick: its place among those
// home so far, its gun, and the finishing window opened by the first.
func finish(f *bus.Frame, r *bus.Race, rc *bus.Racer) {
	rc.State, rc.Home = bus.RacerFinished, f.Tick
	mine := corrected(r, rc)
	place := int16(1)
	lo, hi := racersOf(f, r.Key)
	for j := lo; j < hi; j++ {
		o := &f.Racers[j]
		if o != rc && o.State == bus.RacerFinished && corrected(r, o) < mine {
			place++
		}
	}
	if r.Home == 0 {
		r.Home = f.Tick
		r.Closes = f.Tick + max(elapsed(r, rc)/2, Window)
	}
	event(f, bus.RaceEvent{Race: r.Key, Kind: bus.RaceSignalled, Signal: bus.SignalFinish, Gun: true, Number: rc.Number, Place: place})
	event(f, bus.RaceEvent{Race: r.Key, Kind: bus.RaceFinished, Number: rc.Number, Place: place, Added: float64(rc.Added) / Second})
}

// elapsed is racer rc's time from its start to its finish, ticks.
func elapsed(r *bus.Race, rc *bus.Racer) int64 {
	if r.Trial {
		return rc.Home - rc.Crossed
	}
	return rc.Home - r.Start
}

// corrected is racer rc's time with the seconds added, ticks.
func corrected(r *bus.Race, rc *bus.Racer) int64 { return elapsed(r, rc) + rc.Added }

// Elapsed is a finished racer's time from the start, s, the seconds added
// not counted; 0 for one not home.
func Elapsed(r *bus.Race, rc *bus.Racer) float64 {
	if rc.Home == 0 {
		return 0
	}
	return float64(elapsed(r, rc)) / Second
}

// progress reads racer rc's progress at (x, y), once a second: its way to
// go, and whether it has made none for long enough to be asked whether it
// still races, or to retire for want of an answer.
func progress(f *bus.Frame, r *bus.Race, rc *bus.Racer, x, y float64) {
	rc.ToGo = toGo(r.Course, rc.Next, x, y)
	if rc.State != bus.RacerRacing || r.Start == 0 || f.Tick < r.Start {
		return
	}
	switch {
	case rc.LeastAt == 0 || rc.ToGo < rc.Least-DriftGain:
		rc.Least, rc.LeastAt, rc.Asked = rc.ToGo, f.Tick, 0
	case rc.Asked == 0 && f.Tick-rc.LeastAt >= DriftAfter:
		rc.Asked = f.Tick
		event(f, bus.RaceEvent{Race: r.Key, Kind: bus.RaceDrifting, Number: rc.Number})
	case rc.Asked != 0 && f.Tick-rc.Asked >= DriftAnswer:
		retire(f, r, rc)
	}
}

// toGo is how far a boat at (x, y) whose next check is next has to go,
// m: straight to that check's point of the way, then along the way.
func toGo(c *bus.RaceCourse, next int16, x, y float64) float64 {
	ch := &c.Checks[min(int(next), len(c.Checks)-1)]
	return hypot(x-ch.AtX, y-ch.AtY) + max(c.Length-ch.Along, 0)
}

// retire retires racer rc of race r.
func retire(f *bus.Frame, r *bus.Race, rc *bus.Racer) {
	rc.State = bus.RacerRetired
	event(f, bus.RaceEvent{Race: r.Key, Kind: bus.RaceRetired, Number: rc.Number})
}

// Retire retires account's boat from the race it sails in, at its
// skipper's word: false if it sails in none.
func Retire(f *bus.Frame, account bus.Account) bool {
	j := RacerOf(f, account)
	if j < 0 {
		return false
	}
	rc := &f.Racers[j]
	i := raceOf(f, rc.Race)
	if i < 0 {
		return false
	}
	retire(f, &f.Races[i], rc)
	return true
}

// Drop lets the race of id and run go from f once it has ended: false if
// f has no such race ended.
func Drop(f *bus.Frame, id [16]byte, run int32) bool {
	for i := range f.Races {
		r := &f.Races[i]
		if r.ID != id || r.Run != run || r.Phase != bus.RaceEnded {
			continue
		}
		lo, hi := racersOf(f, r.Key)
		f.Racers = slices.Delete(f.Racers, lo, hi)
		f.Races = slices.Delete(f.Races, i, i+1)
		return true
	}
	return false
}

// calls calls this tick's bumps between two boats of one race, from its
// preparatory signal on, with a boat at fault.
func calls(f *bus.Frame) {
	for b := range f.Bumps {
		bp := &f.Bumps[b]
		if bp.Tick != f.Tick || bp.Fault == physics.Neither {
			continue
		}
		a, o := racerIn(f, bp.A, bp.BoatA), racerIn(f, bp.B, bp.BoatB)
		if a < 0 || o < 0 || f.Racers[a].Race != f.Racers[o].Race {
			continue
		}
		i := raceOf(f, f.Racers[a].Race)
		if i < 0 {
			continue
		}
		r := &f.Races[i]
		if r.Trial || r.Phase < bus.RacePreparatory || r.Phase == bus.RaceEnded {
			continue
		}
		at, other := &f.Racers[a], &f.Racers[o]
		if bp.Fault == physics.Second {
			at, other = other, at
		}
		at.Added += Penalty
		event(f, bus.RaceEvent{Race: r.Key, Kind: bus.RaceCalled, Number: at.Number, Other: other.Number, Article: bp.Article,
			Added: Penalty / Second})
	}
}

// racerIn is the index in f.Racers of the boat in slot s, boat, placed or
// racing, or −1.
func racerIn(f *bus.Frame, s int32, boat uint64) int {
	for j := range f.Racers {
		rc := &f.Racers[j]
		if rc.Slot == s && rc.Boat == boat && (rc.State == bus.RacerPlaced || rc.State == bus.RacerRacing) {
			return j
		}
	}
	return -1
}

// ends reports whether race r, its boats f.Racers[lo:hi], ends this tick.
func ends(f *bus.Frame, r *bus.Race, lo, hi int) bool {
	active := false
	for j := lo; j < hi; j++ {
		if s := f.Racers[j].State; s == bus.RacerPlaced || s == bus.RacerRacing {
			active = true
			break
		}
	}
	tick := f.Tick
	switch {
	case !active:
		return true
	case r.Trial && r.Start == 0:
		if tick-r.Warning >= TrialWait {
			for j := lo; j < hi; j++ {
				if f.Racers[j].State == bus.RacerPlaced {
					retire(f, r, &f.Racers[j])
				}
			}
			return true
		}
		return false
	case r.Start == 0 || tick < r.Start:
		return false
	case r.Home != 0:
		return tick >= r.Closes
	}
	return tick >= r.Start+limit(r)
}

// limit is race r's time limit from its start, ticks: twice its course's
// expected time.
func limit(r *bus.Race) int64 {
	return int64(toInt32(math.Ceil(float64(2*r.Course.Expected) * Second)))
}

// end ends f.Races[i]: everyone placed, its medal or its awards given.
func end(f *bus.Frame, i int) {
	r := &f.Races[i]
	r.Phase, r.Ended = bus.RaceEnded, f.Tick
	lo, hi := racersOf(f, r.Key)
	for j := lo; j < hi; j++ {
		if s := f.Racers[j].State; s == bus.RacerPlaced || s == bus.RacerRacing {
			f.Racers[j].State = bus.RacerPlacedAtEnd
		}
	}
	order := Standings(f, r.Key)
	place := int16(0)
	for _, j := range order {
		rc := &f.Racers[j]
		if rc.State == bus.RacerFinished || rc.State == bus.RacerPlacedAtEnd {
			place++
			rc.Place = place
		}
		if r.Trial && rc.State == bus.RacerFinished {
			rc.Medal = Medal(float64(corrected(r, rc))/Second, r.Course.Expected)
		}
	}
	if r.Prizes {
		award(f, r, order)
	}
	event(f, bus.RaceEvent{Race: r.Key, Kind: bus.RaceOver, Number: place})
}

// Standings are race key's boats in f, by place as it stands: those home
// by their time with the seconds added; then those racing, or placed at
// the end, by the checks passed and the way to go; then the rest. They are
// indices into f.Racers.
func Standings(f *bus.Frame, key uint32) []int {
	i := raceOf(f, key)
	lo, hi := racersOf(f, key)
	out := make([]int, 0, hi-lo)
	for j := lo; j < hi; j++ {
		out = append(out, j)
	}
	if i < 0 {
		return out
	}
	r := &f.Races[i]
	rank := func(s uint8) int {
		switch s {
		case bus.RacerFinished:
			return 0
		case bus.RacerRacing, bus.RacerPlacedAtEnd, bus.RacerPlaced:
			return 1
		case bus.RacerRetired:
			return 2
		}
		return 3
	}
	slices.SortStableFunc(out, func(x, y int) int {
		a, b := &f.Racers[x], &f.Racers[y]
		if ra, rb := rank(a.State), rank(b.State); ra != rb {
			return ra - rb
		}
		switch rank(a.State) {
		case 0:
			if ca, cb := corrected(r, a), corrected(r, b); ca != cb {
				if ca < cb {
					return -1
				}
				return 1
			}
		case 1:
			if a.Next != b.Next {
				return int(b.Next) - int(a.Next)
			}
			if a.ToGo != b.ToGo {
				if a.ToGo < b.ToGo {
					return -1
				}
				return 1
			}
		}
		return int(a.Number) - int(b.Number)
	})
	return out
}

// Gap is racer rc's gap to the first, lead, in race r, s: their times'
// with the seconds added for two boats home; else the way between them at
// the course's own speed, its length over its expected time.
func Gap(r *bus.Race, lead, rc *bus.Racer) float64 {
	if rc == lead {
		return 0
	}
	if rc.State == bus.RacerFinished && lead.State == bus.RacerFinished {
		return max(float64(rc.Home-lead.Home+rc.Added-lead.Added)/Second, 0)
	}
	speed := 1.0
	if c := r.Course; c != nil && c.Expected > 0 {
		speed = max(float64(c.Length/c.Expected), 0.1)
	}
	ahead := lead.ToGo
	if lead.State == bus.RacerFinished {
		ahead = 0
	}
	return max(float64((rc.ToGo-ahead)/speed), 0)
}

// Medal is a trial's run's medal for a time of secs against a par of par,
// s: 0 for none.
func Medal(secs, par float64) uint8 {
	switch {
	case !(par > 0):
		return 0
	case secs <= float64(par*HarbourmasterPar):
		return bus.MedalHarbourmaster
	case secs <= float64(par*GoldPar):
		return bus.MedalGold
	case secs <= float64(par*SilverPar):
		return bus.MedalSilver
	case secs <= float64(par*BronzePar):
		return bus.MedalBronze
	}
	return 0
}

// The medals' times, as shares of par.
const (
	BronzePar        = 1.5
	SilverPar        = 1.2
	GoldPar          = 1.0
	HarbourmasterPar = 0.9
)
