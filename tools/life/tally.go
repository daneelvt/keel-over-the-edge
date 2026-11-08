// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"fmt"
	"io"
	"math"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/life"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// options are a tally's: the worlds, from seed From, the routes sailed in
// each and for how long, hours, the boat's step, s, and how many worlds
// are made and sailed at once.
type options struct {
	Seeds   int
	From    uint64
	Routes  int
	Hours   float64
	Step    float64
	Workers int
}

// speed is the boat's, m/s: 5 kn.
const speed = 5 * nauticalMile / 3600.0

// The waters a step is counted in: everywhere, near the islands, the outer
// water, and each of the schedule's habitats from habitats on. Most of a
// world's water is within nearLand of land, its rim's too: the outer
// water is counted apart from the islands'.
const (
	everywhere = iota
	nearIslands
	outerWater
	habitats
	waters = habitats + life.Habitats
)

// By day, while the sun is up where the boat is, and at all hours.
const (
	byDay = iota
	allHours
)

// tally is what the routes met: the hours sailed in each water, and the
// groups that came in sight there, each counted once, as it first came in
// sight; and by day, the gaps between groups coming in sight, the empty
// stretches with none in sight, and each route's longest, s.
type tally struct {
	kinds    []life.Kind
	hours    [2][waters]float64
	sighted  [2][][waters]float64 // by kind
	groups   [2][waters]float64
	passing  [2][waters]float64 // birds that do not work the water
	working  [2][waters]float64 // groups that work the water
	inWater  [2][waters]float64 // life that is not a bird
	followed [2]float64         // groups that followed the boat
	rode     [2]float64         // pods that rode its bow
	grounds  [2][waters]float64 // grounds of fish it flushed fish from
	inSight  float64            // s by day with something in sight
	gaps     []float64
	empty    []float64
	longest  []float64
	worlds   int
	routes   int
}

// newTally is an empty tally of a schedule's kinds.
func newTally(kinds []life.Kind) *tally {
	t := &tally{kinds: kinds}
	for d := range t.sighted {
		t.sighted[d] = make([][waters]float64, len(kinds))
	}
	return t
}

// add adds u's to t's.
func (t *tally) add(u *tally) {
	for d := range 2 {
		for w := range waters {
			t.hours[d][w] += u.hours[d][w]
			t.groups[d][w] += u.groups[d][w]
			t.passing[d][w] += u.passing[d][w]
			t.working[d][w] += u.working[d][w]
			t.inWater[d][w] += u.inWater[d][w]
			t.grounds[d][w] += u.grounds[d][w]
			for k := range t.sighted[d] {
				t.sighted[d][k][w] += u.sighted[d][k][w]
			}
		}
		t.followed[d] += u.followed[d]
		t.rode[d] += u.rode[d]
	}
	t.inSight += u.inSight
	t.gaps = append(t.gaps, u.gaps...)
	t.empty = append(t.empty, u.empty...)
	t.longest = append(t.longest, u.longest...)
	t.worlds += u.worlds
	t.routes += u.routes
}

// tallyWorlds makes and sails the worlds of o's seeds, o.Workers at once,
// saying how each went on log.
func tallyWorlds(cat *catalog.Catalog, o options, log io.Writer) (*tally, error) {
	wcfg, err := weather.ConfigOf(cat)
	if err != nil {
		return nil, err
	}
	_, kinds := life.Prepare(cat)
	total := newTally(kinds)
	seeds := make(chan uint64)
	var mu sync.Mutex
	var first error
	var wg sync.WaitGroup
	for range max(o.Workers, 1) {
		wg.Go(func() {
			for seed := range seeds {
				made := time.Now()
				s, err := worldSea(cat, wcfg, seed)
				if err != nil {
					mu.Lock()
					first = cmpErr(first, fmt.Errorf("seed %d: %w", seed, err))
					mu.Unlock()
					continue
				}
				took := time.Since(made)
				sailed := time.Now()
				t := s.tally(o)
				mu.Lock()
				total.add(t)
				fmt.Fprintf(log, "seed %d: made in %s, sailed in %s\n", seed, took.Round(100*time.Millisecond), time.Since(sailed).Round(10*time.Millisecond))
				mu.Unlock()
			}
		})
	}
	for i := range o.Seeds {
		seeds <- o.From + uint64(i)
	}
	close(seeds)
	wg.Wait()
	return total, first
}

// cmpErr is the first error of two.
func cmpErr(a, b error) error {
	if a != nil {
		return a
	}
	return b
}

// tally sails o's routes about the sea.
func (s *sea) tally(o options) *tally {
	t := newTally(s.sched.Kinds())
	for r := range o.Routes {
		s.sail(o, r, t)
	}
	t.worlds = 1
	return t
}

// sail sails route r and adds what it met to t. Its start is drawn in the
// r-th of o.Routes equal parts of the week, at the beginning of a slot,
// at a point of open water, on a heading drawn too.
func (s *sea) sail(o options, r int, t *tally) {
	rng := rand.New(rand.NewPCG(s.seed, uint64(r)))
	p := s.sched.Params()
	dur := int64(o.Hours * 3600 * physics.StepsPerSecond)
	step := max(int64(math.Round(o.Step))*physics.StepsPerSecond, physics.StepsPerSecond)
	dt := float64(step) / physics.StepsPerSecond
	start := int64((float64(r) + rng.Float64()) / float64(o.Routes) * float64(max(s.week-dur, 0)))
	start -= start % p.SlotTicks
	x, y, ok := s.openWater(rng)
	if !ok {
		return
	}
	heading := rng.Float64() * 2 * math.Pi
	t.routes++

	w := life.NewWorld(s.sched, 1)
	f := bus.NewFrame(1)
	f.Live = append(f.Live, 0)
	f.Occupied[0] = true
	f.Boat[0] = 1
	kinds := s.sched.Kinds()
	seen, followed, flushed, worked := map[uint64]bool{}, map[uint64]bool{}, map[uint64]bool{}, map[uint64]bool{}
	var a air
	slot := int64(math.MinInt64)
	g := gapper{t: t}
	var classes [4]int
	lastFlush := int64(math.MinInt64 / 2)
	for now := start; now < start+dur; now += step {
		if sl := s.sched.SlotOf(now); sl != slot {
			slot = sl
			a = s.air(sl * p.SlotTicks)
		}
		heading = s.steer(x, y, heading, rng)
		f.Tick = now
		f.State[0] = physics.State{X: x, Y: y, Heading: heading, Surge: speed}
		w.Tick(f, a)
		pose := life.Pose{X: x, Y: y, Heading: heading}

		cls := classes[:0]
		cls = append(cls, everywhere)
		if math.Hypot(x, y) > outerFrom {
			cls = append(cls, outerWater)
		} else if s.chart.FromLand(x, y) <= nearLand {
			cls = append(cls, nearIslands)
		}
		if h, _ := s.sched.Habitat().At(x, y); h < life.Habitats {
			cls = append(cls, habitats+h)
		}
		day := s.sched.Sun(now, x, y) > 0
		for _, c := range cls {
			t.hours[allHours][c] += dt / 3600
			if day {
				t.hours[byDay][c] += dt / 3600
			}
		}
		vis := a.Visibility(x, y)
		something, fresh := false, false
		for i := range f.Life {
			e := &f.Life[i]
			k := &kinds[e.Kind]
			bird := k.Form == catalog.LifeFormBird
			// The fish flushed from a ground are the ground's: met once,
			// however often they are flushed.
			id := e.ID
			if k.Flushes() {
				id = e.Over
				if !flushed[id] {
					flushed[id] = true
					for d := range 2 {
						if d == byDay && !day {
							continue
						}
						for _, c := range cls {
							t.grounds[d][c]++
						}
					}
				}
			}
			if bird && !day {
				continue
			}
			var with *life.Pose
			if e.Boat != 0 {
				with = &pose
			}
			gx, gy, _, alive := life.FlockAt(e, k, float64(now), with)
			if !alive || math.Hypot(gx-x, gy-y) > math.Min(k.Reach, vis) {
				continue
			}
			something = true
			if k.Flushes() {
				lastFlush = now
			}
			if e.Boat != 0 && !followed[e.ID] {
				followed[e.ID] = true
				with := &t.followed
				if k.Rides() {
					with = &t.rode
				}
				with[allHours]++
				if day {
					with[byDay]++
				}
			}
			if seen[id] {
				continue
			}
			// A group that comes with another seen already is part of
			// that sighting, not a sighting of its own.
			seen[id] = true
			fresh = fresh || e.Over == 0 || !seen[e.Over]
			// The birds working one patch of bait are one flock working
			// the water, however many kinds are in it.
			work, again := k.PathOf(e) == life.PathWork, false
			if work && e.Over != 0 {
				again = worked[e.Over]
				worked[e.Over] = true
			}
			for d := range 2 {
				if d == byDay && !day {
					continue
				}
				for _, c := range cls {
					t.sighted[d][e.Kind][c]++
					t.groups[d][c]++
					switch {
					case again:
					case work:
						t.working[d][c]++
					case bird && e.Over == 0:
						// Birds over another's patch are not passing.
						t.passing[d][c]++
					}
					if !bird {
						t.inWater[d][c]++
					}
				}
			}
		}
		// A ground's fish flushed again and again keep it in sight while
		// the boat sails through it.
		something = something || now-lastFlush <= flushHold
		g.at(now, day, something, fresh, dt)
		sin, cos := math.Sincos(heading)
		x, y = x+speed*dt*sin, y+speed*dt*cos
	}
	g.end(start + dur)
}

// flushHold is how long fish flushed keep something in sight after,
// ticks: a boat in a ground flushes them every few seconds.
const flushHold = 30 * physics.StepsPerSecond

// openWater is a point of open water drawn at random, well clear of the
// shallows: false if a thousand draws found none.
func (s *sea) openWater(rng *rand.Rand) (x, y float64, ok bool) {
	for range 1000 {
		a, r := rng.Float64()*2*math.Pi, within*math.Sqrt(rng.Float64())
		x, y = r*math.Sin(a), r*math.Cos(a)
		if s.chart.Clearance(x, y) >= 3*clear {
			return x, y, true
		}
	}
	return 0, 0, false
}

// steer is the boat's heading from (x, y) on heading h: held while the
// water ahead is clear, else one drawn at random of those, ten degrees
// apart, whose water is, or back the way it came. A boat that turned as
// little as it could would run along the routes' rim, round and round.
func (s *sea) steer(x, y, h float64, rng *rand.Rand) float64 {
	if s.clearAhead(x, y, h) {
		return h
	}
	var open [36]float64
	n := 0
	for k := range 36 {
		if hh := float64(k) * math.Pi / 18; s.clearAhead(x, y, hh) {
			open[n] = hh
			n++
		}
	}
	if n == 0 {
		return math.Mod(h+math.Pi, 2*math.Pi)
	}
	return open[rng.IntN(n)]
}

// lookAhead is how far ahead the water must be clear, m.
const lookAhead = 400.0

// clearAhead says whether the water ahead of (x, y) on heading h is clear
// of the shallows for lookAhead.
func (s *sea) clearAhead(x, y, h float64) bool {
	sin, cos := math.Sincos(h)
	for d := chartCell; d <= lookAhead; d += chartCell {
		if s.chart.Clearance(x+d*sin, y+d*cos) < clear {
			return false
		}
	}
	return true
}

// gapper keeps a route's gaps and empty stretches by day: a gap from one
// group coming in sight to the next, an empty stretch while none is in
// sight. The night, and the route's beginning and end, cut them: a gap is
// counted only between two groups, an empty stretch however it ends.
type gapper struct {
	t       *tally
	inDay   bool
	last    int64 // when a group last came in sight, −1 for none this day
	empty   int64 // since when none has been in sight, −1 while one is
	day     float64
	longest float64
}

// at counts a step at tick now of dt s: by day or not, with a group in
// sight or not, and one come in sight or not.
func (g *gapper) at(now int64, day, something, fresh bool, dt float64) {
	if !day {
		if g.inDay {
			g.close(now)
			g.inDay = false
		}
		return
	}
	if !g.inDay {
		g.inDay, g.last, g.empty = true, -1, -1
		if !something {
			g.empty = now
		}
	}
	g.day += dt
	if fresh {
		if g.last >= 0 {
			g.t.gaps = append(g.t.gaps, float64(now-g.last)/physics.StepsPerSecond)
		}
		g.last = now
	}
	switch {
	case something && g.empty >= 0:
		g.stretch(now)
		g.empty = -1
	case !something && g.empty < 0:
		g.empty = now
	}
	if something {
		g.t.inSight += dt
	}
}

// stretch ends an empty stretch at now.
func (g *gapper) stretch(now int64) {
	s := float64(now-g.empty) / physics.StepsPerSecond
	g.t.empty = append(g.t.empty, s)
	g.longest = math.Max(g.longest, s)
}

// close ends the day's run at now.
func (g *gapper) close(now int64) {
	if g.empty >= 0 {
		g.stretch(now)
	}
	g.empty = -1
}

// end ends the route at now: its longest empty stretch is kept if it
// sailed an hour by day.
func (g *gapper) end(now int64) {
	if g.inDay {
		g.close(now)
	}
	if g.day >= 3600 {
		g.t.longest = append(g.t.longest, g.longest)
	}
}
