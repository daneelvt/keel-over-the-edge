// SPDX-License-Identifier: AGPL-3.0-only

package lookout

// The whitecaps the phone draws on the sea, 0 to 1, by the wind the waves
// feel in knots: a row of the foam's look for each Beaufort force, read at
// the middle of the force and between rows, a strength that a row first
// has rising from nothing where its force begins. The sea's voice hears
// them. The page's twin is foamAt in client/src/ocean/look.ts, held to
// testdata/whitecaps.json.

// whitecapsByForce are the whitecaps of each force's row, 0 to 9.
var whitecapsByForce = [...]float64{0, 0, 0, 0.08, 0.25, 0.7, 0.85, 0.95, 1, 1}

// foamTop is the top row read: from it on, the look holds.
const foamTop = len(whitecapsByForce) - 2

// forceKnots is the wind a force's row is read at, knots: the middle of
// the force, a force ending a knot below the next one's beginning; the top
// rows hold from where the top force begins.
func forceKnots(force int) float64 {
	if force >= foamTop {
		return float64(forceFrom[foamTop])
	}
	return float64(forceFrom[force]+forceFrom[force+1]-1) / 2
}

// Whitecaps are the whitecaps in a wind of knots the waves feel.
func Whitecaps(knots float64) float64 {
	lo := 0
	for f := 1; f <= foamTop; f++ {
		if knots >= forceKnots(f) {
			lo = f
		}
	}
	hi := min(lo+1, foamTop)
	a, b := whitecapsByForce[lo], whitecapsByForce[hi]
	from, to := forceKnots(lo), forceKnots(hi)
	if a == 0 && b > 0 {
		begins := float64(forceFrom[hi])
		if knots <= begins {
			return 0
		}
		return float64(b*(knots-begins)) / (to - begins)
	}
	t := 0.0
	if to > from {
		t = min(max((knots-from)/(to-from), 0), 1)
	}
	return a + float64((b-a)*t)
}
