// SPDX-License-Identifier: AGPL-3.0-only

package weather

import (
	"encoding/json"
	"os"
	"testing"
)

// TestSkyFile holds SkyOf to the cases the phone's pocket sky is held to.
func TestSkyFile(t *testing.T) {
	b, err := os.ReadFile("testdata/pocketsky.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []struct {
			Name    string       `json:"name"`
			Weather PlaceWeather `json:"weather"`
			Box     Box          `json:"box"`
			Sky     string       `json:"sky"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Cases) == 0 {
		t.Fatal("no cases")
	}
	for _, c := range file.Cases {
		if got := SkyOf(&c.Weather, c.Box); got != c.Sky {
			t.Errorf("%s: %s, want %s", c.Name, got, c.Sky)
		}
	}
}
