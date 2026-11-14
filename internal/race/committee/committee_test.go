// SPDX-License-Identifier: AGPL-3.0-only

package committee

import (
	"math"
	"slices"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// stage is a stage of one racing area at the world's centre, radius 450
// m, and one island course round a square island, for the catalog's
// boats.
func stage(t *testing.T) *Stage {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	s := &Stage{Areas: []Area{{Number: 1, X: 0, Y: 0, Radius: 450}}}
	for i := range cat.Boats {
		s.Kinds = append(s.Kinds, Kind{Polar: cat.Polar(i), Length: cat.Boats[i].LengthOverall})
	}
	// An island course: out north from (0, −1000) round an island at
	// (0, 0), left to starboard, and home to the start.
	way := [][2]float64{{0, -1000}, {300, -300}, {300, 300}, {-300, 300}, {-300, -300}, {0, -1000}}
	var rays []Ray
	along := 0.0
	for i := 1; i < len(way); i++ {
		along += hypot(way[i][0]-way[i-1][0], way[i][1]-way[i-1][1])
	}
	for k, b := range []float64{math.Pi / 2, 0, -math.Pi / 2, math.Pi} {
		_ = k
		rays = append(rays, Ray{X: 0, Y: 0, Bearing: b, Crossings: 1, Mark: 1})
	}
	// Along the way: east (at y=0, x=300) first, then north, west, south.
	rays[0].Along, rays[1].Along, rays[2].Along, rays[3].Along = 1060, 1360, 1960, 2560
	s.Courses = []Course{{Number: 3, Start: Site{X: 0, Y: -1000, Room: 160}, Finish: Site{X: 0, Y: -1000, Room: 160},
		Rays: rays, Way: way, Length: along}}
	return s
}

// world is a race's world in a test: two frames, the current and the
// next, and the boats' places to come.
type world struct {
	t        *testing.T
	cur, nxt *bus.Frame
}

func newWorld(t *testing.T, boats int) *world {
	w := &world{t: t, cur: bus.NewFrame(16), nxt: bus.NewFrame(16)}
	for s := range boats {
		w.cur.Occupied[s] = true
		w.cur.Live = append(w.cur.Live, int32(s))
		w.cur.Boat[s] = uint64(s + 1)
		w.cur.Owner[s] = bus.Account{byte(s + 1)}
	}
	w.cur.Tick = 1000
	return w
}

// tick moves the world a tick on, the boats to where move puts them (nil
// leaves them), with bumps.
func (w *world) tick(move func(s int, st *physics.State), bumps ...bus.Bump) {
	cur, n := w.cur, w.nxt
	n.Tick = cur.Tick + 1
	n.Live = append(n.Live[:0], cur.Live...)
	copy(n.Occupied, cur.Occupied)
	copy(n.Boat, cur.Boat)
	copy(n.Owner, cur.Owner)
	copy(n.State, cur.State)
	copy(n.Voyage, cur.Voyage)
	n.NextRace = cur.NextRace
	n.Races = append(n.Races[:0], cur.Races...)
	n.Racers = append(n.Racers[:0], cur.Racers...)
	n.RaceEvents = n.RaceEvents[:0]
	n.Bumps = n.Bumps[:0]
	for _, b := range bumps {
		b.Tick = n.Tick
		n.Bumps = append(n.Bumps, b)
	}
	if move != nil {
		for _, s := range n.Live {
			move(int(s), &n.State[s])
		}
	}
	Step(n, cur)
	w.cur, w.nxt = n, cur
}

// events are the frame's events of a kind.
func events(f *bus.Frame, kind uint8) []bus.RaceEvent {
	var out []bus.RaceEvent
	for _, e := range f.RaceEvents {
		if e.Kind == kind && e.Tick == f.Tick {
			out = append(out, e)
		}
	}
	return out
}

// begin begins a race in w for its boats, each its own account, placed at
// the committee's spots by lot, its start the warning's two minutes on.
func (w *world) begin(s *Stage, call *bus.RaceCall) *bus.RaceCourse {
	w.t.Helper()
	f := w.cur
	for i := range call.Entrants {
		if call.Entrants[i].Number == 0 {
			call.Entrants[i].Number = int16(i + 1)
		}
	}
	if call.Start == 0 && !call.Trial {
		call.Start = f.Tick + Warning
	}
	x, y, ok := s.Where(f, call)
	if !ok {
		w.t.Fatal("no place for the race")
	}
	_, _ = x, y
	c := s.Lay(f, call, 5, 0, len(call.Entrants))
	if c == nil {
		w.t.Fatal("no course laid")
	}
	spots := Spots(c, s.kind(call.Kind).Length)
	placed := make([]Placing, len(call.Entrants))
	for k, i := range Lot(call) {
		e := call.Entrants[i]
		slot := int32(-1)
		for _, sl := range f.Live {
			if f.Owner[sl] == e.Account {
				slot = sl
			}
		}
		if slot < 0 {
			continue
		}
		f.State[slot] = spots[k]
		placed[i] = Placing{Slot: slot, Boat: f.Boat[slot], Placed: true}
	}
	Begin(f, call, c, placed)
	return c
}

// entrants are n boats' entrants, slot s's account its own.
func entrants(n int) []bus.RaceEntrant {
	out := make([]bus.RaceEntrant, n)
	for i := range out {
		out[i] = bus.RaceEntrant{Account: bus.Account{byte(i + 1)}, Number: int16(i + 1)}
	}
	return out
}

func TestLayingABuoyCourse(t *testing.T) {
	s := stage(t)
	f := bus.NewFrame(4)
	call := &bus.RaceCall{Course: 1, Entrants: entrants(8)}
	// A north wind, 10 knots.
	c := s.Lay(f, call, 10*physics.Knot, 0, 8)
	jolly := s.Kinds[0].Length
	// The line square to the wind, the committee boat to the east, as long
	// as the boats need.
	if !(math.Abs(c.Committee[1]-c.Pin[1]) < 1e-9 && c.Committee[0] > c.Pin[0]) {
		t.Errorf("a line from %v to %v, not square to a north wind with the committee boat to starboard", c.Pin, c.Committee)
	}
	if l := c.Committee[0] - c.Pin[0]; math.Abs(l-1.5*jolly*8) > 1e-6 {
		t.Errorf("a line of %.1f m for eight boats of %.1f m", l, jolly)
	}
	if len(c.Marks) != 1 || c.Marks[0].Number != 1 || c.Marks[0].Side != bus.MarkPort || !(c.Marks[0].Y > 0) || math.Abs(c.Marks[0].X) > 1e-9 {
		t.Errorf("marks %+v: want one windward mark up the wind", c.Marks)
	}
	if math.Abs(c.Expected-ShortSeconds) > 60 || c.Laps != 1 {
		t.Errorf("a short course of %d laps the Jolly boat sails in %.0f s", c.Laps, c.Expected)
	}
	// In the area, in any wind.
	for _, from := range []float64{0, 1, 2, 3, -2} {
		c := s.Lay(f, &bus.RaceCall{Course: 1, Long: true, Triangle: true, Entrants: entrants(12)}, 10*physics.Knot, from, 12)
		for _, p := range append(c.Way, c.Committee, c.Pin) {
			if hypot(p[0], p[1]) > 450 {
				t.Errorf("a point %v outside the area, the wind from %.0f rad", p, from)
			}
		}
	}
}

func TestACappedCourseSailsMoreLaps(t *testing.T) {
	s := stage(t)
	f := bus.NewFrame(4)
	// The fastest boat, a long course, a fresh breeze: the leg the area
	// holds is not enough.
	fast := uint16(0)
	for k := range s.Kinds {
		if s.Kinds[k].Polar.Speed(8, math.Pi/2) > s.Kinds[fast].Polar.Speed(8, math.Pi/2) && s.Kinds[k].Length < 20 {
			fast = uint16(k)
		}
	}
	c := s.Lay(f, &bus.RaceCall{Course: 1, Long: true, Kind: fast, Entrants: entrants(6)}, 14*physics.Knot, 0.3, 6)
	if c.Laps < 2 {
		t.Fatalf("%d laps for the fastest boat on a long course in a breeze", c.Laps)
	}
	if math.Abs(c.Expected-LongSeconds) > 120 {
		t.Errorf("a long course of %d laps sailed in %.0f s", c.Laps, c.Expected)
	}
	gates := 0
	for _, m := range c.Marks {
		if m.Side == bus.MarkGate {
			gates++
		}
	}
	if gates != 2 {
		t.Errorf("%d gate buoys for a course of laps", gates)
	}
	// Start, a windward mark and a gate each lap but the last, the finish.
	if want := 1 + int(c.Laps) + int(c.Laps-1) + 1; len(c.Checks) != want {
		t.Errorf("%d checks for %d laps, want %d", len(c.Checks), c.Laps, want)
	}
}

func TestLot(t *testing.T) {
	call := &bus.RaceCall{ID: [16]byte{1, 2, 3}, Entrants: entrants(12)}
	a := Lot(call)
	if !slices.Equal(a, Lot(call)) {
		t.Error("a race drawn twice drew two orders")
	}
	call2 := *call
	call2.ID[0] = 9
	if slices.Equal(a, Lot(&call2)) {
		t.Error("two races drew the same order")
	}
	sorted := slices.Clone(a)
	slices.Sort(sorted)
	for i, v := range sorted {
		if v != i {
			t.Fatalf("a draw of %v", a)
		}
	}
}

// sail moves boat s's place toward (x, y) at speed m/s for a tick.
func toward(st *physics.State, x, y, speed float64) {
	dx, dy := x-st.X, y-st.Y
	d := hypot(dx, dy)
	step := speed / Second
	if d <= step {
		st.X, st.Y = x, y
		return
	}
	st.X += dx / d * step
	st.Y += dy / d * step
	st.Heading = physics.Atan2(dx, dy)
	st.Surge = speed
}

// route is a boat's way round course c: through each check's point, round
// the outside of each mark, and over the finish.
func route(c *bus.RaceCourse) [][2]float64 {
	var out [][2]float64
	for k, ch := range c.Checks {
		switch {
		case k == 0:
			out = append(out, [2]float64{ch.AtX, ch.AtY + 10})
		case ch.Line:
			out = append(out, [2]float64{ch.AtX, ch.AtY + 5}, [2]float64{ch.AtX, ch.AtY - 10})
		default:
			// Round a mark to port, the ray toward (S, C): out past it on
			// its starboard side, across its ray, and back.
			rx, ry := ch.C, -ch.S
			out = append(out,
				[2]float64{ch.X + 15*rx - 5*ch.S, ch.Y + 15*ry - 5*ch.C},
				[2]float64{ch.X + 15*rx + 15*ch.S, ch.Y + 15*ry + 15*ch.C},
				[2]float64{ch.X - 15*rx + 15*ch.S, ch.Y - 15*ry + 15*ch.C},
				[2]float64{ch.X - 15*rx - 5*ch.S, ch.Y - 15*ry - 5*ch.C})
		}
	}
	last := c.Checks[len(c.Checks)-1]
	out = append(out, [2]float64{last.AtX, last.AtY - 20})
	return out
}

// sailor sails a route at a speed.
type sailor struct {
	way   [][2]float64
	at    int
	speed float64
	hold  bool
}

func (b *sailor) move(st *physics.State) {
	if b.hold || b.at >= len(b.way) {
		return
	}
	p := b.way[b.at]
	toward(st, p[0], p[1], b.speed)
	if st.X == p[0] && st.Y == p[1] {
		b.at++
	}
}

func TestARaceOfThree(t *testing.T) {
	s := stage(t)
	w := newWorld(t, 3)
	call := &bus.RaceCall{ID: [16]byte{7}, Course: 1, Entrants: entrants(3)}
	c := w.begin(s, call)
	if got := events(w.cur, bus.RaceSignalled); len(got) != 1 || got[0].Signal != bus.SignalWarning || !got[0].Gun {
		t.Fatalf("signals at the warning: %+v", got)
	}
	r := &w.cur.Races[0]
	start := r.Start
	// Hold behind the line until the gun; then sail the course, the
	// first boat fastest.
	boats := []*sailor{{speed: 6}, {speed: 5}, {speed: 4}}
	for i, b := range boats {
		b.way = route(c)
		b.hold = true
		_ = i
	}
	var signals []uint8
	for w.cur.Tick < start+int64(3*c.Expected*Second) && w.cur.Races[0].Phase != bus.RaceEnded {
		w.tick(func(s int, st *physics.State) {
			b := boats[s]
			if w.nxt.Tick >= start {
				b.hold = false
			}
			b.move(st)
		})
		for _, e := range events(w.cur, bus.RaceSignalled) {
			signals = append(signals, e.Signal)
		}
	}
	want := []uint8{bus.SignalPreparatory, bus.SignalStart, bus.SignalFinish, bus.SignalFinish, bus.SignalFinish}
	if !slices.Equal(signals, want) {
		t.Errorf("signals %v, want %v", signals, want)
	}
	r = &w.cur.Races[0]
	if r.Phase != bus.RaceEnded {
		t.Fatalf("the race still under way at tick %d", w.cur.Tick)
	}
	for i := range w.cur.Racers {
		rc := &w.cur.Racers[i]
		if rc.State != bus.RacerFinished || rc.Place != rc.Number {
			t.Errorf("boat %d %d, in place %d", rc.Number, rc.State, rc.Place)
		}
	}
	if len(w.cur.Racers[0].Track) == 0 {
		t.Error("no track kept")
	}
}

func TestTracksRoundTrip(t *testing.T) {
	var rc bus.Racer
	in := []physics.State{{X: 10, Y: -5, Heading: 0.5, Surge: 2}, {X: 18.04, Y: -3.2, Heading: -3, Surge: 2.5}, {X: 1000.5, Y: 7, Heading: 3.1, Surge: 0}}
	for i := range in {
		sample(&rc, &in[i], int64(600+i*TrackEvery))
	}
	got, err := Samples(rc.Track)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(in) {
		t.Fatalf("%d samples, want %d", len(got), len(in))
	}
	for i, g := range got {
		w := in[i]
		dh := math.Abs(wrap(g.Heading - w.Heading))
		if g.Tick != int64(600+i*TrackEvery) || math.Abs(g.East-w.X) > 0.051 || math.Abs(g.North-w.Y) > 0.051 || dh > 0.0125 ||
			math.Abs(g.SpeedAhead-w.Surge) > 0.051 {
			t.Errorf("sample %d: %+v, want %+v", i, g, w)
		}
	}
	if per := float64(len(rc.Track)-4) / 3; per > 12 {
		t.Errorf("%.1f bytes a sample", per)
	}
}
