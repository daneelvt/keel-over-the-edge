// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"flag"
	"math"
	"math/big"
	"math/rand/v2"
	"sync"
	"testing"
)

// A reference for the functions of fmath.go in math/big, precise far beyond
// float64, so the tests measure each function against the true value rather
// than against the standard library (which is itself several units out near
// the zeros of sine and cosine).

const refPrec = 1300 // enough for x mod π/2 of any float64, with room to spare

func nf() *big.Float          { return new(big.Float).SetPrec(refPrec) }
func ni(v int64) *big.Float   { return nf().SetInt64(v) }
func nx(f float64) *big.Float { return nf().SetFloat64(f) }

// seriesSum returns Σ term_k from the first term until the terms fall below
// 2^-refPrec of it, where next turns term_k into term_k+1.
func seriesSum(first *big.Float, next func(term *big.Float, k int64)) *big.Float {
	sum, term := nf().Set(first), nf().Set(first)
	limit := nf().SetMantExp(nf().Abs(first), -refPrec-8)
	for k := int64(1); ; k++ {
		next(term, k)
		if nf().Abs(term).Cmp(limit) < 0 {
			return sum
		}
		sum.Add(sum, term)
	}
}

// atanSmall returns atan(x) for |x| ≤ 1/2 by its Taylor series.
func atanSmall(x *big.Float) *big.Float {
	if x.Sign() == 0 {
		return nf()
	}
	x2 := nf().Mul(x, x)
	pow := nf().Set(x)
	return seriesSum(x, func(term *big.Float, k int64) {
		pow.Mul(pow, x2)
		term.Quo(pow, ni(2*k+1))
		if k%2 == 1 {
			term.Neg(term)
		}
	})
}

var refConsts = sync.OnceValues(func() (pi, ln2 *big.Float) {
	// Machin: π = 16·atan(1/5) − 4·atan(1/239).
	pi = nf().Sub(nf().Mul(ni(16), atanSmall(nf().Quo(ni(1), ni(5)))),
		nf().Mul(ni(4), atanSmall(nf().Quo(ni(1), ni(239)))))
	// ln 2 = 2·atanh(1/3).
	third, ninth := nf().Quo(ni(1), ni(3)), nf().Quo(ni(1), ni(9))
	pow := nf().Set(third)
	ln2 = seriesSum(third, func(term *big.Float, k int64) {
		pow.Mul(pow, ninth)
		term.Quo(pow, ni(2*k+1))
	})
	return pi, ln2.Mul(ln2, ni(2))
})

// bigSinCos returns sin and cos of a moderate angle y by their series.
func bigSinCos(y *big.Float) (sin, cos *big.Float) {
	y2 := nf().Mul(y, y)
	s := nf()
	if y.Sign() != 0 {
		s = seriesSum(y, func(term *big.Float, k int64) {
			term.Mul(term, y2)
			term.Quo(term, ni(-(2*k)*(2*k+1)))
		})
	}
	c := seriesSum(ni(1), func(term *big.Float, k int64) {
		term.Mul(term, y2)
		term.Quo(term, ni(-(2*k-1)*(2*k)))
	})
	return s, c
}

// refSinCos returns sin and cos of x.
func refSinCos(x float64) (sin, cos *big.Float) {
	pi, _ := refConsts()
	pio2 := nf().Quo(pi, ni(2))
	q := nf().Quo(nx(x), pio2)
	q.Add(q, nf().SetFloat64(0.5))
	n, _ := q.Int(nil)
	if q.Sign() < 0 && !q.IsInt() {
		n.Sub(n, big.NewInt(1)) // floor
	}
	s, c := bigSinCos(nf().Sub(nx(x), nf().Mul(nf().SetInt(n), pio2))) // |angle| ≤ π/4
	switch new(big.Int).And(n, big.NewInt(3)).Int64() {
	case 0:
		return s, c
	case 1:
		return c, nf().Neg(s)
	case 2:
		return nf().Neg(s), nf().Neg(c)
	default:
		return nf().Neg(c), s
	}
}

func refExp(x float64) *big.Float {
	_, ln2 := refConsts()
	k := math.Round(x / math.Ln2)
	y := nf().Sub(nx(x), nf().Mul(nx(k), ln2))
	e := seriesSum(ni(1), func(term *big.Float, k int64) {
		term.Mul(term, y)
		term.Quo(term, ni(k))
	})
	return e.SetMantExp(e, int(k))
}

func refLog(x float64) *big.Float {
	_, ln2 := refConsts()
	m := nf()
	k := nx(x).MantExp(m) // x = m·2^k, 0.5 ≤ m < 1
	// log m = 2·atanh(s)
	s := nf().Quo(nf().Sub(m, ni(1)), nf().Add(m, ni(1)))
	s2 := nf().Mul(s, s)
	pow := nf().Set(s)
	l := seriesSum(s, func(term *big.Float, k int64) {
		pow.Mul(pow, s2)
		term.Quo(pow, ni(2*k+1))
	})
	l.Mul(l, ni(2))
	return l.Add(l, nf().Mul(ni(int64(k)), ln2))
}

// bigAtan returns atan(a) for a ≥ 0.
func bigAtan(a *big.Float) *big.Float {
	pi, _ := refConsts()
	a = nf().Set(a)
	invert := a.Cmp(ni(1)) > 0
	if invert {
		a.Quo(ni(1), a)
	}
	// atan(a) = 2·atan(a/(1 + √(1+a²))), twice, brings a below tan(π/16).
	for range 2 {
		d := nf().Sqrt(nf().Add(ni(1), nf().Mul(a, a)))
		a.Quo(a, d.Add(d, ni(1)))
	}
	r := atanSmall(a)
	r.Mul(r, ni(4))
	if invert {
		r.Sub(nf().Quo(pi, ni(2)), r)
	}
	return r
}

func refAtan(x float64) *big.Float {
	r := bigAtan(nf().Abs(nx(x)))
	if x < 0 {
		r.Neg(r)
	}
	return r
}

// refAtan2 is atan2 of the exact point, for finite nonzero y and x.
func refAtan2(y, x float64) *big.Float {
	pi, _ := refConsts()
	r := bigAtan(nf().Quo(nf().Abs(nx(y)), nf().Abs(nx(x))))
	if x < 0 {
		r.Sub(pi, r)
	}
	if y < 0 {
		r.Neg(r)
	}
	return r
}

// faithful reports whether got is one of the two floats either side of the
// true value (or the true value itself), and whether it is the nearest.
func faithful(got float64, truth *big.Float) (ok, nearest bool) {
	near, _ := truth.Float64()
	if math.Float64bits(got) == math.Float64bits(near) || (got == 0 && near == 0) {
		return true, true
	}
	var other float64
	if nx(near).Cmp(truth) < 0 {
		other = math.Nextafter(near, math.Inf(1))
	} else {
		other = math.Nextafter(near, math.Inf(-1))
	}
	return got == other, false
}

var samples = flag.Int("samples", 4000, "inputs drawn for each accuracy case")

type sampler func(*rand.Rand) float64

func uniform(lo, hi float64) sampler {
	return func(r *rand.Rand) float64 { return lo + (hi-lo)*r.Float64() }
}

// spread draws |x| evenly over orders of magnitude, with either sign.
func spread(lo, hi float64, signed bool) sampler {
	return func(r *rand.Rand) float64 {
		x := math.Exp(math.Log(lo) + (math.Log(hi)-math.Log(lo))*r.Float64())
		if signed && r.IntN(2) == 0 {
			return -x
		}
		return x
	}
}

func TestAccuracy(t *testing.T) {
	sin := func(x float64) *big.Float { s, _ := refSinCos(x); return s }
	cos := func(x float64) *big.Float { _, c := refSinCos(x); return c }
	cases := []struct {
		name string
		f    func(float64) float64
		ref  func(float64) *big.Float
		gen  sampler
	}{
		{"Sin within π/4", Sin, sin, uniform(-pio4, pio4)},
		{"Sin", Sin, sin, uniform(-50, 50)},
		{"Sin medium", Sin, sin, spread(1, mediumMax, true)},
		{"Sin large", Sin, sin, spread(mediumMax, math.MaxFloat64, true)},
		{"Sin tiny", Sin, sin, spread(1e-300, 1e-3, true)},
		{"Cos within π/4", Cos, cos, uniform(-pio4, pio4)},
		{"Cos", Cos, cos, uniform(-50, 50)},
		{"Cos medium", Cos, cos, spread(1, mediumMax, true)},
		{"Cos large", Cos, cos, spread(mediumMax, math.MaxFloat64, true)},
		{"Exp", Exp, refExp, uniform(-708, 709)},
		{"Exp near 0", Exp, refExp, uniform(-1, 1)},
		{"Exp subnormal", Exp, refExp, uniform(expUnderflow, -708)},
		{"Log", Log, refLog, spread(1e-300, 1e300, false)},
		{"Log near 1", Log, refLog, uniform(0.5, 2)},
		{"Log subnormal", Log, refLog, spread(5e-324, 2e-308, false)},
		{"Atan", Atan, refAtan, uniform(-2, 2)},
		{"Atan steep", Atan, refAtan, uniform(-40, 40)},
		{"Atan wide", Atan, refAtan, spread(1e-30, 1e30, true)},
	}
	n := *samples
	if testing.Short() {
		n /= 10
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			rng := rand.New(rand.NewPCG(1, uint64(len(c.name))))
			rounded := 0
			for range n {
				x := c.gen(rng)
				got := c.f(x)
				ok, nearest := faithful(got, c.ref(x))
				if !ok {
					want, _ := c.ref(x).Float64()
					t.Fatalf("%s(%v) = %v, want %v (x = %#x)", c.name, x, got, want, math.Float64bits(x))
				}
				if nearest {
					rounded++
				}
			}
			t.Logf("nearest float in %.2f%% of %d", 100*float64(rounded)/float64(n), n)
		})
	}
}

func TestAtan2Accuracy(t *testing.T) {
	rng := rand.New(rand.NewPCG(3, 4))
	wide := spread(1e-300, 1e300, true)
	for i := range 2 * *samples {
		y, x := rng.NormFloat64()*100, rng.NormFloat64()*100
		if i%2 == 1 {
			y, x = wide(rng), wide(rng)
		}
		if ok, _ := faithful(Atan2(y, x), refAtan2(y, x)); !ok {
			want, _ := refAtan2(y, x).Float64()
			t.Fatalf("Atan2(%v, %v) = %v, want %v", y, x, Atan2(y, x), want)
		}
	}
}

// Arguments that are hard to reduce: the double nearest a multiple of π/2
// (Kahan and McDonald), the multiples of π/2 rounded, and the edges of each
// method of reduction.
func TestReductionHardCases(t *testing.T) {
	for _, x := range []float64{
		6381956970095103 * math.Pow(2, 797),
		math.Pow(2, 1023), math.MaxFloat64, -1e300, 1e22,
		pio2Hi, piHi, 3 * pio2Hi, 2 * piHi, 1e6 * piHi, 4 * pio4,
		mediumMax, math.Nextafter(mediumMax, 0), -mediumMax,
		pio4, math.Nextafter(pio4, 1), 0x1p-27, math.Nextafter(0x1p-27, 0),
	} {
		s, c := refSinCos(x)
		if ok, _ := faithful(Sin(x), s); !ok {
			want, _ := s.Float64()
			t.Errorf("Sin(%v) = %v, want %v", x, Sin(x), want)
		}
		if ok, _ := faithful(Cos(x), c); !ok {
			want, _ := c.Float64()
			t.Errorf("Cos(%v) = %v, want %v", x, Cos(x), want)
		}
	}
}

func TestSinCosMatchesSinAndCos(t *testing.T) {
	rng := rand.New(rand.NewPCG(5, 6))
	for range 100000 {
		x := (rng.Float64() - 0.5) * math.Pow(10, float64(rng.IntN(40)-10))
		s, c := SinCos(x)
		if math.Float64bits(s) != math.Float64bits(Sin(x)) || math.Float64bits(c) != math.Float64bits(Cos(x)) {
			t.Fatalf("SinCos(%v) = %v, %v; Sin, Cos = %v, %v", x, s, c, Sin(x), Cos(x))
		}
	}
}

func TestSpecialValues(t *testing.T) {
	inf, nan := math.Inf(1), math.NaN()
	negZero := math.Copysign(0, -1)
	same := func(a, b float64) bool {
		if math.IsNaN(a) || math.IsNaN(b) {
			return math.IsNaN(a) && math.IsNaN(b)
		}
		return math.Float64bits(a) == math.Float64bits(b)
	}
	one := []struct {
		name string
		f    func(float64) float64
		in   float64
		want float64
	}{
		{"Sin", Sin, 0, 0}, {"Sin", Sin, negZero, negZero}, {"Sin", Sin, inf, nan},
		{"Sin", Sin, -inf, nan}, {"Sin", Sin, nan, nan}, {"Sin", Sin, 1e-300, 1e-300},
		{"Cos", Cos, 0, 1}, {"Cos", Cos, negZero, 1}, {"Cos", Cos, inf, nan}, {"Cos", Cos, nan, nan},
		{"Exp", Exp, 0, 1}, {"Exp", Exp, negZero, 1}, {"Exp", Exp, inf, inf}, {"Exp", Exp, -inf, 0},
		{"Exp", Exp, nan, nan}, {"Exp", Exp, 710, inf}, {"Exp", Exp, -746, 0},
		{"Exp", Exp, expUnderflow, 5e-324},
		{"Log", Log, 1, 0}, {"Log", Log, 0, -inf}, {"Log", Log, negZero, -inf}, {"Log", Log, -1, nan},
		{"Log", Log, inf, inf}, {"Log", Log, -inf, nan}, {"Log", Log, nan, nan},
		{"Atan", Atan, 0, 0}, {"Atan", Atan, negZero, negZero}, {"Atan", Atan, inf, pio2Hi},
		{"Atan", Atan, -inf, -pio2Hi}, {"Atan", Atan, nan, nan}, {"Atan", Atan, 1, pio4},
	}
	for _, c := range one {
		if got := c.f(c.in); !same(got, c.want) {
			t.Errorf("%s(%v) = %v, want %v", c.name, c.in, got, c.want)
		}
	}
	// The special cases in math.Atan2's documentation.
	two := []struct{ y, x, want float64 }{
		{1, nan, nan}, {nan, 1, nan},
		{0, 1, 0}, {0, 0, 0}, {negZero, 1, negZero}, {negZero, 0, negZero},
		{0, -1, piHi}, {0, negZero, piHi}, {negZero, -1, -piHi}, {negZero, negZero, -piHi},
		{1, 0, pio2Hi}, {-1, 0, -pio2Hi}, {1, negZero, pio2Hi},
		{inf, inf, pio4}, {-inf, inf, -pio4}, {inf, -inf, pi3o4}, {-inf, -inf, -pi3o4},
		{1, inf, 0}, {-1, inf, negZero}, {1, -inf, piHi}, {-1, -inf, -piHi},
		{inf, 1, pio2Hi}, {-inf, 1, -pio2Hi}, {inf, -1, pio2Hi},
	}
	for _, c := range two {
		if got := Atan2(c.y, c.x); !same(got, c.want) {
			t.Errorf("Atan2(%v, %v) = %v, want %v", c.y, c.x, got, c.want)
		}
	}
}

func TestToInt32(t *testing.T) {
	for _, c := range []struct {
		in   float64
		want int32
	}{
		{0, 0}, {1.9, 1}, {-1.9, -1}, {math.NaN(), 0}, {math.Inf(1), math.MaxInt32},
		{math.Inf(-1), math.MinInt32}, {3e9, math.MaxInt32}, {-3e9, math.MinInt32},
		{2147483646.5, 2147483646}, {-2147483648, math.MinInt32},
	} {
		if got := toInt32(c.in); got != c.want {
			t.Errorf("toInt32(%v) = %d, want %d", c.in, got, c.want)
		}
	}
}

// The constants of fmath.go, computed afresh.
func TestConstants(t *testing.T) {
	pi, ln2 := refConsts()
	pio2 := nf().Quo(pi, ni(2))
	nearest := func(v *big.Float) float64 { f, _ := v.Float64(); return f }
	truncate := func(v *big.Float, bits uint) float64 {
		f, _ := new(big.Float).SetPrec(bits).SetMode(big.ToZero).Set(v).Float64()
		return f
	}
	minus := func(v *big.Float, f float64) *big.Float { return nf().Sub(v, nx(f)) }
	check := func(name string, got, want float64) {
		t.Helper()
		if math.Float64bits(got) != math.Float64bits(want) {
			t.Errorf("%s = %x, want %x", name, got, want)
		}
	}

	rest := nf().Set(pio2)
	for i, p := range []struct{ part, tail float64 }{{pio2_1, pio2_1t}, {pio2_2, pio2_2t}, {pio2_3, pio2_3t}} {
		want := truncate(rest, 33)
		check("pio2 part "+string(rune('1'+i)), p.part, want)
		rest = minus(rest, want)
		check("pio2 tail "+string(rune('1'+i)), p.tail, nearest(rest))
	}
	check("invPio2", invPio2, nearest(nf().Quo(ni(2), pi)))
	check("pio4", pio4, nearest(nf().Quo(pi, ni(4))))
	check("pio2Hi", pio2Hi, nearest(pio2))
	check("pio2Lo", pio2Lo, nearest(minus(pio2, pio2Hi)))
	check("piHi", piHi, nearest(pi))
	check("piLo", piLo, nearest(minus(pi, piHi)))
	check("pi3o4", pi3o4, nearest(nf().Quo(nf().Mul(pi, ni(3)), ni(4))))
	check("mediumMax", mediumMax, pio2Hi*(1<<20))
	check("ln2Hi", ln2Hi, truncate(ln2, 32))
	check("ln2Lo", ln2Lo, nearest(minus(ln2, ln2Hi)))
	check("invLn2", invLn2, nearest(nf().Quo(ni(1), ln2)))
	check("sqrt2", sqrt2, nearest(nf().Sqrt(ni(2))))
	tan := func(num, den int64) *big.Float { // tan(num·π/den)
		s, c := bigSinCos(nf().Quo(nf().Mul(pi, ni(num)), ni(den)))
		return s.Quo(s, c)
	}
	for k := range int64(16) {
		check("atanC", atanC[k], nearest(tan(k, 32)))
		check("atanMid", atanMid[k], nearest(tan(2*k+1, 64)))
		v := refAtan(atanC[k])
		check("atanHi", atanHi[k], nearest(v))
		check("atanLo", atanLo[k], nearest(minus(v, atanHi[k])))
	}
	frac := nf().Quo(ni(2), pi)
	word := nf().SetMantExp(ni(1), 64)
	for i := 1; i < len(twoOverPiBits); i++ {
		frac.Mul(frac, word)
		w, _ := frac.Int(nil)
		if got := twoOverPiBits[i]; got != w.Uint64() {
			t.Errorf("twoOverPiBits[%d] = %#x, want %#x", i, got, w.Uint64())
		}
		frac.Sub(frac, nf().SetInt(w))
	}
	// The thresholds of Exp: the largest x with a finite result and the
	// smallest with a nonzero one.
	maxF := nx(math.MaxFloat64)
	halfMin := nf().SetMantExp(ni(1), -1075)
	if refExp(expOverflow).Cmp(maxF) > 0 || refExp(math.Nextafter(expOverflow, 1000)).Cmp(maxF) <= 0 {
		t.Error("expOverflow is not the largest x with a finite e^x")
	}
	if refExp(expUnderflow).Cmp(halfMin) <= 0 || refExp(math.Nextafter(expUnderflow, -1000)).Cmp(halfMin) > 0 {
		t.Error("expUnderflow is not the smallest x whose e^x rounds above zero")
	}
}
