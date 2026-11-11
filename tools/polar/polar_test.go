// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/xml"
	"math"
	"strings"
	"testing"
)

func TestWind10(t *testing.T) {
	// 10 knots at 3 m is more 10 m up, by the log law over the open sea.
	dinghy := &kind{height: 3}
	got := dinghy.wind10(10) / knot
	want := 10 * math.Log(10/0.0002) / math.Log(3/0.0002)
	if math.Abs(got-want) > 1e-12 || got <= 10 {
		t.Errorf("wind10(10) = %v knots, want %v", got, want)
	}
	// And back.
	if back := dinghy.atHeight(got); math.Abs(back-10) > 1e-12 {
		t.Errorf("atHeight(%v) = %v knots, want 10", got, back)
	}
	// A wind given 10 m up is the game's.
	keel := &kind{height: 10}
	if got := keel.wind10(10) / knot; got != 10 || keel.atHeight(10) != 10 {
		t.Errorf("10 knots 10 m up is %v knots 10 m up", got)
	}
}

func TestVerdict(t *testing.T) {
	p := refPoint{Value: 5, Tolerance: 0.1}
	for got, want := range map[float64]bool{5: true, 5.49: true, 4.51: true, 5.6: false, 4.4: false} {
		if ok, _ := p.verdict(got); ok != want {
			t.Errorf("%v against 5 ± 10%%: %v", got, ok)
		}
	}
	p.AtMost = true
	p.Tolerance = 0
	for got, want := range map[float64]bool{4: true, 5: true, 5.01: false} {
		if ok, _ := p.verdict(got); ok != want {
			t.Errorf("%v at most 5: %v", got, ok)
		}
	}
}

func TestVMG(t *testing.T) {
	p := polar{Points: []point{
		{TWA: 45, Speed: 5, OK: true},
		{TWA: 60, Speed: 6, OK: true},
		{TWA: 150, Speed: 6, OK: true},
		{TWA: 180, Speed: 4, OK: true},
		{TWA: 40, Speed: 9, OK: false},
	}}
	up, upAngle, down, downAngle := vmg(p)
	if math.Abs(up-5*math.Cos(45*deg)) > 1e-12 || upAngle != 45 {
		t.Errorf("upwind VMG %v at %v°", up, upAngle)
	}
	if math.Abs(down-6*math.Cos(30*deg)) > 1e-12 || downAngle != 150 {
		t.Errorf("downwind VMG %v at %v°", down, downAngle)
	}
}

func TestChartIsSVG(t *testing.T) {
	polars := []polar{{Wind: 9, Points: []point{{TWA: 45, Speed: 4.8, OK: true}, {TWA: 90, Speed: 6, OK: true}}}}
	ref := &reference{Points: []refPoint{{Measure: "speed", TWA: 90, Wind: 9, Value: 6.3, Source: "a <source>"}}}
	svg := chart("Boat & co", polars, ref)
	if err := xml.Unmarshal(svg, new(struct{})); err != nil {
		t.Fatalf("the chart is not well-formed XML: %v", err)
	}
	for _, want := range []string{"Boat &amp; co", "<circle", "9 knots", "a &lt;source&gt;"} {
		if !strings.Contains(string(svg), want) {
			t.Errorf("the chart lacks %q", want)
		}
	}
}

func TestBoomRounded(t *testing.T) {
	for deg, want := range map[float64]int{4: 4, 4.4: 4, 4.9: 5, 12.2: 10, 12.6: 15, 77.7: 80, 84.1: 85, -80: 80, -4: 4} {
		if got := boomRounded(deg); got != want {
			t.Errorf("boomRounded(%v) = %d, want %d", deg, got, want)
		}
	}
}

func TestReefAdvice(t *testing.T) {
	kinds := []*kind{{name: "Jolly boat"}, {name: "Keelboat"}, {name: "Ship"}}
	got := reefAdvice(kinds, []float64{19, 13, 25})
	want := reefIntro + " Reef the Jolly boat from 19 knots, the Keelboat from 13 knots and the Ship from 25 knots.\n"
	if got != want {
		t.Errorf("reefAdvice = %q, want %q", got, want)
	}
	// The page's generated part runs from the first table to the advice's
	// end, and -handbook can find it again in what it wrote.
	page := "# Trim\n\nBefore.\n\n" + trimIntro + " (Jolly boat, flat water):\n\n- 40°: 4\n\n" + got + "\nAfter.\n"
	from, to, err := pageBlock(page)
	if err != nil {
		t.Fatal(err)
	}
	if page[:from] != "# Trim\n\nBefore.\n\n" || page[to:] != "\nAfter.\n" {
		t.Errorf("the generated part is %q", page[from:to])
	}
	if _, _, err := pageBlock("# Trim\n"); err == nil {
		t.Error("a page with no generated part")
	}
}

func TestBracesRounded(t *testing.T) {
	for deg, want := range map[float64]int{42: 42, 44.4: 42, 44.6: 45, 52.4: 50, 89.9: 90} {
		if got := bracesRounded(deg, 42); got != want {
			t.Errorf("bracesRounded(%v, 42) = %d, want %d", deg, got, want)
		}
	}
}
