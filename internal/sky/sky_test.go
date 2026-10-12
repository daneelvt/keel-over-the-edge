// SPDX-License-Identifier: AGPL-3.0-only

package sky_test

import (
	"math"
	"math/big"
	"math/rand/v2"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/sky"
)

const (
	deg  = math.Pi / 180
	mile = 1852.0
	// rim is the disk's radius: 4.5 nautical miles.
	rim = 4.5 * mile
	// tight is the tolerance of the exact properties: 10⁻⁹ of a degree.
	tight = 1e-9 * deg
)

// load returns the catalog and its sky, made ready.
func load(t testing.TB) (*catalog.Catalog, *sky.Prepared) {
	t.Helper()
	c, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	return c, c.PrepareSky()
}

// star is a place in the catalogue: right ascension and declination, in degrees.
type star struct{ ra, dec float64 }

// named returns a named star of the catalog.
func named(t testing.TB, c *catalog.Catalog, name string) star {
	t.Helper()
	for _, s := range c.Sky.Stars {
		if s.Name == name {
			return star{s.RightAscension, s.Declination}
		}
	}
	t.Fatalf("the catalog names no star %q", name)
	return star{}
}

// turnDiff is a − b as an angle in (−π, π].
func turnDiff(a, b float64) float64 {
	d := math.Mod(a-b, 2*math.Pi)
	if d > math.Pi {
		d -= 2 * math.Pi
	} else if d <= -math.Pi {
		d += 2 * math.Pi
	}
	return d
}

// between is the angle between two directions.
func between(a, b sky.Body) float64 {
	cx := a.North*b.Up - a.Up*b.North
	cy := a.Up*b.East - a.East*b.Up
	cz := a.East*b.North - a.North*b.East
	return math.Atan2(math.Sqrt(cx*cx+cy*cy+cz*cz), a.East*b.East+a.North*b.North+a.Up*b.Up)
}

// somewhere is a random place on the disk, and a random sky time within
// the first ten years.
func somewhere(r *rand.Rand) (t, east, north float64) {
	d := rim * math.Sqrt(r.Float64())
	a := 2 * math.Pi * r.Float64()
	return math.Floor(r.Float64() * 3.15e14), d * math.Sin(a), d * math.Cos(a)
}

func TestNumbers(t *testing.T) {
	c, s := load(t)
	if got, want := s.Day(), 118*60e6; got != want {
		t.Errorf("the day is %v µs, want %v", got, want)
	}
	// The stars gain one turn on the sun in 365.2422 days.
	if got, want := s.Year(), 2585914776000.0; got != want {
		t.Errorf("the year is %v µs, want %v", got, want)
	}
	if got, want := s.Month(), 209076570120.0; got != want {
		t.Errorf("the month is %v µs, want %v", got, want)
	}
	// The stars turn once in a sidereal day: 117 min 40.7 s.
	sidereal := s.Day() * 365.2422 / 366.2422
	if want := (117*60 + 40.7) * 1e6; math.Abs(sidereal-want) > 0.05e6 {
		t.Errorf("the stars turn once in %v s, want %v", sidereal/1e6, want/1e6)
	}
	epoch := time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)
	if int64(c.Sky.Epoch) != epoch.Unix() {
		t.Errorf("the sky's epoch is %d, want %d (%s)", c.Sky.Epoch, epoch.Unix(), epoch)
	}
}

func TestHubStar(t *testing.T) {
	c, s := load(t)
	hub := c.Sky.Stars[0]
	if hub.Declination != 90 {
		t.Fatalf("the catalog's first star, %s, is not at the pole", hub.Name)
	}
	var b sky.Body
	sky.Star(s, 12345, 0, 0, hub.RightAscension, hub.Declination, &b)
	if b.Altitude != math.Pi/2 {
		t.Errorf("at the centre the Hub Star is %v° up, not at the zenith", b.Altitude/deg)
	}
	r := rand.New(rand.NewPCG(1, 2))
	for range 1000 {
		at, east, north := somewhere(r)
		sky.Star(s, at, east, north, hub.RightAscension, hub.Declination, &b)
		miles := math.Hypot(east, north) / mile
		if want := (90 - 10*miles) * deg; math.Abs(b.Altitude-want) > tight {
			t.Fatalf("%.2f miles out the Hub Star is %.12f° up, want %.12f°", miles, b.Altitude/deg, want/deg)
		}
		if want := math.Atan2(-east, -north); math.Abs(turnDiff(b.Bearing, want)) > tight {
			t.Fatalf("from (%v, %v) the Hub Star bears %.12f°, and the centre %.12f°", east, north, b.Bearing/deg, want/deg)
		}
	}
}

// The constellations a player is to know from a real night, by their stars'
// places in the Bright Star Catalogue (J2000).
var shapes = map[string][]star{
	"the Plough": {
		{165.93208, 61.75083}, // α Ursae Majoris
		{165.46042, 56.38250}, // β
		{178.45750, 53.69472}, // γ
		{183.85667, 57.03250}, // δ
		{193.50708, 55.95972}, // ε
		{200.98125, 54.92528}, // ζ
		{206.88500, 49.31333}, // η
	},
	"Cassiopeia": {
		{2.29458, 59.14972},  // β Cassiopeiae
		{10.12708, 56.53722}, // α
		{14.17708, 60.71667}, // γ
		{21.45417, 60.23528}, // δ
		{28.59875, 63.67000}, // ε
	},
	"Orion": {
		{88.79292, 7.40694},  // α Orionis
		{78.63458, -8.20167}, // β
		{81.28292, 6.34972},  // γ
		{83.00167, -0.29917}, // δ
		{84.05333, -1.20194}, // ε
		{85.18958, -1.94278}, // ζ
		{86.93917, -9.66972}, // κ
	},
}

// A constellation has its catalogue shape from every place, at every time:
// the angle between any two of its stars is the angle between their
// catalogue places.
func TestShapes(t *testing.T) {
	_, s := load(t)
	for name, stars := range shapes {
		for _, place := range [][2]float64{{0, 0}, {0.6 * rim / 2, -0.8 * rim / 2}, {rim * 0.8, rim * 0.6}} {
			for k := range 120 {
				at := math.Floor(s.Day() * float64(k) / 120)
				seen := make([]sky.Body, len(stars))
				for i, st := range stars {
					sky.Star(s, at, place[0], place[1], st.ra, st.dec, &seen[i])
				}
				for i := range stars {
					for j := range i {
						var a, b sky.Body
						a.East, a.North, a.Up = sky.Vector(stars[i].ra, stars[i].dec)
						b.East, b.North, b.Up = sky.Vector(stars[j].ra, stars[j].dec)
						if got, want := between(seen[i], seen[j]), between(a, b); math.Abs(got-want) > tight {
							t.Fatalf("%s from %v at %v: stars %d and %d are %.12f° apart, in the catalogue %.12f°",
								name, place, at, i, j, got/deg, want/deg)
						}
					}
				}
			}
		}
	}
}

func TestStarsRiseAndSet(t *testing.T) {
	c, s := load(t)
	var b sky.Body
	// At the centre a star's height is its declination, all day.
	for _, st := range c.Sky.Stars {
		for k := range 48 {
			at := math.Floor(s.Day() * float64(k) / 48)
			sky.Star(s, at, 0, 0, st.RightAscension, st.Declination, &b)
			if math.Abs(b.Altitude-st.Declination*deg) > tight {
				t.Fatalf("%s at the centre is %.12f° up, its declination is %v°", st.Name, b.Altitude/deg, st.Declination)
			}
		}
	}
	// A star whose point is inside the disk never sets for anyone on it.
	r := rand.New(rand.NewPCG(3, 4))
	inside := 0
	for _, st := range c.Sky.Stars {
		if (90-st.Declination)/float64(c.Sky.Scale) > 4.5 {
			continue
		}
		inside++
		for i := range 2000 {
			at, east, north := somewhere(r)
			if i%2 == 0 {
				// On the rim itself, where it comes lowest.
				k := rim / math.Hypot(east, north)
				east, north = east*k, north*k
			}
			sky.Star(s, at, east, north, st.RightAscension, st.Declination, &b)
			if b.Altitude <= 0 {
				t.Fatalf("%s, whose point is inside the disk, is %.6f° up from (%v, %v) at %v", st.Name, b.Altitude/deg, east, north, at)
			}
		}
	}
	if inside < 8 {
		t.Errorf("only %d named stars have their point inside the disk", inside)
	}
	// Rigel is never up at the centre, and rises and sets at the rim.
	rigel := named(t, c, "Rigel")
	up, down := 0, 0
	for k := range 240 {
		at := math.Floor(s.Day() * float64(k) / 240)
		sky.Star(s, at, 0, 0, rigel.ra, rigel.dec, &b)
		if b.Altitude >= 0 {
			t.Fatalf("Rigel is %.6f° up at the centre", b.Altitude/deg)
		}
		sky.Star(s, at, 0, rim, rigel.ra, rigel.dec, &b)
		if b.Altitude > 0 {
			up++
		} else {
			down++
		}
	}
	if up == 0 || down == 0 {
		t.Errorf("at the rim Rigel was up at %d moments of a day and down at %d", up, down)
	}
}

func TestStarsMatrix(t *testing.T) {
	c, s := load(t)
	r := rand.New(rand.NewPCG(5, 6))
	var all sky.Sky
	var b sky.Body
	for range 200 {
		at, east, north := somewhere(r)
		sky.At(s, at, east, north, &all)
		m := all.Stars
		// A turn: its rows are unit vectors square to each other, and it does
		// not mirror the sky.
		det := m[0]*(m[4]*m[8]-m[5]*m[7]) - m[1]*(m[3]*m[8]-m[5]*m[6]) + m[2]*(m[3]*m[7]-m[4]*m[6])
		if math.Abs(det-1) > 1e-12 {
			t.Fatalf("the stars' matrix has determinant %v", det)
		}
		for _, st := range c.Sky.Stars {
			x, y, z := sky.Vector(st.RightAscension, st.Declination)
			sky.Star(s, at, east, north, st.RightAscension, st.Declination, &b)
			got := [3]float64{m[0]*x + m[1]*y + m[2]*z, m[3]*x + m[4]*y + m[5]*z, m[6]*x + m[7]*y + m[8]*z}
			want := [3]float64{b.East, b.North, b.Up}
			for i := range got {
				if math.Abs(got[i]-want[i]) > 1e-15 {
					t.Fatalf("%s: the matrix puts it at %v, Star at %v", st.Name, got, want)
				}
			}
		}
	}
	// Looking up at the Hub Star, the stars turn anticlockwise: seen from
	// above, as a bearing is, a star's point goes round clockwise.
	kochab := named(t, c, "Kochab")
	var before, after sky.Body
	sky.Star(s, 0, 0, 0, kochab.ra, kochab.dec, &before)
	sky.Star(s, 60e6, 0, 0, kochab.ra, kochab.dec, &after)
	turned := turnDiff(after.Bearing, before.Bearing)
	// Once in a sidereal day: 3.06° a minute.
	if want := 2 * math.Pi * 60e6 * (1/s.Day() + 1/s.Year()); math.Abs(turned-want) > tight {
		t.Errorf("in a minute Kochab's bearing turned %.9f°, want %.9f°", turned/deg, want/deg)
	}
	// And the sky is the real one, not its mirror image: seen from inside,
	// right ascension runs clockwise about the pole, so a star of greater
	// right ascension bears less.
	var east sky.Body
	sky.Star(s, 0, 0, 0, kochab.ra+10, kochab.dec, &east)
	if d := turnDiff(east.Bearing, before.Bearing); math.Abs(d+10*deg) > tight {
		t.Errorf("a star 10° of right ascension on bears %.9f° more, want 10° less", d/deg)
	}
}

// crossing finds, within a µs, the time between lo and hi at which the
// sun's height from a place passes level, in degrees; it must be on
// different sides of it at lo and hi.
func crossing(t *testing.T, s *sky.Prepared, lo, hi, east, north, level float64) float64 {
	t.Helper()
	f := func(at float64) float64 { return sky.SunAltitude(s, at, east, north) - level*deg }
	a, b := f(lo), f(hi)
	if (a > 0) == (b > 0) {
		t.Fatalf("the sun does not pass %v° between %v and %v from (%v, %v)", level, lo, hi, east, north)
	}
	for hi-lo > 1 {
		mid := math.Floor((lo + hi) / 2)
		if (f(mid) > 0) == (a > 0) {
			lo = mid
		} else {
			hi = mid
		}
	}
	return hi
}

// sunDay finds a place's sunrise, noon and sunset, in µs from the centre's
// noon: sunrise before it, sunset after.
func sunDay(t *testing.T, s *sky.Prepared, east, north float64) (rise, noon, set float64) {
	t.Helper()
	d := s.Day()
	// The sun is highest when its point is nearest the place: over the
	// centre at the centre's noon, and earlier to the east. Sunrise and
	// sunset are within half a day either side.
	base := 10 * d
	dist := math.Hypot(east, north)
	high := 0.0
	if dist > 0 {
		c := 10 * deg * dist / mile
		high = math.Atan2(-math.Sin(c)*east/dist, math.Cos(c)) / (2 * math.Pi) * d
	}
	mid := math.Floor(base + high)
	rise = crossing(t, s, mid-d/2+1, mid, east, north, 0)
	set = crossing(t, s, mid, mid+d/2-1, east, north, 0)
	return rise - base, (rise+set)/2 - base, set - base
}

func TestSun(t *testing.T) {
	_, s := load(t)
	d := s.Day()
	var all sky.Sky
	// At the centre it stands at the zenith at noon, rises bearing 090°
	// and sets bearing 270°.
	sky.At(s, 0, 0, 0, &all)
	if all.Sun.Altitude != math.Pi/2 {
		t.Errorf("at the centre's noon the sun is %v° up", all.Sun.Altitude/deg)
	}
	sky.At(s, 3*d/4, 0, 0, &all)
	if math.Abs(all.Sun.Altitude) > tight || math.Abs(all.Sun.Bearing-90*deg) > tight {
		t.Errorf("at the centre the sun rises %.12f° up bearing %.12f°", all.Sun.Altitude/deg, all.Sun.Bearing/deg)
	}
	sky.At(s, d/4, 0, 0, &all)
	if math.Abs(all.Sun.Altitude) > tight || math.Abs(all.Sun.Bearing-270*deg) > tight {
		t.Errorf("at the centre the sun sets %.12f° up bearing %.12f°", all.Sun.Altitude/deg, all.Sun.Bearing/deg)
	}
	if got, want := sky.SunAltitude(s, d/8, 0, 0), all.Sun.Altitude; got == want {
		t.Errorf("SunAltitude did not move with the time")
	}
	sky.At(s, d/8, 300, -4000, &all)
	if got := sky.SunAltitude(s, d/8, 300, -4000); got != all.Sun.Altitude {
		t.Errorf("SunAltitude is %v, At's sun %v", got, all.Sun.Altitude)
	}

	// Day and night are equal everywhere, and the noon sun stands 90° less
	// the place's angle from the line the sun rides over.
	r := rand.New(rand.NewPCG(7, 8))
	for range 1000 {
		_, east, north := somewhere(r)
		rise, noon, set := sunDay(t, s, east, north)
		if day := set - rise; math.Abs(day-d/2) > 1000 {
			t.Fatalf("at (%v, %v) the day is %v µs long, half a day is %v", east, north, day, d/2)
		}
		dist := math.Hypot(east, north)
		c := 10 * deg * dist / mile
		want := math.Pi / 2
		if dist > 0 {
			want = math.Pi/2 - math.Asin(math.Sin(c)*math.Abs(north)/dist)
		}
		if got := sky.SunAltitude(s, 10*d+math.Floor(noon), east, north); math.Abs(got-want) > 1e-6*deg {
			t.Fatalf("at (%v, %v) the noon sun is %.9f° up, want %.9f°", east, north, got/deg, want/deg)
		}
	}
}

// The sun's day at six places, in minutes: sunrise and noon against the
// centre's noon, the noon sun's height, and how long after sunset the sun
// is 6°, 12° and 18° down.
func TestSunAtSixPlaces(t *testing.T) {
	_, s := load(t)
	const min = 60e6
	cases := []struct {
		name               string
		east, north        float64
		rise, noon, height float64
		civil, nautical    float64
		astronomical       float64
	}{
		{"the centre", 0, 0, -29.5, 0, 90, 2.0, 3.9, 5.9},
		{"the east rim", rim, 0, -44.25, -14.75, 90, 2.0, 3.9, 5.9},
		{"the west rim", -rim, 0, -14.75, 14.75, 90, 2.0, 3.9, 5.9},
		{"the north rim", 0, rim, -29.5, 0, 45, 2.8, 5.6, 8.5},
		{"half way north", 0, rim / 2, -29.5, 0, 67.5, 2.1, 4.3, 6.4},
		{"half way east", rim / 2, 0, -36.875, -7.375, 90, 2.0, 3.9, 5.9},
	}
	for _, tc := range cases {
		rise, noon, set := sunDay(t, s, tc.east, tc.north)
		if math.Abs(rise/min-tc.rise) > 0.001 || math.Abs(noon/min-tc.noon) > 0.001 {
			t.Errorf("%s: sunrise %.3f min and noon %.3f min from the centre's noon, want %v and %v", tc.name, rise/min, noon/min, tc.rise, tc.noon)
		}
		if set-rise != 59*min && math.Abs(set-rise-59*min) > 1000 {
			t.Errorf("%s: a day of %.4f min, want 59", tc.name, (set-rise)/min)
		}
		base := 10 * s.Day()
		if h := sky.SunAltitude(s, base+math.Floor(noon), tc.east, tc.north) / deg; math.Abs(h-tc.height) > 1e-6 {
			t.Errorf("%s: the noon sun is %.6f° up, want %v°", tc.name, h, tc.height)
		}
		for i, want := range []float64{tc.civil, tc.nautical, tc.astronomical} {
			level := -6 * float64(i+1)
			at := crossing(t, s, base+set, base+set+s.Day()/4, tc.east, tc.north, level)
			if got := (at - base - set) / min; math.Abs(got-want) > 0.06 {
				t.Errorf("%s: the sun is %v° down %.2f min after sunset, want %v", tc.name, -level, got, want)
			}
		}
	}
}

func TestMoon(t *testing.T) {
	_, s := load(t)
	var all sky.Sky
	// New at sky time zero and each month after.
	for k := range 5 {
		sky.At(s, float64(k)*s.Month(), 0, 0, &all)
		if all.Lit > 1e-20 {
			t.Errorf("%d months on the moon's lit share is %v, want none: a new moon", k, all.Lit)
		}
		// A new moon stands with the sun.
		if d := between(all.Sun, all.Moon); d > 1e-9 {
			t.Errorf("%d months on the new moon is %v° from the sun", k, d/deg)
		}
	}
	// Full half a month on, opposite the sun: it rises as the sun sets.
	r := rand.New(rand.NewPCG(9, 10))
	for range 100 {
		_, east, north := somewhere(r)
		sky.At(s, s.Month()/2, east, north, &all)
		if math.Abs(all.Lit-1) > 1e-15 {
			t.Fatalf("half a month on the moon's lit share is %v, want 1", all.Lit)
		}
		if math.Abs(all.Moon.Altitude+all.Sun.Altitude) > tight || math.Abs(between(all.Sun, all.Moon)-math.Pi) > 1e-7 {
			t.Fatalf("the full moon is %v° up with the sun %v° up", all.Moon.Altitude/deg, all.Sun.Altitude/deg)
		}
	}
	// Its lit share follows from its age, and it trails the sun by its age
	// along the sun's own track.
	for range 1000 {
		at, east, north := somewhere(r)
		sky.At(s, at, east, north, &all)
		age := 2 * math.Pi * frac(at, s.Month())
		if want := (1 - math.Cos(age)) / 2; math.Abs(all.Lit-want) > 1e-12 {
			t.Fatalf("at %v the moon's lit share is %v, want %v", at, all.Lit, want)
		}
		elongation := age
		if elongation > math.Pi {
			elongation = 2*math.Pi - elongation
		}
		if got := between(all.Sun, all.Moon); math.Abs(got-elongation) > 1e-7 {
			t.Fatalf("at %v the moon is %v° from the sun, its age is %v°", at, got/deg, age/deg)
		}
	}
}

// frac is the fractional part of t ÷ period, exactly, by math/big.
func frac(t, period float64) float64 {
	q := new(big.Rat).Quo(new(big.Rat).SetFloat64(t), new(big.Rat).SetFloat64(period))
	whole := new(big.Int).Div(q.Num(), q.Denom())
	f, _ := q.Sub(q, new(big.Rat).SetInt(whole)).Float64()
	return f
}

// The angles, read back from the sky at the centre, against math/big: the
// sun's, the stars' turn beyond the sun's and the moon's age, at times up
// to a century and more from the epoch. Nothing drifts.
func TestPeriodsDoNotDrift(t *testing.T) {
	_, s := load(t)
	century := 100 * 365.25 * 86400e6
	times := []float64{0, 1, s.Day() - 1, s.Day(), s.Year() / 4, s.Year(), s.Month() / 3,
		century, century + 1, century + 123456789, 2.5 * century, 1e15 + 7}
	r := rand.New(rand.NewPCG(11, 12))
	for range 200 {
		times = append(times, math.Floor(r.Float64()*century))
	}
	var all sky.Sky
	for _, at := range times {
		sky.At(s, at, 0, 0, &all)
		sun := math.Atan2(-all.Sun.East, all.Sun.Up)
		if want := 2 * math.Pi * frac(at, s.Day()); math.Abs(turnDiff(sun, want)) > 1e-12 {
			t.Errorf("at %v the sun's angle is %v, want %v", at, sun, want)
		}
		// At the centre the stars' matrix is the stars' turn alone.
		stars := math.Atan2(all.Stars[0], all.Stars[3])
		if want := 2 * math.Pi * frac(at, s.Year()); math.Abs(turnDiff(stars-sun, want)) > 1e-12 {
			t.Errorf("at %v the stars have gained %v on the sun, want %v", at, turnDiff(stars-sun, 0), want)
		}
		moon := math.Atan2(-all.Moon.East, all.Moon.Up)
		if want := 2 * math.Pi * frac(at, s.Month()); math.Abs(turnDiff(sun-moon, want)) > 1e-12 {
			t.Errorf("at %v the moon trails the sun by %v, want %v", at, turnDiff(sun-moon, 0), want)
		}
	}
	// In a year the stars gain exactly one turn on the sun.
	var a, b sky.Sky
	sky.At(s, 0, 0, 0, &a)
	sky.At(s, s.Year(), 0, 0, &b)
	ra, rb := math.Atan2(a.Stars[0], a.Stars[3])-math.Atan2(-a.Sun.East, a.Sun.Up), math.Atan2(b.Stars[0], b.Stars[3])-math.Atan2(-b.Sun.East, b.Sun.Up)
	if math.Abs(turnDiff(ra, rb)) > 1e-12 {
		t.Errorf("a year on, the stars stand %v from where they stood against the sun", turnDiff(ra, rb))
	}
}

// The sky is the same at the same moment in any world: sky time is counted
// from the sky's own epoch, whatever the world's.
func TestTwoWorlds(t *testing.T) {
	c, s := load(t)
	skyEpoch := float64(c.Sky.Epoch) * 1e6
	first := skyEpoch
	later := float64(time.Date(2026, time.October, 12, 3, 0, 0, 0, time.UTC).UnixMicro())
	moment := float64(time.Date(2026, time.October, 13, 19, 30, 0, 123456000, time.UTC).UnixMicro())
	// In a world whose epoch is the sky's, sky time is world time.
	if got := sky.Time(s, first, 5e9); got != 5e9 {
		t.Errorf("in the first world sky time is %v at world time 5e9", got)
	}
	ta := sky.Time(s, first, moment-first)
	tb := sky.Time(s, later, moment-later)
	if ta != tb || ta != moment-skyEpoch {
		t.Fatalf("sky time at one moment: %v in one world, %v in another, want %v", ta, tb, moment-skyEpoch)
	}
	var a, b sky.Sky
	sky.At(s, ta, 1000, -2000, &a)
	sky.At(s, tb, 1000, -2000, &b)
	if a != b {
		t.Errorf("two worlds see different skies at one moment")
	}
	// A world's time is not whole microseconds on the client: sky time is.
	if got := sky.Time(s, later, 1234.75); got != later-skyEpoch+1234 {
		t.Errorf("sky time %v is not whole", got)
	}
}

func BenchmarkAt(b *testing.B) {
	_, s := load(b)
	var all sky.Sky
	b.ReportAllocs()
	for i := range b.N {
		sky.At(s, float64(i)*1e6, 3000, -2000, &all)
	}
}

func TestNoAllocation(t *testing.T) {
	_, s := load(t)
	var all sky.Sky
	var b sky.Body
	if n := testing.AllocsPerRun(100, func() {
		sky.At(s, 1e12, 3000, -2000, &all)
		sky.Star(s, 1e12, 3000, -2000, 100, 20, &b)
		_ = sky.SunAltitude(s, 1e12, 3000, -2000)
	}); n != 0 {
		t.Errorf("the rule allocates %v times a call", n)
	}
}
