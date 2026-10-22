// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// cloudsFixture is a repository root with the real catalog's weather and
// the real clouds' recipes, but for those named in leave.
func cloudsFixture(t *testing.T, weather string, leave ...string) string {
	t.Helper()
	files := map[string]string{"shared/catalog/boats.yaml": validBoats, weatherPath: weather}
	for _, form := range heapedForms {
		p := artDir + "/" + cloudsDir + "/" + form + ".json"
		data, err := os.ReadFile(filepath.Join("..", "..", p))
		if err != nil {
			t.Fatal(err)
		}
		files[p] = string(data)
	}
	for _, l := range leave {
		delete(files, artDir+"/"+cloudsDir+"/"+l+".json")
	}
	return fixture(t, files)
}

func TestClouds(t *testing.T) {
	check := func(root string) error {
		doc, err := readCatalog(root)
		if err != nil {
			t.Fatal(err)
		}
		if err := validate(root, doc); err != nil {
			t.Fatal(err)
		}
		return checkClouds(root, doc)
	}
	if err := check(cloudsFixture(t, realWeather())); err != nil {
		t.Fatalf("the real clouds: %v", err)
	}
	for _, c := range []struct {
		name, weather, leave, want string
	}{
		{"a form without its recipe", realWeather(), "storm", "the storm form has no recipe"},
		{"a top under its base", strings.Replace(realWeather(), "        top: 2500 # m: the anvil's", "        top: 300", 1), "", "weather.systems[squall].cloud: its top"},
		{"a deck under its base", strings.Replace(realWeather(), "        deck: [1, 1200]", "        deck: [1, 200]", 1), "", "weather.systems[storm].cloud.deck"},
		{"layers out of order", strings.Replace(realWeather(), "    middle: 1500 # m", "    middle: 7000 # m", 1), "", "the layers must lie"},
		{"rain's words that do not rise", strings.Replace(realWeather(), "    rainWords: [2.5, 10, 50]", "    rainWords: [2.5, 60, 50]", 1), "", "rainWords"},
	} {
		var leave []string
		if c.leave != "" {
			leave = append(leave, c.leave)
		}
		err := check(cloudsFixture(t, c.weather, leave...))
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v, want an error naming %q", c.name, err, c.want)
		}
	}
}
