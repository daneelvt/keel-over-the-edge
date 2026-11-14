// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"cmp"
	"math"
	"slices"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Courses for races, made with the world as everything in it is, and never
// changed in a live world:
//
//   - racing areas off Port Royal: circles of open water, every part of
//     each within a nautical mile of Port Royal and none in its harbour,
//     clear of the harbour's mouth and the start's fan, wide and deep
//     enough that a buoy course laid to the wind as a race begins fits in
//     any wind;
//   - island courses: from a site off a port, round an island to a side
//     (or a lighthouse's island or rock), a tour of two or three islands,
//     or a passage to another port past an island; each by the shortest
//     way a boat can sail, kept clear of land and shoal water, never into
//     the mist; with a beacon at the seaward end of any reef or bar the
//     way passes that is no part of what it rounds; offered to each boat
//     for which it is a race of the right length with a beat in most
//     winds and room to tack in its narrows; a balanced set of them.
//
// Rounding an island is judged as at sea: by its rounding rays, half-lines
// from the island out past its land at the bearings of its land's corners,
// each to be crossed outside it, in turn (clockwise to leave the island to
// starboard). A beacon has one, out from it across the way. Every ray
// carries the crossings the way makes of it, so a boat's track that keeps
// what the way keeps on each side crosses each as often, the same way.

// The kinds of island course.
const (
	CourseRound   = "round"   // round one island, from a site and back to it
	CourseTour    = "tour"    // round two or three islands, from a site and back
	CoursePassage = "passage" // from one port's site to another's, past an island
	CourseLight   = "light"   // round a lighthouse's island or rock, and home
)

// Area is a racing area: a circle of open water off Port Royal, its least
// depth, m.
type Area struct {
	Number int32   `json:"number"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Radius float64 `json:"radius"`
	Depth  float64 `json:"depth"`
}

// Course is an island course: its kind and name; where it starts and
// finishes; what it rounds, in order, each to its side; its rays, in the
// order the way crosses them; the beacons it needs, by their places'
// numbers; the way, the shortest a boat sails, m east and north, from the
// start to the finish, and its length, m; the typical wind it was sized
// in, m/s 10 m up; the boats it is offered to, each with its expected
// time; and what must be charted for it to open: islands and places, by
// their numbers.
type Course struct {
	Number  int32        `json:"number"`
	Kind    string       `json:"kind"`
	Name    string       `json:"name"`
	Start   CourseSite   `json:"start"`
	Finish  CourseSite   `json:"finish"`
	Rounds  []Rounding   `json:"rounds"`
	Rays    []Ray        `json:"rays"`
	Beacons []int32      `json:"beacons"`
	Way     [][2]float64 `json:"way"`
	Length  float64      `json:"length"`
	Wind    float64      `json:"wind"`
	Boats   []CourseBoat `json:"boats"`
	Islands []int32      `json:"islands"`
	Places  []int32      `json:"places"`
}

// CourseSite is where a course starts or finishes: a site of open water
// off a town's port, its middle, the way out to it from the port, rad
// clockwise from north, and the room of clear water about it, m; the line
// is laid across the wind there as each race begins.
type CourseSite struct {
	Town    int32   `json:"town"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Heading float64 `json:"heading"`
	Room    float64 `json:"room"`
}

// Rounding is what a course rounds or passes: an island (Place −1), a
// lighthouse's rock or a beacon (Island −1, Place its place); its centre;
// and the side it is left to.
type Rounding struct {
	Island    int32   `json:"island"`
	Place     int32   `json:"place"`
	X         float64 `json:"x"`
	Y         float64 `json:"y"`
	Starboard bool    `json:"starboard"`
}

// Ray is a rounding ray: a half-line from (X, Y) toward Bearing, rad
// clockwise from north, of the rounding Round. Crossings is how many
// times the way crosses it clockwise about its start, less those
// anticlockwise: +1 for a ray of an island left to starboard. Along is
// how far along the way, m, it is first crossed so.
type Ray struct {
	Round     int32   `json:"round"`
	X         float64 `json:"x"`
	Y         float64 `json:"y"`
	Bearing   float64 `json:"bearing"`
	Crossings int32   `json:"crossings"`
	Along     float64 `json:"along"`
}

// CourseBoat is a boat a course is offered to, by its kind's id, and how
// long she is expected to take in its typical wind, s: the mean over the
// sixteen winds.
type CourseBoat struct {
	Boat     string  `json:"boat"`
	Expected float64 `json:"expected"`
}

// courseBoat is a boat as the courses size them.
type courseBoat struct {
	id      string
	length  float64 // m
	draught float64 // m
	polar   *physics.Polar
	jolly   bool // the boat by whose minutes Port Royal's courses are short, middle or long: the first
	inAreas bool // she races in the racing areas
}

// courseConfig is the catalog's courses as the generator uses them.
type courseConfig struct {
	catalog.WorldCourses
	boats []courseBoat
	// typical is the world's typical wind at mid-disk, m/s 10 m up: each
	// regime's middle speed by its share of the time; speedCentre,
	// speedRim and rim how it rises from the centre to the rim.
	typical               float64
	speedCentre, speedRim float64
	rim                   float64 // m
	// deepest is the deepest draught of any boat, and of any racing in the
	// areas, m.
	deepest, deepestInAreas float64
}

// newCourseConfig reads the catalog's courses, its boats and its weather.
func newCourseConfig(cat *catalog.Catalog) courseConfig {
	cc := courseConfig{WorldCourses: cat.World.Courses}
	_, prepared := cat.Prepare()
	for i := range cat.Boats {
		b := &cat.Boats[i]
		cb := courseBoat{id: string(b.ID), length: b.LengthOverall, draught: physics.Draught(&prepared[i]),
			polar: cat.Polar(i), jolly: i == 0, inAreas: b.LengthOverall <= cc.Areas.Longest}
		cc.boats = append(cc.boats, cb)
		cc.deepest = max(cc.deepest, cb.draught)
		if cb.inAreas {
			cc.deepestInAreas = max(cc.deepestInAreas, cb.draught)
		}
	}
	var share float64
	for _, r := range cat.Weather.Regimes {
		if len(r.Wind.Speed) == 2 {
			cc.typical += float64(r.Share * float64(float64(r.Wind.Speed[0]+r.Wind.Speed[1])/2))
			share += r.Share
		}
	}
	if share > 0 {
		cc.typical = float64(cc.typical/share) * physics.Knot
	}
	d := &cat.Weather.Disk
	cc.speedCentre, cc.speedRim, cc.rim = d.SpeedCentre, d.SpeedRim, float64(d.Rim*nauticalMile)
	return cc
}

// windAt is the typical wind r m from the centre, m/s 10 m up.
func (cc *courseConfig) windAt(r float64) float64 {
	f := cc.speedCentre + float64((cc.speedRim-cc.speedCentre)*smoothstep(0, 1, r/max(cc.rim, 1)))
	return float64(cc.typical * f)
}

// coursesWork is what the courses share as they are made.
type coursesWork struct {
	c       *config
	cc      *courseConfig
	ground  *physics.Ground
	islands []*made
	names   []string // the islands' names
	b       *Bundle
	grid    *wayGrid
	sites   []CourseSite
	// beacons are the beacons set, by the hazard's place number.
	beacons map[int32]*beaconWork
	// hazards are the reefs and bars a beacon may mark; lights the
	// lighthouses a light run rounds.
	hazards []*Place
	lights  []lightRun
}

// beaconWork is a beacon as it is set: its place.
type beaconWork struct {
	place Place
	x, y  float64
}

// lightRun is a lighthouse a course may round: its place, and the island
// it stands on, or −1 for a rock offshore.
type lightRun struct {
	place  *Place
	island int32
}

// coursesOf makes a world's racing areas and island courses, and the
// beacons they need, numbered after its places; after the start, whose
// fan the areas and the sites keep clear of.
func (c *config) coursesOf(g *physics.Ground, islands []*made, names []string, b *Bundle) ([]Area, []Course, []Place) {
	cw := &coursesWork{c: c, cc: &c.courses, ground: g, islands: islands, names: names, b: b, beacons: map[int32]*beaconWork{}}
	cw.grid = newWayGrid(g, c, b.Towns, decimetres(-(c.courses.deepest + c.courses.Depth)), decimetres(-(c.courses.deepestInAreas + c.courses.Depth)))
	areas := cw.areas()
	cw.findHazards()
	cw.findSites()
	courses := cw.chosen(cw.candidates())
	var beacons []Place
	next := int32(len(b.Islands) + len(b.Groups) + len(b.Places))
	for i := range courses {
		for j, h := range courses[i].Beacons {
			bw := cw.beacons[h]
			if bw.place.Number < 0 {
				bw.place.Number = next
				next++
				beacons = append(beacons, bw.place)
			}
			courses[i].Beacons[j] = bw.place.Number
		}
		for j := range courses[i].Rounds {
			if r := &courses[i].Rounds[j]; r.Place >= 0 {
				if bw, ok := cw.beacons[r.Place]; ok && r.Island == beaconRound {
					r.Island, r.Place = -1, bw.place.Number
				}
			}
		}
	}
	return areas, courses, beacons
}

// beaconRound marks a rounding of a beacon not yet numbered: its Place is
// the hazard's.
const beaconRound = -2

// areas are the racing areas: of the candidates on rings about Port
// Royal's centre, every one whose circle lies within reach of it, its
// water deep and clear for every boat that races there by a margin, clear
// of the harbour's mouth and the start's fan; chosen one at a time, each
// as far round the island from those chosen as can be, the first the one
// with the most room, at most the catalog's most and each its apart from
// the others.
func (cw *coursesWork) areas() []Area {
	a := &cw.cc.Areas
	port := cw.islands[0]
	r := a.Radius
	within := float64(a.Within * nauticalMile)
	var mx, my float64
	hasMouth := false
	if len(cw.b.Towns) > 0 && cw.b.Towns[0].Mouth != nil {
		mx, my, hasMouth = cw.b.Towns[0].Mouth[0], cw.b.Towns[0].Mouth[1], true
	}
	fan := cw.b.Start.Places[:min(cw.b.Start.Fan, len(cw.b.Start.Places))]
	type cand struct {
		x, y    float64
		bearing float64
		room    float64
	}
	var cands []cand
	turns := max(toInt32(360/a.Turn), 1)
	for out := r; out+r <= within; out += a.Step {
		for k := range turns {
			bearing := float64(float64(k) * (2 * math.Pi / float64(turns)))
			s, co := sincos(bearing)
			x, y := port.x+float64(out*s), port.y+float64(out*co)
			room := cw.grid.areaClearance(x, y)
			if room < r+a.Margin {
				continue
			}
			if hasMouth && hypot(x-mx, y-my) < r+a.Mouth {
				continue
			}
			clear := true
			for _, p := range fan {
				if hypot(p[0]-x, p[1]-y) < r+a.Fan {
					clear = false
					break
				}
			}
			if clear {
				cands = append(cands, cand{x, y, bearing, room})
			}
		}
	}
	var chosen []cand
	for len(chosen) < a.Most {
		best, bestScore, bestRoom := -1, -1.0, -1.0
		for i, cd := range cands {
			apart := true
			score := math.Pi
			for _, ch := range chosen {
				if hypot(ch.x-cd.x, ch.y-cd.y) < a.Apart {
					apart = false
					break
				}
				score = min(score, math.Abs(wrapPi(cd.bearing-ch.bearing)))
			}
			if !apart {
				continue
			}
			if len(chosen) == 0 {
				score = 0
			}
			if score > bestScore || score == bestScore && cd.room > bestRoom {
				best, bestScore, bestRoom = i, score, cd.room
			}
		}
		if best < 0 {
			break
		}
		chosen = append(chosen, cands[best])
	}
	out := make([]Area, 0, len(chosen))
	for i, ch := range chosen {
		out = append(out, Area{Number: int32(i), X: round1(ch.x), Y: round1(ch.y), Radius: r, Depth: round1(cw.grid.leastDepth(ch.x, ch.y, r))})
	}
	return out
}

// wrapPi is a, less the whole turns that bring it into [−π, π).
func wrapPi(a float64) float64 {
	return a - float64(2*math.Pi*math.Floor((a+math.Pi)/(2*math.Pi)))
}

// findHazards lists the reefs and bars a beacon may mark, and the hazard
// lights a light run rounds.
func (cw *coursesWork) findHazards() {
	reef, bar, light := cw.c.kinds[catalog.SiteReef], cw.c.kinds[catalog.SiteBar], cw.c.kinds[catalog.SiteLight]
	byNumber := map[int32]*Place{}
	for i := range cw.b.Places {
		p := &cw.b.Places[i]
		byNumber[p.Number] = p
		if p.Kind == reef || p.Kind == bar {
			cw.hazards = append(cw.hazards, p)
		}
	}
	for _, l := range cw.b.Lights {
		if p := byNumber[l.Place]; l.Role == RoleHazard && p != nil && p.Kind == light {
			cw.lights = append(cw.lights, lightRun{place: p, island: p.Island})
		}
	}
}

// findSites finds each port's site, Port Royal's first: of the points
// seaward of its waterfront along its way out, or Port Royal's mouth's,
// and a little either side of it, the nearest with the room of clear
// water about it, clear of the start's fan; none if none is.
func (cw *coursesWork) findSites() {
	st := &cw.cc.Site
	fan := cw.b.Start.Places[:min(cw.b.Start.Fan, len(cw.b.Start.Places))]
	turns := []float64{0}
	for k := 1; float64(15*k) <= st.Turn; k++ {
		turns = append(turns, float64(15*k)*degree, -float64(15*k)*degree)
	}
	for ti := range cw.b.Towns {
		t := &cw.b.Towns[ti]
		if t.Kind != townMain && t.Kind != townPort {
			continue
		}
		ox, oy, out := t.X, t.Y, t.Heading
		if t.Mouth != nil {
			ox, oy, out = t.Mouth[0], t.Mouth[1], t.Opening
		}
		found := false
		for d := st.From; d <= st.To && !found; d += 50 {
			for _, turn := range turns {
				s, c := sincos(out + turn)
				x, y := ox+float64(d*s), oy+float64(d*c)
				if !cw.grid.free(x, y) || cw.grid.clearance(x, y) < st.Room {
					continue
				}
				clear := true
				for _, p := range fan {
					if hypot(p[0]-x, p[1]-y) < st.Room+st.Fan {
						clear = false
						break
					}
				}
				if !clear {
					continue
				}
				cw.sites = append(cw.sites, CourseSite{Town: t.Number, X: round1(x), Y: round1(y),
					Heading: round3(physics.Atan2(x-ox, y-oy)), Room: st.Room})
				found = true
				break
			}
		}
	}
}

// rounded is what a candidate rounds or passes: an island, or a light's
// rock offshore (place); its centre and how far its land and shoals reach
// from it, m; the side it is to be left to (+1 starboard, −1 port, 0
// either) and the bearing of its cut.
type rounded struct {
	island, place int32
	x, y, reach   float64
	want          int8
	cut           float64
}

// candidate is a course to try.
type candidate struct {
	kind          string
	start, finish int // sites, by index
	rounds        []rounded
	light         *Place // a light run's lighthouse
	key           string // its start and what it rounds: no two alike
	est           float64
	course        *Course
	jolly         float64 // the Jolly boat's expected minutes
	sector        int
}

// island is island i's made island.
func (cw *coursesWork) island(i int32) *made { return cw.islands[i] }

// candidates are every course to try from every site, each tried: those
// that passed have their course.
func (cw *coursesWork) candidates() []*candidate {
	cc := cw.cc
	reach := float64(cc.Reach * nauticalMile)
	var out []*candidate
	lit := map[int32]bool{}
	for _, l := range cw.lights {
		if l.island >= 0 {
			lit[l.island] = true
		}
	}
	for si, s := range cw.sites {
		// The islands near the site, nearest first.
		type near struct {
			i int32
			d float64
		}
		var nears []near
		for _, m := range cw.islands {
			if m.kind == kindRock {
				continue
			}
			if d := hypot(m.x-s.X, m.y-s.Y) - m.radius; d <= reach {
				nears = append(nears, near{m.number, d})
			}
		}
		slices.SortStableFunc(nears, func(a, b near) int { return cmp.Or(cmpAsc(a.d, b.d), cmp.Compare(a.i, b.i)) })
		nears = nears[:min(len(nears), cc.Near)]
		var mine []*candidate
		for _, n := range nears {
			if lit[n.i] {
				continue // a light run rounds it
			}
			m := cw.island(n.i)
			mine = append(mine, &candidate{kind: CourseRound, start: si, finish: si,
				rounds: []rounded{cw.roundIsland(m, physics.Atan2(m.x-s.X, m.y-s.Y), 1)},
				est:    float64(2*hypot(m.x-s.X, m.y-s.Y)) + float64(2*math.Pi*(m.radius+cc.Margin))})
		}
		for _, l := range cw.lights {
			x, y := l.place.X, l.place.Y
			var r rounded
			if l.island >= 0 {
				m := cw.island(l.island)
				x, y = m.x, m.y
				r = cw.roundIsland(m, physics.Atan2(x-s.X, y-s.Y), 1)
			} else {
				r = rounded{island: -1, place: l.place.Number, x: x, y: y, reach: hazardReach, want: 1, cut: physics.Atan2(x-s.X, y-s.Y)}
			}
			if hypot(x-s.X, y-s.Y)-r.reach > reach {
				continue
			}
			mine = append(mine, &candidate{kind: CourseLight, start: si, finish: si, rounds: []rounded{r}, light: l.place,
				est: float64(2*hypot(x-s.X, y-s.Y)) + float64(2*math.Pi*(r.reach+cc.Margin))})
		}
		// Tours: two or three of the near islands, each within the tour's
		// reach of the others, the loop's shortest first.
		tour := float64(cc.Tour * nauticalMile)
		var tours []*candidate
		close := func(a, b *made) bool { return hypot(a.x-b.x, a.y-b.y)-a.radius-b.radius <= tour }
		for i := range nears {
			for j := i + 1; j < len(nears); j++ {
				a, b := cw.island(nears[i].i), cw.island(nears[j].i)
				if !close(a, b) {
					continue
				}
				tours = append(tours, cw.tourOf(si, []*made{a, b}))
				for k := j + 1; k < len(nears); k++ {
					if c := cw.island(nears[k].i); close(a, c) && close(b, c) {
						tours = append(tours, cw.tourOf(si, []*made{a, b, c}))
					}
				}
			}
		}
		slices.SortStableFunc(tours, func(a, b *candidate) int { return cmpAsc(a.est, b.est) })
		mine = append(mine, tours[:min(len(tours), cc.Near)]...)
		// Passages to the nearest other ports, past the island nearest the
		// middle of the way, if one lies off it.
		type port struct {
			k int
			d float64
		}
		var ports []port
		for k, f := range cw.sites {
			if k != si {
				ports = append(ports, port{k, hypot(f.X-s.X, f.Y-s.Y)})
			}
		}
		slices.SortStableFunc(ports, func(a, b port) int { return cmpAsc(a.d, b.d) })
		for _, p := range ports[:min(len(ports), cc.Ports)] {
			if p.d > float64(2*reach) {
				continue
			}
			mine = append(mine, cw.passageOf(si, p.k)...)
		}
		out = append(out, mine...)
	}
	for _, cd := range out {
		cw.try(cd)
	}
	return out
}

// roundIsland is island m to be rounded to the side want, its cut toward
// bearing.
func (cw *coursesWork) roundIsland(m *made, bearing float64, want int8) rounded {
	return rounded{island: m.number, place: -1, x: m.x, y: m.y, reach: float64(m.radius * 1.5), want: want, cut: bearing}
}

// tourOf is a tour of the islands given from site si: each left to
// starboard, its cut out from the islands' middle.
func (cw *coursesWork) tourOf(si int, ms []*made) *candidate {
	s := cw.sites[si]
	var cx, cy float64
	for _, m := range ms {
		cx, cy = cx+m.x, cy+m.y
	}
	cx, cy = cx/float64(len(ms)), cy/float64(len(ms))
	cd := &candidate{kind: CourseTour, start: si, finish: si}
	px, py := s.X, s.Y
	for _, m := range ms {
		cd.rounds = append(cd.rounds, cw.roundIsland(m, physics.Atan2(m.x-cx, m.y-cy), 1))
		cd.est += hypot(m.x-px, m.y-py)
		px, py = m.x, m.y
		cd.est += float64(math.Pi * (m.radius + cw.cc.Margin))
	}
	cd.est += hypot(s.X-px, s.Y-py)
	return cd
}

// passageOf are the passages from site si to site fi: past each of the
// islands, up to three, that lie off the straight way between its first
// and its last fifth, nearest the middle first, each its cut out from the
// way; or the straight way if none does.
func (cw *coursesWork) passageOf(si, fi int) []*candidate {
	s, f := cw.sites[si], cw.sites[fi]
	est := float64(1.2 * hypot(f.X-s.X, f.Y-s.Y))
	dx, dy := f.X-s.X, f.Y-s.Y
	l2 := dot(dx, dy, dx, dy)
	if !(l2 > 0) {
		return nil
	}
	homes := map[int32]bool{}
	for _, site := range []CourseSite{s, f} {
		for _, t := range cw.b.Towns {
			if t.Number == site.Town {
				homes[t.Island] = true
			}
		}
	}
	mx, my := s.X+float64(dx/2), s.Y+float64(dy/2)
	type between struct {
		m *made
		d float64
	}
	var off []between
	for _, m := range cw.islands {
		if m.kind == kindRock || homes[m.number] {
			continue
		}
		t := dot(m.x-s.X, m.y-s.Y, dx, dy) / l2
		side := math.Abs(float64(dx*(m.y-s.Y))-float64(dy*(m.x-s.X))) / math.Sqrt(l2)
		if t < 0.2 || t > 0.8 || side < m.radius+cw.cc.Margin || side > float64(0.5*math.Sqrt(l2)) {
			continue
		}
		off = append(off, between{m, hypot(m.x-mx, m.y-my)})
	}
	slices.SortStableFunc(off, func(a, b between) int { return cmp.Or(cmpAsc(a.d, b.d), cmp.Compare(a.m.number, b.m.number)) })
	var out []*candidate
	for _, o := range off[:min(len(off), 3)] {
		m := o.m
		// The cut runs out from the way, square to it, on the island's side.
		bearing := physics.Atan2(dy, -dx) // to the right of the way
		if float64(dx*(m.y-s.Y))-float64(dy*(m.x-s.X)) > 0 {
			bearing = physics.Atan2(-dy, dx) // to its left
		}
		out = append(out, &candidate{kind: CoursePassage, start: si, finish: fi, est: est,
			rounds: []rounded{cw.roundIsland(m, bearing, 0)}})
	}
	if len(out) == 0 {
		out = append(out, &candidate{kind: CoursePassage, start: si, finish: fi, est: est})
	}
	return out
}

// The first and last ways tried may run this far beyond the box of what a
// course rounds, m.
const wayPad = 1200

// beaconDepth is the depth a beacon stands in at a hazard's seaward edge,
// m.
const beaconDepth = 2

// try works out a candidate's course: its way, its rays and beacons, and
// the boats it is offered to; none if it has no way, needs too many
// beacons or suits no boat.
func (cw *coursesWork) try(cd *candidate) {
	cc := cw.cc
	s, f := cw.sites[cd.start], cw.sites[cd.finish]
	box := [4]float64{min(s.X, f.X), min(s.Y, f.Y), max(s.X, f.X), max(s.Y, f.Y)}
	cuts := make([]cutRay, len(cd.rounds))
	for i, r := range cd.rounds {
		sn, cs := sincos(r.cut)
		cuts[i] = cutRay{x: r.x, y: r.y, s: sn, c: cs, want: r.want}
		box = [4]float64{min(box[0], r.x-r.reach), min(box[1], r.y-r.reach), max(box[2], r.x+r.reach), max(box[3], r.y+r.reach)}
	}
	box = [4]float64{box[0] - wayPad, box[1] - wayPad, box[2] + wayPad, box[3] + wayPad}
	way := cw.grid.way(s.X, s.Y, f.X, f.Y, cuts, box)
	if len(way) < 2 {
		return
	}
	course := &Course{Kind: cd.kind, Start: s, Finish: f, Way: way, Length: round1(wayLength(way)), Rounds: []Rounding{}, Rays: []Ray{},
		Beacons: []int32{}, Boats: []CourseBoat{}, Islands: []int32{}, Places: []int32{}}
	// What it rounds, each to the side its way leaves it, with its rays.
	for i, r := range cd.rounds {
		net, _ := crossings(&cuts[i], way)
		ro := Rounding{Island: r.island, Place: r.place, X: round1(r.x), Y: round1(r.y), Starboard: net > 0}
		if r.island < 0 {
			ro.Place = r.place
		}
		course.Rounds = append(course.Rounds, ro)
		for _, bearing := range cw.rayBearings(r) {
			if ray, ok := cw.ray(int32(i), r.x, r.y, bearing, way); ok {
				course.Rays = append(course.Rays, ray)
			}
		}
	}
	// A beacon at each reef or bar the way passes near that is no part of
	// what it rounds.
	rounds := map[int32]bool{}
	for _, r := range cd.rounds {
		if r.island >= 0 {
			rounds[r.island] = true
		}
	}
	for _, h := range cw.hazards {
		if h.Island >= 0 && rounds[h.Island] {
			continue
		}
		qx, qy, d := nearestOnWay(way, h.X, h.Y)
		if d > cc.Beacon {
			continue
		}
		if cd.light != nil && cd.light.Island < 0 && hypot(h.X-cd.light.X, h.Y-cd.light.Y) < hazardReach {
			continue // the light's own rock
		}
		bw := cw.beaconFor(h, qx, qy)
		if bw == nil {
			continue
		}
		n := int32(len(course.Rounds))
		ray, ok := cw.ray(n, bw.x, bw.y, physics.Atan2(qx-bw.x, qy-bw.y), way)
		if !ok {
			continue
		}
		ray.X, ray.Y = round1(bw.x), round1(bw.y)
		course.Rounds = append(course.Rounds, Rounding{Island: beaconRound, Place: h.Number, X: round1(bw.x), Y: round1(bw.y), Starboard: ray.Crossings > 0})
		course.Rays = append(course.Rays, ray)
		course.Beacons = append(course.Beacons, h.Number)
		course.Places = append(course.Places, h.Number)
	}
	if len(course.Beacons) > cc.Beacons {
		return
	}
	slices.SortStableFunc(course.Rays, func(a, b Ray) int { return cmpAsc(a.Along, b.Along) })
	// The boats it suits, in the typical wind where it is sailed.
	var r float64
	for _, p := range way {
		r += hypot(p[0], p[1])
	}
	tws := cc.windAt(r / float64(len(way)))
	course.Wind = round3(tws)
	narrowest := cw.narrowest(way)
	for bi := range cc.boats {
		cb := &cc.boats[bi]
		if cb.polar == nil {
			continue
		}
		expected, beats := legTimes(cb.polar, tws, way, cc.BeatLeg)
		minutes := expected / 60
		if bi == 0 {
			cd.jolly = minutes
		}
		if minutes < cc.Minutes[0] || minutes > cc.Minutes[1] || beats < cc.Beat || narrowest < float64(cc.Narrows*cb.length) {
			continue
		}
		course.Boats = append(course.Boats, CourseBoat{Boat: cb.id, Expected: float64(round(expected))})
	}
	if len(course.Boats) == 0 {
		return
	}
	// What must be charted for it to open.
	for _, site := range []CourseSite{s, f} {
		for _, t := range cw.b.Towns {
			if t.Number != site.Town {
				continue
			}
			if t.Place >= 0 {
				course.Places = append(course.Places, t.Place)
			} else {
				course.Islands = append(course.Islands, t.Island)
			}
		}
	}
	for _, r := range cd.rounds {
		if r.island >= 0 {
			course.Islands = append(course.Islands, r.island)
		} else if r.place >= 0 {
			course.Places = append(course.Places, r.place)
		}
	}
	if cd.light != nil {
		course.Places = append(course.Places, cd.light.Number)
	}
	slices.Sort(course.Islands)
	slices.Sort(course.Places)
	course.Islands, course.Places = slices.Compact(course.Islands), slices.Compact(course.Places)
	// Its key: the start and what it rounds, and the finish if elsewhere.
	keys := []string{}
	for _, r := range cd.rounds {
		keys = append(keys, fmtInt(int64(r.island))+":"+fmtInt(int64(r.place)))
	}
	slices.Sort(keys)
	cd.key = fmtInt(int64(cd.start)) + ">" + fmtInt(int64(cd.finish)) + " " + strings.Join(keys, ",")
	var cx, cy float64
	for _, p := range way {
		cx, cy = cx+p[0], cy+p[1]
	}
	bearing := physics.Atan2(cx, cy)
	if bearing < 0 {
		bearing += 2 * math.Pi
	}
	cd.sector = int(toInt32(bearing / (math.Pi / 4)))
	cd.course = course
}

// fmtInt is n in decimal.
func fmtInt(n int64) string {
	if n < 0 {
		return "-" + fmtInt(-n)
	}
	if n < 10 {
		return string(rune('0' + n))
	}
	return fmtInt(n/10) + string(rune('0'+n%10))
}

// rayBearings are a rounded thing's rays' bearings: an island's toward its
// land's corners, a rock's the four between the points of the compass.
func (cw *coursesWork) rayBearings(r rounded) []float64 {
	if r.island < 0 {
		return []float64{math.Pi / 4, 3 * math.Pi / 4, 5 * math.Pi / 4, 7 * math.Pi / 4}
	}
	m := cw.island(r.island)
	west, south, east, north := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
	for i, e := range m.grid.elev {
		if e <= 0 {
			continue
		}
		x, y := m.grid.centre(int32(i))
		west, south, east, north = min(west, x), min(south, y), max(east, x), max(north, y)
	}
	if west > east {
		return []float64{math.Pi / 4, 3 * math.Pi / 4, 5 * math.Pi / 4, 7 * math.Pi / 4}
	}
	var out []float64
	for _, corner := range [4][2]float64{{east, north}, {east, south}, {west, south}, {west, north}} {
		out = append(out, physics.Atan2(corner[0]-r.x, corner[1]-r.y))
	}
	return out
}

// ray is a rounding ray of rounding n from (x, y) toward bearing, starting
// where it first comes clear of shoal water: false if the way does not
// cross it on the whole.
func (cw *coursesWork) ray(n int32, x, y, bearing float64, way [][2]float64) (Ray, bool) {
	s, c := sincos(bearing)
	ox, oy := x, y
	for d := 0.0; d < 4000; d += coarseCell / 2 {
		px, py := x+float64(d*s), y+float64(d*c)
		if i, ok := cw.grid.index(px, py); ok && cw.grid.dist[i] > 0 {
			ox, oy = px, py
			break
		}
	}
	cut := cutRay{x: ox, y: oy, s: s, c: c}
	net, along := crossings(&cut, way)
	if net == 0 {
		return Ray{}, false
	}
	return Ray{Round: n, X: round1(ox), Y: round1(oy), Bearing: round3(bearing), Crossings: net, Along: round1(along)}, true
}

// nearestOnWay is the point of a way nearest (x, y), and how far it is.
func nearestOnWay(way [][2]float64, x, y float64) (float64, float64, float64) {
	bx, by, bd := way[0][0], way[0][1], math.Inf(1)
	for i := 1; i < len(way); i++ {
		p, q := way[i-1], way[i]
		dx, dy := q[0]-p[0], q[1]-p[1]
		l2 := dot(dx, dy, dx, dy)
		t := 0.0
		if l2 > 0 {
			t = clamp(dot(x-p[0], y-p[1], dx, dy)/l2, 0, 1)
		}
		px, py := p[0]+float64(t*dx), p[1]+float64(t*dy)
		if d := hypot(px-x, py-y); d < bd {
			bx, by, bd = px, py, d
		}
	}
	return bx, by, bd
}

// beaconFor is hazard h's beacon, set the first time a course asks for it:
// at the hazard's edge toward (qx, qy), where the water is first
// beaconDepth deep; nil if it has none within the beacon's reach.
func (cw *coursesWork) beaconFor(h *Place, qx, qy float64) *beaconWork {
	if bw, ok := cw.beacons[h.Number]; ok {
		return bw
	}
	bearing := physics.Atan2(qx-h.X, qy-h.Y)
	s, c := sincos(bearing)
	var bw *beaconWork
	for d := 0.0; d <= cw.cc.Beacon; d += physics.HexAcross {
		x, y := h.X+float64(d*s), h.Y+float64(d*c)
		if e, _ := cw.ground.At(x, y); e <= -beaconDepth {
			bw = &beaconWork{x: x, y: y, place: Place{Number: -1, Kind: cw.c.kinds[catalog.SiteBeacon], Name: h.Name + " Beacon",
				Island: h.Island, X: round1(x), Y: round1(y), Heading: round3(bearing), Zone: zoneNames[cw.c.zoneOf(hypot(x, y))],
				Details: PlaceDetails{Offers: []string{}, Marks: h.Number}}}
			break
		}
	}
	cw.beacons[h.Number] = bw
	return bw
}

// narrowest is the narrowest water across a way, m, at most the widest any
// boat needs: sampled every step along it. A way that keeps its margin off
// one shore with open water on its other side is as wide as the open
// water.
func (cw *coursesWork) narrowest(way [][2]float64) float64 {
	cc := cw.cc
	most := 0.0
	for _, b := range cc.boats {
		most = max(most, float64(cc.Narrows*b.length))
	}
	least := most
	for i := 1; i < len(way); i++ {
		p, q := way[i-1], way[i]
		seg := hypot(q[0]-p[0], q[1]-p[1])
		h := physics.Atan2(q[0]-p[0], q[1]-p[1])
		for d := cc.Step; d < seg; d += cc.Step {
			f := d / seg
			least = min(least, cw.grid.width(p[0]+float64(f*(q[0]-p[0])), p[1]+float64(f*(q[1]-p[1])), h, most))
		}
	}
	return least
}

// legTimes is how long a boat with polar p takes to sail a way in a true
// wind of tws m/s, the mean over the sixteen winds, s; and in how many of
// them a leg of at least beatLeg m is a beat.
func legTimes(p *physics.Polar, tws float64, way [][2]float64, beatLeg float64) (float64, int) {
	var total float64
	beats := 0
	for k := range 16 {
		from := float64(float64(k) * (math.Pi / 8))
		var t float64
		beat := false
		for i := 1; i < len(way); i++ {
			dx, dy := way[i][0]-way[i-1][0], way[i][1]-way[i-1][1]
			l := hypot(dx, dy)
			if !(l > 0) {
				continue
			}
			twa := physics.Atan2(dx, dy) - from
			t += p.LegTime(tws, twa, l)
			if l >= beatLeg && p.Beats(tws, twa) {
				beat = true
			}
		}
		total += t
		if beat {
			beats++
		}
	}
	return total / 16, beats
}

// chosen is the world's set of courses from the candidates that passed:
// one of each length from Port Royal, then, to the most, those that bring a
// kind, a boat, a site or a part of the disk the set has not got, nearest
// Port Royal first; no two alike. Named, and numbered from Port Royal's out.
func (cw *coursesWork) chosen(cands []*candidate) []Course {
	cc := cw.cc
	seen := map[string]bool{}
	var ok []*candidate
	for _, cd := range cands {
		if cd.course == nil || seen[cd.key] {
			continue
		}
		seen[cd.key] = true
		ok = append(ok, cd)
	}
	taken := make([]bool, len(ok))
	var set []*candidate
	take := func(i int) {
		taken[i] = true
		set = append(set, ok[i])
	}
	main := -1
	for si, s := range cw.sites {
		if len(cw.b.Towns) > 0 && s.Town == cw.b.Towns[0].Number && cw.b.Towns[0].Kind == townMain {
			main = si
		}
	}
	// One of each length from Port Royal, the nearest the middle of its
	// length by the Jolly boat's minutes.
	lo, hi := cc.Minutes[0], cc.Minutes[1]
	bands := [3][2]float64{{lo, cc.Lengths[0]}, {cc.Lengths[0], cc.Lengths[1]}, {cc.Lengths[1], hi}}
	for _, band := range bands {
		mid := float64((band[0] + band[1]) * 0.5)
		best, bestD := -1, math.Inf(1)
		for i, cd := range ok {
			if taken[i] || cd.start != main || cd.jolly < band[0] || cd.jolly >= band[1] && band[1] < hi || cd.jolly > hi {
				continue
			}
			if d := math.Abs(cd.jolly - mid); d < bestD {
				best, bestD = i, d
			}
		}
		if best >= 0 {
			take(best)
		}
	}
	// Then what the set has not got.
	for len(set) < cc.Set[1] {
		kinds, sites, sectors, boats := map[string]bool{}, map[int]bool{}, map[int]bool{}, map[string]bool{}
		for _, cd := range set {
			kinds[cd.kind], sites[cd.start], sectors[cd.sector] = true, true, true
			for _, b := range cd.course.Boats {
				boats[b.Boat] = true
			}
		}
		best, bestScore := -1, -1
		for i, cd := range ok {
			if taken[i] {
				continue
			}
			// What it brings, then how many boats it suits.
			score := len(cd.course.Boats)
			if !kinds[cd.kind] {
				score += 32
			}
			for _, b := range cd.course.Boats {
				if !boats[b.Boat] {
					score += 16
					break
				}
			}
			if !sites[cd.start] {
				score += 8
			}
			if !sectors[cd.sector] {
				score += 4
			}
			if score > bestScore {
				best, bestScore = i, score
			}
		}
		if best < 0 {
			break
		}
		take(best)
	}
	slices.SortStableFunc(set, func(a, b *candidate) int {
		return cmp.Or(cmp.Compare(a.start, b.start), cmpAsc(a.course.Length, b.course.Length))
	})
	out := make([]Course, len(set))
	threes := 0
	for i, cd := range set {
		c := *cd.course
		c.Number = int32(i)
		c.Name = cw.nameOf(cd, &threes)
		out[i] = c
	}
	// No two alike: a name a course from Port Royal has is the others' from
	// their port.
	names := map[string]int{}
	for i := range out {
		names[out[i].Name]++
	}
	for i := range out {
		if names[out[i].Name] > 1 && set[i].start != main {
			out[i].Name += " from " + cw.townName(out[i].Start.Town)
		}
	}
	return out
}

// townName is a town's name.
func (cw *coursesWork) townName(n int32) string {
	for _, t := range cw.b.Towns {
		if t.Number == n {
			return t.Name
		}
	}
	return ""
}

// nameOf is a course's name, from the places it uses, as charts name
// passages: "Round Gannet Holm", "Port Royal to Saltcliff"; the first
// tour of three the Three Sisters.
func (cw *coursesWork) nameOf(cd *candidate, threes *int) string {
	islandName := func(i int32) string { return cw.names[i] }
	switch cd.kind {
	case CourseLight:
		return "Round the " + cd.light.Name
	case CourseTour:
		var names []string
		for _, r := range cd.rounds {
			names = append(names, islandName(r.island))
		}
		if len(names) == 3 {
			*threes++
			if *threes == 1 {
				return "The Three Sisters"
			}
		}
		return "Round " + strings.Join(names[:len(names)-1], ", ") + " and " + names[len(names)-1]
	case CoursePassage:
		return cw.townName(cw.sites[cd.start].Town) + " to " + cw.townName(cw.sites[cd.finish].Town)
	}
	return "Round " + islandName(cd.rounds[0].island)
}
