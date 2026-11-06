// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// MinColourDistance is the least CIEDE2000 distance any two of the main
// colours may be apart, seen with full colour vision and with each kind of
// colour blindness at its strongest: far enough that no two read as one,
// however a player sees them.
const MinColourDistance = 15

// checkSailors checks what the schema cannot of the sailors' options: the
// main colours stay apart for every player (MinColourDistance), and the
// skins run from lightest to deepest, each darker than the last.
func checkSailors(doc map[string]any) error {
	opts, _ := doc["sailorOptions"].(map[string]any)
	var problems []string
	colours := optionColours(opts["colours"])
	for _, v := range Visions {
		if d, a, b := closest(colours, v.Sim); d < MinColourDistance {
			problems = append(problems, fmt.Sprintf("  sailorOptions.colours: %s and %s are %.1f apart %s, under %d",
				a, b, d, v.Name, MinColourDistance))
		}
	}
	skins := optionColours(opts["skins"])
	for i := 1; i < len(skins); i++ {
		if lightness(skins[i].rgb) >= lightness(skins[i-1].rgb) {
			problems = append(problems, fmt.Sprintf("  sailorOptions.skins: %s is not darker than %s", skins[i].id, skins[i-1].id))
		}
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return fmt.Errorf("the sailors' options:\n%s", strings.Join(problems, "\n"))
	}
	return nil
}

// optionColour is an option's id and colour, sRGB from 0 to 1.
type optionColour struct {
	id  string
	rgb [3]float64
}

func optionColours(list any) []optionColour {
	items, _ := list.([]any)
	var out []optionColour
	for _, it := range items {
		m, _ := it.(map[string]any)
		id, _ := m["id"].(string)
		hex, _ := m["colour"].(string)
		if c, ok := parseHex(hex); ok {
			out = append(out, optionColour{id: id, rgb: c})
		}
	}
	return out
}

func parseHex(s string) ([3]float64, bool) {
	if len(s) != 7 || s[0] != '#' {
		return [3]float64{}, false
	}
	var c [3]float64
	for i := range 3 {
		v, err := strconv.ParseUint(s[1+2*i:3+2*i], 16, 8)
		if err != nil {
			return [3]float64{}, false
		}
		c[i] = float64(v) / 255
	}
	return c, true
}

// A Vision is how colours are seen: with full colour vision, or with a kind
// of colour blindness at its strongest.
type Vision struct {
	Name string
	// Sim is the colour seen, from linear RGB to linear RGB.
	Sim func([3]float64) [3]float64
}

// Visions are full colour vision and the three kinds of dichromacy, as
// Machado, Oliveira and Fernandes (2009) simulate them at severity 1.
var Visions = []Vision{
	{"with full colour vision", func(c [3]float64) [3]float64 { return c }},
	{"to a protanope", machado([9]float64{0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998})},
	{"to a deuteranope", machado([9]float64{0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.011820, 0.042940, 0.968881})},
	{"to a tritanope", machado([9]float64{1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.303900})},
}

func machado(m [9]float64) func([3]float64) [3]float64 {
	return func(c [3]float64) [3]float64 {
		var out [3]float64
		for i := range 3 {
			out[i] = min(max(m[3*i]*c[0]+m[3*i+1]*c[1]+m[3*i+2]*c[2], 0), 1)
		}
		return out
	}
}

// closest is the least CIEDE2000 distance between any two of cs as sim
// sees them, and which two.
func closest(cs []optionColour, sim func([3]float64) [3]float64) (float64, string, string) {
	labs := make([][3]float64, len(cs))
	for i, c := range cs {
		labs[i] = lab(sim(linear(c.rgb)))
	}
	best, a, b := math.Inf(1), "", ""
	for i := range cs {
		for j := i + 1; j < len(cs); j++ {
			if d := ciede2000(labs[i], labs[j]); d < best {
				best, a, b = d, cs[i].id, cs[j].id
			}
		}
	}
	return best, a, b
}

// ColourDistances are the least distances between the given sRGB colours
// (#rrggbb) for each of Visions, in its order.
func ColourDistances(hexes []string) []float64 {
	cs := make([]optionColour, 0, len(hexes))
	for _, h := range hexes {
		c, _ := parseHex(h)
		cs = append(cs, optionColour{id: h, rgb: c})
	}
	out := make([]float64, len(Visions))
	for i, v := range Visions {
		out[i], _, _ = closest(cs, v.Sim)
	}
	return out
}

// lightness is an sRGB colour's CIE L*.
func lightness(c [3]float64) float64 { return lab(linear(c))[0] }

func linear(c [3]float64) [3]float64 {
	var out [3]float64
	for i, v := range c {
		if v <= 0.04045 {
			out[i] = v / 12.92
		} else {
			out[i] = math.Pow((v+0.055)/1.055, 2.4)
		}
	}
	return out
}

// lab is linear sRGB as CIE L*a*b* under D65.
func lab(c [3]float64) [3]float64 {
	x := (0.4124564*c[0] + 0.3575761*c[1] + 0.1804375*c[2]) / 0.95047
	y := 0.2126729*c[0] + 0.7151522*c[1] + 0.0721750*c[2]
	z := (0.0193339*c[0] + 0.1191920*c[1] + 0.9503041*c[2]) / 1.08883
	f := func(t float64) float64 {
		if t > 216.0/24389 {
			return math.Cbrt(t)
		}
		return (24389.0/27*t + 16) / 116
	}
	fx, fy, fz := f(x), f(y), f(z)
	return [3]float64{116*fy - 16, 500 * (fx - fy), 200 * (fy - fz)}
}

// ciede2000 is the CIEDE2000 colour difference (Sharma, Wu and Dalal, 2005).
func ciede2000(p, q [3]float64) float64 {
	const deg = math.Pi / 180
	l1, a1, b1 := p[0], p[1], p[2]
	l2, a2, b2 := q[0], q[1], q[2]
	c1, c2 := math.Hypot(a1, b1), math.Hypot(a2, b2)
	cm := (c1 + c2) / 2
	c7 := math.Pow(cm, 7)
	g := 0.5 * (1 - math.Sqrt(c7/(c7+math.Pow(25, 7))))
	a1p, a2p := (1+g)*a1, (1+g)*a2
	c1p, c2p := math.Hypot(a1p, b1), math.Hypot(a2p, b2)
	hue := func(b, a float64) float64 {
		if a == 0 && b == 0 {
			return 0
		}
		h := math.Atan2(b, a) / deg
		if h < 0 {
			h += 360
		}
		return h
	}
	h1p, h2p := hue(b1, a1p), hue(b2, a2p)
	dl := l2 - l1
	dc := c2p - c1p
	var dh float64
	switch {
	case c1p*c2p == 0:
		dh = 0
	case math.Abs(h2p-h1p) <= 180:
		dh = h2p - h1p
	case h2p-h1p > 180:
		dh = h2p - h1p - 360
	default:
		dh = h2p - h1p + 360
	}
	dH := 2 * math.Sqrt(c1p*c2p) * math.Sin(dh/2*deg)
	lm := (l1 + l2) / 2
	cmp := (c1p + c2p) / 2
	var hm float64
	switch {
	case c1p*c2p == 0:
		hm = h1p + h2p
	case math.Abs(h1p-h2p) <= 180:
		hm = (h1p + h2p) / 2
	case h1p+h2p < 360:
		hm = (h1p + h2p + 360) / 2
	default:
		hm = (h1p + h2p - 360) / 2
	}
	t := 1 - 0.17*math.Cos((hm-30)*deg) + 0.24*math.Cos(2*hm*deg) + 0.32*math.Cos((3*hm+6)*deg) - 0.20*math.Cos((4*hm-63)*deg)
	dTheta := 30 * math.Exp(-math.Pow((hm-275)/25, 2))
	cm7 := math.Pow(cmp, 7)
	rc := 2 * math.Sqrt(cm7/(cm7+math.Pow(25, 7)))
	sl := 1 + 0.015*math.Pow(lm-50, 2)/math.Sqrt(20+math.Pow(lm-50, 2))
	sc := 1 + 0.045*cmp
	sh := 1 + 0.015*cmp*t
	rt := -math.Sin(2*dTheta*deg) * rc
	return math.Sqrt(math.Pow(dl/sl, 2) + math.Pow(dc/sc, 2) + math.Pow(dH/sh, 2) + rt*(dc/sc)*(dH/sh))
}
