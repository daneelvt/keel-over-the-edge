// SPDX-License-Identifier: AGPL-3.0-only

package lookout

import (
	"fmt"
	"math"
	"strconv"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The wind as the readout shows it: the wind at the masthead over the last
// three seconds, as an anemometer shows it, the mean of the speeds and the
// direction of the mean of the wind's vectors (the World Meteorological
// Organization's gust is the highest three-second mean, WMO-No. 8), and
// the force of the mean wind, without its gusts, as the Beaufort scale is
// defined: a gust raises the knots and leaves the force. The page's twin is
// client/src/ui/model.ts's WindWindow and client/src/ui/format.ts; both are
// held to testdata/wind.json.

// WindWindow is how long the readout's wind is averaged over, ms.
const WindWindow = 3000

// windSamples is how many samples the readout keeps at most: the page keeps
// one a frame.
const windSamples = 512

// Knot is a knot, m/s.
const Knot = 1852.0 / 3600

// Readout is the wind readout's anemometer: fed the wind at the boat as
// often as it is known, it holds the mean over the last WindWindow.
type Readout struct {
	// Speed is the mean speed over the window, m/s; From the direction the
	// mean of its vectors comes from, rad clockwise from north.
	Speed, From float64

	at, speed, east, north [windSamples]float64
	first, count           int
}

// Add takes the wind at now, ms of world time, its speed in m/s and the
// direction it comes from in rad, lets go of what is older than the
// window, and sets the mean. Time that goes back begins it again.
func (r *Readout) Add(now, speed, from float64) {
	n := windSamples
	if r.count > 0 && now < r.at[(r.first+r.count-1)%n] {
		r.count = 0
	}
	for r.count > 0 && (r.count == n || now-r.at[r.first] > WindWindow) {
		r.first = (r.first + 1) % n
		r.count--
	}
	i := (r.first + r.count) % n
	s, c := physics.SinCos(from)
	r.at[i], r.speed[i] = now, speed
	r.east[i], r.north[i] = speed*s, speed*c
	r.count++
	// Summed afresh, in the order taken, as the page sums them.
	var sumSpeed, sumEast, sumNorth float64
	for k := range r.count {
		j := (r.first + k) % n
		sumSpeed += r.speed[j]
		sumEast += r.east[j]
		sumNorth += r.north[j]
	}
	r.Speed = sumSpeed / float64(r.count)
	if sumEast != 0 || sumNorth != 0 {
		r.From = physics.Atan2(sumEast, sumNorth)
	} else {
		r.From = from
	}
}

// Wind is the wind as the readout writes it: "WSW 14 kn · F4".
type Wind struct {
	// Degrees is the direction it comes from, whole degrees 0 to 359, and
	// Point the compass point the readout names.
	Degrees int
	Point   string
	// Knots is its speed in whole knots; Force the mean wind's Beaufort
	// force.
	Knots, Force int
	Text         string
}

// Show is the readout for the mean held, with the mean wind's speed, m/s,
// for its force.
func (r *Readout) Show(mean float64) Wind { return WindOf(r.Speed, r.From, mean) }

// WindOf is the readout of a wind of speed, m/s, from a direction, rad,
// whose mean wind is mean, m/s.
func WindOf(speed, from, mean float64) Wind {
	d := WholeDegrees(from)
	w := Wind{Degrees: d, Point: CompassPoint(d), Knots: int(round(math.Max(0, speed) / Knot)), Force: BeaufortForce(mean)}
	w.Text = fmt.Sprintf("%s %d kn · F%d", w.Point, w.Knots, w.Force)
	return w
}

// round is x to the nearest whole number, a half up, as the page's
// Math.round rounds it.
func round(x float64) float64 {
	f := math.Floor(x)
	if x-f >= 0.5 {
		return f + 1
	}
	return f
}

// Knots is a speed in m/s as knots to a tenth, as the readout writes the
// boat's speed: "5.0".
func Knots(ms float64) string {
	k := round(math.Max(0, ms)/Knot*10) / 10
	return strconv.FormatFloat(k, 'f', 1, 64)
}

// WholeDegrees is an angle in rad as whole degrees clockwise from north, 0
// to 359.
func WholeDegrees(rad float64) int {
	d := int(round(rad*180/math.Pi)) % 360
	if d < 0 {
		d += 360
	}
	return d
}

// points are the sixteen points of the compass.
var points = [16]string{"N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"}

// CompassPoint is the nearest of the sixteen points to a direction in
// whole degrees: 11.25° either side of north is N.
func CompassPoint(deg int) string {
	d := float64((deg%360 + 360) % 360)
	return points[int(math.Floor((d+11.25)/22.5))%16]
}

// HeadingText is a heading in rad as the readout writes it: "090° E".
func HeadingText(rad float64) string {
	d := WholeDegrees(rad)
	return fmt.Sprintf("%03d° %s", d, CompassPoint(d))
}

// forceFrom is the wind, in knots, each Beaufort force begins at, 0 to 12
// (Met Office, Beaufort wind force scale).
var forceFrom = [13]int{0, 1, 4, 7, 11, 17, 22, 28, 34, 41, 48, 56, 64}

// BeaufortForce is the force of a mean wind of speed m/s, 0 to 12, by its
// whole knots as the scale's table has them: 10 knots is force 3, 11 is
// force 4.
func BeaufortForce(speed float64) int {
	k := int(round(math.Max(0, speed) / Knot))
	force := 0
	for f := 1; f < len(forceFrom); f++ {
		if k >= forceFrom[f] {
			force = f
		}
	}
	return force
}
