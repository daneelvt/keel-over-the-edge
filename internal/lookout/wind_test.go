// SPDX-License-Identifier: AGPL-3.0-only

package lookout

import (
	"math"
	"testing"
)

// windFile holds the cases the readout and the page's are held to.
const windFile = "testdata/wind.json"

type windData struct {
	Comment   string       `json:"comment"`
	Sequences []windRun    `json:"sequences"`
	Words     []windWords  `json:"words"`
	Headings  []headingRun `json:"headings"`
}

// windRun is a run of samples: sample i is at Start + i × Every ms, less
// BackBy from sample Back on (0 for none), its speed and direction the
// lists' (i mod their lengths)th; Shown the readout after each sample of At,
// for the mean wind Mean.
type windRun struct {
	Name   string      `json:"name"`
	Start  float64     `json:"start"`
	Every  float64     `json:"every"`
	Count  int         `json:"count"`
	Back   int         `json:"back"`
	BackBy float64     `json:"backBy"`
	Speeds []float64   `json:"speeds"`
	Froms  []float64   `json:"froms"`
	Mean   float64     `json:"mean"`
	At     []int       `json:"at"`
	Shown  []windShown `json:"shown"`
}

type windShown struct {
	Speed float64 `json:"speed"`
	From  float64 `json:"from"`
	Text  string  `json:"text"`
}

// windWords is a wind, its mean, and the readout's words for it.
type windWords struct {
	Speed float64 `json:"speed"`
	From  float64 `json:"from"`
	Mean  float64 `json:"mean"`
	Text  string  `json:"text"`
	Force int     `json:"force"`
	Knots string  `json:"knots"`
}

type headingRun struct {
	Heading float64 `json:"heading"`
	Text    string  `json:"text"`
}

func (w *windRun) run() []windShown {
	var r Readout
	var out []windShown
	k := 0
	for i := range w.Count {
		now := w.Start + float64(i)*w.Every
		if w.Back > 0 && i >= w.Back {
			now -= w.BackBy
		}
		r.Add(now, w.Speeds[i%len(w.Speeds)], w.Froms[i%len(w.Froms)])
		if k < len(w.At) && w.At[k] == i {
			s := r.Show(w.Mean)
			out = append(out, windShown{Speed: r.Speed, From: r.From, Text: s.Text})
			k++
		}
	}
	return out
}

func windRuns() []windRun {
	runs := []windRun{
		{Name: "steady", Start: 1000, Every: 100, Count: 10, Speeds: []float64{6}, Froms: []float64{1}, Mean: 6, At: []int{0, 9}},
		{Name: "gusts over three seconds", Start: 50000, Every: 16.5, Count: 400,
			Speeds: []float64{5, 5.5, 7.25, 8, 6.75, 4.5, 5.25}, Froms: []float64{4, 4.1, 3.9, 4.05, 4.2}, Mean: 5.6,
			At: []int{0, 50, 181, 182, 250, 399}},
		{Name: "about north", Start: 0, Every: 33.25, Count: 120, Speeds: []float64{4, 4.5}, Froms: []float64{6.2, 0.1, 6.25, 0.05}, Mean: 4.2,
			At: []int{1, 60, 119}},
		{Name: "the ring full", Start: 7, Every: 1, Count: 600, Speeds: []float64{3, 9, 4.5}, Froms: []float64{2, 2.5}, Mean: 5.5,
			At: []int{510, 511, 512, 599}},
		{Name: "time goes back", Start: 4000, Every: 100, Count: 50, Back: 30, BackBy: 2500, Speeds: []float64{7, 11}, Froms: []float64{-1, -1.25}, Mean: 8,
			At: []int{29, 30, 31, 49}},
		{Name: "calm", Start: 0, Every: 50, Count: 5, Speeds: []float64{0}, Froms: []float64{2}, Mean: 0, At: []int{0, 4}},
		{Name: "a pause between", Start: 0, Every: 2000, Count: 6, Speeds: []float64{2, 20, 12}, Froms: []float64{0.5, 3}, Mean: 10, At: []int{0, 1, 2, 5}},
		{Name: "a gale", Start: 100, Every: 40, Count: 90, Speeds: []float64{24, 31, 28.5, 35}, Froms: []float64{5.5, 5.6}, Mean: 27, At: []int{89}},
	}
	for i := range runs {
		runs[i].Shown = runs[i].run()
	}
	return runs
}

// windWordCases are winds either side of every force's first knot, and of
// a knot's half, from every quarter.
func windWordCases() []windWords {
	var out []windWords
	add := func(speed, from, mean float64) {
		w := WindOf(speed, from, mean)
		out = append(out, windWords{Speed: speed, From: from, Mean: mean, Text: w.Text, Force: w.Force, Knots: Knots(speed)})
	}
	for f, k := range forceFrom {
		for _, d := range []float64{-0.51, -0.49, 0.49} {
			s := (float64(k) + d) * Knot
			add(s, float64(f)*0.5-2, s)
		}
	}
	add(-1, 0, -1)
	add(70*Knot, 1, 30)
	for _, deg := range []float64{0, 11.24, 11.26, 33.74, 33.76, 180, 348.74, 348.76, 359.5, -0.5, -90, 720} {
		add(5, deg*math.Pi/180, 5)
	}
	return out
}

func headingCases() []headingRun {
	var out []headingRun
	for _, deg := range []float64{0, 0.49, 0.51, 45, 90, 179.5, 270, 359.49, 359.51, -45, 400} {
		h := deg * math.Pi / 180
		out = append(out, headingRun{Heading: h, Text: HeadingText(h)})
	}
	return out
}

// The readout's own words at the cases a sailor reads most.
func TestWindWords(t *testing.T) {
	for _, c := range []struct {
		knots, mean float64
		from        float64
		want        string
	}{
		{14, 14, 247.5, "WSW 14 kn · F4"},
		{10, 10, 0, "N 10 kn · F3"},
		{11, 11, 90, "E 11 kn · F4"},
		// A gust raises the knots and leaves the force.
		{21, 15, 180, "S 21 kn · F4"},
	} {
		if got := WindOf(c.knots*Knot, c.from*math.Pi/180, c.mean*Knot).Text; got != c.want {
			t.Errorf("%v kn from %v°: %q, want %q", c.knots, c.from, got, c.want)
		}
	}
	if got := Knots(5 * Knot); got != "5.0" {
		t.Errorf("5 kn: %q", got)
	}
	if got := HeadingText(math.Pi / 2); got != "090° E" {
		t.Errorf("east: %q", got)
	}
}

// The readout is the mean over three seconds: a sample older is let go.
func TestReadoutWindow(t *testing.T) {
	var r Readout
	r.Add(0, 10, 0)
	r.Add(3000, 4, 0)
	if r.Speed != 7 {
		t.Errorf("both within the window: %v", r.Speed)
	}
	r.Add(3001, 4, 0)
	if r.Speed != 4 {
		t.Errorf("the first let go: %v", r.Speed)
	}
	// From north-east and north-west alike: from the north.
	r = Readout{}
	r.Add(0, 5, math.Pi/4)
	r.Add(10, 5, -math.Pi/4)
	if math.Abs(r.From) > 1e-12 {
		t.Errorf("from %v", r.From)
	}
}

func TestWindFile(t *testing.T) {
	got := windData{
		Comment:   "Written by go test ./internal/lookout -run WindFile -update: runs of the wind at the boat, ms of world time, m/s and rad, and the readout after some of them, the mean over three seconds and its words; winds and their means and the readout's words; headings, rad, and their words.",
		Sequences: windRuns(), Words: windWordCases(), Headings: headingCases(),
	}
	caseFile(t, windFile, got, func(t *testing.T, want windData) {
		for _, w := range want.Sequences {
			shown := w.run()
			for i, s := range w.Shown {
				if i >= len(shown) || shown[i] != s {
					t.Errorf("%s at %d: %+v, wind.json %+v", w.Name, w.At[i], shown, s)
				}
			}
		}
		for _, c := range want.Words {
			w := WindOf(c.Speed, c.From, c.Mean)
			if w.Text != c.Text || w.Force != c.Force || Knots(c.Speed) != c.Knots {
				t.Errorf("%+v: %+v %q", c, w, Knots(c.Speed))
			}
		}
		for _, c := range want.Headings {
			if HeadingText(c.Heading) != c.Text {
				t.Errorf("%v: %q, wind.json %q", c.Heading, HeadingText(c.Heading), c.Text)
			}
		}
	})
}
