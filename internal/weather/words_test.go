// SPDX-License-Identifier: AGPL-3.0-only

package weather

import (
	"encoding/json"
	"math"
	"os"
	"reflect"
	"testing"
)

// The words' cases, which the page's twin (client/src/chart/words.ts) is
// held to: fields sampled at points and times and the words they give.
// After a deliberate change, rewrite them with
//
//	go test ./internal/weather -run WordsFile -update
const wordsFile = "testdata/words.json"

type wordsData struct {
	Comment    string          `json:"comment"`
	Words      Words           `json:"words"`
	Boxes      []boxCase       `json:"boxes"`
	Outlooks   []outlookCase   `json:"outlooks"`
	Warnings   []warningCase   `json:"warnings"`
	Situations []situationCase `json:"situations"`
}

type boxCase struct {
	Weather PlaceWeather `json:"weather"`
	Box     Box          `json:"box"`
}

type outlookCase struct {
	Samples []OutlookSample `json:"samples"`
	Falls   bool            `json:"falls"`
	Outlook string          `json:"outlook"`
}

type warningCase struct {
	Warning Warning `json:"warning"`
	Wind    string  `json:"wind"`
	When    string  `json:"when"`
	Where   string  `json:"where"`
	Text    string  `json:"text"`
}

type situationCase struct {
	Situation Situation `json:"situation"`
	Lines     []string  `json:"lines"`
}

// testWords are the catalog's words.
func testWords(t testing.TB) Words {
	cat, _ := load(t)
	return WordsOf(cat)
}

const kn = knotMS

// rad is a direction in degrees as rad.
func rad(d float64) float64 { return d * math.Pi / 180 }

// ring is a place's centre and eight points about it: the mean winds from
// lo to hi knots from a direction, gusts g knots over, in clear air. The
// products are rounded alone, as Go on amd64 rounds them, not fused into
// the sum as on arm64: words.json is the same from either.
func ring(from, lo, hi, g float64) []PlaceSample {
	var out []PlaceSample
	for i := range 9 {
		m := float64((lo + (hi-lo)*float64(i)/8) * kn)
		out = append(out, PlaceSample{Mean: m, From: rad(from + float64(i%3-1)*4), Gust: m + float64(g*kn), Visibility: 9000})
	}
	return out
}

// with is ring's points with a change at some: sky, rain and visibility.
func with(ps []PlaceSample, n int, near int, rain, vis float64) []PlaceSample {
	out := append([]PlaceSample(nil), ps...)
	for i := 0; i < n && i < len(out); i++ {
		out[i].Near |= near
		out[i].Rain = rain
		if vis > 0 {
			out[i].Visibility = vis
		}
	}
	return out
}

func boxCases() []PlaceWeather {
	return []PlaceWeather{
		{Points: ring(225, 11, 17, 7), Pressure: 1013.2, Before: 1012.9, Quarter: 1012.6},
		{Points: ring(250, 14, 14.4, 4), Pressure: 1009.4, Before: 1011.1, Quarter: 1013.6},
		{Points: with(ring(200, 18, 26, 12), 3, NearSquall, 70, 600), Pressure: 1003.0, Before: 1001.2, Quarter: 1006.1},
		{Points: with(ring(200, 16, 22, 10), 2, NearSquall, 20, 1500), Pressure: 1006.0, Before: 1006.1, Quarter: 1006.0},
		{Points: with(ring(90, 4, 7, 2), 9, NearShower, 4, 3000), Pressure: 1016.0, Before: 1016.3, Quarter: 1015.0, Risk: "showers"},
		{Points: with(ring(0, 2, 5, 1), 4, NearFog, 0, 150), Pressure: 1024.6, Before: 1024.6, Quarter: 1024.6},
		{Points: with(ring(300, 25, 33, 14), 9, NearStorm, 12, 1200), Pressure: 994.4, Before: 996.0, Quarter: 1001.0},
		{Points: ring(160, 6, 9, 3), Pressure: 1018.0, Before: 1017.6, Quarter: 1012.0, Risk: "fog patches"},
		{Points: ring(170, 9, 10.4, 3), Pressure: 1015.3, Before: 1015.2, Quarter: 1015.5},
		{Points: with(ring(45, 30, 38, 15), 1, 0, 0.5, 2500), Pressure: 999.5, Before: 999.0, Quarter: 994.0},
	}
}

func outlookCases() []outlookCase {
	at := func(m float64, w PlaceWeather) OutlookSample { return OutlookSample{At: m, PlaceWeather: w} }
	sw := PlaceWeather{Points: with(ring(225, 9, 18, 7), 2, NearSquall, 20, 0)}
	nw := PlaceWeather{Points: ring(315, 22, 26, 8)}
	fair := PlaceWeather{Points: ring(315, 20, 24, 6)}
	poor := PlaceWeather{Points: with(ring(315, 20, 24, 6), 9, 0, 0.5, 1500)}
	east := PlaceWeather{Points: ring(90, 6, 9, 3)}
	east2 := PlaceWeather{Points: ring(95, 13, 16, 5)}
	east3 := PlaceWeather{Points: ring(70, 18, 21, 6)}
	storm := PlaceWeather{Points: with(ring(160, 30, 40, 14), 9, NearStorm, 10, 2500), Cyclonic: true}
	after := PlaceWeather{Points: ring(250, 28, 36, 12)}
	return []outlookCase{
		{Samples: []OutlookSample{at(0, sw), at(30, nw), at(60, fair), at(90, fair)}},
		{Samples: []OutlookSample{at(0, east), at(30, east2), at(60, east3), at(90, east3)}},
		{Samples: []OutlookSample{at(0, after), at(30, storm), at(60, after), at(90, after)}},
		{Samples: []OutlookSample{at(0, fair), at(30, poor), at(60, fair), at(90, fair)}, Falls: true},
		{Samples: []OutlookSample{at(0, east), at(30, east), at(60, east), at(90, east)}},
		{Samples: []OutlookSample{at(0, fair), at(30, poor), at(60, poor), at(90, poor)}},
	}
}

func warningCases() []Warning {
	return []Warning{
		{From: rad(225), Force: 8, First: 40, East: -3000, North: -2500, Place: "Gannet Holm", PlaceEast: -2000, PlaceNorth: -1500},
		{From: rad(0), Force: 9, First: 10, East: 500, North: 7000, Place: "Port Royal"},
		{From: rad(100), Force: 10, First: 80, East: 6500, North: 0, Place: "Lantern Rock", PlaceEast: 6000, PlaceNorth: 2000},
		{From: rad(300), Force: 11, First: 30, East: -6000, North: 4000},
		{From: rad(170), Force: 12, First: 60, East: 0, North: -7000, Place: "Hollow Rock", PlaceEast: 300, PlaceNorth: -5000},
	}
}

func situationCases() []Situation {
	nm := nauticalMile
	return []Situation{
		{Port: "Port Royal", Centre: 1.6 * nm, Middle: 3.2 * nm,
			Lows:   []SituationSystem{{Pressure: 995.6, East: -2.6 * nm, North: -2.4 * nm, Heading: rad(90), Speed: 4 * kn}},
			Fronts: []SituationFront{{From: rad(270), At: 50}}, Squalls: true, From: rad(260)},
		{Port: "Port Royal", Centre: 1.6 * nm, Middle: 3.2 * nm,
			Lows:   []SituationSystem{{Forming: true, At: 25, East: 0.5 * nm, North: 3.8 * nm}, {Pressure: 1001.2, East: 1 * nm, North: 0.5 * nm, Heading: rad(200), Speed: 0.5 * kn}},
			Fronts: []SituationFront{{From: rad(45), At: -1}}},
		{Port: "Port Royal", Centre: 1.6 * nm, Middle: 3.2 * nm},
	}
}

func makeWords(t testing.TB) wordsData {
	words := testWords(t)
	d := wordsData{
		Comment: "Written by go test ./internal/weather -run WordsFile -update: fields sampled at points and times (m/s, rad, mm an hour, m, hPa, minutes after the issue) and the words a box, an outlook, a gale warning and the general situation give of them.",
		Words:   words,
	}
	for _, w := range boxCases() {
		d.Boxes = append(d.Boxes, boxCase{Weather: w, Box: BoxOf(&w, &words)})
	}
	for _, c := range outlookCases() {
		c.Outlook = Outlook(c.Samples, c.Falls, &words)
		d.Outlooks = append(d.Outlooks, c)
	}
	for _, w := range warningCases() {
		c := warningCase{Warning: w, Text: WarningText(&w, &words)}
		c.Wind, c.When, c.Where = WarningParts(&w, &words)
		d.Warnings = append(d.Warnings, c)
	}
	for _, s := range situationCases() {
		d.Situations = append(d.Situations, situationCase{Situation: s, Lines: GeneralSituation(&s, &words)})
	}
	return d
}

// The words as a sailor reads them, at the cases the forecast's own
// examples give.
func TestWords(t *testing.T) {
	words := testWords(t)
	box := BoxOf(&boxCases()[0], &words)
	if want := (Box{Wind: "SW 13–16 kn · F4", Gusts: "23 kn", Sky: "Fair", Visibility: "Good", Barometer: "1013 hPa, rising slowly"}); box != want {
		t.Errorf("a box: %+v, want %+v", box, want)
	}
	if got := Outlook(outlookCases()[0].Samples, false, &words); got != "Southwest 4, veering northwest 6 imminent. Squally showers, then fair. Good." {
		t.Errorf("an outlook: %q", got)
	}
	if got := Outlook(outlookCases()[2].Samples, false, &words); got != "West 7 or gale 8, becoming cyclonic 7 or gale 8 imminent, veering west 7 or gale 8 soon. Fair, then rain, then fair. Good, occasionally moderate." {
		t.Errorf("a storm passing: %q", got)
	}
	if got := Outlook(outlookCases()[3].Samples, true, &words); got != "Northwest 5 or 6. Fair, then rain, then fair, then the falls. Good, occasionally poor." {
		t.Errorf("the falls ahead: %q", got)
	}
	w := warningCases()[0]
	if got := WarningText(&w, &words); got != "Southwesterly gale 8 expected soon, south-west of Gannet Holm" {
		t.Errorf("a warning: %q", got)
	}
	s := situationCases()[0]
	if got := GeneralSituation(&s, &words); !reflect.DeepEqual(got, []string{"Low 996 in the south-west outer waters, moving east slowly", "Front coming from the west, expected soon at Port Royal", "Squalls from the west"}) {
		t.Errorf("the general situation: %q", got)
	}
	for _, c := range []struct {
		words  int32
		turned bool
		want   string
	}{{0, false, "steady"}, {1, false, "rising slowly"}, {2, false, "rising"}, {-3, false, "falling quickly"}, {-4, false, "falling very rapidly"}, {-2, true, "now rising"}, {3, true, "now falling"}} {
		if got := TendencyWords(c.words, c.turned); got != c.want {
			t.Errorf("tendency %d %v: %q, want %q", c.words, c.turned, got, c.want)
		}
	}
}

// The cases written down are these words': the page holds its own to
// them.
func TestWordsFile(t *testing.T) {
	got := makeWords(t)
	if *update {
		data, _ := json.MarshalIndent(got, "", "  ")
		if err := os.WriteFile(wordsFile, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	data, err := os.ReadFile(wordsFile)
	if err != nil {
		t.Fatal(err)
	}
	var want wordsData
	if err := json.Unmarshal(data, &want); err != nil {
		t.Fatal(err)
	}
	round, _ := json.Marshal(got)
	var g wordsData
	if err := json.Unmarshal(round, &g); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(g, want) {
		t.Errorf("the words differ from words.json: rewrite it with -update if the change is meant")
	}
}
