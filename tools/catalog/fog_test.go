// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fogDevices are the fog signals' devices, each with its recipe.
var fogDevices = []string{"twotone", "diaphone", "siren", "reedhorn"}

// fogFixture is a repository root with the real catalog's weather and
// world and the real fog signals' recipes, but for those named in leave.
func fogFixture(t *testing.T, world string, leave ...string) string {
	t.Helper()
	files := map[string]string{"shared/catalog/boats.yaml": validBoats, worldPath: world}
	for _, d := range fogDevices {
		p := artDir + "/" + soundDir + "/" + d + ".json"
		data, err := os.ReadFile(filepath.Join("..", "..", p))
		if err != nil {
			t.Fatal(err)
		}
		files[p] = string(data)
	}
	for _, l := range leave {
		delete(files, artDir+"/"+soundDir+"/"+l+".json")
	}
	return fixture(t, files)
}

func TestFog(t *testing.T) {
	check := func(root string) error {
		doc, err := readCatalog(root)
		if err != nil {
			t.Fatal(err)
		}
		if err := validate(root, doc); err != nil {
			t.Fatal(err)
		}
		return checkFog(root, doc)
	}
	world := realFile(worldPath)
	if err := check(fogFixture(t, world)); err != nil {
		t.Fatalf("the real fog signals: %v", err)
	}
	for _, c := range []struct {
		name, world, leave, want string
	}{
		{"a device without its recipe", world, "siren", "the siren has no recipe"},
		{"steps that end on a blast", strings.Replace(world, "device: reedhorn, steps: [1000, 9000] }", "device: reedhorn, steps: [1000, 9000, 1000] }", 1), "", "ending on a blast"},
		{"a pattern twice", strings.Replace(world, "{ notation: Horn(1) 15s, device: reedhorn", "{ notation: Horn(1) 10s, device: reedhorn", 1), "", `"Horn(1) 10s" twice`},
		{"too few patterns", strings.Replace(world, "edge: siren, hazard: reedhorn }", "edge: siren, hazard: twotone }", 1), "", "devices.hazard: the twotone has 1 patterns"},
	} {
		var leave []string
		if c.leave != "" {
			leave = append(leave, c.leave)
		}
		err := check(fogFixture(t, c.world, leave...))
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v, want an error naming %q", c.name, err, c.want)
		}
	}
	weather := realWeather()
	for _, c := range []struct {
		name, weather, want string
	}{
		{"words that do not rise", strings.Replace(weather, "words: [400, 1852, 3704]", "words: [400, 3704, 1852]", 1), "weather.visibility.words"},
		{"a fog's core upside down", strings.Replace(weather, "fog: { core: [50, 150]", "fog: { core: [150, 50]", 1), "weather.systems[fog].fog.core"},
	} {
		root := fogFixture(t, world)
		if err := os.WriteFile(filepath.Join(root, weatherPath), []byte(c.weather), 0o644); err != nil {
			t.Fatal(err)
		}
		err := check(root)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v, want an error naming %q", c.name, err, c.want)
		}
	}
}
