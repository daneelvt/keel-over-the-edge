// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"fmt"
	"math"
	"sync"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Waiting and waking. observe with a wait holds its call until something
// its boat's sailor would notice happens, or the wait's seconds pass: one
// call stands in for the agent's eyes while its boat sails on its held
// orders. A machine sailor waits once at a time: a second wait ends the
// first, "superseded". The call's own stream closing ends it too, and
// nothing is lost: the next report tells everything since the last one
// answered.

// The words of wake_on.
const (
	wakeGust      = "gust"
	wakeBoat      = "boat"
	wakeLand      = "land"
	wakeSighting  = "sighting"
	wakeHeel      = "heel"
	wakeWindShift = "wind_shift"
	wakeBearing   = "bearing"
	wakeNear      = "near"
	wakeChat      = "chat"
	wakeRace      = "race"
	wakePilot     = "pilot"
)

// wakeWords lists wake_on's words, in their order.
var wakeWords = []string{wakeGust, wakeBoat, wakeLand, wakeSighting, wakeHeel, wakeWindShift, wakeBearing, wakeNear, wakeChat, wakeRace, wakePilot}

// wakeDefault are what a wait wakes on when wake_on is not given: all but
// those that need a value.
var wakeDefault = []string{wakeGust, wakeBoat, wakeLand, wakeSighting, wakeChat, wakeRace, wakePilot}

// The limits of a wait.
const (
	MaxWait = 50 * time.Second
	// SafeWait is the wait every app is known to hold a call for.
	SafeWait = 25 * time.Second
	// progressEvery is how often a waiting call tells a client that asked
	// for progress that it is still waiting.
	progressEvery = 10 * time.Second
)

// gustEvery is how many of the hub's looks apart a wait looks for gusts:
// twice a second.
const gustEvery = 5

// landAhead is how far ahead the ground is watched for, in seconds at the
// boat's speed, and the depth under which water counts as shoal, m; a
// boat in shoal water as its wait began is woken when the water under it
// shoals by shoalFall more, m.
const (
	landAhead = 60.0
	shoal     = 1.5
	shoalFall = 0.5
	// closeBy is the range within which a boat closing on a steady
	// bearing wakes a wait, m; steadyDrift the most its bearing may drift
	// over driftWindow and still be steady.
	closeBy     = 500.0
	steadyDrift = 2 * math.Pi / 180
	driftWindow = 5 * time.Second
)

// waiter is a call waiting.
type waiter struct {
	since time.Time
	on    map[string]bool
	// The values its wakes need: the heel and the wind's turn that wake
	// it, rad; a charted place, its bearing, rad, and how near it, m.
	heelOver, shiftOver float64
	place               *placeOf
	bearing             float64
	near                float64

	// What the wait began with, the hub's: the mean wind's direction; the
	// boats in sight, the subjects in sight, and the side of the place's
	// bearing.
	started   bool
	windFrom  float64
	boats     map[uint64]bool
	sighted   map[int32]bool
	bearingOn float64
	// bearings are each boat's bearings since the wait began, for a
	// steady one.
	tracks map[uint64]*track
	// The overlays: the boats the right-of-way overlay has marked, and
	// whether it has been looked at; whether the gust ring has been looked
	// at, and whether a gust coming soon would be news.
	marked                map[uint64]bool
	markedLooked          bool
	gustLooked, gustArmed bool
	landLooked, landArmed bool
	// depth is the water under the boat as the wait began, m.
	depth float64

	done chan string
	once sync.Once
}

// placeOf is a charted place a wait watches: its name and where it is.
type placeOf struct {
	name string
	x, y float64
}

// track is a boat's bearing and range at a look, and some seconds before.
type track struct {
	at, oldAt time.Time
	b, oldB   float64
	r, oldR   float64
}

func newWaiter(now time.Time, on []string) *waiter {
	w := &waiter{since: now, on: map[string]bool{}, done: make(chan string, 1), boats: map[uint64]bool{}, sighted: map[int32]bool{},
		tracks: map[uint64]*track{}, marked: map[uint64]bool{}}
	for _, o := range on {
		w.on[o] = true
	}
	return w
}

// wake ends the wait, for why; only its first wake counts.
func (w *waiter) wake(why string) {
	w.once.Do(func() { w.done <- why })
}

// wait registers a wait for the helm, ending any it had: superseded.
func (h *helm) wait(w *waiter) {
	h.mu.Lock()
	old := h.waiter
	h.waiter = w
	h.mu.Unlock()
	if old != nil {
		old.wake(wokeSuperseded)
	}
}

// unwait forgets the wait w, if it is still the helm's.
func (h *helm) unwait(w *waiter) {
	h.mu.Lock()
	if h.waiter == w {
		h.waiter = nil
	}
	h.mu.Unlock()
}

// What ends a wait other than a wake.
const (
	wokeTime       = "time"
	wokeSuperseded = "superseded"
	wokeCut        = "cut"
	wokeShutdown   = "shutdown"
	// wokeEnded: the game's operator stopped the machine sailor, or
	// revoked its grants, or it was deleted.
	wokeEnded = "ended"
)

// look is the hub's look at the helm's boat in f: its wind's readout, its
// autopilot's turns, and whatever its wait watches for.
func (h *helm) look(s *Sea, f *bus.Frame, sight bool) {
	h.mu.Lock()
	if h.sea != s || h.boat == 0 || !f.Occupied[h.slot] || f.Boat[h.slot] != h.boat {
		h.mu.Unlock()
		return
	}
	sl := h.slot
	in := &f.Instruments[sl]
	h.readout.Add(float64(f.Tick)*1000/physics.StepsPerSecond, float64(in.WindSpeed), float64(in.WindFrom))
	turned := h.turnDone(f, sl)
	w := h.waiter
	why := ""
	if w != nil {
		why = h.watch(s, f, sl, w, sight)
	}
	h.mu.Unlock()
	switch turned {
	case WayTackDone:
		h.event(event{Tick: f.Tick, Kind: evTurned, Words: "the autopilot finished its tack"})
	case WayGybeDone:
		h.event(event{Tick: f.Tick, Kind: evTurned, Words: "the autopilot finished its gybe"})
	case WayTackStalled, WayGybeStalled:
		turn := "tack"
		if turned == WayGybeStalled {
			turn = "gybe"
		}
		left := f.State[sl].PilotLeft
		h.event(event{Tick: f.Tick, Kind: evStalled, Words: fmt.Sprintf(
			"the autopilot's %s stalled with no steerage: it holds wind %d° %s again; bear away to gather way, then order the %s again",
			turn, degrees(math.Abs(left)), side(left), turn)})
	}
	if why != "" {
		w.wake(why)
	}
}

// The autopilot's turns, as the hub sees them end: finished, or stalled.
const (
	WayTackDone    = 1
	WayGybeDone    = 2
	WayTackStalled = 3
	WayGybeStalled = 4
)

// turnDone reports a tack or a gybe the autopilot has finished or given up
// since the last look: its turn was under way, and is over. With mu held.
func (h *helm) turnDone(f *bus.Frame, sl int32) int {
	way := uint8(f.State[sl].PilotWay)
	was := h.turning
	h.turning = way
	if was != physics.WayTack && was != physics.WayGybe || f.Pilot[sl].Mode() == bus.PilotOff {
		return 0
	}
	switch way {
	case physics.WayHold:
		if was == physics.WayGybe {
			return WayGybeDone
		}
		return WayTackDone
	case physics.WayTackStalled:
		return WayTackStalled
	case physics.WayGybeStalled:
		return WayGybeStalled
	}
	return 0
}

// watch is why the wait w wakes at this look, or "". With mu held.
func (h *helm) watch(s *Sea, f *bus.Frame, sl int32, w *waiter, sight bool) string {
	st := &f.State[sl]
	now := time.Now()
	if !w.started {
		w.started = true
		w.windFrom = f.Wind[sl].MeanFrom
		for _, c := range h.inSight(s, f, sl) {
			w.boats[f.Boat[c.slot]] = true
		}
		if w.place != nil {
			w.bearingOn = wrap(physics.Atan2(w.place.x-st.X, w.place.y-st.Y) - w.bearing)
		}
		if sight {
			for _, sub := range h.subjectsInSight(s, f, sl) {
				w.sighted[sub] = true
			}
		} else {
			w.sighted = nil
		}
		return ""
	}
	if w.on[wakeHeel] && w.heelOver > 0 && math.Abs(st.Heel) >= w.heelOver {
		return wakeHeel
	}
	if w.on[wakeWindShift] && w.shiftOver > 0 && math.Abs(wrap(f.Wind[sl].MeanFrom-w.windFrom)) >= w.shiftOver {
		return wakeWindShift
	}
	if p := w.place; p != nil {
		dx, dy := p.x-st.X, p.y-st.Y
		if w.on[wakeNear] && w.near > 0 && dx*dx+dy*dy <= w.near*w.near {
			return wakeNear
		}
		if w.on[wakeBearing] {
			off := wrap(physics.Atan2(dx, dy) - w.bearing)
			// The bearing reached: its side of the one asked for has
			// changed, near it rather than across the compass.
			if off == 0 || math.Signbit(off) != math.Signbit(w.bearingOn) && math.Abs(off) < math.Pi/2 {
				return wakeBearing
			}
			w.bearingOn = off
		}
	}
	if w.on[wakeBoat] {
		if why := h.boatsWatch(s, f, sl, w, now); why != "" {
			return why
		}
	}
	if w.on[wakeLand] {
		// Land ahead as the wait began is no news: it wakes once the boat
		// has had clear water ahead, along its heading and its track. So is
		// shoal water under it: it wakes as the water shoals through
		// shoal, or by shoalFall more for a boat in shoal water already.
		in := &f.Instruments[sl]
		depth := float64(in.Depth)
		ahead := landAheadOf(s, st, float64(in.SpeedOverGround), float64(in.CourseOverGround))
		switch {
		case !w.landLooked:
			w.landLooked, w.landArmed, w.depth = true, ahead == "", depth
		case depth < shoal && (w.depth >= shoal || depth <= w.depth-shoalFall):
			return "shoal water under you, " + fmt.Sprintf("%.1f m", max(depth, 0))
		case ahead == "":
			w.landArmed = true
		case w.landArmed:
			return ahead
		}
	}
	if w.on[wakeSighting] && sight {
		subs := h.subjectsInSight(s, f, sl)
		if w.sighted == nil {
			w.sighted = map[int32]bool{}
			for _, sub := range subs {
				w.sighted[sub] = true
			}
		} else {
			for _, sub := range subs {
				if !w.sighted[sub] {
					return wakeSighting
				}
			}
		}
	}
	// The gust ring is the dearest look, so a wait looks for gusts every
	// gustEvery-th look, each helm on its own: a patch is rung up to a
	// minute ahead, and a wake half a second later changes nothing seen.
	if w.on[wakeGust] && (f.Tick/checkEvery+int64(h.conn))%gustEvery == 0 {
		// A gust coming when the wait began is no news: the wait wakes
		// for the next.
		switch soon := h.gustComing(s, f, sl); {
		case !w.gustLooked:
			w.gustLooked, w.gustArmed = true, !soon
		case !soon:
			w.gustArmed = true
		case w.gustArmed:
			return wakeGust
		}
	}
	return ""
}

// boatsWatch wakes for a boat come into sight, or one within closeBy
// closing on a steady bearing to pass close within a minute: a collision
// course, as a lookout judges one (COLREG Rule 7: risk "shall be deemed to
// exist if the compass bearing of an approaching vessel does not
// appreciably change"); or one the right-of-way overlay would show.
func (h *helm) boatsWatch(s *Sea, f *bus.Frame, sl int32, w *waiter, now time.Time) string {
	st := &f.State[sl]
	seen := h.inSight(s, f, sl)
	for _, c := range seen {
		boat := f.Boat[c.slot]
		if !w.boats[boat] {
			w.boats[boat] = true
			return wakeBoat
		}
		o := &f.State[c.slot]
		dx, dy := o.X-st.X, o.Y-st.Y
		r := math.Sqrt(dx*dx + dy*dy)
		b := physics.Atan2(dx, dy)
		t := w.tracks[boat]
		if t == nil {
			w.tracks[boat] = &track{at: now, oldAt: now, b: b, oldB: b, r: r, oldR: r}
			continue
		}
		if now.Sub(t.oldAt) > driftWindow {
			t.oldAt, t.oldB, t.oldR = t.at, t.b, t.r
		}
		t.at, t.b, t.r = now, b, r
		if dt := now.Sub(t.oldAt).Seconds(); r < closeBy && dt >= driftWindow.Seconds()/2 && r < t.oldR-1 && math.Abs(wrap(b-t.oldB)) < steadyDrift &&
			collision(t.oldB, t.oldR, b, r, dt) {
			return wakeBoat
		}
	}
	// The overlay judges a few times a second, as the phone's does; a
	// boat it marked as the wait began is no news.
	if (f.Tick/checkEvery+int64(h.conn))%2 == 0 {
		news := false
		for _, b := range h.rightOfWayMarked(s, f, sl, seen) {
			if !w.marked[b] {
				w.marked[b] = true
				news = news || w.markedLooked
			}
		}
		w.markedLooked = true
		if news {
			return wakeBoat
		}
	}
	return ""
}

// The collision course a lookout judges, from a boat's bearing and range
// some seconds apart: it will pass within passWithin of the boat within
// passBefore.
const (
	passWithin = 25.0
	passBefore = 60.0
)

// collision reports whether a boat seen at bearing b0 and range r0, then
// dt s later at b1 and r1, holds on to pass within passWithin before
// passBefore, by its motion over them.
func collision(b0, r0, b1, r1, dt float64) bool {
	s0, c0 := physics.SinCos(b0)
	s1, c1 := physics.SinCos(b1)
	x, y := r1*s1, r1*c1
	vx, vy := (x-r0*s0)/dt, (y-r0*c0)/dt
	v2 := vx*vx + vy*vy
	if v2 < 0.01 {
		return false
	}
	t := -(x*vx + y*vy) / v2
	if t <= 0 || t > passBefore {
		return false
	}
	px, py := x+vx*t, y+vy*t
	return px*px+py*py < passWithin*passWithin
}

// landAheadOf is the land or shoal water ahead within landAhead seconds
// at the boat's speed, along its heading and along its track, course over
// ground, as the bed's colour shows it on the phone: "shoal water 080° ~30
// m", the nearest found; "" for none.
func landAheadOf(s *Sea, st *physics.State, speed, course float64) string {
	if s.Ground == nil {
		return ""
	}
	reach := max(speed*landAhead, 30)
	best, word, at := math.Inf(1), "", 0.0
	for _, way := range [...]float64{st.Heading, course} {
		sin, cos := physics.SinCos(way)
		for _, k := range [...]float64{0.25, 0.5, 0.75, 1} {
			r := reach * k
			e, _ := s.Ground.At(st.X+sin*r, st.Y+cos*r)
			if e > -shoal {
				if r < best {
					best, at, word = r, way, "shoal water"
					if e > 0 {
						word = "land"
					}
				}
				break
			}
		}
	}
	if word == "" {
		return ""
	}
	return word + " " + three(bearing5(at)) + " " + rangeWords(best)
}
