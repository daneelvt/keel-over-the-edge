// SPDX-License-Identifier: AGPL-3.0-only

package chart

import (
	"encoding/json"
	"math"
	"os"
	"reflect"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sight"
)

// listFile holds the cases both the server's list and the page's are held
// to: a boat, the entries charted, and the list's groups.
const listFile = "testdata/list.json"

type listData struct {
	Comment string     `json:"comment"`
	Cases   []listCase `json:"cases"`
}

type listCase struct {
	Name    string          `json:"name"`
	East    float64         `json:"east"`
	North   float64         `json:"north"`
	Entries []listCaseEntry `json:"entries"`
	Groups  []ListGroup     `json:"groups"`
}

type listCaseEntry struct {
	Subject string  `json:"subject"`
	East    float64 `json:"east"`
	North   float64 `json:"north"`
}

func (c *listCase) entries() []ListEntry {
	out := make([]ListEntry, len(c.Entries))
	for i, e := range c.Entries {
		out[i] = ListEntry{Kind: KindOf(e.Subject), East: e.East, North: e.North}
	}
	return out
}

// listCases are a few boats among entries: on every side and at every
// range, metres either side of a tenth of a mile, a tenth's tie, two at
// the same distance, a bearing that rounds to 360°, and groups left empty.
func listCases() []listCase {
	at := func(subject string, east, north float64) listCaseEntry {
		return listCaseEntry{Subject: subject, East: east, North: north}
	}
	polar := func(subject string, east, north, deg, d float64) listCaseEntry {
		s, c := physics.SinCos(deg * math.Pi / 180)
		return at(subject, east+float64(d*s), north+float64(d*c))
	}
	var cases []listCase
	{
		e, n := 1200.0, -3400.0
		c := listCase{Name: "about a boat", East: e, North: n}
		for i, d := range []float64{0.5, 12, 185.2, 185.3, 463, 926, 1852, 2500.4, 9000, 14000} {
			kind := []string{IslandWord, PlaceWord, FeatureWord}[i%3]
			c.Entries = append(c.Entries, polar(kind, e, n, float64(37*i+5), d))
		}
		c.Entries = append(c.Entries,
			at(PlaceWord, e+300, n), at(PlaceWord, e-300, n), at(FeatureWord, e, n+150),
			polar(IslandWord, e, n, 359.6, 4000), polar(FeatureWord, e, n, 0.4, 60), polar(PlaceWord, e, n, 180.5, 700))
		cases = append(cases, c)
	}
	cases = append(cases, listCase{Name: "islands alone", East: 0, North: 0, Entries: []listCaseEntry{
		at(IslandWord, 0, 0), at(IslandWord, -5000, 5000), at(IslandWord, 1000, 0), at(IslandWord, 0, -1000),
	}})
	cases = append(cases, listCase{Name: "nothing charted", East: 10, North: 10, Entries: []listCaseEntry{}})
	for i := range cases {
		cases[i].Groups = List(cases[i].entries(), cases[i].East, cases[i].North)
	}
	return cases
}

// The list's own words at the cases a sailor reads most.
func TestListWords(t *testing.T) {
	for _, c := range []struct {
		m    float64
		want string
	}{{0, "0 m"}, {0.5, "1 m"}, {185.2, "185 m"}, {185.3, "0.1 NM"}, {463, "0.3 NM"}, {926, "0.5 NM"}, {1852, "1.0 NM"}, {2500.4, "1.4 NM"}} {
		if got := DistanceText(c.m); got != c.want {
			t.Errorf("%v m: %q, want %q", c.m, got, c.want)
		}
	}
	for _, c := range []struct {
		deg  float64
		want string
	}{{0, "000°"}, {45, "045°"}, {359.6, "000°"}, {-90, "270°"}, {180.6, "181°"}} {
		if got := BearingText(c.deg * math.Pi / 180); got != c.want {
			t.Errorf("%v°: %q, want %q", c.deg, got, c.want)
		}
	}
	g := List([]ListEntry{{Kind: sight.Feature, East: 0, North: 50}, {Kind: sight.Island, East: 3000, North: 0}, {Kind: sight.Feature, East: 0, North: -20}}, 0, 0)
	if len(g) != 3 || len(g[0].Lines) != 1 || len(g[1].Lines) != 0 || g[2].Lines[0].Entry != 2 || g[0].Lines[0].Where != "090° 1.6 NM · 73°48′N 090°00′" {
		t.Errorf("the list: %+v", g)
	}
}

// The cases written down are this rule's: the page holds its own to them.
func TestListFile(t *testing.T) {
	got := listData{
		Comment: "Written by go test ./internal/chart -run ListFile -update: a boat m east and north of the centre, the entries charted, and the chart's list: its groups, each line's entry by its index, its distance, m, and where it is, as written.",
		Cases:   listCases(),
	}
	if *update {
		data, _ := json.MarshalIndent(got, "", "  ")
		if err := os.WriteFile(listFile, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	data, err := os.ReadFile(listFile)
	if err != nil {
		t.Fatal(err)
	}
	var want listData
	if err := json.Unmarshal(data, &want); err != nil {
		t.Fatal(err)
	}
	for _, c := range want.Cases {
		if g := List(c.entries(), c.East, c.North); !reflect.DeepEqual(g, c.Groups) {
			t.Errorf("%s: %+v, list.json %+v", c.Name, g, c.Groups)
		}
	}
	if !reflect.DeepEqual(want, got) {
		t.Errorf("list.json has other cases: rewrite it with -update")
	}
}
