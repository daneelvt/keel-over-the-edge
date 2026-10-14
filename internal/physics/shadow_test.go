// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"testing"
)

// heldSource is a boat held at an apparent wind angle of awa off its
// starboard bow in a true wind of 5 m/s from the north: its heading, and
// its speed through the water to make that apparent wind, sailing at 40°
// to the true wind with the speed that gives.
func heldSource(t *testing.T, b *Prepared, e *EncounterPrepared, awa float64) (State, Env, Wake) {
	t.Helper()
	env := Env{WindSpeed: 5, WindFrom: 0}
	// At rest, the apparent wind is the true: heading −awa off the wind.
	s := State{Heading: -awa, SheetLimit: 0.3, Boom: -0.3}
	w := WakeOf(&s, &env, b, e)
	return s, env, w
}

// at is the point s rig heights along wake w's axis and c across it.
func at(w *Wake, s, c float64) (x, y float64) {
	return w.X + w.Height*(s*w.East+c*w.North), w.Y + w.Height*(s*w.North-c*w.East)
}

// shadowed is the wind at (x, y) in the shadow of w alone.
func shadowed(w *Wake, env Env, x, y float64, e *EncounterPrepared) Env {
	var src Sources
	src.Consider(w, 1, x, y, e)
	ShadowAt(&env, x, y, &src, e)
	return env
}

// On the wake's axis behind a source held at 20° apparent: the deficit is
// A at one rig height, A × 2^(−2/3) at two and nothing at ten; a boat
// length to the side at one rig height the wind is back to 98%; the header
// is 4° at three rig heights (Richards and others 2012).
func TestShadowOnTheAxis(t *testing.T) {
	b := jolly(t)
	e := testEncounters(t)
	_, env, w := heldSource(t, b, e, 20*degree)
	if math.Abs(w.Height-b.mastHeight) > 1e-12 {
		t.Fatalf("an upright rig's wake scales with %g m, not the mast's %g m", w.Height, b.mastHeight)
	}
	for _, c := range []struct {
		s, want float64
	}{{1, 1 - e.deficit}, {2, 1 - e.deficit*math.Pow(2, -2.0/3)}, {10, 1}} {
		x, y := at(&w, c.s, 0)
		got := shadowed(&w, env, x, y, e).WindSpeed / env.WindSpeed
		if math.Abs(got-c.want) > 1e-9 {
			t.Errorf("%g rig heights behind: %.4f of the wind, want %.4f", c.s, got, c.want)
		}
	}
	x, y := at(&w, 1, 4.2/w.Height)
	if got := shadowed(&w, env, x, y, e).WindSpeed / env.WindSpeed; got < 0.98 {
		t.Errorf("a boat length to the side at one rig height: %.4f of the wind, want at least 0.98", got)
	}
	x, y = at(&w, 3, 0)
	header := shadowed(&w, env, x, y, e).WindFrom - env.WindFrom
	// The source's wind comes over its starboard side; turned toward its
	// bow, the direction it comes from backs.
	if math.Abs(header+4*degree) > 0.5*degree {
		t.Errorf("three rig heights behind: the wind turned %.2f°, want −4° ± 0.5°", header/degree)
	}
}

// The wake lies along the apparent wind, not the true. A source beating
// at 40° to the true wind at 2.3 m/s in 5.1 m/s has its apparent wind 12°
// off the true wind's line; with its deflection toward its windward side,
// its wake runs 17° to 18° off it. A boat in the true wind's line three
// rig heights behind loses under a tenth of what one on the axis loses.
func TestShadowFollowsTheApparentWind(t *testing.T) {
	b := jolly(t)
	e := testEncounters(t)
	env := Env{WindSpeed: 5.1, WindFrom: 0}
	s := State{Heading: 40 * degree, Surge: 2.3, Boom: -0.15}
	w := WakeOf(&s, &env, b, e)
	// The true wind blows toward the south: the wake's axis off that line.
	off := math.Abs(math.Atan2(w.East, -w.North)) / degree
	if off < 16 || off > 19 {
		t.Errorf("the wake runs %.1f° off the true wind's line, want 17° to 18°", off)
	}
	ax, ay := -env.WindSpeed*math.Sin(env.WindFrom)-2.3*math.Sin(s.Heading), -env.WindSpeed*math.Cos(env.WindFrom)-2.3*math.Cos(s.Heading)
	apparent := math.Abs(math.Atan2(ax, -ay)) / degree
	if apparent < 11 || apparent > 13 {
		t.Errorf("the apparent wind is %.1f° off the true wind's line, want 12°", apparent)
	}
	axis := 3 * w.Height
	ox, oy := at(&w, 3, 0)
	onAxis := 1 - shadowed(&w, env, ox, oy, e).WindSpeed/env.WindSpeed
	tx, ty := w.X, w.Y-axis
	onTrue := 1 - shadowed(&w, env, tx, ty, e).WindSpeed/env.WindSpeed
	if !(onTrue < onAxis/10) {
		t.Errorf("in the true wind's line: %.3f lost, on the axis %.3f", onTrue, onAxis)
	}
}

// A capsized rig casts no wake; a boat upwind of the source, or beyond its
// reach, feels none; and the wind is continuous at the reach's end.
func TestShadowBounds(t *testing.T) {
	b := jolly(t)
	e := testEncounters(t)
	env := Env{WindSpeed: 6, WindFrom: 0}
	capsized := State{Heading: 1.2, Heel: 1.7}
	if w := WakeOf(&capsized, &env, b, e); w.Height != 0 {
		t.Errorf("a capsized boat casts a wake %g m high", w.Height)
	}
	_, env, w := heldSource(t, b, e, 25*degree)
	x, y := at(&w, -1, 0)
	if got := shadowed(&w, env, x, y, e); got != env {
		t.Errorf("upwind of the source the wind is %+v, not %+v", got, env)
	}
	prev := math.NaN()
	for s := e.reach - 0.05; s < e.reach+0.05; s += 0.001 {
		x, y := at(&w, s, 0)
		got := shadowed(&w, env, x, y, e).WindSpeed
		if !math.IsNaN(prev) && math.Abs(got-prev) > 1e-4 {
			t.Fatalf("the wind steps from %g to %g at %g rig heights", prev, got, s)
		}
		prev = got
	}
	if prev != env.WindSpeed {
		t.Errorf("beyond the reach the wind is %g, not %g", prev, env.WindSpeed)
	}
	// Into the wake from its side and from its start, no step either.
	prev = math.NaN()
	for c := -3.0; c < 3; c += 0.001 {
		x, y := at(&w, 1, c)
		got := shadowed(&w, env, x, y, e).WindSpeed
		if !math.IsNaN(prev) && math.Abs(got-prev) > 0.01 {
			t.Fatalf("the wind steps from %g to %g at %g across", prev, got, c)
		}
		prev = got
	}
	prev = math.NaN()
	for s := -0.5; s < 1; s += 0.001 {
		x, y := at(&w, s, 0)
		got := shadowed(&w, env, x, y, e).WindSpeed
		if !math.IsNaN(prev) && math.Abs(got-prev) > 0.03 {
			t.Fatalf("the wind steps from %g to %g at %g along", prev, got, s)
		}
		prev = got
	}
}

// A boat feels the nearest MaxSources wakes that reach it, ties going to
// the lower slot, whatever order they are offered in.
func TestShadowSources(t *testing.T) {
	b := jolly(t)
	e := testEncounters(t)
	_, _, w := heldSource(t, b, e, 25*degree)
	// The reader on the axis, sources stacked behind each other upwind.
	rx, ry := at(&w, 9, 0)
	var wakes []Wake
	for i := range 12 {
		v := w
		d := float64(i/2) * 0.5 // pairs at the same distance
		v.X -= d * w.East * w.Height / 10
		v.Y -= d * w.North * w.Height / 10
		wakes = append(wakes, v)
	}
	var src Sources
	for _, order := range [][]int{{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11}, {11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0}, {5, 0, 11, 3, 8, 1, 10, 2, 7, 4, 9, 6}} {
		src.Reset()
		for _, i := range order {
			src.Consider(&wakes[i], int32(i), rx, ry, e)
		}
		if src.Len() != MaxSources {
			t.Fatalf("%d sources, want %d", src.Len(), MaxSources)
		}
		for i := range MaxSources {
			if src.slot[i] != int32(i) {
				t.Errorf("offered in the order %v: source %d is slot %d, want %d", order, i, src.slot[i], i)
			}
		}
	}
}

// Seen from the side the shadow is mirrored: a source on port tack casts
// the mirror image of one on starboard, header and all.
func TestShadowMirrored(t *testing.T) {
	b := jolly(t)
	e := testEncounters(t)
	env := Env{WindSpeed: 5, WindFrom: 0}
	stb := State{Heading: 40 * degree, Surge: 2, Boom: -0.2}
	port := State{Heading: -40 * degree, Surge: 2, Boom: 0.2}
	ws, wp := WakeOf(&stb, &env, b, e), WakeOf(&port, &env, b, e)
	if math.Abs(ws.East+wp.East) > 1e-12 || math.Abs(ws.North-wp.North) > 1e-12 || ws.Side != -wp.Side {
		t.Fatalf("the wakes are not mirrored: %+v and %+v", ws, wp)
	}
	xs, ys := at(&ws, 2, 0.1)
	xp, yp := at(&wp, 2, -0.1)
	a, c := shadowed(&ws, env, xs, ys, e), shadowed(&wp, env, xp, yp, e)
	if math.Abs(a.WindSpeed-c.WindSpeed) > 1e-9 || math.Abs(a.WindFrom+c.WindFrom) > 1e-9 {
		t.Errorf("mirrored points feel %+v and %+v", a, c)
	}
}

func TestShadowAllocatesNothing(t *testing.T) {
	b := jolly(t)
	e := testEncounters(t)
	s := State{Heading: 0.7, Surge: 2}
	env := Env{WindSpeed: 6, WindFrom: 0}
	w := WakeOf(&s, &env, b, e)
	x, y := at(&w, 2, 0.1)
	var src Sources
	n := testing.AllocsPerRun(1000, func() {
		w = WakeOf(&s, &env, b, e)
		src.Reset()
		for i := range 10 {
			src.Consider(&w, int32(i), x, y, e)
		}
		e2 := env
		ShadowAt(&e2, x, y, &src, e)
	})
	if n != 0 {
		t.Errorf("the shadow allocates %v times", n)
	}
}

func BenchmarkShadowAt(bm *testing.B) {
	b := jolly(bm)
	e := testEncounters(bm)
	env := Env{WindSpeed: 6, WindFrom: 0}
	// Eight sources side by side, all reaching a reader behind them.
	s0 := State{Heading: 0.7, Surge: 2}
	w0 := WakeOf(&s0, &env, b, e)
	x, y := at(&w0, 3, 0)
	var src Sources
	for i := range MaxSources {
		s := State{X: float64(i%4) * 0.5, Y: float64(i/4) * 0.5, Heading: 0.7, Surge: 2}
		w := WakeOf(&s, &env, b, e)
		src.Consider(&w, int32(i), x, y, e)
	}
	if src.Len() != MaxSources {
		bm.Fatalf("%d sources reach the reader", src.Len())
	}
	for bm.Loop() {
		e2 := env
		ShadowAt(&e2, x, y, &src, e)
	}
}

func BenchmarkWakeOf(bm *testing.B) {
	b := jolly(bm)
	e := testEncounters(bm)
	env := Env{WindSpeed: 6, WindFrom: 0}
	s := State{Heading: 0.7, Surge: 2, Heel: 0.1, Boom: -0.2}
	for bm.Loop() {
		WakeOf(&s, &env, b, e)
	}
}
