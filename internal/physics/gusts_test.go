// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"math/rand/v2"
	"slices"
	"testing"
)

// gustSamples is how many points the field's tests draw.
func gustSamples() int {
	if testing.Short() {
		return 200_000
	}
	return 1_000_000
}

// rawField is the octaves' sum of a spell's field, before it is scaled and
// clamped.
func rawField(st *spellTick, g *gustCells, x, y float64) float64 {
	along := -(x*st.sinD + y*st.cosD) - st.travel
	across := x*st.cosD - y*st.sinD
	sum := 0.0
	for k := range GustOctaves {
		sum += gustWeights[k] * noise3(along*g.invAlong[k], across*g.invAcross[k], st.time[k], st.s.seeds[k])
	}
	return sum
}

// The field's spread is what its two constants say: its 99th percentile in
// magnitude is gustScale, and the mean of h(n), n above 0 and half of n
// below, is gustMeanH, each within 2%. It is symmetric: its mean and median
// are 0, and half the water is gust and half lull.
func TestGustField(t *testing.T) {
	p := testWeather(t)
	rng := rand.New(rand.NewPCG(11, 12))
	n := gustSamples()
	raw := make([]float64, n)
	var at WeatherTick
	for i := range raw {
		if i%1000 == 0 {
			s := spellOfRegime(t, p, "trade", rng.Uint32(), 360*rng.Float64(), 0, 0)
			WeatherAt(weatherOf(p, s), &at, math.Floor(rng.Float64()*1e9))
		}
		raw[i] = rawField(&at.at[0], &p.gustCells, (rng.Float64()-0.5)*16000, (rng.Float64()-0.5)*16000)
	}
	var mean, sq, h float64
	above := 0
	abs := make([]float64, n)
	for i, v := range raw {
		mean += v
		sq += v * v
		abs[i] = math.Abs(v)
		g := max(-1, min(1, v/gustScale))
		if g > 0 {
			above++
			h += g
		} else {
			h += g / 2
		}
	}
	mean, h = mean/float64(n), h/float64(n)
	sd := math.Sqrt(sq/float64(n) - mean*mean)
	slices.Sort(abs)
	sorted := slices.Clone(raw)
	slices.Sort(sorted)
	p99 := abs[n*99/100]
	median := sorted[n/2]
	t.Logf("over %d samples: standard deviation %.4f, 1st and 99th percentile %.4f and %.4f, median %.5f, 99th percentile in magnitude %.4f, mean h %.4f, %.1f%% gust",
		n, sd, sorted[n/100], sorted[n*99/100], median, p99, h, 100*float64(above)/float64(n))
	if math.Abs(p99-gustScale) > 0.02*gustScale {
		t.Errorf("the 99th percentile in magnitude is %.4f, gustScale %.4f", p99, gustScale)
	}
	if math.Abs(h-gustMeanH) > 0.02*gustMeanH {
		t.Errorf("the mean of h is %.4f, gustMeanH %.4f", h, gustMeanH)
	}
	if math.Abs(mean) > 0.01*sd || math.Abs(median) > 0.01*sd {
		t.Errorf("the field's mean is %.5f and its median %.5f", mean, median)
	}
	if f := float64(above) / float64(n); math.Abs(f-0.5) > 0.03 {
		t.Errorf("%.1f%% of the water is gust, not half", 100*f)
	}
	if math.Abs(sd-0.309) > 0.02*0.309 {
		t.Errorf("the standard deviation is %.4f, not 0.309", sd)
	}
}

// The mean wind is kept: over space and time the gust factor's mean is 1
// within 0.5%, in every regime, at mid-disk and at the rim; the strongest
// gusts reach the regime's gust factor and the deepest lulls fall half as
// far below.
func TestGustsKeepTheMean(t *testing.T) {
	p := testWeather(t)
	rng := rand.New(rand.NewPCG(21, 22))
	n := gustSamples() / 4
	for _, id := range []string{"settled", "trade", "unsettled", "stormy"} {
		g := testRegime(t, id).GustFactor
		for _, radius := range []float64{2.1 * nm, 4.2 * nm} {
			sum, most, least := 0.0, 0.0, math.Inf(1)
			var at WeatherTick
			for i := range n {
				if i%500 == 0 {
					s := spellOfRegime(t, p, id, rng.Uint32(), 360*rng.Float64(), 0, 0)
					WeatherAt(weatherOf(p, s), &at, math.Floor(rng.Float64()*1e9))
				}
				a := 2 * math.Pi * rng.Float64()
				var pt WindPoint
				WindPointAt(&at, radius*math.Sin(a), radius*math.Cos(a), &pt, nil)
				sum += pt.Factor
				most, least = max(most, pt.Factor), min(least, pt.Factor)
			}
			mean := sum / float64(n)
			if math.Abs(mean-1) > 0.005 {
				t.Errorf("%s at %.1f NM: the gust factor's mean is %.4f", id, radius/nm, mean)
			}
			// Toward the rim the excess is greater by the catalog's share.
			excess := g - 1
			if radius > 4*nm {
				excess *= 1 + p.rimGusts
			}
			wantMost, wantLeast := 1+excess*(1-gustMeanH), 1-excess*(0.5+gustMeanH)
			if math.Abs(most-wantMost) > 1e-9 || math.Abs(least-wantLeast) > 1e-9 {
				t.Errorf("%s at %.1f NM: gust factors from %.4f to %.4f, want %.4f to %.4f", id, radius/nm, least, most, wantLeast, wantMost)
			}
		}
	}
}

// Gusts veer and lulls back: the wind's direction less the mean wind's is
// the catalog's veer times the field, clockwise in a gust.
func TestGustsVeer(t *testing.T) {
	p := testWeather(t)
	params, _ := weatherOnce()
	w := weatherOf(p, spellOfRegime(t, p, "trade", 4, 220, 0, 0))
	rng := rand.New(rand.NewPCG(31, 32))
	veered, backed := 0, 0
	for range 20000 {
		pt := windAt(w, (rng.Float64()-0.5)*8000, 3000+(rng.Float64()-0.5)*4000, worldTick+float64(rng.IntN(100000)))
		turn := wrapAngle(pt.From - pt.MeanFrom)
		if math.Abs(turn-params.GustVeer*deg*pt.Gust) > 1e-12 {
			t.Fatalf("a gust of %.3f turns the wind %.4f°, not %.4f°", pt.Gust, turn/deg, params.GustVeer*pt.Gust)
		}
		if pt.Gust > 0.5 && turn > 0 {
			veered++
		}
		if pt.Gust < -0.5 && turn < 0 {
			backed++
		}
	}
	if veered < 500 || backed < 500 {
		t.Errorf("%d strong gusts veered and %d deep lulls backed", veered, backed)
	}
}

// correlation is the correlation of two series.
func correlation(a, b []float64) float64 {
	var ma, mb float64
	for i := range a {
		ma += a[i]
		mb += b[i]
	}
	ma, mb = ma/float64(len(a)), mb/float64(len(b))
	var sab, saa, sbb float64
	for i := range a {
		sab += (a[i] - ma) * (b[i] - mb)
		saa += (a[i] - ma) * (a[i] - ma)
		sbb += (b[i] - mb) * (b[i] - mb)
	}
	return sab / math.Sqrt(saa*sbb)
}

// A patch travels downwind: the field a while later is most like the field
// now at the place the catalog's share of the spell's wind has carried it
// to, along the spell's direction.
func TestGustsTravelDownwind(t *testing.T) {
	p := testWeather(t)
	s := spellOfRegime(t, p, "trade", 9, 250, 0, 0)
	s.Drift = 0
	w := weatherOf(p, s)
	const seconds = 20
	speed := p.gustSpeed * s.Speed * SeaSpeedStep
	from := s.From * turnStep
	// Downwind: toward the direction the wind comes from, less half a turn.
	east, north := -math.Sin(from), -math.Cos(from)
	rng := rand.New(rand.NewPCG(41, 42))
	const n = 20000
	xs, ys, now := make([]float64, n), make([]float64, n), make([]float64, n)
	for i := range n {
		xs[i], ys[i] = (rng.Float64()-0.5)*6000, (rng.Float64()-0.5)*6000
		now[i] = windAt(w, xs[i], ys[i], worldTick).Gust
	}
	best, bestAt := -1.0, 0.0
	later := make([]float64, n)
	for d := 0.0; d <= 2*speed*seconds; d += 4 {
		for i := range n {
			later[i] = windAt(w, xs[i]+d*east, ys[i]+d*north, worldTick+seconds*StepsPerSecond).Gust
		}
		if c := correlation(now, later); c > best {
			best, bestAt = c, d
		}
	}
	want := speed * seconds
	t.Logf("after %d s the field is most itself (correlation %.3f) %.0f m downwind; the wind carries it %.0f m", seconds, best, bestAt, want)
	if math.Abs(bestAt-want) > 8 || best < 0.9 {
		t.Errorf("after %d s the field is most itself %.0f m downwind (correlation %.3f), want %.0f m", seconds, bestAt, best, want)
	}
	// Upwind and across the wind it is not.
	for i := range n {
		later[i] = windAt(w, xs[i]-want*east, ys[i]-want*north, worldTick+seconds*StepsPerSecond).Gust
	}
	if c := correlation(now, later); c > 0.3 {
		t.Errorf("the field is like itself upwind (correlation %.3f)", c)
	}
}

// arrival is the correlation of the gust factor seen ahead metres upwind
// of a boat with the gust factor at the boat when the patch arrives, in a
// spell of a regime: over boats about mid-disk at many moments.
func arrival(t testing.TB, p *WeatherPrepared, id string, ahead float64, n int) float64 {
	t.Helper()
	rng := rand.New(rand.NewPCG(51, 52))
	seen, felt := make([]float64, n), make([]float64, n)
	for i := range n {
		s := spellOfRegime(t, p, id, uint32(i/200), 360*rng.Float64(), 0, 0)
		w := weatherOf(p, s)
		tick := worldTick + float64(rng.IntN(100000))
		a := 2 * math.Pi * rng.Float64()
		x, y := 2.1*nm*math.Sin(a), 2.1*nm*math.Cos(a)
		// Upwind by the wind the boat feels on average: the mean wind there.
		here := windAt(w, x, y, tick)
		ux, uy := math.Sin(here.MeanFrom), math.Cos(here.MeanFrom)
		seen[i] = windAt(w, x+ahead*ux, y+ahead*uy, tick).Factor
		seconds := ahead / (p.gustSpeed * here.MeanSpeed)
		felt[i] = windAt(w, x, y, tick+math.Round(seconds*StepsPerSecond)).Factor
	}
	return correlation(seen, felt)
}

// A seen gust arrives: the gust factor 150 m upwind of a boat and the gust
// factor at the boat when the patch has been carried to it correlate at
// 0.8 or more in a trade spell, though the wind there has swung with its
// shifts and differs across the disk from the direction the field travels
// in.
func TestSeenGustArrives(t *testing.T) {
	p := testWeather(t)
	n := gustSamples() / 20
	for _, id := range []string{"settled", "trade", "unsettled", "stormy"} {
		c := arrival(t, p, id, 150, n)
		t.Logf("%s: a gust seen 150 m upwind arrives with a correlation of %.3f", id, c)
		if id == "trade" && c < 0.8 {
			t.Errorf("in a trade spell a gust seen 150 m upwind arrives with a correlation of %.3f", c)
		}
	}
}

// Through a change of spell the two spells' fields are mixed so that the
// field keeps its spread: within 5% of a single spell's all the way. The
// spread is taken over spells that began at different moments: gradient
// noise is a little quieter each time its lattice in time comes round, all
// over the field at once.
func TestGustsThroughAChange(t *testing.T) {
	p := testWeather(t)
	change := float64(p.change)
	rng := rand.New(rand.NewPCG(61, 62))
	spread := func(f float64) float64 {
		sq := 0.0
		const pairs, points = 400, 100
		for i := range pairs {
			a := spellOfRegime(t, p, "trade", uint32(2*i), 360*rng.Float64(), worldTick-float64(rng.IntN(1000000)), 0)
			b := spellOfRegime(t, p, "unsettled", uint32(2*i+1), 360*rng.Float64(), worldTick+float64(rng.IntN(7200)), 0)
			b.Change = change
			var at WeatherTick
			WeatherAt(weatherOf(p, a, b), &at, b.Begin+math.Round(f*change))
			for range points {
				var pt WindPoint
				WindPointAt(&at, (rng.Float64()-0.5)*8000, (rng.Float64()-0.5)*8000, &pt, nil)
				sq += pt.Gust * pt.Gust
			}
		}
		return math.Sqrt(sq / (pairs * points))
	}
	before := spread(-0.01)
	for _, f := range []float64{0.1, 0.3, 0.5, 0.7, 0.9, 1.1} {
		got := spread(f)
		t.Logf("%.0f%% through a change the field's spread is %.4f; before it %.4f", 100*f, got, before)
		if math.Abs(got-before) > 0.05*before {
			t.Errorf("%.0f%% through the change the field's spread is %.4f, before it %.4f", 100*f, got, before)
		}
	}
}

// The field is continuous: a centimetre away, or a tick later, it has
// barely changed, in a spell and across the cells' edges.
func TestGustsContinuous(t *testing.T) {
	p := testWeather(t)
	w := weatherOf(p, spellOfRegime(t, p, "stormy", 5, 0, 0, 0))
	rng := rand.New(rand.NewPCG(71, 72))
	var space, time float64
	for range 100000 {
		x, y := (rng.Float64()-0.5)*16000, (rng.Float64()-0.5)*16000
		tick := worldTick + float64(rng.IntN(1000000))
		here := windAt(w, x, y, tick).Gust
		a := 2 * math.Pi * rng.Float64()
		space = max(space, math.Abs(windAt(w, x+0.01*math.Sin(a), y+0.01*math.Cos(a), tick).Gust-here))
		time = max(time, math.Abs(windAt(w, x, y, tick+1).Gust-here))
	}
	t.Logf("the field changes by at most %.5f in a centimetre and %.5f in a tick", space, time)
	if space > 0.002 || time > 0.02 {
		t.Errorf("the field changes by %.5f in a centimetre and %.5f in a tick", space, time)
	}
}

// A lattice cell is split the same way for a GPU to carry on from: the cell
// whole, the fraction in [0, 1).
func TestGustCellOf(t *testing.T) {
	for _, c := range []struct {
		u    float64
		cell int32
		frac float64
	}{{0, 0, 0}, {2.75, 2, 0.75}, {-0.25, -1, 0.75}, {-3, -3, 0}, {123456.5, 123456, 0.5}} {
		if g := GustCellOf(c.u); g.Cell != c.cell || g.Frac != c.frac {
			t.Errorf("%v is cell %d and %v, want %d and %v", c.u, g.Cell, g.Frac, c.cell, c.frac)
		}
	}
}
