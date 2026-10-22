// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestForecast(t *testing.T) {
	check := func(root string) error {
		doc, err := readCatalog(root)
		if err != nil {
			t.Fatal(err)
		}
		if err := validate(root, doc); err != nil {
			t.Fatal(err)
		}
		return checkForecast(doc)
	}
	weather := realWeather()
	if err := check(fixture(t, map[string]string{"shared/catalog/boats.yaml": validBoats, worldPath: realFile(worldPath)})); err != nil {
		t.Fatalf("the real forecast: %v", err)
	}
	for _, c := range []struct {
		name, weather, want string
	}{
		{"a horizon not a whole number of steps", strings.Replace(weather, "horizon: 90 # minutes", "horizon: 95 # minutes", 1), "a whole number of steps"},
		{"a regime without risks", strings.Replace(weather, "      - { regime: trade, sky: showers, marks: [showers] }\n", "", 1), "regime trade has no risks"},
		{"a regime's risks twice", strings.Replace(weather, "      - { regime: trade, sky: showers, marks: [showers] }\n",
			"      - { regime: trade, sky: showers, marks: [showers] }\n      - { regime: trade, sky: rain, marks: [] }\n", 1), "regime trade has risks 2 times"},
		{"a gale's gust under its mean", strings.Replace(weather, "gale: { mean: 34, gust: 43", "gale: { mean: 44, gust: 43", 1), "must be more than the mean wind"},
		{"a cone that does not grow", strings.Replace(weather, "cone: { perHour: 0.34", "cone: { perHour: 0", 1), "the cones must grow"},
		{"a grid too fine", strings.Replace(weather, "grid: 0.25, within: 4.2", "grid: 0.05, within: 4.2", 1), "points a side"},
	} {
		root := fixture(t, map[string]string{"shared/catalog/boats.yaml": validBoats, worldPath: realFile(worldPath)})
		if err := os.WriteFile(filepath.Join(root, weatherPath), []byte(c.weather), 0o644); err != nil {
			t.Fatal(err)
		}
		doc, err := readCatalog(root)
		if err != nil {
			t.Fatal(err)
		}
		if err := validate(root, doc); err != nil {
			// The schema itself refuses it: as good as the check.
			if strings.Contains(c.name, "cone") {
				continue
			}
			t.Fatalf("%s: %v", c.name, err)
		}
		err = checkForecast(doc)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v, want an error naming %q", c.name, err, c.want)
		}
	}
}
