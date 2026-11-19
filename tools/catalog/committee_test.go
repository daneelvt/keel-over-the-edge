// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

// committeeDoc is a catalog of two boats and the committee's flags as given.
func committeeDoc(t *testing.T, flags string) map[string]any {
	t.Helper()
	src := `
boats:
  - { id: one }
  - { id: two }
world:
  committee:
    dyes:
      - { letter: "r", name: red, colour: "#aa0000" }
      - { letter: "w", name: white, colour: "#eeeeee" }
    flags:
` + flags
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(src), &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

const committeeSignals = `
      - { id: f-p, signal: preparatory, rows: [rw] }
      - { id: f-x, signal: recall, rows: [rw] }
      - { id: f-ap, signal: postponement, rows: [rw] }
      - { id: f-m, signal: mark, rows: [rw] }
      - { id: f-pin, signal: pin, rows: [rw] }
      - { id: f-won-r, signal: victory, rows: [rw] }
      - { id: f-won-w, signal: victory, rows: [wr] }
      - { id: f-b, signal: burgee, rows: [rw] }
      - { id: f-g, signal: gilded, rows: [rw] }
      - { id: f-c, signal: committee, rows: [rw] }
`

func TestCommitteeFlags(t *testing.T) {
	good := `      - { id: c-one, signal: class, boat: one, rows: [rr, ww] }
      - { id: c-two, signal: class, boat: two, rows: [rw] }
` + committeeSignals
	if err := checkCommittee(committeeDoc(t, good)); err != nil {
		t.Fatalf("good flags refused: %v", err)
	}
	for name, c := range map[string]struct{ flags, want string }{
		"rows of two lengths": {strings.Replace(good, "[rr, ww]", "[rr, w]", 1), "row 1 is 1 long"},
		"a dye not listed":    {strings.Replace(good, "[rr, ww]", "[rr, wb]", 1), `names dye "b"`},
		"a boat with none":    {strings.Replace(good, "boat: two", "boat: one", 1), "boat two has no class pennant"},
		"a boat not there":    {strings.Replace(good, "boat: two", "boat: three", 1), `boat "three" is not in the catalog`},
		"a signal twice":      {good + "      - { id: f-x2, signal: recall, rows: [rw] }\n", "signal recall is flown by 2 flags"},
		"a signal by none":    {strings.Replace(good, "      - { id: f-pin, signal: pin, rows: [rw] }\n", "", 1), "signal pin is flown by 0 flags"},
		"a boat on a signal":  {strings.Replace(good, "signal: mark,", "signal: mark, boat: one,", 1), "only a class pennant names a boat"},
		"no winner's pennant": {strings.ReplaceAll(good, "signal: victory", "signal: burgee"), "no flag is a winner's pennant"},
	} {
		err := checkCommittee(committeeDoc(t, c.flags))
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: got %v, want an error saying %q", name, err, c.want)
		}
	}
}

// The real catalog's flags hold together.
func TestRealCommittee(t *testing.T) {
	doc, err := readCatalog(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	if err := checkCommittee(doc); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join("..", "..", artDir, "committee", "committee.glb")); err != nil {
		t.Fatal(err)
	}
}
