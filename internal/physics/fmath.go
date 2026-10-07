// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"math/bits"
)

// The package's own transcendental functions, in plain arithmetic so that Go
// on amd64, Go on arm64 and TinyGo's WebAssembly give the same bits. Each is
// faithfully rounded: its result is one of the two floats either side of the
// true value, and most often the nearest. The tests check this against
// values computed with math/big, which also check every constant below
// (fmath_test.go). The polynomials are truncated Taylor series, taken far
// enough that the truncation lies below the rounding.

// Parts of π/2 for reducing arguments of medium size: the first three hold 33
// bits each, so a multiple of one by an integer below 2^20 is exact; each
// "t" constant is what remains of π/2 after the parts before it.
const (
	pio2_1  = 0x1.921fb544p+00
	pio2_1t = 0x1.0b4611a626331p-34
	pio2_2  = 0x1.0b4611a6p-34
	pio2_2t = 0x1.3198a2e037073p-69
	pio2_3  = 0x1.3198a2ep-69
	pio2_3t = 0x1.b839a252049c1p-104
	invPio2 = 0x1.45f306dc9c883p-01 // 2/π

	pio4   = 0x1.921fb54442d18p-01 // π/4, rounded
	pio2Hi = 0x1.921fb54442d18p+00 // π/2 = pio2Hi + pio2Lo
	pio2Lo = 0x1.1a62633145c07p-54
	piHi   = 0x1.921fb54442d18p+01 // π = piHi + piLo
	piLo   = 0x1.1a62633145c07p-53
	pi3o4  = 0x1.2d97c7f3321d2p+01 // 3π/4, rounded

	// Arguments up to 2^20·π/2 are reduced with the parts above; larger ones
	// with the bits of 2/π.
	mediumMax = 0x1.921fb54442d18p+20

	ln2Hi  = 0x1.62e42feep-01 // ln 2 = ln2Hi + ln2Lo; ln2Hi has 32 bits
	ln2Lo  = 0x1.a39ef35793c76p-33
	invLn2 = 0x1.71547652b82fep+00

	expOverflow  = 0x1.62e42fefa39efp+09 // largest x with a finite exp(x)
	expUnderflow = -0x1.74910d52d3051p+09
	sqrt2        = 0x1.6a09e667f3bcdp+00

	splitter = 0x1p+27 + 1 // splits a float64 into two halves of 26 bits
)

// The arctangent reduces its argument to the nearest of the angles kπ/32,
// k = 0…15: atanC[k] is tan(kπ/32) rounded, atanHi[k] + atanLo[k] is the
// arctangent of that rounded value, and atanMid[k] is tan((k+½)π/32), the
// boundary between angle k and angle k+1.
var (
	atanC = [16]float64{
		0, 0x1.936bb8c5b2da2p-04, 0x1.975f5e0553158p-03, 0x1.36a08355c63dcp-02,
		0x1.a827999fcef32p-02, 0x1.11ab7190834ecp-01, 0x1.561b82ab7f99p-01, 0x1.a43002ae4285p-01,
		0x1p+00, 0x1.37efd8d87607ep+00, 0x1.7f218e25a7461p+00, 0x1.def13b73c1406p+00,
		0x1.3504f333f9de6p+01, 0x1.a5f59e90600ddp+01, 0x1.41bfee2424771p+02, 0x1.44e6c595afdccp+03,
	}
	atanHi = [16]float64{
		0, 0x1.921fb54442d18p-04, 0x1.921fb54442d18p-03, 0x1.2d97c7f3321d2p-02,
		0x1.921fb54442d18p-02, 0x1.f6a7a2955385fp-02, 0x1.2d97c7f3321d2p-01, 0x1.5fdbbe9bba775p-01,
		0x1.921fb54442d18p-01, 0x1.c463abeccb2bbp-01, 0x1.f6a7a2955385ep-01, 0x1.1475cc9eedf01p+00,
		0x1.2d97c7f3321d2p+00, 0x1.46b9c347764a4p+00, 0x1.5fdbbe9bba775p+00, 0x1.78fdb9effea47p+00,
	}
	atanLo = [16]float64{
		0, -0x1.a6a92370f06b7p-60, 0x1.f93470dfef04ap-58, 0x1.ab73d134ce998p-56,
		0x1.c398861b78b55p-59, 0x1.502d27c7987c2p-58, -0x1.8f57cafebcf16p-58, 0x1.756cab91ebae2p-55,
		0x1.1a62633145c07p-55, 0x1.8c8af69547e5ep-55, 0x1.34dfa5661a3cbp-56, -0x1.5c0c8981e68dfp-54,
		0x1.fc774dbe287ap-56, -0x1.eb08d130d92fep-55, 0x1.e3cdb040ef2b3p-55, -0x1.0f05e34745b3ep-54,
	}
	atanMid = [16]float64{
		0x1.927278a3b1162p-05, 0x1.2fcac73a6064p-03, 0x1.007fa758626aep-02, 0x1.6e649f7d78649p-02,
		0x1.e450e0d273e7ap-02, 0x1.32e1889047ffdp-01, 0x1.7bb99ed2990cfp-01, 0x1.d00cbc7384d2ep-01,
		0x1.1a73d55278c4bp+00, 0x1.592d11142fa55p+00, 0x1.ab1c35d8a74eap+00, 0x1.0ea21d716fbf7p+01,
		0x1.65bc6cc825147p+01, 0x1.ff01305ecd8dcp+01, 0x1.af73f4ca3310fp+02, 0x1.45affed201b55p+04,
	}
)

// twoOverPiBits holds the bits of 2/π after the binary point, most significant
// first, after one word of zeros that stands for the bits before the point.
var twoOverPiBits = [21]uint64{
	0,
	0xa2f9836e4e441529, 0xfc2757d1f534ddc0, 0xdb6295993c439041, 0xfe5163abdebbc561,
	0xb7246e3a424dd2e0, 0x06492eea09d1921c, 0xfe1deb1cb129a73e, 0xe88235f52ebb4484,
	0xe99c7026b45f7e41, 0x3991d639835339f4, 0x9c845f8bbdf9283b, 0x1ff897ffde05980f,
	0xef2f118b5a0a6d1f, 0x6d367ecf27cb09b7, 0x4f463f669e5fea2d, 0x7527bac7ebe5f17b,
	0x3d0739f78a5292ea, 0x6bfb5fb11f8d5d08, 0x56033046fc7b6bab, 0xf0cfbc209af4361d,
}

// toInt32 converts f to an int32, truncating toward zero. It is the only
// conversion from a float to an integer in the package: Go leaves an
// out-of-range conversion to the machine, and amd64, arm64 and WebAssembly
// answer differently. Here NaN gives 0 and out-of-range values saturate.
func toInt32(f float64) int32 {
	switch {
	case f != f:
		return 0
	case f >= math.MaxInt32:
		return math.MaxInt32
	case f <= math.MinInt32:
		return math.MinInt32
	}
	return int32(f)
}

// pow2 returns 2^k for a k with a normal result, -1022 ≤ k ≤ 1023.
func pow2(k int32) float64 {
	return math.Float64frombits(uint64(k+1023) << 52)
}

// biasedExp returns the biased exponent field of f.
func biasedExp(f float64) int32 {
	return int32(math.Float64bits(f) >> 52 & 0x7ff)
}

// Sin returns the sine of x.
func Sin(x float64) float64 {
	a := math.Abs(x)
	switch {
	case a < 0x1p-27:
		return x
	case a <= pio4:
		return sinKernel(x, 0)
	case x != x || a > math.MaxFloat64:
		return math.NaN()
	}
	n, y0, y1 := reducePio2(x)
	switch n & 3 {
	case 0:
		return sinKernel(y0, y1)
	case 1:
		return cosKernel(y0, y1)
	case 2:
		return -sinKernel(y0, y1)
	default:
		return -cosKernel(y0, y1)
	}
}

// Cos returns the cosine of x.
func Cos(x float64) float64 {
	a := math.Abs(x)
	switch {
	case a < 0x1p-27:
		return 1
	case a <= pio4:
		return cosKernel(x, 0)
	case x != x || a > math.MaxFloat64:
		return math.NaN()
	}
	n, y0, y1 := reducePio2(x)
	switch n & 3 {
	case 0:
		return cosKernel(y0, y1)
	case 1:
		return -sinKernel(y0, y1)
	case 2:
		return -cosKernel(y0, y1)
	default:
		return sinKernel(y0, y1)
	}
}

// SinCos returns Sin(x) and Cos(x), with the same bits as the separate calls,
// reducing the argument once.
func SinCos(x float64) (sin, cos float64) {
	a := math.Abs(x)
	switch {
	case a < 0x1p-27:
		return x, 1
	case a <= pio4:
		return sinKernel(x, 0), cosKernel(x, 0)
	case x != x || a > math.MaxFloat64:
		return math.NaN(), math.NaN()
	}
	n, y0, y1 := reducePio2(x)
	s, c := sinKernel(y0, y1), cosKernel(y0, y1)
	switch n & 3 {
	case 0:
		return s, c
	case 1:
		return c, -s
	case 2:
		return -s, -c
	default:
		return -c, s
	}
}

// Taylor coefficients of sin and cos, as exact constant expressions that the
// compiler rounds once.
const (
	s1 = -1.0 / 6
	s2 = 1.0 / 120
	s3 = -1.0 / 5040
	s4 = 1.0 / 362880
	s5 = -1.0 / 39916800
	s6 = 1.0 / 6227020800
	s7 = -1.0 / 1307674368000
	s8 = 1.0 / 355687428096000

	c1 = 1.0 / 24
	c2 = -1.0 / 720
	c3 = 1.0 / 40320
	c4 = -1.0 / 3628800
	c5 = 1.0 / 479001600
	c6 = -1.0 / 87178291200
	c7 = 1.0 / 20922789888000
	c8 = -1.0 / 6402373705728000
)

// sinKernel returns sin(x+y) for |x| ≤ π/4 (a little more after reduction)
// and |y| far below the last place of x.
func sinKernel(x, y float64) float64 {
	z := x * x
	v := z * x
	r := float64(z*s8) + s7
	r = float64(z*r) + s6
	r = float64(z*r) + s5
	r = float64(z*r) + s4
	r = float64(z*r) + s3
	r = float64(z*r) + s2
	if y == 0 {
		return x + float64(v*(float64(z*r)+s1))
	}
	return x - ((float64(z*(float64(0.5*y)-float64(v*r))) - y) - float64(v*s1))
}

// cosKernel returns cos(x+y) under the same conditions as sinKernel.
func cosKernel(x, y float64) float64 {
	z := x * x
	r := float64(z*c8) + c7
	r = float64(z*r) + c6
	r = float64(z*r) + c5
	r = float64(z*r) + c4
	r = float64(z*r) + c3
	r = float64(z*r) + c2
	r = float64(z*r) + c1
	r = z * r
	hz := float64(0.5 * z)
	w := 1 - hz
	return w + (((1 - w) - hz) + (float64(z*r) - float64(x*y)))
}

// reducePio2 returns n and y0 + y1 with x = n·π/2 + (y0 + y1) and
// |y0 + y1| ≤ π/4 or very slightly more, for a finite |x| > π/4.
func reducePio2(x float64) (n int32, y0, y1 float64) {
	if math.Abs(x) >= mediumMax {
		return reduceLarge(x)
	}
	// Cody and Waite's method, with more parts of π/2 when the result
	// cancels so much that the first two would not hold its bits.
	fn := math.Floor(float64(x*invPio2) + 0.5)
	n = toInt32(fn)
	r := x - float64(fn*pio2_1)
	w := float64(fn * pio2_1t)
	y0 = r - w
	ex := biasedExp(x)
	if ex-biasedExp(y0) > 16 {
		t := r
		w = float64(fn * pio2_2)
		r = t - w
		w = float64(fn*pio2_2t) - ((t - r) - w)
		y0 = r - w
		if ex-biasedExp(y0) > 49 {
			t = r
			w = float64(fn * pio2_3)
			r = t - w
			w = float64(fn*pio2_3t) - ((t - r) - w)
			y0 = r - w
		}
	}
	y1 = (r - y0) - w
	return n, y0, y1
}

// reduceLarge reduces a finite x with |x| ≥ 2^20·π/2 by Payne and Hanek's
// method: x·2/π is computed in integers from the bits of 2/π that matter,
// keeping 190 bits after the binary point.
func reduceLarge(x float64) (n int32, y0, y1 float64) {
	b := math.Float64bits(x)
	neg := b>>63 != 0
	// x = m·2^e, with -32 ≤ e ≤ 971 for these arguments.
	m := b&(1<<52-1) | 1<<52
	e := int32(b>>52&0x7ff) - 1075
	// Bits of 2/π weighted 2^-(e-1) and below; heavier bits add multiples
	// of 4 to x·2/π, which do not change the quadrant.
	pos := uint32(e - 1 + 63)
	i, s := pos/64, pos%64
	t := &twoOverPiBits
	w0 := t[i]<<s | t[i+1]>>(64-s)
	w1 := t[i+1]<<s | t[i+2]>>(64-s)
	w2 := t[i+2]<<s | t[i+3]>>(64-s)

	// p1:p2:p3 = m·(w0:w1:w2) mod 2^192; the binary point lies after bit 190.
	h2, p3 := bits.Mul64(m, w2)
	h1, l1 := bits.Mul64(m, w1)
	p2, c := bits.Add64(h2, l1, 0)
	p1, _ := bits.Add64(h1, m*w0, c)

	n = int32(p1 >> 62)
	f0, f1, f2 := p1&(1<<62-1), p2, p3 // the fraction, 190 bits
	fneg := false
	if f0>>61 != 0 {
		// At least a half: count the next quadrant and keep 1 − fraction.
		n++
		fneg = true
		var borrow uint64
		f2, borrow = bits.Sub64(0, f2, 0)
		f1, borrow = bits.Sub64(0, f1, borrow)
		f0, _ = bits.Sub64(1<<62, f0, borrow)
	}

	// Align the fraction to the top of 192 bits and normalise it. A double
	// comes no closer than about 2^-62 to a multiple of π/2, so at least 128
	// significant bits remain.
	v0, v1, v2 := f0<<2|f1>>62, f1<<2|f2>>62, f2<<2
	shift := int32(0)
	if v0 == 0 {
		v0, v1, v2 = v1, v2, 0
		shift = 64
	}
	if lz := uint32(bits.LeadingZeros64(v0)); lz > 0 {
		v0, v1 = v0<<lz|v1>>(64-lz), v1<<lz|v2>>(64-lz)
		shift += int32(lz)
	}
	// fraction = (v0·2^64 + v1)·2^-(128+shift), as a + c in floats.
	a := float64(float64(int64(v0>>11)) * pow2(-53-shift))
	rest := (v0&0x7ff)<<52 | v1>>12
	cc := float64(float64(int64(rest)) * pow2(-116-shift))
	hi := a + cc
	lo := cc - (hi - a)

	// Multiply by π/2 in double-double arithmetic.
	p, pe := twoProd(hi, pio2Hi)
	pe = pe + (float64(hi*pio2Lo) + float64(lo*pio2Hi))
	y0 = p + pe
	y1 = pe - (y0 - p)
	if fneg {
		y0, y1 = -y0, -y1
	}
	if neg {
		y0, y1, n = -y0, -y1, -n
	}
	return n, y0, y1
}

// twoProd returns p = a·b rounded and e with a·b = p + e exactly, by
// Dekker's method (a fused multiply-add would do it in one step, but is
// exactly what the package avoids).
func twoProd(a, b float64) (p, e float64) {
	p = float64(a * b)
	ah, al := split(a)
	bh, bl := split(b)
	e = ((float64(ah*bh) - p) + float64(ah*bl) + float64(al*bh)) + float64(al*bl)
	return p, e
}

// split returns hi + lo = a with each half holding 26 bits (Veltkamp).
func split(a float64) (hi, lo float64) {
	c := float64(splitter * a)
	hi = c - (c - a)
	return hi, a - hi
}

// Taylor coefficients of exp.
const (
	e2  = 1.0 / 2
	e3  = 1.0 / 6
	e4  = 1.0 / 24
	e5  = 1.0 / 120
	e6  = 1.0 / 720
	e7  = 1.0 / 5040
	e8  = 1.0 / 40320
	e9  = 1.0 / 362880
	e10 = 1.0 / 3628800
	e11 = 1.0 / 39916800
	e12 = 1.0 / 479001600
	e13 = 1.0 / 6227020800
)

// Exp returns e^x.
func Exp(x float64) float64 {
	switch {
	case x != x:
		return math.NaN()
	case x > expOverflow:
		return math.Inf(1)
	case x < expUnderflow:
		return 0
	case math.Abs(x) < 0x1p-28:
		return 1 + x
	}
	// x = k·ln2 + r with |r| ≤ ln2/2; k·ln2Hi is exact.
	kf := math.Floor(float64(x*invLn2) + 0.5)
	k := toInt32(kf)
	hi := x - float64(kf*ln2Hi)
	lo := float64(kf * ln2Lo)
	r := hi - lo
	p := float64(r*e13) + e12
	p = float64(r*p) + e11
	p = float64(r*p) + e10
	p = float64(r*p) + e9
	p = float64(r*p) + e8
	p = float64(r*p) + e7
	p = float64(r*p) + e6
	p = float64(r*p) + e5
	p = float64(r*p) + e4
	p = float64(r*p) + e3
	p = float64(r*p) + e2
	// e^r = 1 + r + r²·p, with r kept as hi − lo for its last bits.
	y := 1 + (hi - (lo - float64(float64(r*r)*p)))

	// y·2^k, with one rounding even when the result is subnormal.
	switch {
	case k > 1023:
		return float64(y*2) * pow2(k-1)
	case k >= -1022:
		return y * pow2(k)
	case k >= -1074:
		return y * math.Float64frombits(1<<uint32(k+1074))
	default:
		return float64(y*0.5) * math.Float64frombits(1)
	}
}

// Coefficients of 2·atanh(s)/s − 2 in powers of s², which are 2/(2i+1).
const (
	lg1  = 2.0 / 3
	lg2  = 2.0 / 5
	lg3  = 2.0 / 7
	lg4  = 2.0 / 9
	lg5  = 2.0 / 11
	lg6  = 2.0 / 13
	lg7  = 2.0 / 15
	lg8  = 2.0 / 17
	lg9  = 2.0 / 19
	lg10 = 2.0 / 21
)

// Log returns the natural logarithm of x.
func Log(x float64) float64 {
	switch {
	case x != x || x < 0:
		return math.NaN()
	case x == 0:
		return math.Inf(-1)
	case x > math.MaxFloat64:
		return x
	}
	k := int32(0)
	if x < 0x1p-1022 { // subnormal: scale into the normal range
		x *= 0x1p+54
		k = -54
	}
	b := math.Float64bits(x)
	k += int32(b>>52) - 1023
	m := math.Float64frombits(b&(1<<52-1) | 0x3ff<<52) // 1 ≤ m < 2
	if m >= sqrt2 {
		m *= 0.5
		k++
	}
	// log(m) = log(1+f) = 2·atanh(s) with s = f/(2+f), |s| < 0.172.
	f := m - 1
	kf := float64(k)
	if f == 0 {
		return float64(kf*ln2Hi) + float64(kf*ln2Lo)
	}
	s := f / (2 + f)
	z := s * s
	r := float64(z*lg10) + lg9
	r = float64(z*r) + lg8
	r = float64(z*r) + lg7
	r = float64(z*r) + lg6
	r = float64(z*r) + lg5
	r = float64(z*r) + lg4
	r = float64(z*r) + lg3
	r = float64(z*r) + lg2
	r = float64(z*r) + lg1
	r = float64(z * r)
	hfsq := float64(float64(0.5*f) * f)
	return float64(kf*ln2Hi) - ((hfsq - (float64(s*(hfsq+r)) + float64(kf*ln2Lo))) - f)
}

// Coefficients of (t − atan(t))/t³ in powers of t², alternating 1/(2i+1).
// Six are enough for |t| ≤ tan(π/64).
const (
	at1 = 1.0 / 3
	at2 = -1.0 / 5
	at3 = 1.0 / 7
	at4 = -1.0 / 9
	at5 = 1.0 / 11
	at6 = -1.0 / 13
)

// Atan returns the arctangent of x, in [-π/2, π/2].
func Atan(x float64) float64 {
	a := math.Abs(x)
	switch {
	case x != x:
		return math.NaN()
	case a < 0x1p-27:
		return x
	case a > math.MaxFloat64:
		return math.Copysign(pio2Hi, x)
	}
	hi, lo := atanKernel(a, 1)
	return math.Copysign(hi+lo, x)
}

// Atan2 returns the angle of the point (x, y) from the positive x axis, in
// [-π, π], with the special cases of the standard library's Atan2. It never
// forms y/x, whose rounding would add to the error.
func Atan2(y, x float64) float64 {
	ay, ax := math.Abs(y), math.Abs(x)
	switch {
	case y != y || x != x:
		return math.NaN()
	case y == 0:
		if x > 0 || (x == 0 && !math.Signbit(x)) {
			return y // ±0
		}
		return math.Copysign(piHi, y)
	case x == 0:
		return math.Copysign(pio2Hi, y)
	case ay > math.MaxFloat64:
		switch {
		case ax <= math.MaxFloat64:
			return math.Copysign(pio2Hi, y)
		case x > 0:
			return math.Copysign(pio4, y)
		default:
			return math.Copysign(pi3o4, y)
		}
	case ax > math.MaxFloat64:
		if x > 0 {
			return math.Copysign(0, y)
		}
		return math.Copysign(piHi, y)
	}
	hi, lo := atanKernel(ay, ax)
	if x < 0 { // π − angle
		s, e := twoSum(piHi, -hi)
		hi, lo = s, e+(piLo-lo)
	}
	return math.Copysign(hi+lo, y)
}

// atanKernel returns the angle of (x, y) as hi + lo, in [0, π/2], for finite
// y, x ≥ 0, not both zero. Its error is far below the last place of hi, so a
// caller that adds hi and lo rounds once.
func atanKernel(y, x float64) (hi, lo float64) {
	// Scale so that the products below neither overflow nor lose bits.
	m := x
	if y > m {
		m = y
	}
	if m > 0x1p+900 {
		x, y = float64(x*0x1p-300), float64(y*0x1p-300)
	} else if m < 0x1p-500 {
		x, y = float64(x*0x1p+300), float64(y*0x1p+300)
	}
	// k: how many of the boundaries atanMid lie below y/x.
	k := 0
	if y >= float64(atanMid[7]*x) {
		k = 8
	}
	if y >= float64(atanMid[k+3]*x) {
		k += 4
	}
	if y >= float64(atanMid[k+1]*x) {
		k += 2
	}
	if y >= float64(atanMid[k]*x) {
		k++
	}
	if k == 16 { // above 15.5π/32: π/2 − atan(x/y), with x/y ≤ tan(π/64)
		hi, lo = fastTwoSum(pio2Hi, -atanPoly(x/y))
		return hi, lo + pio2Lo
	}

	// atan(y/x) = atan(c) + atan(t) with t = (y − c·x)/(x + c·y), |t| ≤
	// tan(π/64). t is found as t + tl, so the sum below rounds once.
	c := atanC[k]
	p, pe := twoProd(c, x)
	q, qe := twoProd(c, y)
	n := y - p // exact: y and c·x are within a factor of two
	d, de := twoSum(x, q)
	de += qe
	t := (n - pe) / d
	tp, te := twoProd(t, d)
	tl := ((((n - tp) - te) - pe) - float64(t*de)) / d
	z := t * t
	hi, lo = fastTwoSum(atanHi[k], t)
	return hi, lo + (atanLo[k] + (tl - float64(float64(t*z)*atanQ(z))))
}

// atanQ returns (t − atan(t))/t³ for z = t², |t| ≤ tan(π/64).
func atanQ(z float64) float64 {
	q := float64(z*at6) + at5
	q = float64(z*q) + at4
	q = float64(z*q) + at3
	q = float64(z*q) + at2
	return float64(z*q) + at1
}

// twoSum returns s = a + b rounded and e with a + b = s + e exactly (Knuth).
func twoSum(a, b float64) (s, e float64) {
	s = a + b
	bb := s - a
	return s, (a - (s - bb)) + (b - bb)
}

// fastTwoSum is twoSum for |a| ≥ |b| (Dekker).
func fastTwoSum(a, b float64) (s, e float64) {
	s = a + b
	return s, b - (s - a)
}

// atanPoly returns atan(t) for |t| ≤ tan(π/64).
func atanPoly(t float64) float64 {
	return t - float64(float64(t*(t*t))*atanQ(t*t))
}
