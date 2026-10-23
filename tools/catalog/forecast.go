// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The forecast, the chart's weather and the barometer are checked here for
// what the schema cannot say: the forecast's steps divide its horizon and
// its issues fall on its steps, its cones grow, every regime has its risks
// once, a gale's gust lies above its mean wind and its grid fits the
// module's room, an outlook's samples rise within the horizon, and the
// barometer's dial and words run in order.

// checkForecast fails on a forecast, a chart's weather or a barometer the
// schema cannot judge.
func checkForecast(doc map[string]any) error {
	var problems []string
	bad := func(format string, args ...any) { problems = append(problems, "  "+fmt.Sprintf(format, args...)) }
	num := func(v any) float64 {
		n, _ := v.(json.Number)
		f, err := n.Float64()
		if err != nil {
			return math.NaN()
		}
		return f
	}
	whole := func(x float64) bool { return math.Abs(x-math.Round(x)) < 1e-9 }

	w, _ := doc["weather"].(map[string]any)
	f, _ := w["forecast"].(map[string]any)
	every, horizon, step := num(f["every"]), num(f["horizon"]), num(f["step"])
	if steps := horizon / step; !whole(steps) || steps > physics.MaxForecastSteps-1 {
		bad("weather.forecast: the horizon (%v) must be a whole number of steps (%v), at most %d", f["horizon"], f["step"], physics.MaxForecastSteps-1)
	}
	if !whole(every/step) && !whole(step/every) {
		bad("weather.forecast: every (%v) and step (%v) must be whole multiples, one of the other", f["every"], f["step"])
	}
	cone, _ := f["cone"].(map[string]any)
	if !(num(cone["perHour"]) > 0) || !(num(cone["forming"]) > 0) {
		bad("weather.forecast.cone: the cones must grow: perHour %v, forming %v", cone["perHour"], cone["forming"])
	}
	gale, _ := f["gale"].(map[string]any)
	if !(num(gale["mean"]) < num(gale["gust"])) {
		bad("weather.forecast.gale: the gust (%v) must be more than the mean wind (%v)", gale["gust"], gale["mean"])
	}
	if side := 2*math.Ceil(num(gale["within"])/num(gale["grid"])) + 1; side > physics.MaxGaleSide {
		bad("weather.forecast.gale: a grid of %v nautical miles within %v has %v points a side, more than %d", gale["grid"], gale["within"], side, physics.MaxGaleSide)
	}
	outlook, _ := f["outlook"].(map[string]any)
	samples, _ := outlook["samples"].([]any)
	for i := range samples {
		if num(samples[i]) > horizon || i > 0 && !(num(samples[i-1]) < num(samples[i])) {
			bad("weather.forecast.outlook.samples: %v must rise within the horizon, %v", outlook["samples"], f["horizon"])
			break
		}
	}
	if !(num(outlook["imminent"]) < num(outlook["soon"])) {
		bad("weather.forecast.outlook: imminent (%v) must be less than soon (%v)", outlook["imminent"], outlook["soon"])
	}
	regimes, _ := w["regimes"].([]any)
	risked := map[string]int{}
	risks, _ := f["risks"].([]any)
	for _, r := range risks {
		m, _ := r.(map[string]any)
		id, _ := m["regime"].(string)
		risked[id]++
	}
	for _, r := range regimes {
		m, _ := r.(map[string]any)
		id, _ := m["id"].(string)
		switch risked[id] {
		case 0:
			bad("weather.forecast.risks: regime %s has no risks", id)
		case 1:
		default:
			bad("weather.forecast.risks: regime %s has risks %d times", id, risked[id])
		}
		delete(risked, id)
	}
	for id := range risked {
		bad("weather.forecast.risks: no regime %q", id)
	}

	world, _ := doc["world"].(map[string]any)
	inst, _ := world["instruments"].(map[string]any)
	baro, _ := inst["barometer"].(map[string]any)
	rng, _ := baro["range"].([]any)
	if len(rng) == 2 && !(num(rng[0]) < num(rng[1])) {
		bad("world.instruments.barometer.range: %v is not from low to high", baro["range"])
	}
	words, _ := baro["words"].([]any)
	last := math.Inf(-1)
	for _, x := range words {
		m, _ := x.(map[string]any)
		at := num(m["at"])
		if len(rng) == 2 && (at < num(rng[0]) || at > num(rng[1])) || !(at > last) {
			bad("world.instruments.barometer.words: %v must rise within the dial", baro["words"])
			break
		}
		last = at
	}
	if len(problems) > 0 {
		return fmt.Errorf("catalog: the forecast:\n%s", strings.Join(problems, "\n"))
	}
	return nil
}
