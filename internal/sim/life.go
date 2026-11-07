// SPDX-License-Identifier: AGPL-3.0-only

package sim

import "github.com/daneelvt/keel-over-the-edge/internal/physics"

// The sea's life, in the rules phase, last but the world's end: the
// schedule's slots drawn as they begin, in the weather at the tick, and
// the groups that follow boats kept with them (package life). Nothing
// alive touches a boat.

// lifeWeather is the weather the sea's life is drawn in: the mean wind and
// the rain at a point, at the tick the physics phase brought the weather
// to.
type lifeWeather struct{ w *World }

func (l lifeWeather) Weather(x, y float64) (wind, rain float64) {
	wind, _ = physics.MeanWindAt(&l.w.wind, x, y)
	return wind, physics.RainAt(&l.w.wind, x, y)
}

// lifeRules brings the sea's life to the next frame's tick.
func (w *World) lifeRules() {
	if w.life == nil {
		return
	}
	w.life.Tick(w.next, w.lifeWeather)
}
