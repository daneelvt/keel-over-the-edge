// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"math/rand/v2"
	"testing"
)

// testSystems is the catalog's wind with its kinds of system set, by their
// ids, and the index of each.
func testSystems(t testing.TB) (*WeatherPrepared, map[string]int32) {
	t.Helper()
	p := testWeather(t)
	c, err := readCatalogWeather()
	if err != nil {
		t.Fatal(err)
	}
	shapes := map[string]float64{"none": ShapeNone, "dome": ShapeDome, "low": ShapeLow}
	inward := map[string]float64{"none": InwardNone, "weak": InwardWeak, "gone": InwardGone}
	index := map[string]int32{}
	for i, k := range c.Weather.Systems {
		num := func(name string) float64 { return k[name].(float64) }
		broad := k["broad"].([]any)
		sk := SystemKind{
			Shape: shapes[k["shape"].(string)], Turning: num("turning"), Width: num("width"), Ahead: num("ahead"),
			Broad: broad[0].(float64), BroadWidth: broad[1].(float64), Stretch: num("stretch"),
			Inward: inward[k["inward"].(string)], Gusts: num("gusts"),
		}
		if sw, ok := k["swell"].(map[string]any); ok {
			pair := func(v any) [2]float64 { a := v.([]any); return [2]float64{a[0].(float64), a[1].(float64)} }
			sk.SwellPeriod, sk.SwellBand, sk.SwellHeight = pair(sw["period"]), pair(sw["band"]), pair(sw["height"])
			sk.SwellWind = pair(k["wind"])
		}
		p.SetKind(int32(i), &sk)
		index[k["id"].(string)] = int32(i)
	}
	return p, index
}

// still is a spell with no wind of its own, so that what blows is the
// systems' alone: no gusts, no shifts.
func still(begin float64) Spell {
	return Spell{Begin: begin, Start: begin, Speed: 0, Gust: 1000, Pressure: 101300}
}

// withSystem is a Weather of spells and one system, the same at two
// keyframes about tick.
func withSystem(p *WeatherPrepared, tick float64, s System, spells ...Spell) *Weather {
	w := weatherOf(p, spells...)
	for k := range int32(2) {
		w.SetKeyframe(k, tick+float64(k)*300)
		w.SetSystem(k, 0, &s)
	}
	w.SetKeyCount(2)
	return w
}

// systemAt is a system of a kind at (east, north) m, moving toward heading
// degrees, of a size m, a peak in knots and a depth in hPa, at full
// strength.
func systemAt(kind int32, east, north, heading, size, peakKnots, depth float64) System {
	return System{
		On: 1, Kind: float64(kind), Seed: 1, Stage: StageMature,
		East: math.Round(east * 4), North: math.Round(north * 4), Heading: math.Round(heading * degreeSteps),
		Speed: 300, Strength: strengthSteps, Size: size,
		Peak: math.Round(peakKnots * knotSteps), Depth: math.Round(depth * 100),
	}
}

// blowsToward is the direction the air moves in, degrees clockwise from
// north, from where the wind comes from.
func blowsToward(from float64) float64 { return math.Mod(from/degree+180+720, 360) }

// bearing is the direction from (x0, y0) to (x1, y1), degrees.
func bearing(x0, y0, x1, y1 float64) float64 {
	return math.Mod(math.Atan2(x1-x0, y1-y0)/degree+720, 360)
}

// turn is the angle from a to b, degrees, clockwise positive, in [−180, 180).
func turnDeg(a, b float64) float64 { return math.Mod(b-a+540, 360) - 180 }

// A squall's wind blows out of its dome, turned 10° clockwise; a storm's
// round its low anticlockwise and in toward its centre, 20° off the
// isobars.
func TestSystemsTurnTheirWind(t *testing.T) {
	p, kinds := testSystems(t)
	cx, cy := 3.5*nm, 0.0
	for _, c := range []struct {
		kind string
		want float64 // the air's direction off straight out of the centre, degrees clockwise
	}{{"squall", 10}, {"shower", 10}, {"storm", 180 + 70}} {
		w := withSystem(p, worldTick, systemAt(kinds[c.kind], cx, cy, 90, 0.4*nm, 16, 3), still(0))
		for _, a := range []float64{0, 60, 120, 180, 240, 300} {
			// Behind the centre, where a dome is round, and a fraction of
			// its width out.
			d := 0.3 * nm
			if c.kind == "storm" {
				d = 0.6 * 0.4 * nm
			}
			if c.kind != "storm" && math.Cos(a*degree) > 0.01 {
				continue
			}
			sin, cos := math.Sincos((90 + a) * degree)
			x, y := cx+d*sin, cy+d*cos
			wp := windAt(w, x, y, worldTick)
			if wp.MeanSpeed < 0.5 {
				t.Fatalf("%s: at %.0f° only %.2f m/s", c.kind, a, wp.MeanSpeed)
			}
			out := bearing(cx, cy, x, y)
			if got := turnDeg(out, blowsToward(wp.MeanFrom)); math.Abs(turnDeg(c.want, got)) > 1 {
				t.Errorf("%s at %.0f°: the air moves %.1f° off straight out, want %.0f°", c.kind, a, got, c.want)
			}
		}
	}
}

// A dome's wind is strongest ahead, at its gust front; a low's in a ring
// near its core's width.
func TestSystemPeaks(t *testing.T) {
	p, kinds := testSystems(t)
	cx := 3.5 * nm
	size := 0.4 * nm
	w := withSystem(p, worldTick, systemAt(kinds["squall"], cx, 0, 270, size, 16, 3), still(0))
	best, at := 0.0, 0.0
	for d := -size; d <= size; d += 2 {
		if v := windAt(w, cx-d, 0, worldTick).MeanSpeed; v > best {
			best, at = v, d
		}
	}
	if math.Abs(best/knotSpeed-16) > 0.2 || at <= 0 {
		t.Errorf("the squall's wind peaks at %.2f knots %.0f m ahead; want 16 knots ahead", best/knotSpeed, at)
	}
	w = withSystem(p, worldTick, systemAt(kinds["storm"], cx, 0, 0, 2*nm, 22, 15), still(0))
	best, at = 0, 0
	for d := 10.0; d < 2*nm; d += 5 {
		if v := windAt(w, cx, d, worldTick).MeanSpeed; v > best {
			best, at = v, d
		}
	}
	if math.Abs(at/(0.6*2*nm)-1) > 0.1 || math.Abs(best/knotSpeed/22-1) > 0.1 {
		t.Errorf("the storm's wind peaks at %.1f knots %.0f m out; want about 22 knots at %.0f m", best/knotSpeed, at, 0.6*2*nm)
	}
}

// A system's wind ends where it is cut, four of its widths out, with a step
// of under a tenth of a knot; so does its pressure, by under 0.01 hPa.
func TestSystemCut(t *testing.T) {
	p, kinds := testSystems(t)
	for _, kind := range []string{"squall", "shower", "storm"} {
		size := 0.5 * nm
		s := systemAt(kinds[kind], 0, 0, 90, size, 20, 15)
		w := withSystem(p, worldTick, s, still(0))
		var at WeatherTick
		WeatherAt(w, &at, worldTick)
		st := &at.sys[0]
		// Behind it, where a dome reaches furthest.
		reach := math.Sqrt(st.cut2)
		in := windAt(w, -(reach - 0.01), 0, worldTick)
		out := windAt(w, -(reach + 0.01), 0, worldTick)
		if d := math.Abs(in.MeanSpeed - out.MeanSpeed); d > 0.1*knotSpeed {
			t.Errorf("%s: the wind steps by %.3f knots at its cut", kind, d/knotSpeed)
		}
		pin, pout := PressureAt(&at, -(reach-0.01), 0), PressureAt(&at, -(reach+0.01), 0)
		if d := math.Abs(pin - pout); d > 0.01 {
			t.Errorf("%s: the pressure steps by %.4f hPa at its cut", kind, d)
		}
	}
}

// A system weakens toward Port Royal: a storm to nothing within 0.8 NM, a
// squall to 0.35 of itself, both whole beyond 3 NM, and at 2 NM a little
// over half and seven tenths.
func TestInwardWeakening(t *testing.T) {
	p, kinds := testSystems(t)
	for _, c := range []struct {
		kind string
		r    float64 // NM
		want float64
	}{
		{"storm", 3.2, 1}, {"storm", 2, 0.55}, {"storm", 0.7, 0},
		{"squall", 3.2, 1}, {"squall", 2, 0.7}, {"squall", 0.7, 0.35},
	} {
		got := p.inwardOf(&p.kinds[kinds[c.kind]], c.r*nm)
		if math.Abs(got-c.want) > 0.03 {
			t.Errorf("%s at %.1f NM keeps %.3f of itself, want %.2f", c.kind, c.r, got, c.want)
		}
	}
}

// The refuge holds whatever comes: a storm at full strength driven over the
// centre, a squall at the refuge's edge, and a trade spell's wind with
// them, never blow over its limits within its radius.
func TestRefugeHoldsUnderSystems(t *testing.T) {
	p, kinds := testSystems(t)
	stormy := spellOfRegime(t, p, "stormy", 3, 200, 0, 4*hourOfTicks)
	for _, s := range []System{
		systemAt(kinds["storm"], 0.5*nm, 0, 0, 2.5*nm, 26, 20),
		systemAt(kinds["squall"], 0.9*nm, 0, 270, 0.6*nm, 18, 4),
	} {
		w := withSystem(p, worldTick, s, stormy)
		for x := -1.0 * nm; x <= 1.0*nm; x += 25 {
			for y := -1.0 * nm; y <= 1.0*nm; y += 25 {
				if x*x+y*y > nm*nm {
					continue
				}
				wp := windAt(w, x, y, worldTick)
				if wp.MeanSpeed > 14*knotSpeed+1e-9 || wp.Speed > 18*knotSpeed+1e-9 {
					t.Fatalf("at (%.0f, %.0f) the mean wind is %.2f knots and the wind %.2f", x, y, wp.MeanSpeed/knotSpeed, wp.Speed/knotSpeed)
				}
			}
		}
	}
}

// The wind with systems allocates nothing and is never NaN, with none, one
// or sixteen systems, and a front.
func TestSystemsAllocateNothingNorNaN(t *testing.T) {
	p, kinds := testSystems(t)
	trade := spellOfRegime(t, p, "trade", 1, 0, 0, 4*hourOfTicks)
	rng := rand.New(rand.NewPCG(3, 4))
	for _, n := range []int{0, 1, 16} {
		w := weatherOf(p, trade, frontSpell(t, p, worldTick-hourOfTicks/2))
		for k := range int32(2) {
			w.SetKeyframe(k, worldTick+float64(k)*300)
			for i := range n {
				kind := int32(i % len(kinds))
				s := systemAt(kind, (rng.Float64()-0.5)*8*nm, (rng.Float64()-0.5)*8*nm, rng.Float64()*360, (0.2+rng.Float64())*nm, 10+rng.Float64()*10, 3)
				if kind == kinds["fog"] || kind == kinds["light-air"] {
					s.Peak = 400
				}
				w.SetSystem(k, int32(i), &s)
			}
		}
		w.SetKeyCount(2)
		var at WeatherTick
		var wp WindPoint
		allocs := testing.AllocsPerRun(100, func() {
			WeatherAt(w, &at, worldTick+150)
			WindPointAt(&at, rng.Float64()*8000-4000, rng.Float64()*8000-4000, &wp, nil)
			_ = PressureAt(&at, 0, 0)
		})
		if allocs != 0 {
			t.Errorf("%d systems: %v allocations", n, allocs)
		}
		for range 20000 {
			x, y := (rng.Float64()-0.5)*9*nm, (rng.Float64()-0.5)*9*nm
			WindPointAt(&at, x, y, &wp, nil)
			pr := PressureAt(&at, x, y)
			if math.IsNaN(wp.Speed) || math.IsNaN(wp.From) || math.IsNaN(wp.MeanSpeed) || math.IsNaN(pr) {
				t.Fatalf("%d systems: NaN at (%.0f, %.0f): %+v, %v hPa", n, x, y, wp, pr)
			}
		}
	}
}

// Between two keyframes a system moves and grows evenly, and at a
// keyframe's tick it is that keyframe's exactly.
func TestKeyframesInterpolate(t *testing.T) {
	p, kinds := testSystems(t)
	a := systemAt(kinds["squall"], 3*nm, 0, 90, 0.4*nm, 16, 3)
	b := a
	b.East += 4 * 60
	b.Strength = strengthSteps / 2
	w := weatherOf(p, still(0))
	w.SetKeyframe(0, worldTick)
	w.SetSystem(0, 0, &a)
	w.SetKeyframe(1, worldTick+300)
	w.SetSystem(1, 0, &b)
	w.SetKeyCount(2)
	only := func(s System, tick float64) *Weather {
		v := weatherOf(p, still(0))
		v.SetKeyframe(0, tick)
		v.SetSystem(0, 0, &s)
		v.SetKeyCount(1)
		return v
	}
	for _, c := range []struct {
		tick float64
		s    System
	}{{worldTick, a}, {worldTick + 300, b}} {
		for _, x := range []float64{2.8 * nm, 3 * nm, 3.1 * nm} {
			got, want := windAt(w, x, 50, c.tick), windAt(only(c.s, c.tick), x, 50, c.tick)
			if got != want {
				t.Errorf("at tick %v: %+v, the keyframe's %+v", c.tick, got, want)
			}
		}
	}
	var at WeatherTick
	WeatherAt(w, &at, worldTick+150)
	if st := &at.sys[0]; math.Abs(st.cx-(3*nm+30)) > 1e-6 {
		t.Errorf("half way, the squall is at %.3f m, want %.3f", st.cx, 3*nm+30)
	}
	// A system born between two keyframes grows from nothing.
	w.Keys[0].Systems[0] = System{}
	WeatherAt(w, &at, worldTick+75)
	if at.ns != 1 || math.Abs(at.sys[0].depth-0.25*0.5*3) > 1e-9 {
		t.Errorf("a quarter of the way after its birth: %d systems, depth %v", at.ns, at.sys[0].depth)
	}
}

// A patch of light air takes the wind down to its share at its core.
func TestLightAir(t *testing.T) {
	p, kinds := testSystems(t)
	trade := spellOfRegime(t, p, "trade", 1, 0, 0, 4*hourOfTicks)
	s := systemAt(kinds["light-air"], 3*nm, 0, 0, 0.4*nm, 0, 0)
	s.Peak = 400
	open := windAt(weatherOf(p, trade), 3*nm, 0, worldTick).MeanSpeed
	got := windAt(withSystem(p, worldTick, s, trade), 3*nm, 0, worldTick).MeanSpeed
	if math.Abs(got/open-0.4) > 1e-9 {
		t.Errorf("at its core the wind is %.3f of the open wind, want 0.4", got/open)
	}
}

// frontSpell is an unsettled spell arriving by a front moving east at 6
// knots, its line crossing the centre at cross.
func frontSpell(t testing.TB, p *WeatherPrepared, cross float64) Spell {
	t.Helper()
	change := math.Round(2 * p.FrontReach() / (6 * knotSpeed) * StepsPerSecond)
	s := spellOfRegime(t, p, "unsettled", 2, 290, cross-change/2, 3*hourOfTicks)
	s.Change = change
	s.Front, s.Toward, s.Trough = 1, math.Round(100*degreeSteps), 450
	s.Pressure = 100600
	return s
}

// As a front passes, the wind backs and freshens ahead of it and veers
// sharply at the line, from the old spell's to the new one's.
func TestFrontVeers(t *testing.T) {
	p := testWeather(t)
	old := spellOfRegime(t, p, "trade", 1, 225, 0, 8*hourOfTicks)
	old.Pressure = 101500
	front := frontSpell(t, p, worldTick)
	w := weatherOf(p, old, front)
	alone := weatherOf(p, old)
	checked := 0
	for _, tick := range []float64{worldTick - 1200*30, worldTick, worldTick + 1200*30} {
		var at WeatherTick
		WeatherAt(w, &at, tick)
		if !at.front {
			t.Fatalf("at tick %v the front is not crossing", tick)
		}
		for along := -4 * nm; along <= 4*nm; along += 0.5 * nm {
			// Points on the line now, and either side of it.
			lx, ly := at.line*at.fe, at.line*at.fn
			px, py := lx-along*at.fn, ly+along*at.fe
			if r := math.Hypot(px, py); r > 3.6*nm || r < 1*nm {
				continue
			}
			ahead := windAt(w, px+0.3*nm*at.fe, py+0.3*nm*at.fn, tick)
			behind := windAt(w, px-0.3*nm*at.fe, py-0.3*nm*at.fn, tick)
			if v := turnDeg(ahead.MeanFrom/degree, behind.MeanFrom/degree); v < 40 || v > 100 {
				t.Errorf("tick %v: the wind veers %.0f° across the line, from %.0f° to %.0f°", tick, v, ahead.MeanFrom/degree, behind.MeanFrom/degree)
			}
			fx, fy := px+1*nm*at.fe, py+1*nm*at.fn
			got, was := windAt(w, fx, fy, tick), windAt(alone, fx, fy, tick)
			if turnDeg(was.MeanFrom/degree, got.MeanFrom/degree) >= 0 || got.MeanSpeed <= was.MeanSpeed {
				t.Errorf("tick %v: a mile ahead the wind is %.0f° at %.1f knots, the old spell's %.0f° at %.1f: not backed and fresher",
					tick, got.MeanFrom/degree, got.MeanSpeed/knotSpeed, was.MeanFrom/degree, was.MeanSpeed/knotSpeed)
			}
			checked++
		}
	}
	if checked == 0 {
		t.Fatal("no point checked")
	}
}

// The front's spells hand over with no step: the line enters and leaves
// the disk's reach with nothing of it on the disk.
func TestFrontEntersAndLeavesSmoothly(t *testing.T) {
	p := testWeather(t)
	old := spellOfRegime(t, p, "trade", 1, 225, 0, 8*hourOfTicks)
	front := frontSpell(t, p, worldTick)
	w := weatherOf(p, old, front)
	for _, edge := range []float64{front.Begin, front.Begin + front.Change} {
		for _, pt := range [][2]float64{{-4.4 * nm, 0}, {4.4 * nm, 0}, {0, 4.4 * nm}, {3 * nm, -3 * nm}} {
			a, b := windAt(w, pt[0], pt[1], edge-1), windAt(w, pt[0], pt[1], edge)
			if d := math.Abs(a.MeanSpeed - b.MeanSpeed); d > 0.01*knotSpeed {
				t.Errorf("at tick %v at %v the wind steps by %.3f knots", edge, pt, d/knotSpeed)
			}
			var at0, at1 WeatherTick
			WeatherAt(w, &at0, edge-1)
			WeatherAt(w, &at1, edge)
			if d := math.Abs(PressureAt(&at0, pt[0], pt[1]) - PressureAt(&at1, pt[0], pt[1])); d > 0.01 {
				t.Errorf("at tick %v at %v the pressure steps by %.3f hPa", edge, pt, d)
			}
		}
	}
}

// Buys Ballot's law: with one's back to the wind, a storm's centre lies on
// the left, wherever the storm's own wind is the greater part of the wind.
func TestBuysBallot(t *testing.T) {
	p, kinds := testSystems(t)
	trade := spellOfRegime(t, p, "trade", 1, 45, 0, 8*hourOfTicks)
	cx, cy := -3.6*nm, 0.0
	s := systemAt(kinds["storm"], cx, cy, 0, 2*nm, 22, 15)
	with, without := withSystem(p, worldTick, s, trade), weatherOf(p, trade)
	stormOnly := withSystem(p, worldTick, s, still(0))
	held, seen := 0, 0
	for r := 0.05 * nm; r < 3*nm; r += 0.05 * nm {
		for a := 0.0; a < 360; a += 10 {
			x, y := cx+r*math.Sin(a*degree), cy+r*math.Cos(a*degree)
			if math.Hypot(x, y) > 4.4*nm {
				continue
			}
			own := windAt(stormOnly, x, y, worldTick)
			rest := windAt(without, x, y, worldTick)
			if !(rest.MeanSpeed < 0.9*own.MeanSpeed) {
				continue
			}
			seen++
			wp := windAt(with, x, y, worldTick)
			left := turnDeg(blowsToward(wp.MeanFrom), bearing(x, y, cx, cy))
			if left > -135 && left < -5 {
				held++
			} else {
				t.Errorf("at (%.0f, %.0f) the centre is %.0f° off downwind", x, y, left)
			}
		}
	}
	if seen < 100 {
		t.Fatalf("only %d points where the storm is the wind", seen)
	}
}

// The barometer warns of a storm: approaching at 4.5 knots, it reads
// falling or more at least 20 minutes before the ring of strongest wind
// reaches a boat, and falling quickly at least 10 minutes before.
func TestBarometerBeforeAStorm(t *testing.T) {
	p, kinds := testSystems(t)
	settled := Spell{Begin: 0, Start: 0, Speed: 0, Gust: 1000, Pressure: 101500}
	size := 2 * nm
	ring := 0.6 * size
	speed := 4.5 * knotSpeed
	boat := [2]float64{3.5 * nm, 0}
	// The storm moves north along x = boat's, from the south; its ring
	// reaches the boat at tick 0 + T.
	pressureAt := func(tick float64) float64 {
		north := -ring + speed*Dt*(tick-worldTick)
		s := systemAt(kinds["storm"], boat[0], north, 0, size, 22, 15)
		w := weatherOf(p, settled)
		w.SetKeyframe(0, tick)
		w.SetSystem(0, 0, &s)
		w.SetKeyCount(1)
		var at WeatherTick
		WeatherAt(w, &at, tick)
		return PressureAt(&at, boat[0], boat[1])
	}
	quarter := float64(15 * minuteTicks)
	firstFalling, firstQuickly := math.NaN(), math.NaN()
	for m := 90.0; m >= 0; m-- {
		tick := worldTick - m*minuteTicks
		words, _ := Tendency(pressureAt(tick), pressureAt(tick-5*minuteTicks), pressureAt(tick-quarter))
		if words <= -TendencyPlain && math.IsNaN(firstFalling) {
			firstFalling = m
		}
		if words <= -TendencyQuickly && math.IsNaN(firstQuickly) {
			firstQuickly = m
		}
	}
	if !(firstFalling >= 20) || !(firstQuickly >= 10) {
		t.Errorf("falling %v minutes and falling quickly %v minutes before the ring arrives", firstFalling, firstQuickly)
	}
}

// The tendency's words, either side of each threshold.
func TestTendency(t *testing.T) {
	for _, c := range []struct {
		change float64
		words  int32
	}{
		{0.05, TendencySteady}, {-0.05, TendencySteady}, {0.2, TendencySlowly}, {1.5, TendencySlowly},
		{1.6, TendencyPlain}, {-3.5, -TendencyPlain}, {3.6, TendencyQuickly}, {-6, -TendencyQuickly}, {6.1, TendencyRapidly},
	} {
		if got, _ := Tendency(1000+c.change, 1000+c.change, 1000); got != c.words {
			t.Errorf("a change of %v hPa: %d, want %d", c.change, got, c.words)
		}
	}
	if w, turned := Tendency(1000, 999.5, 1002); w != -TendencyPlain || !turned {
		t.Errorf("fallen 2 hPa, risen 0.5 in the last minutes: %d, turned %v", w, turned)
	}
	if _, turned := Tendency(1000, 1000.5, 1002); turned {
		t.Error("still falling: turned")
	}
}

// A system's keyframe follows its record: on its track, born and gone at
// its times, at full strength between maturing and decaying, and a storm
// on an arc keeps its distance from the centre unless it closes.
func TestSystemAt(t *testing.T) {
	r := SystemRecord{
		Kind: 2, Seed: 9, Born: 1000, Mature: 1000 + 30*minuteTicks, Decays: 1000 + 90*minuteTicks, Gone: 1000 + 120*minuteTicks,
		Track: TrackArc, Speed: math.Round(4.5 * knotSteps), Radius: 4 * 3.6 * nm, Angle: 0, Sense: -1, Size: 2 * nm,
		Peak: 1000, Depth: 1500,
	}
	if s := SystemAt(&r, 999); s.On != 0 {
		t.Error("on before it is born")
	}
	if s := SystemAt(&r, r.Gone); s.On != 0 {
		t.Error("on once gone")
	}
	for tick := r.Born; tick < r.Gone; tick += 300 {
		s := SystemAt(&r, tick)
		d := math.Hypot(s.East/4, s.North/4)
		if math.Abs(d-3.6*nm) > 1 {
			t.Fatalf("at tick %v it is %.1f m from the centre", tick, d)
		}
		if tick >= r.Mature && tick < r.Decays && s.Strength != strengthSteps {
			t.Fatalf("at tick %v mature with strength %v", tick, s.Strength)
		}
	}
	// Anticlockwise from north: west of north after a while, moving round.
	s := SystemAt(&r, r.Born+10*minuteTicks)
	if !(s.East < 0) || math.Abs(turnDeg(s.Heading/degreeSteps, bearing(0, 0, s.East, s.North)-90)) > 0.5 {
		t.Errorf("going anticlockwise from north: at (%v, %v) heading %.0f°", s.East/4, s.North/4, s.Heading/degreeSteps)
	}
	r.Inward = math.Round(1 * knotSteps)
	near := SystemAt(&r, r.Born+60*minuteTicks)
	if d := math.Hypot(near.East/4, near.North/4); !(d < 3.6*nm-0.9*nm) {
		t.Errorf("closing at a knot, an hour on it is %.2f NM out", d/nm)
	}
	// A line, with its wobble.
	line := SystemRecord{Kind: 0, Born: 0, Mature: 600, Decays: 1200, Gone: 1800, Track: TrackLine,
		East: -4 * 4000, North: 0, Heading: math.Round(90 * degreeSteps), Speed: 500, Size: 600, Peak: 800, Depth: 300}
	a, b := SystemAt(&line, 900), SystemAt(&line, 1200)
	if (b.East-a.East)/4 != 300*Dt*5 || b.North != a.North {
		t.Errorf("along its line it moves (%v, %v) m in 300 ticks", (b.East-a.East)/4, (b.North-a.North)/4)
	}
	line.Wobble, line.WobblePeriod, line.WobblePhase = 4*0.4*nm, [2]float64{20 * minuteTicks, 37 * minuteTicks}, [2]float64{1000, 20000}
	te, tn := SystemTrack(&line, 900)
	w := SystemAt(&line, 900)
	if d := math.Hypot(w.East/4-te, w.North/4-tn); d > 0.4*nm*math.Sqrt2+1 || d == 0 {
		t.Errorf("wobbling %.1f m off its track", d)
	}
}

func BenchmarkWindAtSystems(b *testing.B) {
	p, kinds := testSystems(b)
	trade := spellOfRegime(b, p, "trade", 1, 0, 0, 4*hourOfTicks)
	rng := rand.New(rand.NewPCG(5, 6))
	for _, c := range []struct {
		name  string
		n     int
		reach float64 // how far out systems lie
	}{{"systems/4", 4, 0.5 * nm}, {"systems/16", 16, 4 * nm}, {"systems/16-in-reach", 16, 0.5 * nm}} {
		w := weatherOf(p, trade)
		for k := range int32(2) {
			w.SetKeyframe(k, worldTick+float64(k)*300)
			for i := range c.n {
				kind := kinds["squall"]
				if i%4 == 1 {
					kind = kinds["shower"]
				}
				s := systemAt(kind, (rng.Float64()-0.5)*2*c.reach, (rng.Float64()-0.5)*2*c.reach, rng.Float64()*360, 0.5*nm, 15, 3)
				w.SetSystem(k, int32(i), &s)
			}
		}
		w.SetKeyCount(2)
		b.Run(c.name, func(b *testing.B) {
			var at WeatherTick
			WeatherAt(w, &at, worldTick+100)
			xs := make([]float64, 1<<16)
			for i := range xs {
				xs[i] = (rng.Float64() - 0.5) * 1000
			}
			sum := 0.0
			i := 0
			for b.Loop() {
				sum += WindAt(&at, xs[i&65535], xs[(i+7)&65535], nil).WindSpeed
				i++
			}
			_ = sum
		})
		b.Run(c.name+"/tick", func(b *testing.B) {
			var at WeatherTick
			tick := worldTick
			for b.Loop() {
				WeatherAt(w, &at, tick)
				tick++
			}
		})
	}
	b.Run("pressure", func(b *testing.B) {
		var at WeatherTick
		WeatherAt(weatherOf(p, trade), &at, worldTick)
		sum := 0.0
		for b.Loop() {
			sum += PressureAt(&at, 1000, 2000)
		}
		_ = sum
	})
}
