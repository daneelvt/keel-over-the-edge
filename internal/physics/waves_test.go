// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"math/rand/v2"
	"slices"
	"testing"
)

// The boat in waves: physical facts, each checked within a tolerance.

// atRest is the Jolly boat lying still in no wind, heading heading degrees.
func atRest(t testing.TB, heading float64) *sim {
	t.Helper()
	m := &sim{t: t, b: jolly(t)}
	m.s.Heading = heading * deg
	m.s.SheetLimit = m.b.boomOut
	m.c.Sheet = 1
	return m
}

// swing measures a value that swings at a known period: its amplitude and
// its phase, by its first harmonic over whole periods.
type swing struct{ sin, cos, n float64 }

func (w *swing) add(value, angle float64) {
	w.sin += value * math.Sin(angle)
	w.cos += value * math.Cos(angle)
	w.n++
}

func (w *swing) amplitude() float64 { return 2 * math.Hypot(w.sin, w.cos) / w.n }
func (w *swing) phase() float64     { return math.Atan2(w.cos, w.sin) }

// A wave much longer than the boat lifts and tilts it as the water itself
// rises and tilts: a dinghy's own heave and pitch periods are under a
// second, a 60 m wave's is over six.
func TestLongWavesAreFollowed(t *testing.T) {
	const length, a = 60.0, 0.5
	k := 2 * math.Pi / length
	omega := math.Sqrt(gravity * k)
	m := atRest(t, 0).in(oneWave(length, a, 0))
	m.run(30, nil)
	var heave, surface, pitch, slope swing
	periods := 4.0
	m.run(periods*2*math.Pi/omega, func() {
		angle := omega * m.time
		heave.add(m.s.Heave, angle)
		surface.add(m.o.WaveHeight, angle)
		pitch.add(m.s.Pitch, angle)
		slope.add(m.o.WaveSlopeAhead, angle)
	})
	t.Logf("heave %.3f m against the wave's %.3f m, %.1f° behind; pitch %.2f° against the slope's %.2f°, %.1f° behind",
		heave.amplitude(), surface.amplitude(), math.Remainder(surface.phase()-heave.phase(), 2*math.Pi)/deg,
		pitch.amplitude()/deg, slope.amplitude()/deg, math.Remainder(slope.phase()-pitch.phase(), 2*math.Pi)/deg)
	if got := heave.amplitude(); math.Abs(got-a) > 0.1*a {
		t.Errorf("the boat heaves %.3f m on a wave of %.3f m", got, a)
	}
	if d := math.Remainder(heave.phase()-surface.phase(), 2*math.Pi); math.Abs(d) > 10*deg {
		t.Errorf("the heave is %.1f° out of step with the wave", d/deg)
	}
	if got, want := pitch.amplitude(), a*k; math.Abs(got-want) > 0.1*want {
		t.Errorf("the boat pitches %.2f° on a slope of %.2f°", got/deg, want/deg)
	}
	if d := math.Remainder(pitch.phase()-slope.phase(), 2*math.Pi); math.Abs(d) > 10*deg {
		t.Errorf("the pitch is %.1f° out of step with the slope", d/deg)
	}
}

// A wave about as long as the hull lifts it less than a long one of the
// same height: the hull spans its crest and trough at once.
func TestShortWavesAreFiltered(t *testing.T) {
	heave := func(length float64) float64 {
		m := atRest(t, 0).in(oneWave(length, 0.1, 0))
		m.run(20, nil)
		lo, hi := math.Inf(1), math.Inf(-1)
		m.run(10, func() { lo, hi = min(lo, m.s.Heave), max(hi, m.s.Heave) })
		return (hi - lo) / 2
	}
	long, short, hull := heave(60), heave(8), heave(2*jolly(t).halfLength)
	t.Logf("heave on waves of 0.1 m: %.3f m at 60 m, %.3f m at 8 m, %.4f m at the hull's own length", long, short, hull)
	if !(short < 0.9*long) {
		t.Errorf("an 8 m wave heaves the boat %.3f m, a 60 m one %.3f m", short, long)
	}
	if !(hull < 0.1*long) {
		t.Errorf("a wave as long as the hull heaves the boat %.3f m", hull)
	}
}

// Dropped into calm water the hull settles within two of its own heave
// periods, without bouncing much.
func TestReleasedHeaveSettles(t *testing.T) {
	b := jolly(t)
	period := 2 * math.Pi / math.Sqrt(b.heaveStiffness*b.invHeaveMass)
	pitchPeriod := 2 * math.Pi / math.Sqrt(b.pitchStiffness*b.invPitchInertia)
	t.Logf("the hull's own periods: %.2f s in heave, %.2f s in pitch", period, pitchPeriod)
	if period < 0.5 || period > 1.5 || pitchPeriod < 0.5 || pitchPeriod > 1.5 {
		t.Errorf("a dinghy's heave and pitch periods are about a second, not %.2f s and %.2f s", period, pitchPeriod)
	}
	m := atRest(t, 0).in(openSea(t, 0, 0, 6))
	m.s.Heave, m.s.Pitch = 0.2, 5*deg
	var lowest, bowDown float64
	m.run(2*period, func() { lowest = min(lowest, m.s.Heave) })
	if math.Abs(m.s.Heave) > 0.01 {
		t.Errorf("after two periods the hull is still %.3f m from where it floats", m.s.Heave)
	}
	if lowest < -0.25*0.2 {
		t.Errorf("the hull overshot by %.3f m of the 0.2 m it was dropped", -lowest)
	}
	m = atRest(t, 0).in(openSea(t, 0, 0, 6))
	m.s.Pitch = 5 * deg
	m.run(2*pitchPeriod, func() { bowDown = min(bowDown, m.s.Pitch) })
	if math.Abs(m.s.Pitch) > 0.25*deg || bowDown < -0.25*5*deg {
		t.Errorf("released at 5° of pitch: %.2f° after two periods, having swung to %.2f°", m.s.Pitch/deg, bowDown/deg)
	}
	// Little else moved: the pitching mast fans the still air, no more.
	if math.Hypot(m.s.X, m.s.Y) > 0.01 || m.s.Heel != 0 || m.s.Heading != 0 {
		t.Errorf("a released pitch moved the boat: %+v", m.s)
	}
}

// Lying across a long swell the boat rolls with it: the heel swings at the
// wave's period and follows the slope of the surface under the hull.
func TestBeamSeaRollsTheBoat(t *testing.T) {
	const length, a = 30.0, 0.3
	k := 2 * math.Pi / length
	omega := math.Sqrt(gravity * k)
	// The boat heads north, the wave travels east: from port to starboard.
	m := atRest(t, 0).in(oneWave(length, a, math.Pi/2))
	m.run(40, nil)
	var heel, slope swing
	var crossings []float64
	last := m.s.Heel
	m.run(8*2*math.Pi/omega, func() {
		angle := omega * m.time
		heel.add(m.s.Heel, angle)
		// Starboard down where the surface falls toward starboard.
		slope.add(-m.o.WaveSlopeAcross, angle)
		if last < 0 && m.s.Heel >= 0 {
			crossings = append(crossings, m.time)
		}
		last = m.s.Heel
	})
	if len(crossings) < 6 {
		t.Fatalf("the heel crossed upright %d times in eight wave periods", len(crossings))
	}
	period := (crossings[len(crossings)-1] - crossings[0]) / float64(len(crossings)-1)
	lag := math.Remainder(slope.phase()-heel.phase(), 2*math.Pi)
	t.Logf("heel ±%.1f° on a slope of ±%.1f°, every %.2f s (the wave's %.2f s), %.0f° behind the slope",
		heel.amplitude()/deg, slope.amplitude()/deg, period, 2*math.Pi/omega, lag/deg)
	if want := 2 * math.Pi / omega; math.Abs(period-want) > 0.05*want {
		t.Errorf("the boat rolls every %.2f s in a wave of %.2f s", period, want)
	}
	// The sailor hikes against the roll, so the boat rolls less than the
	// surface tilts; a boat left to itself rolls more.
	if got, want := heel.amplitude(), slope.amplitude(); got < 0.25*want || got > 2*want {
		t.Errorf("the boat rolls ±%.1f° on a slope of ±%.1f°", got/deg, want/deg)
	}
	if math.Abs(lag) > 45*deg {
		t.Errorf("the roll is %.0f° out of step with the slope", lag/deg)
	}
}

// percentile returns the p-th percentile of xs, which it sorts.
func percentile(xs []float64, p float64) float64 {
	slices.Sort(xs)
	return xs[min(int(p*float64(len(xs))), len(xs)-1)]
}

// Off the wind in a sea the boat surfs: caught by a wave's face it runs
// faster than it could in flat water in the same wind. Running in 20 knots,
// and broad reaching in a gale: dead before a gale the Jolly boat rolls over
// in flat water too.
func TestSurfing(t *testing.T) {
	for _, c := range []struct {
		name           string
		knots, heading float64
	}{{"running in 20 knots", 20, 180}, {"broad reaching in a gale", 34, 135}} {
		run := func(sea *ocean) (speeds []float64, m *sim) {
			m = newSim(t, c.knots*knot, c.heading, 0.9)
			if sea != nil {
				m.in(sea)
			}
			m.run(20, nil)
			m.run(120, func() { speeds = append(speeds, m.speed()) })
			if m.maxMode != Sailing {
				t.Fatalf("%s: the boat capsized", c.name)
			}
			return speeds, m
		}
		flat, _ := run(nil)
		waves, m := run(openSea(t, c.knots, 0, 6))
		steady := percentile(slices.Clone(flat), 0.5)
		faster := 0
		for _, v := range waves {
			if v > steady {
				faster++
			}
		}
		share := float64(faster) / float64(len(waves))
		f90, w90 := percentile(flat, 0.9), percentile(slices.Clone(waves), 0.9)
		t.Logf("%s: %.1f knots in flat water; in its sea faster %.0f%% of the time, 10th to 90th percentile %.1f to %.1f knots, fastest %.1f, heel to %.0f°",
			c.name, steady/knot, 100*share, percentile(slices.Clone(waves), 0.1)/knot, w90/knot, slices.Max(waves)/knot, m.maxHeel)
		if share < 0.2 {
			t.Errorf("%s: faster than in flat water %.0f%% of the time, want a fifth at least", c.name, 100*share)
		}
		if !(w90 > 1.05*f90) {
			t.Errorf("%s: 90th percentile of speed %.2f m/s in waves, %.2f m/s in flat water", c.name, w90, f90)
		}
		// Surfing is a burst, not flight: a dinghy this size tops out near
		// 16 knots.
		if top := slices.Max(waves); top > 16*knot {
			t.Errorf("%s: %.1f knots at its fastest", c.name, top/knot)
		}
	}
}

// Beating into a breeze's chop costs a little: the waves never help a boat
// to windward.
func TestUpwindInWaves(t *testing.T) {
	vmg := func(sea *ocean) float64 {
		m := newSim(t, windAtSail(12), 42, 0.05)
		if sea != nil {
			m.in(sea)
		}
		m.run(30, nil)
		y := m.windward()
		m.run(120, nil)
		if m.maxMode != Sailing {
			t.Fatalf("the boat capsized beating in 12 knots")
		}
		return (m.windward() - y) / 120
	}
	flat := vmg(nil)
	waves := vmg(openSea(t, windAtSail(12)/knot, 0, 6))
	t.Logf("VMG close-hauled in 12 knots: %.2f knots in flat water, %.2f knots in its sea", flat/knot, waves/knot)
	if waves > flat*1.005 {
		t.Errorf("VMG %.3f m/s in waves, %.3f m/s in flat water", waves, flat)
	}
	if waves < 0.7*flat {
		t.Errorf("the chop of a breeze takes %.0f%% of the VMG", 100*(1-waves/flat))
	}
}

// With no waves the boat sails exactly as in flat water: a calm sea and no
// sea give the same numbers, and the hull neither heaves nor pitches.
func TestNoSeaNoChange(t *testing.T) {
	var sf scenarioFile
	readJSON(t, scenariosFile, &sf)
	b := jolly(t)
	calm := openSea(t, 0, 0, 6)
	for _, sc := range sf.Scenarios {
		if sc.Sea != nil {
			continue
		}
		var (
			s, s2 State
			c     Control
			e     Env
			o, o2 Out
		)
		setFields(&s, sc.State)
		setFields(&c, sc.Control)
		setFields(&e, sc.Env)
		s2 = s
		for i := range min(sc.Steps, 1200) {
			Step(&s, &c, &e, nil, b, &o)
			Step(&s2, &c, &e, calm.at(7.4e8+float64(i)), b, &o2)
			if s != s2 || o != o2 {
				t.Fatalf("%s, step %d: a calm sea differs from flat water:\n flat %+v\n calm %+v", sc.Name, i, s, s2)
			}
			if s.Heave != 0 || s.HeaveRate != 0 || s.Pitch != 0 || s.PitchRate != 0 {
				t.Fatalf("%s, step %d: the hull moved in flat water: %+v", sc.Name, i, s)
			}
			if o.WaveHeight != 0 || o.WaveSlopeAhead != 0 || o.WaveSlopeAcross != 0 || o.SpeedThroughWater != o.SpeedOverGround {
				t.Fatalf("%s, step %d: waves in flat water: %+v", sc.Name, i, o)
			}
		}
	}
}

// Waves move the water round and back to where it was, and a boat lying in
// them with it: left alone in a gale's sea with no wind, it does not sail
// away.
func TestNoDriftAtRest(t *testing.T) {
	m := atRest(t, 60).in(openSea(t, 34, 0, 6))
	fastest := 0.0
	const window = 300 // ten seconds of steps
	var xs, ys []float64
	m.run(600, func() {
		xs, ys = append(xs, m.s.X), append(ys, m.s.Y)
		if n := len(xs); n > window {
			fastest = max(fastest, math.Hypot(xs[n-1]-xs[n-1-window], ys[n-1]-ys[n-1-window])/(window*Dt))
		}
	})
	drift := math.Hypot(m.s.X, m.s.Y) / 600
	t.Logf("ten minutes in the gale's sea: %.0f m from the start (%.3f m/s), fastest over ten seconds %.2f m/s, heel to %.0f°", math.Hypot(m.s.X, m.s.Y), drift, fastest, m.maxHeel)
	if drift > 0.3 {
		t.Errorf("the boat drifts at %.2f m/s over ten minutes", drift)
	}
	if m.maxMode != Sailing {
		t.Errorf("the boat capsized lying in the waves with no wind")
	}
}

// person steers as someone at the tiller does, for a heading in degrees:
// the helm follows how far off course the boat was seen to be a third of a
// second ago, and moves no faster than a hand does. The tests' heading-hold
// (steer) sees the rate of turn and answers at once; nobody sails like that.
func person(heading float64) func(s *State) float64 {
	const late = 10 // steps
	var seen [late]float64
	n, helm := 0, 0.0
	return func(s *State) float64 {
		seen[n%late] = s.Heading
		n++
		was := seen[0]
		if n >= late {
			was = seen[n%late]
		}
		want := max(-1, min(1, math.Remainder(heading*deg-was, 2*math.Pi)))
		helm += max(-2*Dt, min(2*Dt, want-helm))
		return helm
	}
}

// A boat left alone with its sheet eased rounds up until the sail is on the
// edge of luffing and all but stops. Steered for a beam reach from there it
// must get under way in a sea as readily as in flat water: the waves must
// not shake the last drive off a slow boat and leave it lying stopped, with
// no flow over its rudder to steer it out by. Winds from 6 to 20 knots,
// three sheets, three waits and several of the sea's times; a getaway fails
// when after half a minute at the helm the boat still makes less than a
// fifth of the wind's speed.
func TestGettingUnderWayInWaves(t *testing.T) {
	ticks := []float64{7.4e8, 7.4e8 + 1234567, 7.4e8 + 7654321, 2.2e9}
	waits := []float64{20, 60, 180}
	if testing.Short() {
		ticks, waits = ticks[:1], waits[:2]
	}
	fails := func(knots, sheet, wait float64, sea *ocean, tick float64) bool {
		m := &sim{t: t, b: jolly(t)}
		// As a boat appears: heading east, at rest, in a wind from the north.
		m.e.WindSpeed, m.s.Heading, m.c.Sheet = knots*knot, 90*deg, sheet
		if sea != nil {
			m.in(sea)
			m.tick = tick
		}
		m.run(wait, nil)
		helm := person(90)
		sum, n := 0.0, 0
		for i := range 60 * StepsPerSecond {
			m.c.Helm = helm(&m.s)
			m.step()
			if i >= 30*StepsPerSecond {
				sum += m.speed()
				n++
			}
		}
		return sum/float64(n) < 0.2*knots*knot
	}
	var flat, waves, flatRuns, wavesRuns int
	for _, knots := range []float64{6, 8, 10, 12, 15, 20} {
		sea := openSea(t, knots, 0, 6)
		var f, w int
		for _, sheet := range []float64{0.4, 0.5, 0.6} {
			for _, wait := range waits {
				flatRuns++
				if fails(knots, sheet, wait, nil, 0) {
					f++
				}
				for _, tick := range ticks {
					wavesRuns++
					if fails(knots, sheet, wait, sea, tick) {
						w++
					}
				}
			}
		}
		t.Logf("%2.0f knots: %d of %d getaways fail in flat water, %d of %d in its sea", knots, f, 3*len(waits), w, 3*len(waits)*len(ticks))
		flat, waves = flat+f, waves+w
	}
	inFlat, inWaves := float64(flat)/float64(flatRuns), float64(waves)/float64(wavesRuns)
	t.Logf("%.0f%% of getaways fail in flat water, %.0f%% in waves", 100*inFlat, 100*inWaves)
	if inWaves > inFlat+0.1 {
		t.Errorf("%.0f%% of getaways fail in waves, %.0f%% in flat water: the sea holds a stopped boat", 100*inWaves, 100*inFlat)
	}
}

// The moment along the hull, for a kind that takes all of it, is that of
// the sway push spread evenly along the waterline: summed here from the
// sea's own slope at points along the centreline.
func TestWaveYawMoment(t *testing.T) {
	b := *jolly(t)
	b.waveYaw = b.waveSway
	sea := openSea(t, 10, 0, 6).at(7.4e8)
	length := 2 * b.halfLength
	for _, c := range []struct{ x, y, heading float64 }{{0, 0, 60}, {13, -7, 60}, {40, 5, 20}, {-9, 31, 135}} {
		s := State{X: c.x, Y: c.y, Heading: c.heading * deg}
		sinH, cosH := math.Sincos(s.Heading)
		var v wave
		v.read(sea, &s, sinH, cosH, b.halfLength, b.halfBeam, &b.foilDecay)
		v.twist *= b.twistArm
		var l loads
		b.waveLoads(&v, &l)
		const n = 400
		want := 0.0
		for i := range n {
			along := (float64(i)+0.5)/n*length - b.halfLength
			p := SeaSample(sea, c.x+along*sinH, c.y+along*cosH)
			// The slope rising toward starboard pushes the hull to port.
			push := -b.waveSway / length * (p.East*cosH - p.North*sinH)
			want += along * push * length / n
		}
		t.Logf("at (%.0f, %.0f) heading %.0f°: %.2f N·m, %.2f N·m summed along the hull", c.x, c.y, c.heading, l.N, want)
		if math.Abs(l.N-want) > 0.1*math.Abs(want)+0.5 {
			t.Errorf("at (%.0f, %.0f) heading %.0f°: a moment of %.2f N·m, %.2f N·m summed along the hull", c.x, c.y, c.heading, l.N, want)
		}
	}
	// The Jolly boat takes none of it.
	if got := jolly(t).waveYaw; got != 0 {
		t.Errorf("the Jolly boat's share of the moment is %v N, not none", got)
	}
}

// Seeded random controls, winds and seas from calm to 60 knots, at a tick
// anywhere in a world's life: the state stays finite and the boat below
// 20 m/s.
func TestRandomSeasStayFinite(t *testing.T) {
	b := jolly(t)
	w := testWaves(t)
	rng := rand.New(rand.NewPCG(21, 22))
	win := newWindow(seaMiddle-1, seaMiddle-1, 3)
	sea := &ocean{Sea: Sea{Waves: w, Window: win}}
	sea.Tick = &sea.tick
	tick := math.Floor(rng.Float64() * (1 << 52))
	s := State{SheetLimit: b.boomIn, Surge: 1}
	var (
		c Control
		e Env
		o Out
	)
	for i := range 10_000 {
		if i%(30+rng.IntN(270)) == 0 {
			c = Control{Helm: 2*rng.Float64() - 1, Sheet: rng.Float64()}
			e = Env{WindSpeed: 60 * knot * rng.Float64(), WindFrom: (2*rng.Float64() - 1) * math.Pi}
			for a := range int32(9) {
				SeaArea(w, win, a, SeaInputOf(60*knot*rng.Float64(), 2*math.Pi*rng.Float64(), 12*nauticalMile*rng.Float64()))
			}
			win.Seal()
		}
		Step(&s, &c, &e, sea.at(tick), b, &o)
		tick++
		for _, v := range append(fields(&s), fields(&o)...) {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				t.Fatalf("step %d: not finite: %+v %+v", i, s, o)
			}
		}
		if v := math.Hypot(s.Surge, s.Sway); v > 20 {
			t.Fatalf("step %d: %.1f m/s", i, v)
		}
		if math.Abs(s.Heave) > 10 || math.Abs(s.Pitch) > 1 {
			t.Fatalf("step %d: heave %.1f m, pitch %.0f°", i, s.Heave, s.Pitch/deg)
		}
	}
}

// mirrorSea returns the sea turned east for west: every wave's direction
// mirrored, with the amplitudes it had.
func mirrorSea(o *ocean) *ocean {
	w := *o.Waves
	for i := range SeaComponents {
		w.East[i], w.kEast[i] = -w.East[i], -w.kEast[i]
	}
	m := &ocean{Sea: Sea{Waves: &w, Window: o.Window}}
	m.Tick = &m.tick
	return m
}

// Port and starboard are mirrors in waves too: a boat in the mirrored sea
// sails the mirrored course.
func TestMirrorSymmetryInWaves(t *testing.T) {
	b := jolly(t)
	for _, c := range []struct {
		name           string
		knots, heading float64
		sheet          float64
	}{{"beat", 12, 42, 0.05}, {"reach", 20, 95, 0.4}, {"run", 34, 165, 0.9}} {
		sea := openSea(t, c.knots, 0.3, 6)
		twin := mirrorSea(sea)
		s := State{Heading: c.heading * deg, Surge: 2, SheetLimit: 0.5, Boom: 0.5, X: 37, Y: -12}
		m := mirror(s)
		ctl := Control{Sheet: c.sheet}
		e := Env{WindSpeed: c.knots * knot, WindFrom: 0.3}
		me := Env{WindSpeed: e.WindSpeed, WindFrom: -e.WindFrom}
		var o Out
		for i := range 1800 {
			tick := 7.4e8 + float64(i)
			ctl.Helm = steer(c.heading*deg, &s)
			Step(&s, &ctl, &e, sea.at(tick), b, &o)
			mc := Control{Helm: -ctl.Helm, Sheet: ctl.Sheet}
			Step(&m, &mc, &me, twin.at(tick), b, &o)
			p, q := s, mirror(m)
			for _, d := range []float64{
				p.X - q.X, p.Y - q.Y, math.Remainder(p.Heading-q.Heading, 2*math.Pi), p.Surge - q.Surge,
				p.Sway - q.Sway, p.YawRate - q.YawRate, math.Remainder(p.Heel-q.Heel, 2*math.Pi), p.RollRate - q.RollRate,
				p.Boom - q.Boom, p.BoomRate - q.BoomRate, p.Sailor - q.Sailor, p.Rudder - q.Rudder,
				p.SheetLimit - q.SheetLimit, p.SailorMode - q.SailorMode, p.SailorTimer - q.SailorTimer,
				p.Heave - q.Heave, p.HeaveRate - q.HeaveRate, p.Pitch - q.Pitch, p.PitchRate - q.PitchRate,
			} {
				if math.Abs(d) > 1e-12 {
					t.Fatalf("%s, step %d: the mirrored run differs by %g:\n plain    %+v\n mirrored %+v", c.name, i, d, p, q)
				}
			}
		}
	}
}

// Four substeps are close to thirty-two in waves as in flat water, until
// the sailor first falls in.
func TestSubstepsConvergeInWaves(t *testing.T) {
	b := jolly(t)
	for _, c := range []struct {
		name           string
		knots, heading float64
		sheet          float64
	}{{"breeze, beating", 12, 42, 0.05}, {"breeze, reaching", 12, 90, 0.4}, {"gale, reaching", 34, 100, 1}, {"gale, running", 34, 170, 1}} {
		sea := openSea(t, c.knots, 0, 6)
		run := func(n int32) []State {
			s := State{Heading: c.heading * deg, Surge: 2, SheetLimit: b.boomIn + c.sheet*(b.boomOut-b.boomIn)}
			s.Boom = s.SheetLimit
			ctl := Control{Sheet: c.sheet}
			e := Env{WindSpeed: c.knots * knot}
			var o Out
			var out []State
			for i := range 600 {
				ctl.Helm = steer(c.heading*deg, &s)
				step(&s, &ctl, &e, sea.at(7.4e8+float64(i)), b, &o, n)
				out = append(out, s)
			}
			return out
		}
		four, fine := run(Substeps), run(32)
		var pos, heel, heave, pitch float64
		sailed := 0
		for i := range four {
			if four[i].SailorMode != Sailing || fine[i].SailorMode != Sailing {
				break
			}
			sailed++
			pos = max(pos, math.Hypot(four[i].X-fine[i].X, four[i].Y-fine[i].Y))
			heel = max(heel, math.Abs(math.Remainder(four[i].Heel-fine[i].Heel, 2*math.Pi)))
			heave = max(heave, math.Abs(four[i].Heave-fine[i].Heave))
			pitch = max(pitch, math.Abs(four[i].Pitch-fine[i].Pitch))
		}
		t.Logf("%s: over %.0f s, %d substeps are %.3f m, %.2f° of heel, %.3f m of heave and %.2f° of pitch from 32", c.name, float64(sailed)*Dt, Substeps, pos, heel/deg, heave, pitch/deg)
		if pos > 0.2 || heel > 1*deg || heave > 0.02 || pitch > 0.5*deg {
			t.Errorf("%s: %d substeps are %.3f m, %.2f° of heel, %.3f m of heave and %.2f° of pitch from 32", c.name, Substeps, pos, heel/deg, heave, pitch/deg)
		}
	}
}

// A step in a sea allocates nothing, as in flat water.
func TestStepInWavesAllocatesNothing(t *testing.T) {
	b := jolly(t)
	sea := openSea(t, 34, 0, 6)
	s := State{Heading: 1, Surge: 2, SheetLimit: 0.5}
	c := Control{Helm: 0.3, Sheet: 0.4}
	e := Env{WindSpeed: 17, WindFrom: 2}
	var o Out
	tick := 7.4e8
	if n := testing.AllocsPerRun(1000, func() { Step(&s, &c, &e, sea.at(tick), b, &o); tick++ }); n != 0 {
		t.Errorf("a step in waves allocates %v times", n)
	}
}
