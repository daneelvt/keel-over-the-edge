// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"fmt"
	"math"
	"os"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/race/committee"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// Careful runs: a plain, careful sailor sails each of the Harbourmaster's
// courses through the machine sailors' tools, and the run is told as a
// multiple of the course's expected time, the polar's sailed perfectly.
// It is what the certificates' medals are held against: a medal a careful
// run does not reach with time to spare is not one to ask early.
//
// The sailor knows what the handbook says and little more. She steers by
// the autopilot: straight at the next point of the course where the boat
// can lie it; close-hauled, 45° off the wind, where it is up the wind,
// tacking once the point is laid on the other tack; ten degrees off a
// dead run where it is straight down the wind, gybing the same way. She
// leaves each mark two lengths clear, and sails an island course by its
// way's own points. Placed at rest under a line across the wind, she
// runs off ten lengths first and comes back at it close-hauled with way
// on. She trims to the handbook's table for the angle and the wind,
// eased to its word for a breeze, and reefs where it says to; coming up
// from a run she comes up a little at a time, the sheet coming in with
// the boat; stopped head to wind, she bears away with the sheet eased
// and gathers way. She looks once a second. The wind is steady: no
// gusts, no shifts.
//
// One run is always sailed, the first certificate's own, in open water:
// the rest are sailed in seed 1's world, and their tables printed, with
// KEEL_CAREFUL_RUNS=1. KEEL_CAREFUL_ONLY="the Reach,Jolly boat,12" sails
// one, and KEEL_CAREFUL_TRACE=1 says where the boat is at every look.

// carefulBoat is what the careful sailor knows of a boat: the handbook's
// fastest boom by angle off the wind in 6, 12 and 20 knots, the wind she
// reefs from, knots, the reef she takes then (0 for 1), and how near the
// wind she sails close-hauled, degrees.
type carefulBoat struct {
	boom     [7][3]float64
	reefFrom float64
	reef     int
	close    float64
}

// carefulAngles are the angles off the wind of a carefulBoat's booms.
var carefulAngles = [7]float64{40, 60, 90, 120, 150, 170, 180}

// carefulWinds are their winds, knots.
var carefulWinds = [3]float64{6, 12, 20}

// The handbook's tables (handbook/trim.md), by the boats' names.
var carefulBoats = map[string]carefulBoat{
	"Jolly boat": {boom: [7][3]float64{{4, 4, 5}, {4, 10, 15}, {20, 25, 30}, {45, 50, 50}, {75, 80, 70}, {80, 80, 80}, {85, 85, 85}}, reefFrom: 19, close: 45},
	"Yacht":      {boom: [7][3]float64{{4, 4, 4}, {4, 5, 10}, {25, 25, 30}, {45, 50, 50}, {75, 75, 65}, {75, 75, 75}, {75, 75, 75}}, reefFrom: 30, close: 45},
	"Keelboat":   {boom: [7][3]float64{{4, 4, 10}, {4, 15, 20}, {20, 30, 30}, {45, 50, 55}, {75, 80, 65}, {80, 80, 80}, {80, 80, 80}}, reefFrom: 13, close: 45},
	"Skiff":      {boom: [7][3]float64{{4, 4, 10}, {4, 10, 20}, {15, 15, 35}, {20, 25, 45}, {65, 70, 65}, {75, 75, 75}, {75, 75, 75}}, reefFrom: 13, reef: 2, close: 45},
}

// boomFor is the boom for an angle off the wind, degrees, in a wind of
// knots: the table's, between its entries.
func (b *carefulBoat) boomFor(angle, knots float64) float64 {
	lerp := func(xs []float64, x float64) (int, float64) {
		for i := 1; i < len(xs); i++ {
			if x <= xs[i] {
				return i - 1, min(max((x-xs[i-1])/(xs[i]-xs[i-1]), 0), 1)
			}
		}
		return len(xs) - 2, 1
	}
	i, t := lerp(carefulAngles[:], angle)
	j, u := lerp(carefulWinds[:], knots)
	at := func(i int) float64 { return b.boom[i][j] + u*(b.boom[i][j+1]-b.boom[i][j]) }
	return at(i) + t*(at(i+1)-at(i))
}

// carefulRun is what a careful run came to.
type carefulRun struct {
	finished          bool
	elapsed, expected float64
	medal             uint8
	capsizes          int
}

func (r carefulRun) multiple() float64 { return r.elapsed / r.expected }

// medalWord is a medal in a word.
func medalWord(m uint8) string {
	return [...]string{"none", "bronze", "silver", "gold", "harbourmaster's"}[min(int(m), 4)]
}

// carefulSailor sails one boat by the tools.
type carefulSailor struct {
	t     *testing.T
	h     *harness
	a     *oauth.Accepted
	boat  carefulBoat
	knots float64
	from  float64 // rad
	// last is the order she holds, as it was sent.
	last    string
	beating int // the side of the tack she beats on, 1 port, −1 starboard, 0 for none
	running int // and the side she runs on
	// gather is how many looks she still gathers way for, bearing away on
	// gatherSide with the sheet eased once.
	gather     int
	gatherSide int
	eased      bool
	// lead is how far ahead of the boat an order to come up is given,
	// degrees; ease the most boom she gets under way with in a breeze.
	lead  float64
	ease  float64
	trace bool
}

// state is the sailor's boat's state, its racer and its race in the
// newest frame.
func (cs *carefulSailor) state() (st physics.State, rc bus.Racer, r bus.Race, ok bool) {
	f := cs.h.w.Bus().Frames.Acquire()
	defer f.Release()
	for _, s := range f.Live {
		if f.Owner[s] == bus.Account(cs.a.Account) {
			st, ok = f.State[s], true
		}
	}
	for i := range f.Racers {
		if f.Racers[i].Account == bus.Account(cs.a.Account) {
			rc = f.Racers[i]
			for j := range f.Races {
				if f.Races[j].Key == rc.Race {
					r = f.Races[j]
				}
			}
		}
	}
	return st, rc, r, ok
}

// rad is degrees in radians.
func radOf(d float64) float64 { return d * math.Pi / 180 }

// wrapPi is an angle in [−π, π).
func wrapPi(a float64) float64 {
	return math.Mod(math.Mod(a+math.Pi, 2*math.Pi)+2*math.Pi, 2*math.Pi) - math.Pi
}

// toward orders the boat at st toward (x, y), as the careful sailor
// does.
func (cs *carefulSailor) toward(st *physics.State, x, y float64) {
	b := math.Atan2(x-st.X, y-st.Y)
	// off is where the point lies off the wind's eye: positive to its
	// right, looking up the wind, and so is over, the side the wind comes
	// over now: a boat heading to the right of the wind's eye has it over
	// her port side.
	off := wrapPi(b - cs.from)
	over := wrapPi(st.Heading - cs.from)
	now := 1
	if over < 0 {
		now = -1
	}
	closeHauled, run := radOf(cs.boat.close), radOf(170)
	const lay = 5 * math.Pi / 180
	args := map[string]any{}
	angle := math.Abs(off)
	want := 1
	if off < 0 {
		want = -1
	}
	switch {
	case cs.beating != 0 && angle < closeHauled+lay && want == cs.beating, cs.beating == 0 && angle < closeHauled:
		// A beat: close-hauled on the tack nearer the point, until it is
		// well laid on the other.
		if cs.beating == 0 {
			cs.beating = want
		}
		cs.running = 0
	case cs.beating != 0 && angle < closeHauled+lay:
		// Not yet laid on the other tack: stand on.
	case cs.beating != 0 && want != cs.beating && angle < radOf(100):
		// Laid on the other tack: tack, and steer for it.
		cs.beating, cs.running = 0, 0
	case cs.running != 0 && angle > run-lay && want == cs.running, cs.running == 0 && angle > run:
		// Straight down the wind: ten degrees off a dead run, on the side
		// she is on, until the point is well laid on the other.
		if cs.running == 0 {
			cs.running = now
		}
		cs.beating = 0
	case cs.running != 0 && angle > run-lay:
	default:
		cs.beating, cs.running = 0, 0
	}
	switch {
	case cs.beating != 0:
		angle = closeHauled
		args["wind_angle"], args["side"], args["via"] = int(math.Round(cs.boat.close)), sideWord(cs.beating), "tack"
		want = cs.beating
	case cs.running != 0:
		angle = run
		args["wind_angle"], args["side"], args["via"] = 170, sideWord(cs.running), "gybe"
		want = cs.running
	default:
		args["heading"] = (int(math.Round(b*180/math.Pi)) + 360) % 360
		// The short way round: through the wind if its eye lies on it.
		turn, eye := wrapPi(b-st.Heading), wrapPi(cs.from-st.Heading)
		args["via"] = "gybe"
		if (turn > 0) == (eye > 0) && math.Abs(eye) < math.Abs(turn) {
			args["via"] = "tack"
		}
	}
	// The handbook's light air: with no way on, a turn through the wind
	// stalls. Head to wind and stopped, or about to tack too slow, she
	// bears away on the side she is on and gathers way first.
	slow := st.Surge < 0.3*cs.knots*physics.Knot*0.5
	inIrons := math.Abs(over) < radOf(35) && st.Surge < 0.5
	if cs.gather == 0 && inIrons {
		cs.gather, cs.gatherSide = 15, now
	}
	if cs.gather == 1 && (st.Surge < 1 || math.Abs(over) < radOf(60)) {
		// Not sailing yet: the same order stands.
		cs.gather = 2
	}
	if cs.gather == 0 && want != now && args["via"] == "tack" && slow && math.Abs(over) > radOf(35) {
		cs.gather, cs.gatherSide = 5, now
	}
	if cs.gather > 0 {
		cs.gather--
		angle = radOf(80)
		args = map[string]any{"wind_angle": 80, "side": sideWord(cs.gatherSide), "via": "auto"}
		cs.eased = true
	}
	// Coming up a long way, from a run or a broad reach toward
	// close-hauled, she comes up a little at a time: put straight up, a
	// heavy boat carries her way through the wind's eye and stops.
	if lies := math.Abs(over); cs.gather == 0 && want == now && !inIrons && lies-angle > radOf(30) {
		step := math.Round((lies*180/math.Pi-cs.lead)/5) * 5
		angle = radOf(step)
		args = map[string]any{"wind_angle": int(step), "side": sideWord(now), "via": "auto"}
	}
	// She trims to the wind she has: coming up, the sheet comes in as
	// the boat does, not before; bearing away it is eased first.
	if lies := math.Abs(over); cs.gather == 0 && !inIrons && want == now && lies > angle {
		angle = lies
	}
	boom := cs.boat.boomFor(angle*180/math.Pi, cs.knots)
	reef := 0
	if cs.knots >= cs.boat.reefFrom {
		// The handbook's breeze: reefed, no tighter than 18° close-hauled
		// and about 40° reaching.
		reef = max(cs.boat.reef, 1)
		boom = max(boom, 18+(40-18)*min(max((angle*180/math.Pi-45)/45, 0), 1))
	}
	if cs.eased {
		// Bearing away with no way on: the sheet well eased, or the sail
		// holds her bow up.
		boom, cs.eased = max(boom, 50), false
	}
	if st.Surge < 2 && cs.knots >= cs.boat.reefFrom && angle > radOf(60) {
		// Getting under way in a breeze, across the wind: the sheet no
		// further out than a close reach's until she moves. Eased as far
		// as a reach at speed asks, the sail gives her no way, and she
		// turns up into the wind and lies there.
		boom = min(boom, cs.ease)
	}
	args["boom"], args["reef"] = int(math.Round(boom)), reef
	order := fmt.Sprint(args)
	if order == cs.last {
		// A look, as a sailor looks: it also keeps the boat at sea.
		cs.h.call(cs.t, cs.a, "observe", map[string]any{"detail": "brief"})
		return
	}
	if text, refused := cs.h.call(cs.t, cs.a, "steer", args); refused {
		cs.t.Logf("steer %v refused: %s", args, text)
		return
	}
	cs.last = order
}

// sideWord is the side the wind comes over: 1 port, −1 starboard.
func sideWord(side int) string {
	if side > 0 {
		return "port"
	}
	return "starboard"
}

// points are where the careful sailor steers for to pass check k of
// course c, in order, in a boat of length l: over a line by its middle
// and on; round a mark two lengths clear, on its side.
func carefulPoints(c *bus.RaceCourse, k int, l float64) [][2]float64 {
	ch := &c.Checks[k]
	clear := max(2*l, 10)
	if ch.Line {
		mx, my := (ch.X+ch.X2)/2, (ch.Y+ch.Y2)/2
		dx, dy := ch.X2-ch.X, ch.Y2-ch.Y
		d := math.Hypot(dx, dy)
		// Crossed from its left to its right (Want 1), looking from its
		// first end to its second: toward (dy, −dx).
		nx, ny := dy/d*float64(ch.Want), -dx/d*float64(ch.Want)
		pts := [][2]float64{{mx, my}, {mx + 3*clear*nx, my + 3*clear*ny}}
		if k == 0 && !c.Across {
			// A start up the wind: she is placed at rest three lengths
			// under the line, and runs off first, to come back at it
			// close-hauled with way on, between its ends.
			pts = append([][2]float64{{mx - 10*l*nx, my - 10*l*ny}}, pts...)
		}
		return pts
	}
	// A ray toward (S, C) crossed anticlockwise about its start (Want
	// −1): past the mark on the ray's right, across it, and back.
	rx, ry := ch.C*-float64(ch.Want), -ch.S*-float64(ch.Want)
	if c.Dash {
		// A Dash's mark, its ray on along the way out: she passes it close,
		// half a length off, and tacks round it in one turn for the way
		// home, as a sailor does, without coming up to a point first.
		near := 0.5 * l
		return [][2]float64{
			{ch.X + near*rx + 2*clear*ch.S, ch.Y + near*ry + 2*clear*ch.C},
			{ch.X - 6*clear*ch.S - clear*rx, ch.Y - 6*clear*ch.C - clear*ry},
		}
	}
	return [][2]float64{
		{ch.X + clear*rx + clear*ch.S, ch.Y + clear*ry + clear*ch.C},
		{ch.X - clear*rx + clear*ch.S, ch.Y - clear*ry + clear*ch.C},
	}
}

// sail sails the run the sailor's boat is placed for, by its course's
// checks, or by the way's points for an island course, and says what it
// came to.
func (cs *carefulSailor) sail(length float64) carefulRun {
	var out carefulRun
	at, next := 0, int16(-1)
	var pts [][2]float64
	capsized := false
	for step := range 4 * 3600 {
		st, rc, r, ok := cs.state()
		if !ok || r.Course == nil {
			cs.t.Fatalf("no boat or no race: %v", ok)
		}
		c := r.Course
		out.expected = c.Expected
		if down := st.SailorMode != physics.Sailing; down != capsized {
			capsized = down
			if down {
				out.capsizes++
			}
		}
		if rc.State != bus.RacerPlaced && rc.State != bus.RacerRacing {
			out.finished = rc.State == bus.RacerFinished
			out.elapsed, out.medal = committee.Elapsed(&r, &rc), rc.Medal
			if !out.finished {
				out.elapsed = float64(r.Ended-r.Start) / committee.Second
			}
			if r.Phase != bus.RaceEnded {
				time.Sleep(time.Second)
				continue
			}
			return out
		}
		switch {
		case c.Island:
			// An island course is sailed by its way's points.
			pts, at = islandPoints(c), cs.islandAt(c, st, at)
		case rc.Next != next:
			next, at = rc.Next, 0
			pts = carefulPoints(c, min(int(next), len(c.Checks)-1), length)
		}
		for at < len(pts)-1 && math.Hypot(pts[at][0]-st.X, pts[at][1]-st.Y) < max(1.5*length, 8) {
			at++
		}
		cs.toward(&st, pts[at][0], pts[at][1])
		if cs.trace {
			cs.t.Logf("t=%4d at (%.0f, %.0f) hdg %3.0f spd %.1f state %d next %d → pt %d (%.0f, %.0f) %s", step, st.X, st.Y, st.Heading*180/math.Pi,
				st.Surge, rc.State, rc.Next, at, pts[at][0], pts[at][1], cs.last)
		}
		time.Sleep(time.Second)
	}
	cs.t.Fatal("the run never ended")
	return out
}

// islandPoints are an island course's way's points after its start, and
// one beyond its finish.
func islandPoints(c *bus.RaceCourse) [][2]float64 {
	pts := append([][2]float64{}, c.Way[1:]...)
	n := len(c.Way)
	dx, dy := c.Way[n-1][0]-c.Way[n-2][0], c.Way[n-1][1]-c.Way[n-2][1]
	d := math.Hypot(dx, dy)
	return append(pts, [2]float64{c.Way[n-1][0] + 40*dx/d, c.Way[n-1][1] + 40*dy/d})
}

// islandAt is the point of an island course's way the boat steers for:
// on from at once she is within 40 m of it, or past it along the way.
func (cs *carefulSailor) islandAt(c *bus.RaceCourse, st physics.State, at int) int {
	pts := islandPoints(c)
	for at < len(pts)-1 {
		p := pts[at]
		prev := c.Way[at]
		dx, dy := p[0]-prev[0], p[1]-prev[1]
		past := (st.X-p[0])*dx+(st.Y-p[1])*dy > 0
		if math.Hypot(p[0]-st.X, p[1]-st.Y) > 40 && !past {
			break
		}
		at++
	}
	return at
}

// carefulStage is a stage of one racing area at (0, 2000), as large as a
// world's, for the catalog's boats.
func carefulStage(cat *catalog.Catalog) *committee.Stage {
	st := &committee.Stage{Areas: []committee.Area{{Number: 1, X: 0, Y: 2000, Radius: 450}}}
	for i := range cat.Boats {
		st.Kinds = append(st.Kinds, committee.Kind{Polar: cat.Polar(i), Length: cat.Boats[i].LengthOverall})
	}
	return st
}

// carefulWorld is a harness of seed 1's world: its land, its lip and the
// water running to it, its racing areas and island courses, in a steady
// wind of knots from from degrees.
func carefulWorld(t *testing.T, cat *catalog.Catalog, knots, from float64) (*harness, *worldgen.Bundle) {
	t.Helper()
	return carefulWorldOf(t, cat, knots, from, 8)
}

// carefulWorldOf is carefulWorld holding up to limit boats.
func carefulWorldOf(t *testing.T, cat *catalog.Catalog, knots, from float64, limit int) (*harness, *worldgen.Bundle) {
	t.Helper()
	b, err := seed1()
	if err != nil {
		t.Fatal(err)
	}
	st := carefulStage(cat)
	st.Areas = st.Areas[:0]
	for _, a := range b.Records.Areas {
		st.Areas = append(st.Areas, committee.Area{Number: a.Number, X: a.X, Y: a.Y, Radius: a.Radius})
	}
	for i := range b.Records.Courses {
		wc := &b.Records.Courses[i]
		ic := committee.Course{Number: wc.Number, Way: wc.Way, Length: wc.Length,
			Start:  committee.Site{X: wc.Start.X, Y: wc.Start.Y, Room: wc.Start.Room},
			Finish: committee.Site{X: wc.Finish.X, Y: wc.Finish.Y, Room: wc.Finish.Room}}
		for _, r := range wc.Rays {
			ic.Rays = append(ic.Rays, committee.Ray{X: r.X, Y: r.Y, Bearing: r.Bearing, Crossings: int8(r.Crossings), Along: r.Along, Mark: int16(r.Round + 1)})
		}
		st.Courses = append(st.Courses, ic)
	}
	e := cat.World.Edge
	return newHarnessWith(t, harnessWith{limit: limit, knots: knots, from: from, stage: st, terrain: b.Terrain(cat.PrepareGround()), sheets: cat.StartSheets(),
		edge: &sim.Edge{Fall: int64(math.Round(e.Fall * physics.StepsPerSecond)), Clear: e.Clear}}), b
}

// kindNamed is the catalog's boat of a name: its place.
func kindNamed(t *testing.T, cat *catalog.Catalog, name string) int {
	t.Helper()
	for i := range cat.Boats {
		if cat.Boats[i].Name == name {
			return i
		}
	}
	t.Fatalf("no %s in the catalog", name)
	return 0
}

// carefulTrial sails a run of the trial of call in harness h, in the boat
// of name, and says what it came to.
func carefulTrial(t *testing.T, h *harness, cat *catalog.Catalog, name string, knots, from float64, call bus.RaceCall) carefulRun {
	t.Helper()
	a := sailor(1, "Careful Kate")
	if text, refused := h.call(t, a, "observe", nil); refused {
		t.Fatalf("no boat: %s", text)
	}
	kind := kindNamed(t, cat, name)
	call.ID, call.Run, call.Trial, call.Kind = [16]byte{0xca, 0x4e}, 1, true, uint16(kind)
	call.Entrants = []bus.RaceEntrant{{Account: bus.Account(a.Account), Number: 1, Machine: true}}
	if err := h.w.Bus().Commands.Server().TrySend(bus.Command{Op: bus.RacePlace, Race: &call}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Second)
	cs := &carefulSailor{t: t, h: h, a: a, boat: carefulBoats[name], knots: knots, from: radOf(from), trace: os.Getenv("KEEL_CAREFUL_TRACE") != "", ease: 25, lead: 15}
	return cs.sail(cat.Boats[kind].LengthOverall)
}

// TestACarefulRunOfTheReach: the first certificate's course, sailed
// plainly in a Jolly boat in a middling wind, is finished well inside
// bronze, with a tack at the mark and no capsize.
func TestACarefulRunOfTheReach(t *testing.T) {
	if testing.Short() {
		t.Skip("sails five minutes of the world")
	}
	synctest.Test(t, func(t *testing.T) {
		cat, err := catalog.Load()
		if err != nil {
			t.Fatal(err)
		}
		h := newHarnessWith(t, harnessWith{limit: 8, knots: 12, from: 0, stage: carefulStage(cat)})
		run := carefulTrial(t, h, cat, "Jolly boat", 12, 0, bus.RaceCall{Across: true})
		t.Logf("the Reach in a Jolly boat in 12 knots: %.0f s against %.0f expected, ×%.2f, %s", run.elapsed, run.expected, run.multiple(), medalWord(run.medal))
		if !run.finished || run.medal < bus.MedalBronze || run.capsizes != 0 || !(run.multiple() < 1.25) {
			t.Errorf("a careful run of the Reach: %+v", run)
		}
	})
}

// TestCarefulDash sails the Dash in a Jolly boat, a skiff and a keelboat,
// in light, middling and fresh wind, and prints the table of multiples of
// its expected time: with KEEL_CAREFUL_RUNS=1.
func TestCarefulDash(t *testing.T) {
	if os.Getenv("KEEL_CAREFUL_RUNS") == "" {
		t.Skip("set KEEL_CAREFUL_RUNS=1 to sail the Dash and print the table")
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	var table strings.Builder
	only := strings.Split(os.Getenv("KEEL_CAREFUL_ONLY"), ",")
	for _, long := range []bool{false, true} {
		name := "the Dash     "
		if long {
			name = "the Long Dash"
		}
		for _, boat := range []string{"Jolly boat", "Skiff", "Keelboat"} {
			for _, knots := range carefulWinds {
				if len(only) == 2 && (only[0] != boat || only[1] != fmt.Sprint(knots)) {
					continue
				}
				synctest.Test(t, func(t *testing.T) {
					h, _ := carefulWorld(t, cat, knots, 0)
					run := carefulTrial(t, h, cat, boat, knots, 0, bus.RaceCall{Across: true, Dash: true, Long: long})
					if !run.finished {
						fmt.Fprintf(&table, "%s  %-10s %2.0f kn  not finished, %d capsizes\n", name, boat, knots, run.capsizes)
						return
					}
					fmt.Fprintf(&table, "%s  %-10s %2.0f kn  %5.0f s of %5.0f  ×%.2f  %s, %d capsizes\n",
						name, boat, knots, run.elapsed, run.expected, run.multiple(), medalWord(run.medal), run.capsizes)
				})
			}
		}
	}
	t.Logf("careful runs of the Dash:\n%s", table.String())
}

// TestCarefulRuns sails every standing course in a Jolly boat and a
// yacht, in light, middling and fresh wind, and prints the table.
func TestCarefulRuns(t *testing.T) {
	if os.Getenv("KEEL_CAREFUL_RUNS") == "" {
		t.Skip("set KEEL_CAREFUL_RUNS=1 to sail every course and print the table")
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	courses := []struct {
		name string
		call bus.RaceCall
	}{
		{"the Reach", bus.RaceCall{Across: true}},
		{"the Short Course", bus.RaceCall{}},
		{"the Triangle", bus.RaceCall{Triangle: true}},
		{"the Long Course", bus.RaceCall{Long: true}},
		{"the Long Triangle", bus.RaceCall{Triangle: true, Long: true}},
		{"Round Port Royal", bus.RaceCall{Island: true, Course: 1}},
	}
	const from = 0.0
	var table strings.Builder
	only := strings.Split(os.Getenv("KEEL_CAREFUL_ONLY"), ",")
	for _, c := range courses {
		for _, boat := range []string{"Jolly boat", "Yacht"} {
			for _, knots := range carefulWinds {
				if len(only) == 3 && (only[0] != c.name || only[1] != boat || only[2] != fmt.Sprint(knots)) {
					continue
				}
				synctest.Test(t, func(t *testing.T) {
					h, _ := carefulWorld(t, cat, knots, from)
					run := carefulTrial(t, h, cat, boat, knots, from, c.call)
					if !run.finished {
						fmt.Fprintf(&table, "%-18s %-10s %2.0f kn  not finished, %d capsizes\n", c.name, boat, knots, run.capsizes)
						return
					}
					fmt.Fprintf(&table, "%-18s %-10s %2.0f kn  %5.0f s of %5.0f  ×%.2f  %s, %d capsizes\n",
						c.name, boat, knots, run.elapsed, run.expected, run.multiple(), medalWord(run.medal), run.capsizes)
				})
			}
		}
	}
	t.Logf("careful runs:\n%s", table.String())
}

// edgeRun is what an approach to the lip came to: the least distance
// inside it, m, whether she went over, and whether she came back out of
// the mist band.
type edgeRun struct {
	least float64
	over  bool
	back  bool
}

// carefulEdge sails a Jolly boat at the lip in harness h's world, in a
// wind of knots from the east, and turns for home once the lip is turn m
// off: she steers straight out for the lip as the careful sailor steers
// for any point, and then for the world's centre the same way,
// close-hauled and tacking where that is up the wind. Windward, she comes
// at the eastern rim, the wind blowing from the lip; else at the western,
// the wind behind her.
func carefulEdge(t *testing.T, h *harness, cat *catalog.Catalog, knots, turn float64, windward bool) edgeRun {
	t.Helper()
	a := sailor(1, "Careful Kate")
	if text, refused := h.call(t, a, "observe", nil); refused {
		t.Fatalf("no boat: %s", text)
	}
	cs := &carefulSailor{t: t, h: h, a: a, boat: carefulBoats["Jolly boat"], knots: knots, from: radOf(90), ease: 25, lead: 15,
		trace: os.Getenv("KEEL_CAREFUL_TRACE") != ""}
	w := cat.PrepareWeather()
	r := w.Edge()
	band := r - cat.Weather.Disk.Rim*nm + cat.World.Edge.Clear
	// 400 m inside the lip, sailing already.
	st := physics.State{X: r - 400, Y: 0, Heading: radOf(45), Surge: 1.5}
	if !windward {
		st = physics.State{X: -(r - 400), Y: 0, Heading: radOf(-100), Surge: 1.5}
	}
	f := h.w.Bus().Frames.Acquire()
	var boat uint64
	for _, s := range f.Live {
		if f.Owner[s] == bus.Account(a.Account) {
			boat = f.Boat[s]
		}
	}
	f.Release()
	if err := h.w.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.Place, Boat: boat, State: st}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	res := edgeRun{least: math.Inf(1)}
	turned := false
	// Two looks a second, for two hours at most.
	for i := range 2 * 3600 * 2 {
		f := h.w.Bus().Frames.Acquire()
		var now physics.State
		falling := false
		for _, s := range f.Live {
			if f.Owner[s] == bus.Account(a.Account) {
				now, falling = f.State[s], f.Voyage[s].Falling()
			}
		}
		f.Release()
		d := physics.EdgeDistance(w, now.X, now.Y)
		if falling || d <= 0 {
			res.over = true
			return res
		}
		res.least = min(res.least, d)
		if cs.trace && i%20 == 0 {
			t.Logf("t=%4d s  %.0f m inside  hdg %.0f  %.1f m/s through the water  turned %v  %s", i/2, d, now.Heading*180/math.Pi, now.Surge, turned, cs.last)
		}
		turned = turned || d <= turn
		switch {
		case turned && d >= band:
			res.back = true
			return res
		case turned:
			cs.toward(&now, 0, 0)
		default:
			// Straight out: a point beyond the lip, on from the centre.
			out := (r + 1000) / math.Hypot(now.X, now.Y)
			cs.toward(&now, now.X*out, now.Y*out)
		}
		time.Sleep(500 * time.Millisecond)
	}
	return res
}

// TestCarefulEdge sails a Jolly boat to the lip and back, turning away at
// several distances in light, middling and fresh wind, and prints how
// near she came: with KEEL_CAREFUL_RUNS=1.
func TestCarefulEdge(t *testing.T) {
	if os.Getenv("KEEL_CAREFUL_RUNS") == "" {
		t.Skip("set KEEL_CAREFUL_RUNS=1 to sail to the lip and print the table")
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	var table strings.Builder
	for _, windward := range []bool{true, false} {
		for _, knots := range carefulWinds {
			for _, turn := range []float64{100, 60, 40, 20, 15, 12, 10} {
				if o := os.Getenv("KEEL_CAREFUL_ONLY"); o != "" && !strings.Contains(o, ",") && o != fmt.Sprint(windward, knots, turn) {
					continue
				}
				synctest.Test(t, func(t *testing.T) {
					h, _ := carefulWorld(t, cat, knots, 90)
					run := carefulEdge(t, h, cat, knots, turn, windward)
					rim := "the rim the wind blows from"
					if !windward {
						rim = "the rim the wind blows to"
					}
					fmt.Fprintf(&table, "%-27s %2.0f kn  turned at %2.0f m  nearest %5.1f m  over %-5v back out %v\n", rim, knots, turn, run.least, run.over, run.back)
				})
			}
		}
	}
	t.Logf("to the lip and back in a Jolly boat:\n%s", table.String())
}

// placedRun is what a boat placed for a race came to, left alone: its
// speed through the water and its angle off the wind ten seconds and
// thirty seconds after it was placed, and whether it had capsized by then.
type placedRun struct {
	surge10, off10       float64
	surge30, off30       float64
	capsized10, capsized bool
}

// underWay reports whether a boat left alone ten seconds after it was
// placed is sailing: way on and gathering, upright, and far enough off
// the wind to keep it.
func (p placedRun) underWay() bool { return p.surge10 >= 0.3 && p.off10 >= 35 && !p.capsized10 }

// carefulPlaced places a boat of name for a Dash in harness h, as a race
// places it, touches nothing, and says what it came to.
func carefulPlaced(t *testing.T, h *harness, cat *catalog.Catalog, name string, from float64) placedRun {
	t.Helper()
	a := sailor(1, "Careful Kate")
	if text, refused := h.call(t, a, "observe", nil); refused {
		t.Fatalf("no boat: %s", text)
	}
	kind := kindNamed(t, cat, name)
	f := h.w.Bus().Frames.Acquire()
	start := f.Tick + 120*committee.Second
	f.Release()
	call := bus.RaceCall{ID: [16]byte{0x9a, 0x1c}, Course: 1, Across: true, Dash: true, Kind: uint16(kind), Start: start,
		Entrants: []bus.RaceEntrant{{Account: bus.Account(a.Account), Number: 1, Machine: true}}}
	if err := h.w.Bus().Commands.Server().TrySend(bus.Command{Op: bus.RacePlace, Race: &call}); err != nil {
		t.Fatal(err)
	}
	var out placedRun
	look := func() (float64, float64) {
		f := h.w.Bus().Frames.Acquire()
		defer f.Release()
		for _, s := range f.Live {
			if f.Owner[s] == bus.Account(a.Account) {
				st := f.State[s]
				if st.SailorMode != physics.Sailing {
					out.capsized = true
				}
				return st.Surge, math.Abs(wrapPi(st.Heading-radOf(from))) * 180 / math.Pi
			}
		}
		t.Fatal("no boat")
		return 0, 0
	}
	for range 10 {
		time.Sleep(time.Second)
		look()
	}
	out.surge10, out.off10 = look()
	out.capsized10 = out.capsized
	for range 20 {
		time.Sleep(time.Second)
		look()
	}
	out.surge30, out.off30 = look()
	return out
}

// TestEveryPlacedBoatGetsUnderWay places every kind of boat that races in
// the areas for a Dash, as a race places it, in winds from light to a
// severe gale, just below a storm, and holds that each is sailing ten
// seconds later, left alone; with -v, the table. The one exception is the
// skiff in a severe gale: she capsizes within ten seconds however her sail
// is set, and is let to.
func TestEveryPlacedBoatGetsUnderWay(t *testing.T) {
	if testing.Short() {
		t.Skip("sails half a minute of the world for each boat in each wind")
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	var table strings.Builder
	for i := range cat.Boats {
		b := &cat.Boats[i]
		if b.LengthOverall > cat.World.Courses.Areas.Longest {
			continue
		}
		for _, knots := range []float64{6, 12, 20, 25, 30, 36, 40, 45} {
			synctest.Test(t, func(t *testing.T) {
				h, _ := carefulWorld(t, cat, knots, 0)
				p := carefulPlaced(t, h, cat, b.Name, 0)
				fmt.Fprintf(&table, "%-10s %2.0f kn  10 s: %4.1f m/s %3.0f° off  30 s: %4.1f m/s %3.0f° off  capsized by 10 s %-5v by 30 s %-5v under way %v\n",
					b.Name, knots, p.surge10, p.off10, p.surge30, p.off30, p.capsized10, p.capsized, p.underWay())
				if !p.underWay() && !(b.Name == "Skiff" && knots >= 40) {
					t.Errorf("a %s placed in %.0f knots: %+v", b.Name, knots, p)
				}
			})
		}
	}
	t.Logf("boats placed for a Dash, left alone:\n%s", table.String())
}

// fleetMeeting is how near a Dash's boats going out came to its boats
// coming home: the least distance between one going out and one coming
// home, each further than three lengths (the mark's own rounding, its
// zone) from the mark, m; how many seconds two such were within two
// lengths of each other, there and further than ten lengths from the
// mark; and how many boats came home.
type fleetMeeting struct {
	least           float64
	meetings, clear int
	finished        int
}

// carefulFleet sails a Dash of n Jolly boats as a race, in harness h: each
// sailor lies on her spot as placed, her sheet let fly, until twenty
// seconds before the gun, then sails for the line straight ahead and on
// round the course as the careful sailor does. It says how near the boats
// going out came to those coming home.
func carefulFleet(t *testing.T, h *harness, cat *catalog.Catalog, knots, from float64, n int) fleetMeeting {
	t.Helper()
	kind := kindNamed(t, cat, "Jolly boat")
	length := cat.Boats[kind].LengthOverall
	var sailors []*carefulSailor
	call := bus.RaceCall{ID: [16]byte{0xf1, 0xee}, Course: 1, Across: true, Dash: true, Kind: uint16(kind)}
	for i := range n {
		a := sailor(byte(10+i), fmt.Sprintf("Careful %d", i+1))
		if text, refused := h.call(t, a, "observe", nil); refused {
			t.Fatalf("no boat: %s", text)
		}
		call.Entrants = append(call.Entrants, bus.RaceEntrant{Account: bus.Account(a.Account), Number: int16(i + 1), Machine: true})
		sailors = append(sailors, &carefulSailor{t: t, h: h, a: a, boat: carefulBoats["Jolly boat"], knots: knots, from: radOf(from),
			ease: 25, lead: 15})
	}
	f := h.w.Bus().Frames.Acquire()
	call.Start = f.Tick + 125*committee.Second
	f.Release()
	if err := h.w.Bus().Commands.Server().TrySend(bus.Command{Op: bus.RacePlace, Race: &call}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Second)
	out := fleetMeeting{least: math.Inf(1)}
	type way struct {
		next int16
		at   int
		pts  [][2]float64
		held float64
	}
	ways := make([]way, n)
	for i := range ways {
		ways[i].next = -1
	}
	for range 3600 {
		f := h.w.Bus().Frames.Acquire()
		tick := f.Tick
		f.Release()
		type boat struct {
			st   physics.State
			next int16
			on   bool
		}
		boats := make([]boat, n)
		var c *bus.RaceCourse
		var race bus.Race
		for i, cs := range sailors {
			st, rc, r, ok := cs.state()
			if !ok || r.Course == nil {
				t.Fatalf("boat %d: no boat or no race", i+1)
			}
			c, race = r.Course, r
			boats[i] = boat{st, rc.Next, rc.State == bus.RacerPlaced || rc.State == bus.RacerRacing}
		}
		if race.Phase == bus.RaceEnded {
			for i := range sailors {
				_, rc, _, _ := sailors[i].state()
				if rc.State == bus.RacerFinished {
					out.finished++
				}
			}
			return out
		}
		// How near the ways out come to the ways home, away from the mark.
		mark := c.Marks[0]
		zone := 3 * length
		for i := range boats {
			for j := range boats {
				a, b := &boats[i], &boats[j]
				if !a.on || !b.on || a.next > 1 || b.next != 2 {
					continue
				}
				if math.Hypot(a.st.X-mark.X, a.st.Y-mark.Y) < zone || math.Hypot(b.st.X-mark.X, b.st.Y-mark.Y) < zone {
					continue
				}
				d := math.Hypot(a.st.X-b.st.X, a.st.Y-b.st.Y)
				out.least = min(out.least, d)
				if d < 2*length {
					out.meetings++
					if math.Hypot(a.st.X-mark.X, a.st.Y-mark.Y) > 10*length && math.Hypot(b.st.X-mark.X, b.st.Y-mark.Y) > 10*length {
						out.clear++
					}
				}
			}
		}
		for i, cs := range sailors {
			b := &boats[i]
			w := &ways[i]
			if !b.on {
				cs.h.call(t, cs.a, "observe", map[string]any{"detail": "brief"})
				continue
			}
			if tick < race.Start-20*committee.Second {
				// Lying on her spot until it is time to go, the sheet let
				// fly.
				if w.held == 0 {
					w.held = b.st.Heading
				}
				cs.h.call(t, cs.a, "steer", map[string]any{"heading": (int(math.Round(w.held*180/math.Pi)) + 360) % 360, "boom": 95})
				continue
			}
			if b.next != w.next {
				w.next, w.at = b.next, 0
				k := min(int(w.next), len(c.Checks)-1)
				if k == 0 {
					// Straight ahead for the line, from where she lies.
					ch := &c.Checks[0]
					dx, dy := ch.X2-ch.X, ch.Y2-ch.Y
					d := math.Hypot(dx, dy)
					nx, ny := dy/d*float64(ch.Want), -dx/d*float64(ch.Want)
					along := ((b.st.X-ch.X)*dx + (b.st.Y-ch.Y)*dy) / (d * d)
					along = min(max(along, 0.1), 0.9)
					px, py := ch.X+along*dx, ch.Y+along*dy
					w.pts = [][2]float64{{px + 30*nx, py + 30*ny}}
				} else {
					w.pts = carefulPoints(c, k, length)
				}
			}
			for w.at < len(w.pts)-1 && math.Hypot(w.pts[w.at][0]-b.st.X, w.pts[w.at][1]-b.st.Y) < max(1.5*length, 8) {
				w.at++
			}
			cs.toward(&b.st, w.pts[w.at][0], w.pts[w.at][1])
		}
		time.Sleep(time.Second)
	}
	t.Fatal("the race never ended")
	return out
}

// TestCarefulFleet sails a Dash with twelve Jolly boats for each of
// several distances of its finish line up the wind of its start line's
// end, and prints how near the boats going out came to those coming
// home: with KEEL_CAREFUL_RUNS=1.
func TestCarefulFleet(t *testing.T) {
	if os.Getenv("KEEL_CAREFUL_RUNS") == "" {
		t.Skip("set KEEL_CAREFUL_RUNS=1 to sail a fleet round the Dash and print the table")
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	defer func(a float64) { committee.DashApart = a }(committee.DashApart)
	var table strings.Builder
	for _, knots := range carefulWinds {
		for _, apart := range []float64{0, 4, 8, 12, 16} {
			committee.DashApart = apart
			var sum fleetMeeting
			sum.least = math.Inf(1)
			for _, from := range []float64{0, 120, 240} {
				synctest.Test(t, func(t *testing.T) {
					h, _ := carefulWorldOf(t, cat, knots, from, 32)
					m := carefulFleet(t, h, cat, knots, from, 12)
					sum.least = min(sum.least, m.least)
					sum.meetings += m.meetings
					sum.clear += m.clear
					sum.finished += m.finished
				})
			}
			fmt.Fprintf(&table, "%2.0f kn  apart %2.0f lengths  nearest out to home %4.1f m  seconds within two lengths %4d, beyond ten lengths of the mark %3d  home %2d of 36\n",
				knots, apart, sum.least, sum.meetings, sum.clear, sum.finished)
		}
	}
	t.Logf("twelve Jolly boats round the Dash:\n%s", table.String())
}
