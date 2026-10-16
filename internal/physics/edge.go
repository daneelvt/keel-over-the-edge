// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// The edge of the world: the lip of the falls, the disk's radius. A boat is
// over the falls when its centre of gravity is at or beyond the lip: one
// comparison of the state's bits, which the server makes after each step
// and a client after each step it predicts, so both name the same tick.

// OverEdge reports whether a boat whose centre of gravity is at (x, y) is
// over the lip.
func OverEdge(w *WeatherPrepared, x, y float64) bool {
	return float64(x*x)+float64(y*y) >= w.edge2
}

// EdgeDistance is how far (x, y) lies inside the lip, m: negative beyond
// it.
func EdgeDistance(w *WeatherPrepared, x, y float64) float64 {
	return w.edge - math.Sqrt(float64(x*x)+float64(y*y))
}

// Edge is the lip's distance from the centre, m.
func (w *WeatherPrepared) Edge() float64 { return w.edge }

// MistFrom is where the mist band begins, m from the centre: where the
// falls begin to draw the air.
func (w *WeatherPrepared) MistFrom() float64 { return w.draftFrom }
