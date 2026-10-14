// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"encoding/json"
	"math"
	"math/rand/v2"
	"os"
	"sync"
	"testing"
)

// The encounters' numbers are the catalog's, read from its generated JSON,
// as the wind's are.
var encountersOnce = sync.OnceValues(func() (*EncounterParams, error) {
	data, err := os.ReadFile("../catalog/catalog.gen.json")
	if err != nil {
		return nil, err
	}
	var c struct {
		Encounters struct {
			Contact  map[string]any `json:"contact"`
			Shadow   map[string]any `json:"shadow"`
			Articles map[string]any `json:"articles"`
		} `json:"encounters"`
	}
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	values := map[string]any{}
	for _, g := range []map[string]any{c.Encounters.Contact, c.Encounters.Shadow, c.Encounters.Articles} {
		for k, v := range g {
			values[k] = v
		}
	}
	var p EncounterParams
	return &p, setRecord(&p, values)
})

// testEncounters is the catalog's encounters, prepared.
func testEncounters(t testing.TB) *EncounterPrepared {
	t.Helper()
	p, err := encountersOnce()
	if err != nil {
		t.Fatal(err)
	}
	var e EncounterPrepared
	PrepareEncounters(p, &e)
	return &e
}

// bruteDepth is the least overlap of a and b over n directions round the
// circle, and its direction: the depth Touch must find, found the slow
// way.
func bruteDepth(a, b *State, pa, pb *Prepared, n int) (depth, angle float64) {
	var ha, hb hullFrame
	sa, ca := math.Sincos(a.Heading)
	sb, cb := math.Sincos(b.Heading)
	ha.place(&pa.outline, a.X, a.Y, sa, ca)
	hb.place(&pb.outline, b.X, b.Y, sb, cb)
	depth = math.Inf(1)
	for k := range n {
		th := float64(k) * 2 * math.Pi / float64(n)
		nx, ny := math.Sin(th), math.Cos(th)
		// a's furthest along n less b's nearest.
		o := -ha.lowest(-nx, -ny) - hb.lowest(nx, ny)
		if o < depth {
			depth, angle = o, th
		}
	}
	return depth, angle
}

// Two hulls placed into each other by a known depth, at every 15° of
// relative heading and from four bearings: Touch finds the depth within
// 1 mm and the normal within 0.5° of the least overlap over directions
// every fiftieth of a degree (separating axes: Ericson 2005, 5.2.1).
func TestContactDepthAndNormal(t *testing.T) {
	b := jolly(t)
	var h Hulls
	for rel := 0; rel < 360; rel += 15 {
		for bearing := 30; bearing < 360; bearing += 90 {
			for _, want := range []float64{0.02, 0.3} {
				a := State{Heading: 0.3}
				o := State{Heading: 0.3 + float64(rel)*degree}
				dir := 0.3 + float64(bearing)*degree
				sd, cd := math.Sincos(dir)
				// Find the distance at which the least overlap is want.
				lo, hi := 0.0, 6.0
				for range 40 {
					mid := (lo + hi) / 2
					o.X, o.Y = mid*sd, mid*cd
					if d, _ := bruteDepth(&a, &o, b, b, 720); d > want {
						lo = mid
					} else {
						hi = mid
					}
				}
				o.X, o.Y = hi*sd, hi*cd
				depth, angle := bruteDepth(&a, &o, b, b, 18000)
				var c Contact
				if !h.Touch(&a, &o, b, b, &c) {
					t.Errorf("relative heading %d°, from %d°, %g m in: no contact", rel, bearing, want)
					continue
				}
				if math.Abs(c.Depth-depth) > 0.001 {
					t.Errorf("relative heading %d°, from %d°: depth %.4f m, want %.4f", rel, bearing, c.Depth, depth)
				}
				got := math.Atan2(c.NormalEast, c.NormalNorth)
				if d := math.Abs(math.Remainder(got-angle, 2*math.Pi)); d > 0.5*degree {
					// Two axes may tie to within the sampling: only a
					// clearly better one must be found.
					if alt := overlapOn(&a, &o, b, c.NormalEast, c.NormalNorth); alt-depth > 0.001 {
						t.Errorf("relative heading %d°, from %d°: normal %.2f°, want %.2f°", rel, bearing, got/degree, angle/degree)
					}
				}
			}
		}
	}
}

// overlapOn is how far a's hull overlaps b's along (nx, ny), from a
// toward b.
func overlapOn(a, o *State, b *Prepared, nx, ny float64) float64 {
	var ha, hb hullFrame
	sa, ca := math.Sincos(a.Heading)
	sb, cb := math.Sincos(o.Heading)
	ha.place(&b.outline, a.X, a.Y, sa, ca)
	hb.place(&b.outline, o.X, o.Y, sb, cb)
	return -ha.lowest(-nx, -ny) - hb.lowest(nx, ny)
}

// momentum is a boat's momentum east and north, with its added masses.
func momentum(s *State, b *Prepared) (px, py float64) {
	sin, cos := math.Sincos(s.Heading)
	u, v := b.massX*s.Surge, b.massY*s.Sway
	return u*sin + v*cos, u*cos - v*sin
}

// energy is a boat's kinetic energy in surge, sway and yaw, with its added
// masses and inertia.
func energy(s *State, b *Prepared) float64 {
	return 0.5 * (b.massX*s.Surge*s.Surge + b.massY*s.Sway*s.Sway + s.YawRate*s.YawRate/b.invYawInertia)
}

// randomPair is two boats close enough to touch, moving at random.
func randomPair(rng *rand.Rand) (State, State) {
	a := State{Heading: rng.Float64() * 2 * math.Pi, Surge: rng.NormFloat64() * 2, Sway: rng.NormFloat64() * 0.3, YawRate: rng.NormFloat64() * 0.3}
	th := rng.Float64() * 2 * math.Pi
	r := rng.Float64() * 4
	o := State{X: r * math.Sin(th), Y: r * math.Cos(th), Heading: rng.Float64() * 2 * math.Pi,
		Surge: rng.NormFloat64() * 2, Sway: rng.NormFloat64() * 0.3, YawRate: rng.NormFloat64() * 0.3}
	return a, o
}

// An impulse is internal to the pair: their momentum, with added masses, is
// kept; with restitution below 1 and friction, their energy never rises.
func TestImpulseKeepsMomentum(t *testing.T) {
	b := jolly(t)
	e := testEncounters(t)
	rng := rand.New(rand.NewPCG(19, 2))
	var h Hulls
	touched := 0
	for range 10000 {
		a, o := randomPair(rng)
		ax, ay := momentum(&a, b)
		ox, oy := momentum(&o, b)
		before := energy(&a, b) + energy(&o, b)
		var c Contact
		if !h.Collide(&a, &o, b, b, e, &c) {
			continue
		}
		touched++
		for _, s := range []*State{&a, &o} {
			for _, v := range []float64{s.X, s.Y, s.Surge, s.Sway, s.YawRate} {
				if math.IsNaN(v) || math.IsInf(v, 0) {
					t.Fatalf("a contact gave %v: %+v", v, c)
				}
			}
		}
		ax2, ay2 := momentum(&a, b)
		ox2, oy2 := momentum(&o, b)
		if math.Abs(ax+ox-ax2-ox2) > 1e-9*(1+math.Abs(ax)+math.Abs(ox)) || math.Abs(ay+oy-ay2-oy2) > 1e-9*(1+math.Abs(ay)+math.Abs(oy)) {
			t.Fatalf("momentum (%g, %g) became (%g, %g)", ax+ox, ay+oy, ax2+ox2, ay2+oy2)
		}
		if after := energy(&a, b) + energy(&o, b); after > before*(1+1e-9)+1e-12 {
			t.Fatalf("energy rose from %g J to %g J", before, after)
		}
	}
	if touched < 1000 {
		t.Fatalf("only %d of 10,000 random pairs touched", touched)
	}
}

// relativeNormal is how fast the contact's point on o moves away from that
// on a along the contact's normal.
func relativeNormal(a, o *State, c *Contact) float64 {
	sa, ca := math.Sincos(a.Heading)
	so, co := math.Sincos(o.Heading)
	ax, ay := pointVelocity(a, sa, ca, c.X-a.X, c.Y-a.Y)
	ox, oy := pointVelocity(o, so, co, c.X-o.X, c.Y-o.Y)
	return (ox-ax)*c.NormalEast + (oy-ay)*c.NormalNorth
}

// Head on at 2.5 m/s each, the bows part at the restitution's share of
// their closing speed along the contact's normal; a glancing blow turns
// both boats.
func TestHeadOnAndGlancing(t *testing.T) {
	b := jolly(t)
	e := testEncounters(t)
	var h Hulls
	a := State{Heading: 0, Surge: 2.5}
	o := State{Y: 4.48, Heading: math.Pi, Surge: 2.5}
	var c Contact
	if !h.Touch(&a, &o, b, b, &c) {
		t.Fatal("bows 2 cm into each other do not touch")
	}
	closing := -relativeNormal(&a, &o, &c)
	if math.Abs(closing-c.Closing) > 1e-9 {
		t.Errorf("closing %g, the contact says %g", closing, c.Closing)
	}
	if !h.Collide(&a, &o, b, b, e, &c) {
		t.Fatal("no contact")
	}
	parting := relativeNormal(&a, &o, &c)
	// Friction along the tangent, through the boats' turning, moves the
	// normal's speed a little after its impulse: within a percent.
	if want := 0.3 * closing; math.Abs(parting-want) > 0.01*closing {
		t.Errorf("head on at %.2f m/s along the normal: part at %.4f m/s, want %.4f", closing, parting, want)
	}

	// A boat sailing into another's side at 45°, forward of its centre.
	a = State{Heading: 0}
	o = State{X: 1.9, Y: 2.2, Heading: -3 * math.Pi / 4, Surge: 2.5}
	if !h.Collide(&a, &o, b, b, e, &c) {
		t.Fatal("a glancing blow did not touch")
	}
	if a.YawRate == 0 || o.YawRate == 0 {
		t.Errorf("a glancing blow left a yawing %g, o yawing %g", a.YawRate, o.YawRate)
	}
}

// A boat at rest struck forward of its centre of gravity yaws away from
// the boat that struck it, and aft of it the other way.
func TestStruckYawsAway(t *testing.T) {
	b := jolly(t)
	e := testEncounters(t)
	var h Hulls
	for _, c := range []struct {
		name string
		y    float64
		sign float64
	}{{"forward", 1.2, -1}, {"aft", -1.2, 1}} {
		// Struck from the east, heading west.
		a := State{Heading: 0}
		o := State{X: 1.6, Y: c.y, Heading: -math.Pi / 2, Surge: 2}
		var ct Contact
		if !h.Collide(&a, &o, b, b, e, &ct) {
			t.Fatalf("%s: no contact", c.name)
		}
		if a.YawRate*c.sign <= 0 {
			t.Errorf("struck %s from starboard: yaw rate %g, want its sign %g", c.name, a.YawRate, c.sign)
		}
		if a.Sway >= 0 {
			t.Errorf("struck %s from starboard: sway %g, want to port", c.name, a.Sway)
		}
	}
}

// Boats placed a metre inside each other, at rest, are pushed apart within
// 8 ticks, never more than the cap a tick.
func TestPlacedInsideParts(t *testing.T) {
	b := jolly(t)
	e := testEncounters(t)
	var h Hulls
	a := State{Heading: 0}
	o := State{X: 0.39, Heading: 0}
	var c Contact
	if !h.Touch(&a, &o, b, b, &c) || math.Abs(c.Depth-1) > 0.01 {
		t.Fatalf("placed 1 m inside: depth %g", c.Depth)
	}
	for tick := 1; tick <= 8; tick++ {
		ax, ox := a.X, o.X
		if !h.Collide(&a, &o, b, b, e, &c) {
			break
		}
		if moved := math.Abs(a.X-ax) + math.Abs(o.X-ox); moved > e.cap+1e-12 {
			t.Errorf("tick %d: pushed %g m apart, more than the cap", tick, moved)
		}
	}
	if h.Touch(&a, &o, b, b, &c) && c.Depth > e.slop+0.001 {
		t.Errorf("after 8 ticks still %g m inside each other", c.Depth)
	}
}

func TestContactAllocatesNothing(t *testing.T) {
	b := jolly(t)
	e := testEncounters(t)
	var h Hulls
	a0, o0 := State{Heading: 0, Surge: 2}, State{X: 1.2, Y: 0.5, Heading: 0.4}
	ts := make([]Touching, 1)
	a, o := new(State), new(State)
	n := testing.AllocsPerRun(1000, func() {
		*a, *o = a0, o0
		if h.Touch(a, o, b, b, &ts[0].C) {
			ts[0].A, ts[0].B, ts[0].PA, ts[0].PB = a, o, b, b
			Resolve(ts, e)
		}
	})
	if n != 0 {
		t.Errorf("a contact allocates %v times", n)
	}
}

func BenchmarkTouch(bm *testing.B) {
	b := jolly(bm)
	var h Hulls
	a, o := State{Heading: 0, Surge: 2}, State{X: 1.2, Y: 0.5, Heading: 0.4}
	var c Contact
	for bm.Loop() {
		h.Touch(&a, &o, b, b, &c)
	}
}
