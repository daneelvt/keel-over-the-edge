// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"flag"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

var update = flag.Bool("update", false, "write testdata/golden.json again")

const goldenPath = "testdata/golden.json"

// wellFormed checks that an SVG is XML that parses to its end.
func wellFormed(t *testing.T, name string, data []byte) {
	t.Helper()
	dec := xml.NewDecoder(strings.NewReader(string(data)))
	for {
		_, err := dec.Token()
		if err == io.EOF {
			return
		}
		if err != nil {
			t.Fatalf("%s is not well formed: %v", name, err)
		}
	}
}

func digest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func TestPreview(t *testing.T) {
	if testing.Short() {
		t.Skip("makes whole worlds")
	}
	// The tool runs from the repository's root.
	t.Chdir(filepath.Join("..", ".."))
	out := t.TempDir()
	if err := run(7, "", 0, 0, -1, out); err != nil {
		t.Fatal(err)
	}
	svg, err := os.ReadFile(filepath.Join(out, "chart.svg"))
	if err != nil {
		t.Fatal(err)
	}
	page, err := os.ReadFile(filepath.Join(out, "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	wellFormed(t, "chart.svg", svg)
	// Every island's name but a group's rocks' is on the chart once, and
	// every one in the page's list.
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	b, err := worldgen.Generate(7, cat)
	if err != nil {
		t.Fatal(err)
	}
	for _, is := range b.Islands {
		name := strings.ReplaceAll(strings.ReplaceAll(is.Name, "&", "&amp;"), "'", "&#39;")
		n := strings.Count(string(svg), ">"+name+"<")
		if is.Group < 0 && n != 1 || is.Group >= 0 && n != 0 {
			t.Errorf("%q is on the chart %d times", is.Name, n)
		}
		if !strings.Contains(string(page), "<td>"+name+"</td>") {
			t.Errorf("%q is not in the page's list", is.Name)
		}
	}
	got := map[string]string{"chart.svg": digest(svg), "index.html": digest(page)}
	if *update {
		data, _ := json.MarshalIndent(got, "", "  ")
		if err := os.WriteFile(filepath.Join("tools", "worldgen-preview", goldenPath), append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	} else {
		var want map[string]string
		data, err := os.ReadFile(filepath.Join("tools", "worldgen-preview", goldenPath))
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, &want); err != nil {
			t.Fatal(err)
		}
		for k, v := range got {
			if want[k] != v {
				t.Errorf("%s has changed: if it should, write %s again with -update", k, goldenPath)
			}
		}
	}

	// Several seeds side by side, and one island alone.
	if err := run(7, "", 4, 3, -1, out); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(out, "seeds.html")); err != nil || strings.Count(string(data), "<h2>Seed ") != 4 {
		t.Errorf("seeds.html has %d seeds (%v)", strings.Count(string(data), "<h2>Seed "), err)
	}
	if err := run(7, "", 0, 0, 1, out); err != nil {
		t.Fatal(err)
	}
	island, err := os.ReadFile(filepath.Join(out, "island-1.svg"))
	if err != nil {
		t.Fatal(err)
	}
	wellFormed(t, "island-1.svg", island)
	if err := run(7, "", 0, 0, 100000, out); err == nil {
		t.Error("an island the world has not was drawn")
	}
}
