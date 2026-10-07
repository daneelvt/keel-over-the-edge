// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// Fn names one of the package's own functions, so that a client can evaluate
// it inside the WebAssembly module and compare the bits with the server's
// (the golden tests, and the developer page on a phone).
type Fn uint32

// The functions, in the order of FnNames.
const (
	FnSin Fn = iota
	FnCos
	FnExp
	FnLog
	FnAtan
	FnAtan2
	fnCount
)

// FnNames names each Fn as the client's generated layout does.
var FnNames = [fnCount]string{
	FnSin:   "sin",
	FnCos:   "cos",
	FnExp:   "exp",
	FnLog:   "log",
	FnAtan:  "atan",
	FnAtan2: "atan2",
}

// Eval returns fn(a), or fn(a, b) for Atan2. An unknown fn gives NaN.
func Eval(fn Fn, a, b float64) float64 {
	switch fn {
	case FnSin:
		return Sin(a)
	case FnCos:
		return Cos(a)
	case FnExp:
		return Exp(a)
	case FnLog:
		return Log(a)
	case FnAtan:
		return Atan(a)
	case FnAtan2:
		return Atan2(a, b)
	}
	return math.NaN()
}
