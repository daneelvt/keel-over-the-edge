// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"testing"
)

// Tests of the model's parts, each against a hand calculation or the
// published figure it comes from.

func near(t *testing.T, what string, got, want, tol float64) {
	t.Helper()
	if math.Abs(got-want) > tol {
		t.Errorf("%s = %.9g, want %.9g ± %g", what, got, want, tol)
	}
}

func TestWindProfile(t *testing.T) {
	b := jolly(t)
	near(t, "wind at 10 m", b.windFactor(10), 1, 1e-15)
	// The log law: ln(3/z₀)/ln(10/z₀) with z₀ = 0.0002 m.
	near(t, "wind at 3 m", b.windFactor(3), math.Log(3/0.0002)/math.Log(10/0.0002), 1e-15)
	near(t, "wind at the floor, from above", b.windFactor(windFloor), b.windFactor(math.Nextafter(windFloor, 0)), 1e-12)
	for _, z := range []float64{0, -1, math.Inf(-1)} {
		if f := b.windFactor(z); f != 0 {
			t.Errorf("wind at %g m = %g, want 0", z, f)
		}
	}
	prev := 0.0
	for z := 0.0; z < 12; z += 0.01 {
		if f := b.windFactor(z); f < prev {
			t.Fatalf("the wind falls with height at %g m", z)
		} else {
			prev = f
		}
	}
}

// flowAt returns the flow at a point of a boat moving at u, v with no turn,
// heading north at heel φ, in a true wind of speed 10 m up from windFrom.
func flowAt(b *Prepared, u, v, heel, speed, windFrom, x, y, z float64) pointFlow {
	m := motion{u: u, v: v}
	m.sinHeel, m.cosHeel = math.Sincos(heel)
	sinW, cosW := math.Sincos(windFrom)
	m.windX, m.windY = -speed*cosW, -speed*sinW
	return b.flow(&m, x, y, z, 0, 0, true)
}

func TestApparentWind(t *testing.T) {
	b := jolly(t)
	// The sail's centre of effort, upright: its height above the water.
	z := b.effortZ
	v := 6 * b.windFactor(b.centreOfGravity-z)

	// At rest, the apparent wind is the true wind at the point's height.
	f := flowAt(b, 0, 0, 0, 6, 30*deg, 0, 0, z)
	near(t, "at rest, ahead", f.x, -v*math.Cos(30*deg), 1e-12)
	near(t, "at rest, across", f.y, -v*math.Sin(30*deg), 1e-12)

	// Head to wind at 3 m/s: the wind and the boat's own speed add.
	f = flowAt(b, 3, 0, 0, 6, 0, 0, 0, z)
	near(t, "head to wind", f.x, -(v + 3), 1e-12)
	near(t, "head to wind, across", f.y, 0, 1e-12)
	// Beam reach, the wind from the east: from starboard, blowing to port.
	f = flowAt(b, 3, 0, 0, 6, 90*deg, 0, 0, z)
	near(t, "beam reach, ahead", f.x, -3, 1e-12)
	near(t, "beam reach, across", f.y, -v, 1e-12)
	if a := math.Atan2(-f.y, -f.x); a < 0 || a > math.Pi/2 {
		t.Errorf("on a beam reach the apparent wind comes from %.1f°, not forward of the beam", a/deg)
	}
	// Dead downwind: the boat's speed comes off the wind.
	f = flowAt(b, 3, 0, 0, 6, math.Pi, 0, 0, z)
	near(t, "running", f.x, v-3, 1e-12)
}

func TestHeelScalesCrosswind(t *testing.T) {
	b := jolly(t)
	// A point at the centre of gravity keeps its height as the boat heels,
	// so heel only turns the crosswind out of the sail's plane: cos φ.
	upright := flowAt(b, 0, 0, 0, 6, 90*deg, 0, 0, 0)
	for _, heel := range []float64{10 * deg, 30 * deg, -45 * deg} {
		f := flowAt(b, 0, 0, heel, 6, 90*deg, 0, 0, 0)
		near(t, "heeled crosswind", f.y, upright.y*math.Cos(heel), 1e-12)
		near(t, "heeled wind along the boat", f.x, upright.x, 1e-12)
	}
}

func TestResistance(t *testing.T) {
	b := jolly(t)
	// Day and Nixon (2014), Figure 2, level trim, 160 kg.
	for _, c := range []struct{ knots, area float64 }{{2, 0.0125}, {4, 0.0157}, {6.5, 0.0246}, {9, 0.0206}} {
		v := c.knots * knot
		near(t, "drag area", lookup(b.dragArea[:], v, b.dragAreaInvStep), c.area, 1e-12)
		m := motion{u: v, cosHeel: 1}
		var l loads
		b.hullLoads(&m, &l)
		near(t, "resistance", -l.X, 0.5*waterDensity*c.area*v*v, 1e-9)
	}
	// Beyond the table, its last value.
	near(t, "drag area at 20 knots", lookup(b.dragArea[:], 20*knot, b.dragAreaInvStep), 0.0185, 1e-15)
}

func TestFoilLiftSlope(t *testing.T) {
	b := jolly(t)
	// Helmbold: a = 2π A / (2 + √(A² + 4)), with A twice span over chord.
	for _, c := range []struct {
		f           *foil
		span, chord float64
	}{{&b.board, 0.69, 0.34}, {&b.rudder, 0.60, 0.25}} {
		a := 2 * c.span / c.chord
		near(t, "lift slope", c.f.slope, 2*math.Pi*a/(2+math.Sqrt(a*a+4)), 1e-12)
		// At a small angle, attached flow gives exactly the slope.
		sinA, cosA := math.Sincos(2 * deg)
		cl, cd := b.foilCoefficients(c.f, 2*deg, sinA, cosA)
		near(t, "lift at 2°", cl, c.f.slope*2*deg, 1e-12)
		near(t, "drag at 2°", cd, b.foilDrag+c.f.induced*cl*cl, 1e-12)
	}
	near(t, "the board's carry-over", b.board.carry, 1+1.80*0.094/0.69, 1e-12)
}

func TestFoilContinuous(t *testing.T) {
	b := jolly(t)
	const step = 0.05 * deg
	prevL, prevD := 0.0, b.foilDrag
	for a := step; a <= math.Pi; a += step {
		sinA, cosA := math.Sincos(a)
		cl, cd := b.foilCoefficients(&b.board, a, sinA, cosA)
		// Across the stall and across a flow from behind, no jumps.
		if math.Abs(cl-prevL) > 0.02 || math.Abs(cd-prevD) > 0.02 {
			t.Fatalf("the board's coefficients jump at %.2f°: lift %.4f to %.4f, drag %.4f to %.4f", a/deg, prevL, cl, prevD, cd)
		}
		prevL, prevD = cl, cd
	}
	// Water from behind works the foil in reverse.
	sinA, cosA := math.Sincos(178 * deg)
	if cl, _ := b.foilCoefficients(&b.board, 178*deg, sinA, cosA); cl >= 0 {
		t.Errorf("with the flow from behind, lift %.3f should reverse", cl)
	}
}

func TestRudderAtRest(t *testing.T) {
	b := jolly(t)
	m := motion{cosHeel: 1}
	var l loads
	sinR, cosR := math.Sincos(b.rudderMax)
	if f := b.foilLoads(&b.rudder, &m, sinR, cosR, b.rudderInflow, b.downwash, 1, 1, &l); f != 0 || l != (loads{}) {
		t.Errorf("hard over at rest the rudder gives %g N and %+v", f, l)
	}
}

func TestSailContinuous(t *testing.T) {
	b := jolly(t)
	const step = 0.05 * deg
	cl0, cd0 := SailCoefficients(b, 0, 1)
	for a := step; a <= math.Pi; a += step {
		cl, cd := SailCoefficients(b, a, 1)
		if math.Abs(cl-cl0) > 0.02 || math.Abs(cd-cd0) > 0.02 {
			t.Fatalf("the sail's coefficients jump at %.2f°: lift %.4f to %.4f, drag %.4f to %.4f", a/deg, cl0, cl, cd0, cd)
		}
		cl0, cd0 = cl, cd
	}
	if cl, _ := SailCoefficients(b, 0, 1); cl != 0 {
		t.Errorf("a sail edge on to the flow lifts %g", cl)
	}
	if cl, cd := SailCoefficients(b, math.Pi, 1); math.Abs(cl) > 1e-12 || cd > 0.1 {
		t.Errorf("flow straight from the leech gives lift %g, drag %g", cl, cd)
	}
}

// sailAt returns the sail's forces and boom moment on a boat at rest,
// heading north, in a beam wind from the east, with the boom at boom.
func sailAt(b *Prepared, boom float64) (l loads, r sailResult) {
	s := State{Boom: boom}
	m := motion{cosHeel: 1, windY: -6}
	b.sailLoads(&s, &m, 1, b.twist(boom, 1), &l, &r)
	return l, r
}

func TestSailForceContinuousInBoomAngle(t *testing.T) {
	b := jolly(t)
	l0, r0 := sailAt(b, -b.boomOut)
	for boom := -b.boomOut; boom <= b.boomOut; boom += 0.05 * deg {
		l, r := sailAt(b, boom)
		if math.Abs(l.X-l0.X) > 2 || math.Abs(l.Y-l0.Y) > 2 || math.Abs(r.boomMoment-r0.boomMoment) > 2 {
			t.Fatalf("the sail's force jumps at a boom angle of %.2f°: %+v to %+v", boom/deg, l0, l)
		}
		l0, r0 = l, r
	}
}

func TestNoWindNoForce(t *testing.T) {
	b := jolly(t)
	for _, boom := range []float64{0, 0.5, -1.2} {
		s := State{Boom: boom}
		m := motion{cosHeel: 1}
		var l loads
		var r sailResult
		b.sailLoads(&s, &m, 1, b.twist(boom, 1), &l, &r)
		if l != (loads{}) || r.boomMoment != 0 {
			t.Errorf("a sail in no wind at %g rad gives %+v, boom moment %g", boom, l, r.boomMoment)
		}
	}
}

func TestBoom(t *testing.T) {
	// Let fly on a beam reach: the boom swings out until the sail luffs.
	m := newSim(t, 15*knot, 90, 1)
	m.run(30, nil)
	if math.Abs(m.s.Boom) >= m.s.SheetLimit {
		t.Errorf("let fly, the boom is on its stop at %.1f°", m.s.Boom/deg)
	}
	if mean := (m.o.FootAttack + m.o.HeadAttack) / 2; math.Abs(mean) > 3*deg {
		t.Errorf("let fly, the sail meets the wind at %.1f°, not luffing", mean/deg)
	}

	// Trimmed close-hauled, it rests on the sheet's stop, drawing.
	m = newSim(t, windAtSail(9), 45, 0.02)
	m.run(30, nil)
	if m.s.Boom != m.s.SheetLimit {
		t.Errorf("trimmed, the boom is at %.2f°, its stop at %.2f°", m.s.Boom/deg, m.s.SheetLimit/deg)
	}
	if m.o.FootFlow != FlowAttached && m.o.FootFlow != FlowStalled {
		t.Errorf("trimmed, the foot's flow is %g", m.o.FootFlow)
	}

	// With the wind behind its leech, it swings across: 40° by the lee with
	// the boom still out to starboard.
	m = newSim(t, windAtSail(12), 220, 0.9)
	m.s.Boom = 80 * deg
	m.run(5, nil)
	if m.s.Boom > 0 {
		t.Errorf("40° by the lee, the boom stayed out to starboard at %.1f°", m.s.Boom/deg)
	}
}
