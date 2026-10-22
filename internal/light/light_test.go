// SPDX-License-Identifier: AGPL-3.0-only

package light_test

import (
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/light"
)

var update = flag.Bool("update", false, "rewrite testdata/schedule.json")

const scheduleFile = "testdata/schedule.json"

func characters(t *testing.T) []catalog.LightCharacter {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	return cat.World.Lights.Characters
}

// morse is the letters' Morse code: a dot, a dash.
var morse = map[string]string{"A": ".-", "D": "-..", "K": "-.-", "U": "..-"}

// e110 checks a character against IALA Recommendation E-110's limits for
// its class (Table 1), and the eclipse every class keeps: one shorter than
// 0.15 s merges the flashes (Guideline G1116).
func e110(ch *catalog.LightCharacter) error {
	s := make([]float64, len(ch.Steps))
	for i, v := range ch.Steps {
		s[i] = float64(v) / 1000
	}
	period := 0.0
	for _, v := range s {
		period += v
	}
	for i := 1; i < len(s); i += 2 {
		if s[i] < 0.15 {
			return fmt.Errorf("an eclipse of %.2f s merges the flashes", s[i])
		}
	}
	want := func(ok bool, format string, args ...any) error {
		if !ok {
			return fmt.Errorf(format, args...)
		}
		return nil
	}
	n := len(s) / 2
	switch ch.Class {
	case catalog.ClassFl:
		if ch.Group == "2+1" {
			if len(s) != 6 {
				return fmt.Errorf("a composite group of %d steps", len(s))
			}
			return want(s[1] >= s[0] && s[3] > s[1] && s[5] >= 3*s[1] && s[5] > s[3] && period <= 30,
				"Fl(2+1): eclipses %.1f, %.1f, %.1f s in %.0f s", s[1], s[3], s[5], period)
		}
		if n == 1 {
			return want(s[1] >= 3*s[0] && period >= 2 && period <= 15, "Fl: %.1f s light, %.1f s dark", s[0], s[1])
		}
		if fmt.Sprint(n) != ch.Group || n > 5 {
			return fmt.Errorf("group %s of %d flashes", ch.Group, n)
		}
		least, longest := 1.0, 20.0
		if n >= 3 {
			least, longest = 2, 30
		}
		for i := 0; i < len(s)-2; i += 2 {
			if s[i] != s[0] || s[i+1] != s[1] || s[1] < s[0] || s[0]+s[1] < least {
				return fmt.Errorf("Fl(%d): flash %.1f s and eclipse %.1f s within the group", n, s[i], s[i+1])
			}
		}
		return want(s[len(s)-2] == s[0] && s[len(s)-1] >= 3*s[1] && period <= longest,
			"Fl(%d): %.1f s between groups in %.0f s", n, s[len(s)-1], period)
	case catalog.ClassLFl:
		return want(n == 1 && s[0] >= 2 && s[1] >= 3*s[0] && period <= 20, "LFl: %.1f s light, %.1f s dark", s[0], s[1])
	case catalog.ClassOc:
		light, dark := 0.0, 0.0
		for i, v := range s {
			if i%2 == 0 {
				light += v
			} else {
				dark += v
			}
		}
		if n == 1 {
			return want(s[0] >= 3*s[1] && period >= 2 && period <= 15, "Oc: %.1f s light, %.1f s dark", s[0], s[1])
		}
		if fmt.Sprint(n) != ch.Group || n > 4 {
			return fmt.Errorf("group %s of %d eclipses", ch.Group, n)
		}
		longest := 20.0
		if n >= 3 {
			longest = 30
		}
		for i := 2; i < len(s); i += 2 {
			if s[i] != s[2] || s[i-1] != s[1] || s[0] < 3*s[i] {
				return fmt.Errorf("Oc(%d): light %.1f s within the group, %.1f s between", n, s[i], s[0])
			}
		}
		return want(light > dark && period <= longest, "Oc(%d): %.1f s light and %.1f s dark in %.0f s", n, light, dark, period)
	case catalog.ClassIso:
		return want(n == 1 && s[0] == s[1] && period >= 2 && period <= 12, "Iso: %.1f s and %.1f s", s[0], s[1])
	case catalog.ClassMo:
		code, ok := morse[ch.Group]
		if !ok || len(code) != n {
			return fmt.Errorf("Mo(%s): %d elements", ch.Group, n)
		}
		dot := s[0]
		for i, c := range code {
			if c == '.' {
				dot = s[2*i]
			}
		}
		for i, c := range code {
			if c == '-' && s[2*i] < 3*dot || c == '.' && s[2*i] != dot || i < n-1 && s[2*i+1] != dot {
				return fmt.Errorf("Mo(%s): element %d", ch.Group, i)
			}
		}
		return want(math.Abs(dot-0.5) < 0.11 && period <= 30, "Mo(%s): a dot of %.2f s in %.0f s", ch.Group, dot, period)
	}
	return fmt.Errorf("a class E-110 has not: %s", ch.Class)
}

// mark reports whether a character is one the buoyage system keeps for its
// marks (E-110 Tables 2 and 3): quick and very quick lights and their
// groups, the cardinal marks'; white Fl(2) 5 s or 10 s, the isolated
// danger's; white Iso, Oc, LFl 10 s and Mo(A), the safe water mark's; Mo(U),
// set aside; red or green Fl(2+1), the preferred channel's.
func mark(ch *catalog.LightCharacter) bool {
	period := float64(light.Period(ch.Steps)) / 1e6
	white := ch.Colour == catalog.LightCharacterColourWhite
	quick := len(ch.Steps) >= 2 && float64(ch.Steps[0]+ch.Steps[1]) < 1200
	switch {
	case quick:
		return true
	case white && ch.Class == catalog.ClassFl && ch.Group == "2" && (period == 5 || period == 10):
		return true
	case white && period == 10 && (ch.Class == catalog.ClassIso || ch.Class == catalog.ClassLFl || ch.Class == catalog.ClassOc && ch.Group == "1"):
		return true
	case ch.Class == catalog.ClassMo && (ch.Group == "A" || ch.Group == "U"):
		return true
	case !white && ch.Group == "2+1":
		return true
	}
	return false
}

func TestCharactersWithinE110(t *testing.T) {
	for i := range characters(t) {
		ch := &characters(t)[i]
		if err := e110(ch); err != nil {
			t.Errorf("%s: %v", ch.Notation, err)
		}
		if mark(ch) {
			t.Errorf("%s is a buoyage mark's", ch.Notation)
		}
		// Green flashing briefly can be mistaken for white (G1116): never
		// quick, and no flash under half a second.
		if ch.Colour == catalog.LightCharacterColourGreen && ch.Steps[0] < 500 {
			t.Errorf("%s: a green flash of %d ms", ch.Notation, ch.Steps[0])
		}
		// The notation says what the steps are.
		period := fmt.Sprintf("%ds", light.Period(ch.Steps)/1e6)
		colour := map[catalog.LightCharacterColour]string{"white": "W", "red": "R", "green": "G"}[ch.Colour]
		if !strings.HasSuffix(ch.Notation, " "+colour+" "+period) || !strings.HasPrefix(ch.Notation, string(ch.Class)) {
			t.Errorf("%s is not written as its class, colour and period %s %s", ch.Notation, colour, period)
		}
	}
}

func TestTheRulesCatchAMark(t *testing.T) {
	for _, ch := range []catalog.LightCharacter{
		{Notation: "Q", Class: catalog.ClassFl, Group: "1", Colour: "white", Steps: []int{300, 700}},
		{Notation: "Fl(2) W 10s", Class: catalog.ClassFl, Group: "2", Colour: "white", Steps: []int{500, 1000, 500, 8000}},
		{Notation: "Iso W 10s", Class: catalog.ClassIso, Group: "1", Colour: "white", Steps: []int{5000, 5000}},
		{Notation: "Mo(A) W 10s", Class: catalog.ClassMo, Group: "A", Colour: "white", Steps: []int{500, 500, 1500, 7500}},
		{Notation: "Fl(2+1) R 15s", Class: catalog.ClassFl, Group: "2+1", Colour: "red", Steps: []int{500, 1000, 500, 3000, 500, 9500}},
	} {
		if !mark(&ch) {
			t.Errorf("%s is not caught as a mark's", ch.Notation)
		}
	}
	for _, ch := range []catalog.LightCharacter{
		{Notation: "Fl W 5s", Class: catalog.ClassFl, Group: "1", Colour: "white", Steps: []int{2000, 3000}},
		{Notation: "Fl(3) W 10s", Class: catalog.ClassFl, Group: "3", Colour: "white", Steps: []int{500, 1000, 500, 1000, 500, 6500}},
		{Notation: "Oc W 6s", Class: catalog.ClassOc, Group: "1", Colour: "white", Steps: []int{4000, 2000}},
		{Notation: "Iso W 1s", Class: catalog.ClassIso, Group: "1", Colour: "white", Steps: []int{500, 500}},
	} {
		if e110(&ch) == nil {
			t.Errorf("%s passes E-110", ch.Notation)
		}
	}
}

func TestOn(t *testing.T) {
	steps := []int{500, 1500, 500, 1500, 500, 10500} // Fl(3) 15 s
	for _, c := range []struct {
		phase, t int64
		on       bool
	}{
		{0, 0, true}, {0, 499_999, true}, {0, 500_000, false}, {0, 2_000_000, true}, {0, 4_400_000, true},
		{0, 4_500_000, false}, {0, 14_999_999, false}, {0, 15_000_000, true}, {2_000_000, 0, true},
		{0, -1, false}, {0, -15_000_000, true}, {3_000_000, 12_000_000, true},
	} {
		if got := light.On(steps, c.phase, c.t); got != c.on {
			t.Errorf("phase %d at %d: %v, not %v", c.phase, c.t, got, c.on)
		}
	}
	if light.On(nil, 0, 0) {
		t.Error("a light of no steps shows")
	}
}

func TestBlast(t *testing.T) {
	steps := []int{2000, 2000, 2000, 24000} // two blasts every 30 s
	for _, c := range []struct {
		phase, t, start int64
		on              bool
	}{
		{0, 0, 0, true}, {0, 1_999_999, 0, true}, {0, 2_000_000, 0, false}, {0, 4_000_000, 4_000_000, true},
		{0, 5_500_000, 4_000_000, true}, {0, 6_000_000, 0, false}, {0, 29_999_999, 0, false},
		{0, 30_500_000, 30_000_000, true}, {1_000_000, 0, -1_000_000, true}, {0, -29_000_000, -30_000_000, true},
	} {
		start, on := light.Blast(steps, c.phase, c.t)
		if on != c.on || on && start != c.start {
			t.Errorf("phase %d at %d: %v from %d, not %v from %d", c.phase, c.t, on, start, c.on, c.start)
		}
		if on != light.On(steps, c.phase, c.t) {
			t.Errorf("phase %d at %d: a blast where a light would not show", c.phase, c.t)
		}
	}
}

// Each light takes the first pattern of its device no light before it
// within the distance has; when every one is had, the one held furthest.
func TestAssignFogSignals(t *testing.T) {
	patterns := []string{"a", "b", "b", "b", "c"}
	places := [][2]float64{{0, 0}, {100, 0}, {200, 0}, {300, 0}, {400, 0}, {10000, 0}, {500, 0}, {50, 0}}
	devices := []string{"b", "b", "b", "a", "b", "b", "d", "b"}
	got := light.AssignFogSignals(places, devices, patterns, 1000)
	// The fourth b is within 1000 m of all three before it: the one whose
	// holder is furthest, the first's, 400 m off; the last, 50 m from the
	// first and within reach of all, takes the one held 150 m off.
	want := []int{1, 2, 3, 0, 1, 1, -1, 3}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("light %d: pattern %d, want %d", i, got[i], want[i])
		}
	}
}

func TestAllard(t *testing.T) {
	tr := light.Transmissivity(10)
	if math.Abs(tr-0.676) > 0.0005 {
		t.Errorf("the transmissivity in 10 miles' visibility is %.4f, not 0.676", tr)
	}
	for _, r := range []float64{1389, 2778, 4630, 8334} {
		ta := light.Transmissivity(4.5)
		i := light.Intensity(r, ta, 2e-7)
		if e := light.Illuminance(i, r, ta); math.Abs(e/2e-7-1) > 1e-9 {
			t.Errorf("at its range of %.0f m a light gives %.3g lux, not the threshold", r, e)
		}
		if light.Illuminance(i, r/2, ta) <= 2e-7 || light.Illuminance(i, 2*r, ta) >= 2e-7 {
			t.Errorf("a light of range %.0f m is not seen within it, or is beyond it", r)
		}
	}
}

func TestNotation(t *testing.T) {
	for _, c := range []struct {
		char       string
		focal, rng float64
		want       string
	}{
		{"Fl(3) W 15s", 84.7, 8334, "Fl(3) W 15s 85m 4.5M"},
		{"Oc(2) W 10s", 30.4, 4630, "Oc(2) W 10s 30m 2.5M"},
		{"Fl R 5s", 17.2, 1389, "Fl R 5s 17m 0.8M"},
		{"Iso G 6s", 17, 3704, "Iso G 6s 17m 2M"},
	} {
		if got := light.Notation(c.char, c.focal, c.rng); got != c.want {
			t.Errorf("%q, not %q", got, c.want)
		}
	}
}

// golden is the schedule file: each character's light at times about its
// period, with two phases, as a string of 1 for light and 0 for dark.
type golden struct {
	Comment string        `json:"comment"`
	Times   []int64       `json:"times"`
	Phases  []int64       `json:"phases"`
	Lights  []goldenLight `json:"lights"`
	// FogSignals are the fog signals' blasts, and Assignment a world's
	// lights given their fog signals.
	FogSignals []goldenSignal   `json:"fogSignals"`
	Assignment goldenAssignment `json:"assignment"`
}

type goldenLight struct {
	Notation string   `json:"notation"`
	Steps    []int    `json:"steps"`
	On       []string `json:"on"` // by phase
}

// goldenSignal is a fog signal's blasts in the schedule file: at each time
// and phase, 1 for a blast and 0 for silence, and each blast's start.
type goldenSignal struct {
	Notation string    `json:"notation"`
	Device   string    `json:"device"`
	Steps    []int     `json:"steps"`
	On       []string  `json:"on"`     // by phase
	Starts   [][]int64 `json:"starts"` // by phase, the blasts' starts at the times in a blast
}

// goldenAssignment is an assignment of fog signals to lights in the
// schedule file, which the page's makes too.
type goldenAssignment struct {
	Places  [][2]float64 `json:"places"`
	Devices []string     `json:"devices"`
	Apart   float64      `json:"apart"`
	Signals []int        `json:"signals"`
}

// TestGoldenSchedule holds the rule to testdata/schedule.json, which the
// page's rule is held to too (client/src/lights/character.test.ts): the
// same flash at the same moment on the server and every phone. Rewrite it
// after a change to the characters with
//
//	go test ./internal/light -run Golden -update
func TestGoldenSchedule(t *testing.T) {
	chars := characters(t)
	g := golden{
		Comment: "Written by go test ./internal/light -run Golden -update: each character's light at each time, with each phase.",
		Phases:  []int64{0, 7_654_321, 1_234_567_890_123},
	}
	// Times across days of world time, and about each step's edges.
	for k := int64(0); k < 400; k++ {
		g.Times = append(g.Times, k*137_000+k*k*977)
	}
	for _, d := range []int64{86_400_000_000, 3_000_000_000_000, 9_000_000_000_000_000} {
		for k := int64(0); k < 40; k++ {
			g.Times = append(g.Times, d+k*499_999, d+k*500_000, d+k*500_001)
		}
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	var patterns []string
	for _, fs := range cat.World.Lights.FogSignals {
		gs := goldenSignal{Notation: fs.Notation, Device: string(fs.Device), Steps: fs.Steps}
		patterns = append(patterns, string(fs.Device))
		for _, p := range g.Phases {
			var b strings.Builder
			starts := []int64{}
			for _, tm := range g.Times {
				if start, on := light.Blast(fs.Steps, p, tm); on {
					b.WriteByte('1')
					starts = append(starts, start)
				} else {
					b.WriteByte('0')
				}
			}
			gs.On = append(gs.On, b.String())
			gs.Starts = append(gs.Starts, starts)
		}
		g.FogSignals = append(g.FogSignals, gs)
	}
	// Forty lights about a disk, each of a device of the catalog's, many
	// within reach of one another.
	devices := cat.World.Lights.FogSignal.Devices
	roles := []string{string(devices.Port), string(devices.Hazard), string(devices.Edge), string(devices.Hazard)}
	a := goldenAssignment{Apart: cat.World.Lights.FogSignal.Apart * light.NauticalMile, Devices: []string{string(devices.MainPort)}, Places: [][2]float64{{-36.25, 71.5}}}
	for k := range 40 {
		r := 300 + float64(k*k%37)*210.125
		th := float64(k) * 2.399963
		a.Places = append(a.Places, [2]float64{math.Round(r*math.Sin(th)*8) / 8, math.Round(r*math.Cos(th)*8) / 8})
		a.Devices = append(a.Devices, roles[k%len(roles)])
	}
	a.Signals = light.AssignFogSignals(a.Places, a.Devices, patterns, a.Apart)
	g.Assignment = a
	for _, ch := range chars {
		gl := goldenLight{Notation: ch.Notation, Steps: ch.Steps}
		for _, p := range g.Phases {
			var b strings.Builder
			for _, tm := range g.Times {
				if light.On(ch.Steps, p, tm) {
					b.WriteByte('1')
				} else {
					b.WriteByte('0')
				}
			}
			gl.On = append(gl.On, b.String())
		}
		g.Lights = append(g.Lights, gl)
	}
	if *update {
		data, _ := json.MarshalIndent(g, "", "  ")
		if err := os.WriteFile(scheduleFile, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	data, err := os.ReadFile(scheduleFile)
	if err != nil {
		t.Fatal(err)
	}
	var want golden
	if err := json.Unmarshal(data, &want); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(want.Times) != fmt.Sprint(g.Times) || fmt.Sprint(want.Phases) != fmt.Sprint(g.Phases) || len(want.Lights) != len(g.Lights) {
		t.Fatalf("%s is for other times, phases or characters: write it again with -update", scheduleFile)
	}
	if fmt.Sprint(want.FogSignals) != fmt.Sprint(g.FogSignals) {
		t.Errorf("the fog signals' blasts differ from %s", scheduleFile)
	}
	if fmt.Sprint(want.Assignment) != fmt.Sprint(g.Assignment) {
		t.Errorf("the fog signals' assignment differs from %s", scheduleFile)
	}
	for i := range g.Lights {
		if fmt.Sprint(want.Lights[i]) != fmt.Sprint(g.Lights[i]) {
			t.Errorf("%s's schedule differs from %s", g.Lights[i].Notation, scheduleFile)
		}
	}
}
