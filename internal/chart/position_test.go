// SPDX-License-Identifier: AGPL-3.0-only

package chart

import (
	"encoding/json"
	"flag"
	"math"
	"os"
	"testing"
)

var update = flag.Bool("update", false, "rewrite testdata/positions.json from this machine's results")

// positionsFile holds the cases both the server's rule and the page's are
// held to: points and the positions written for them, and positions as a
// person might write them and the points they name.
const positionsFile = "testdata/positions.json"

type positionsData struct {
	Comment string          `json:"comment"`
	Written []writtenCase   `json:"written"`
	Parsed  []parsedCase    `json:"parsed"`
	Refused []refusedParsed `json:"refused"`
}

type writtenCase struct {
	East  float64 `json:"east"`
	North float64 `json:"north"`
	Text  string  `json:"text"`
}

type parsedCase struct {
	Text  string  `json:"text"`
	East  float64 `json:"east"`
	North float64 `json:"north"`
}

type refusedParsed struct {
	Text string `json:"text"`
}

// pointAt is the point at a latitude and a longitude in degrees.
func pointAt(lat, lon float64) (east, north float64) {
	r := (90 - lat) / degreesPerMile * nauticalMileM
	b := lon * math.Pi / 180
	return r * math.Sin(b), r * math.Cos(b)
}

// writtenCases are the points written: the pole and near it, the rim and
// half way, every meridian at every whole degree of latitude from the rim
// in, minutes either side of a half, a latitude's 59.5′ carried, 359°59.5′
// carried round to 000°00′, and beyond the lip.
func writtenCases() []writtenCase {
	var out []writtenCase
	add := func(e, n float64) { out = append(out, writtenCase{East: e, North: n, Text: Format(e, n)}) }
	add(0, 0)
	add(1, 0)    // 90°00′N: a metre is a third of a minute
	add(0, -3.5) // 89°59′N 180°00′
	add(pointAt(45, 0))
	add(pointAt(67.5, 90))
	for lon := 0.0; lon < 360; lon += 30 {
		for lat := 45.0; lat <= 85; lat += 5 {
			add(pointAt(lat, lon))
		}
	}
	const eps = 1e-6 // of a minute: clear of either side of a half
	for _, m := range []float64{0.5 - eps, 0.5 + eps, 59.5 - eps, 59.5 + eps} {
		add(pointAt(67+m/60, 45+12.25/60))
		add(pointAt(67.2, 45+m/60))
	}
	add(pointAt(52.4, 120.4))
	add(pointAt(60, 359+59.5/60+eps/60))
	add(pointAt(60, 359+59.5/60-eps/60))
	add(pointAt(44.5, 210))
	add(pointAt(61.123456, 1.0/60))
	return out
}

func parsedCases() []parsedCase {
	var out []parsedCase
	add := func(s string) {
		e, n, err := ParsePosition(s)
		if err != nil {
			panic(err)
		}
		out = append(out, parsedCase{Text: s, East: e, North: n})
	}
	for _, s := range []string{
		"67°24′N 045°12′", "67°24'N 045°12'", "67 24 N 45 12", "67 24.5 45 12.25", "67°24.5′N 45°12.25′",
		"90°00′N", "45°00′N 000°00′", "89°59′N 180°00′", "61°07′ 359°59′",
	} {
		add(s)
	}
	return out
}

var refusedCases = []string{"", "67°24′S 045°12′", "67°60′N 045°12′", "67°24′N 360°00′", "91°00′N 010°00′", "67°24′N", "a b c d", "67.5°24′N 045°12′"}

// The rule's own words at the cases a sailor reads most.
func TestPositionWords(t *testing.T) {
	for _, c := range []struct {
		east, north float64
		want        string
	}{
		{0, 0, "90°00′N"},
		{0, 3 * nauticalMileM, "60°00′N 000°00′"},
		{4.5 * nauticalMileM, 0, "45°00′N 090°00′"},
		{0, -2.25 * nauticalMileM, "67°30′N 180°00′"},
	} {
		if got := Format(c.east, c.north); got != c.want {
			t.Errorf("(%v, %v): %q, want %q", c.east, c.north, got, c.want)
		}
	}
	// 59.5′ is carried: never 60′.
	if got := Format(pointAt(67+59.5000001/60, 45)); got != "68°00′N 045°00′" {
		t.Errorf("a latitude of 67°59.5′: %q", got)
	}
	if got := Format(pointAt(60, 359+59.5000001/60)); got != "60°00′N 000°00′" {
		t.Errorf("a longitude of 359°59.5′: %q", got)
	}
}

// Every written case parses back to its point within a minute of arc, of
// latitude and of longitude.
func TestPositionsRoundTrip(t *testing.T) {
	for _, c := range writtenCases() {
		e, n, err := ParsePosition(c.Text)
		if err != nil {
			t.Fatalf("%q: %v", c.Text, err)
		}
		r0, r1 := math.Hypot(c.East, c.North), math.Hypot(e, n)
		if math.Abs(r0-r1) > nauticalMileM/degreesPerMile/60 {
			t.Errorf("%q: %.1f m from the pole, the point %.1f", c.Text, r1, r0)
		}
		if r0 > 10 {
			d := math.Abs(math.Remainder(math.Atan2(e, n)-math.Atan2(c.East, c.North), 2*math.Pi)) * 180 / math.Pi * 60
			if d > 1 {
				t.Errorf("%q: %.2f′ of longitude off", c.Text, d)
			}
		}
	}
	for _, s := range refusedCases {
		if _, _, err := ParsePosition(s); err == nil {
			t.Errorf("%q was read", s)
		}
	}
}

// The cases written down are this rule's: the page holds its own to them.
func TestPositionsFile(t *testing.T) {
	got := positionsData{
		Comment: "Written by go test ./internal/chart -run PositionsFile -update: points m east and north of the centre and their positions as written; positions as a person writes them and the points they name; texts that are no position.",
		Written: writtenCases(), Parsed: parsedCases(),
	}
	for _, s := range refusedCases {
		got.Refused = append(got.Refused, refusedParsed{Text: s})
	}
	if *update {
		data, _ := json.MarshalIndent(got, "", "  ")
		if err := os.WriteFile(positionsFile, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	data, err := os.ReadFile(positionsFile)
	if err != nil {
		t.Fatal(err)
	}
	var want positionsData
	if err := json.Unmarshal(data, &want); err != nil {
		t.Fatal(err)
	}
	for _, c := range want.Written {
		if s := Format(c.East, c.North); s != c.Text {
			t.Errorf("(%v, %v): %q, positions.json %q", c.East, c.North, s, c.Text)
		}
	}
	for _, c := range want.Parsed {
		e, n, err := ParsePosition(c.Text)
		if err != nil || e != c.East || n != c.North {
			t.Errorf("%q: (%v, %v) %v, positions.json (%v, %v)", c.Text, e, n, err, c.East, c.North)
		}
	}
	if len(want.Written) != len(got.Written) || len(want.Parsed) != len(got.Parsed) || len(want.Refused) != len(got.Refused) {
		t.Errorf("positions.json has other cases: rewrite it with -update")
	}
}
