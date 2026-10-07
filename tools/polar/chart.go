// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"fmt"
	"html"
	"math"
)

// chartColours are one per wind, distinguishable in colour-blind vision.
var chartColours = []string{"#0072b2", "#009e73", "#d55e00", "#cc79a7", "#e69f00", "#56b4e9"}

// chart draws the polar as an SVG: speed against true wind angle, the wind
// from the top, one curve per wind, with the reference data as points. A
// filled point is a measurement; a hollow one is an upper bound.
func chart(name string, polars []polar, ref *reference) []byte {
	const (
		size   = 640.0
		margin = 48.0
		cx     = margin
		cy     = size / 2
	)
	top := 2.0
	for _, p := range polars {
		for _, pt := range p.Points {
			top = max(top, pt.Speed)
		}
	}
	rings := math.Ceil(top/2) * 2
	scale := (size/2 - margin) / rings
	xy := func(twa, knots float64) (float64, float64) {
		s, c := math.Sincos(twa * deg)
		return cx + knots*scale*s, cy - knots*scale*c
	}
	var b bytes.Buffer
	fmt.Fprintf(&b, `<svg xmlns="http://www.w3.org/2000/svg" width="%g" height="%g" viewBox="0 0 %g %g" font-family="sans-serif" font-size="12">`+"\n",
		size/2+margin, size, size/2+margin, size)
	fmt.Fprintf(&b, `<rect width="100%%" height="100%%" fill="#fff"/>`+"\n")
	fmt.Fprintf(&b, `<text x="%g" y="20" font-size="14">%s: speed in knots against true wind angle</text>`+"\n", margin/2, html.EscapeString(name))
	for k := 2.0; k <= rings; k += 2 {
		x0, y0 := xy(0, k)
		x1, y1 := xy(180, k)
		fmt.Fprintf(&b, `<path d="M%.1f %.1f A%.1f %.1f 0 0 1 %.1f %.1f" fill="none" stroke="#ddd"/>`+"\n", x0, y0, k*scale, k*scale, x1, y1)
		fmt.Fprintf(&b, `<text x="%.1f" y="%.1f" fill="#888">%g</text>`+"\n", x0+3, y0+12, k)
	}
	for a := 0.0; a <= 180; a += 30 {
		x, y := xy(a, rings)
		fmt.Fprintf(&b, `<line x1="%g" y1="%g" x2="%.1f" y2="%.1f" stroke="#ddd"/>`+"\n", cx, cy, x, y)
		lx, ly := xy(a, rings+0.6)
		fmt.Fprintf(&b, `<text x="%.1f" y="%.1f" text-anchor="middle" fill="#888">%g°</text>`+"\n", lx, ly+4, a)
	}
	for i, p := range polars {
		colour := chartColours[i%len(chartColours)]
		var d bytes.Buffer
		for _, pt := range p.Points {
			if !pt.OK {
				continue
			}
			x, y := xy(pt.TWA, pt.Speed)
			if d.Len() == 0 {
				fmt.Fprintf(&d, "M%.1f %.1f", x, y)
			} else {
				fmt.Fprintf(&d, " L%.1f %.1f", x, y)
			}
		}
		fmt.Fprintf(&b, `<path d="%s" fill="none" stroke="%s" stroke-width="2"/>`+"\n", d.String(), colour)
		fmt.Fprintf(&b, `<line x1="%g" y1="%g" x2="%g" y2="%g" stroke="%s" stroke-width="2"/><text x="%g" y="%g">%g knots</text>`+"\n",
			size/2-70, size-20*float64(len(polars)-i), size/2-50, size-20*float64(len(polars)-i), colour, size/2-44, size-20*float64(len(polars)-i)+4, p.Wind)
		if ref == nil {
			continue
		}
		for _, rp := range ref.Points {
			if rp.Wind != p.Wind || rp.Measure != "speed" {
				continue
			}
			x, y := xy(rp.TWA, rp.Value)
			fill := colour
			if rp.AtMost {
				fill = "#fff"
			}
			fmt.Fprintf(&b, `<circle cx="%.1f" cy="%.1f" r="5" fill="%s" stroke="%s" stroke-width="2"><title>%s</title></circle>`+"\n",
				x, y, fill, colour, html.EscapeString(rp.Source))
		}
	}
	b.WriteString("</svg>\n")
	return b.Bytes()
}
