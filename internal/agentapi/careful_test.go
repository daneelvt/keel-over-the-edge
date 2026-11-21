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
// run does not reach with a fifth of its time to spare is not one to ask
// of a certificate before the last.
//
// The sailor knows what the handbook says and no more. She steers by the
// autopilot: straight at the next point of the course where the boat can
// lie it; close-hauled where it is up the wind, tacking once the point
// can be laid on the other tack; ten degrees off a dead run where it is
// straight down the wind, gybing the same way. She leaves each mark two
// lengths clear. She trims to the handbook's table for the angle and the
// wind, eased to its word for a breeze, and reefs where it says to. She
// looks once a second. The wind is steady: no gusts, no shifts.
//
// One run is always sailed, the first certificate's own: the rest are
// sailed, and their table printed, with KEEL_CAREFUL_RUNS=1.

// carefulBoat is what the careful sailor knows of a boat: the handbook's
// fastest boom by angle off the wind in 6, 12 and 20 knots, the wind she
// reefs from, knots, and how near the wind she sails close-hauled,
// degrees.
type carefulBoat struct {
	boom     [7][3]float64
	reefFrom float64
	close    float64
}

// carefulAngles are the angles off the wind of a carefulBoat's booms.
var carefulAngles = [7]float64{40, 60, 90, 120, 150, 170, 180}

// carefulWinds are their winds, knots.
var carefulWinds = [3]float64{6, 12, 20}

// The handbook's tables (handbook/trim.md), by the boats' places in the
// catalog.
var carefulBoats = map[string]carefulBoat{
	"Jolly boat": {boom: [7][3]float64{{4, 4, 5}, {4, 10, 15}, {20, 25, 30}, {45, 50, 50}, {75, 80, 70}, {80, 80, 80}, {85, 85, 85}}, reefFrom: 19, close: 45},
	"Yacht":      {boom: [7][3]float64{{4, 4, 4}, {4, 5, 10}, {25, 25, 30}, {45, 50, 50}, {75, 75, 65}, {75, 75, 75}, {75, 75, 75}}, reefFrom: 30, close: 45},
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
	leg               float64
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
	// The order held: the autopilot's angle off the wind and side (side
	// 0 for a heading), or the heading, and the boom.
	side       int
	last       string
	beating    int // the side of the tack she beats on, 0 for none
	running    int
	tacks      int
	gather     int // seconds still to gather way for
	gatherSide int
	eased      bool
	lead       float64
	ease       float64
	trace      bool
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
		reef = 1
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
		out.expected, out.leg = c.Expected, c.Length
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
	return newHarnessWith(t, harnessWith{limit: 8, knots: knots, from: from, stage: st, terrain: b.Terrain(cat.PrepareGround()),
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
					how := medalWord(run.medal)
					if !run.finished {
						how = "not finished"
					}
					fmt.Fprintf(&table, "%-18s %-10s %2.0f kn  %5.0f s of %5.0f  ×%.2f  %s, %d capsizes\n",
						c.name, boat, knots, run.elapsed, run.expected, run.multiple(), how, run.capsizes)
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
// wind of knots from the east, and turns away once the lip is turn m off.
// Windward, she comes at the eastern rim close-hauled, the wind blowing
// from the lip, and bears away from it; else at the western rim on a
// broad reach with the wind behind her, and comes up and about.
func carefulEdge(t *testing.T, h *harness, cat *catalog.Catalog, knots, turn float64, windward bool) edgeRun {
	t.Helper()
	a := sailor(1, "Careful Kate")
	if text, refused := h.call(t, a, "observe", nil); refused {
		t.Fatalf("no boat: %s", text)
	}
	cs := &carefulSailor{t: t, h: h, a: a, boat: carefulBoats["Jolly boat"], knots: knots, from: radOf(90), trace: os.Getenv("KEEL_CAREFUL_TRACE") != ""}
	w := cat.PrepareWeather()
	r := w.Edge()
	band := r - cat.Weather.Disk.Rim*nm + cat.World.Edge.Clear
	// 400 m inside the lip, sailing already.
	st := physics.State{X: r - 400, Y: -300, Heading: radOf(45), Surge: 1.5}
	in, out := map[string]any{"wind_angle": 45, "side": "starboard", "boom": 4}, map[string]any{"wind_angle": 135, "side": "starboard", "boom": 60}
	if !windward {
		// The lee rim, the wind blowing onto the lip: in on a broad
		// reach, and out close-hauled the other way.
		st = physics.State{X: -(r - 400), Y: 0, Heading: radOf(-120), Surge: 1.5}
		in, out = map[string]any{"wind_angle": 150, "side": "starboard", "boom": 75}, map[string]any{"wind_angle": 50, "side": "port", "via": "tack", "boom": 8}
	}
	if knots >= cs.boat.reefFrom {
		in["reef"], out["reef"] = 1, 1
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
	h.call(t, a, "steer", in)
	res := edgeRun{least: math.Inf(1)}
	turned := false
	for i := range 45 * 60 * 4 {
		time.Sleep(250 * time.Millisecond)
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
			t.Logf("t=%3d s  %.0f m inside  hdg %.0f  %.1f m/s through the water  turned %v", i/4, d, now.Heading*180/math.Pi, now.Surge, turned)
		}
		if !turned && d <= turn {
			turned = true
			h.call(t, a, "steer", out)
		}
		if turned && d >= band {
			res.back = true
			return res
		}
		if i%40 == 0 {
			h.call(t, a, "observe", map[string]any{"detail": "brief"})
		}
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
			for _, turn := range []float64{40, 30, 20, 15, 12, 10} {
				if o := os.Getenv("KEEL_CAREFUL_ONLY"); o != "" && !strings.Contains(o, ",") && o != fmt.Sprint(windward, knots, turn) {
					continue
				}
				synctest.Test(t, func(t *testing.T) {
					h, _ := carefulWorld(t, cat, knots, 90)
					run := carefulEdge(t, h, cat, knots, turn, windward)
					rim := "the windward rim, bearing away"
					if !windward {
						rim = "the lee rim, coming about"
					}
					fmt.Fprintf(&table, "%-30s %2.0f kn  turned at %2.0f m  nearest %5.1f m  over %-5v back out %v\n", rim, knots, turn, run.least, run.over, run.back)
				})
			}
		}
	}
	t.Logf("to the lip and back in a Jolly boat:\n%s", table.String())
}
