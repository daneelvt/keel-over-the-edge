// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"html"
	"image"
	"image/color"
	"math"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen/chart"
)

// The marks' colours, as the chart package has them.
const (
	markGreen  = chart.MarkGreen
	markOrange = chart.MarkOrange
	markPink   = chart.MarkPink
	markYellow = chart.MarkYellow
)

// view maps the world to the chart: chart.View.
type view = chart.View

// worldView is the whole disk.
func worldView(scale float64) view { return chart.WorldView(scale) }

func encodePNG(img image.Image) []byte { return chart.EncodePNG(img) }

func dataURI(p []byte) string { return "data:image/png;base64," + base64.StdEncoding.EncodeToString(p) }

// chart is the world's chart as an SVG: the terrain, its coasts, the rings
// of the calm water and the mist band and the disk's edge, the start area,
// every island's name but the rocks', each group's, the places and the
// lights with their names and characters, the lights' ranges, and a scale.
func worldChart(b *worldgen.Bundle, c *chartConfig, v view, terrain []byte) []byte {
	var s bytes.Buffer
	side := float64(v.Side)
	fmt.Fprintf(&s, `<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d" font-family="sans-serif">`+"\n", v.Side, v.Side, v.Side, v.Side)
	fmt.Fprintf(&s, `<rect width="100%%" height="100%%" fill="#14365e"/>`+"\n")
	fmt.Fprintf(&s, `<image id="terrain" width="%d" height="%d" href="%s"/>`+"\n", v.Side, v.Side, dataURI(terrain))
	fmt.Fprintf(&s, `<path id="coasts" d="%s" fill="none" stroke="#3b2f22" stroke-width="0.6"/>`+"\n", chart.Coasts(b.Ground, v))
	cx, cy := v.Px(0, 0)
	for _, r := range []struct {
		radius float64
		label  string
		colour string
	}{{c.calm, "calm water", markGreen}, {c.mist, "mist band", markPink}, {c.disk, "the edge", markOrange}} {
		fmt.Fprintf(&s, `<circle cx="%.1f" cy="%.1f" r="%.1f" fill="none" stroke="%s" stroke-width="1.2" stroke-dasharray="6 4"/>`+"\n", cx, cy, r.radius/v.Scale, r.colour)
		fmt.Fprintf(&s, `<text x="%.1f" y="%.1f" font-size="11" fill="%s">%s</text>`+"\n", cx+4, cy-r.radius/v.Scale-3, r.colour, r.label)
	}
	// The start area: a dot at each place.
	var d strings.Builder
	for _, p := range b.Start.Places {
		x, y := v.Px(p[0], p[1])
		fmt.Fprintf(&d, "M%.1f %.1fh.01", x, y)
	}
	fmt.Fprintf(&s, `<path id="start" d="%s" stroke="%s" stroke-width="1.6" stroke-linecap="round"/>`+"\n", d.String(), markYellow)
	// Names: a landmark's larger.
	fmt.Fprintln(&s, `<g id="names" fill="#111" stroke="#fff" stroke-width="2.5" paint-order="stroke" text-anchor="middle">`)
	for _, is := range b.Islands {
		if is.Group >= 0 {
			continue // its group's name is shown, and the page lists it
		}
		x, y := v.Px(is.X, is.Y)
		size := 9
		switch is.Kind {
		case "main":
			size = 14
		case "landmark":
			size = 12
		}
		fmt.Fprintf(&s, `<text x="%.1f" y="%.1f" font-size="%d">%s</text>`+"\n", x, y-float64(is.Across)/2/v.Scale-3, size, html.EscapeString(is.Name))
	}
	for _, g := range b.Groups {
		x, y := v.Px(g.X, g.Y)
		fmt.Fprintf(&s, `<text x="%.1f" y="%.1f" font-size="10" font-style="italic">%s</text>`+"\n", x, y+14, html.EscapeString(g.Name))
	}
	fmt.Fprintln(&s, `</g>`)
	// The places, each a diamond in its kind's colour, and named.
	fmt.Fprintln(&s, `<g id="places" font-size="9" stroke-width="0.6">`)
	for _, p := range b.Places {
		if c.sites[p.Kind] == "light" {
			continue // drawn with the lights
		}
		x, y := v.Px(p.X, p.Y)
		fmt.Fprintf(&s, `<path d="M%.1f %.1fl3.5 3.5l-3.5 3.5l-3.5 -3.5z" fill="%s" stroke="#111"/>`+"\n", x, y-3.5, c.marks[p.Kind])
		fmt.Fprintf(&s, `<text x="%.1f" y="%.1f" fill="#111" stroke="#fff" stroke-width="2" paint-order="stroke" font-style="italic">%s</text>`+"\n", x+5, y+3, html.EscapeString(p.Name))
	}
	fmt.Fprintln(&s, `</g>`)
	// The islands worth seeing: a ring about each of class A, a fainter one
	// about each of class B.
	fmt.Fprintln(&s, `<g id="classes" fill="none">`)
	for _, is := range b.Islands {
		colour, width := "", 0.0
		switch is.Class {
		case "A":
			colour, width = "#f2c14e", 2.2
		case "B":
			colour, width = "#9fc5e8", 0.8
		default:
			continue
		}
		x, y := v.Px(is.X, is.Y)
		fmt.Fprintf(&s, `<circle cx="%.1f" cy="%.1f" r="%.1f" stroke="%s" stroke-width="%.1f"><title>%s: class %s, %.1f</title></circle>`+"\n",
			x, y, is.Across/2/v.Scale+5, colour, width, html.EscapeString(is.Name), is.Class, is.Score)
	}
	fmt.Fprintln(&s, `</g>`)
	// The features, each a triangle in its kind's colour, hollow if no boat
	// sees it from the water.
	fmt.Fprintln(&s, `<g id="features" stroke="#111" stroke-width="0.6">`)
	for _, f := range b.Features {
		x, y := v.Px(f.X, f.Y)
		fill := c.featureMarks[f.Kind]
		if !f.Seen {
			fill = "none"
		}
		fmt.Fprintf(&s, `<path d="M%.1f %.1fl3.5 6h-7z" fill="%s"><title>%s, %.0f m</title></path>`+"\n", x, y-3.5, fill, html.EscapeString(f.Kind), f.Height)
	}
	fmt.Fprintln(&s, `</g>`)
	// The lights' ranges, each a ring.
	fmt.Fprintln(&s, `<g id="ranges" fill="none" stroke-width="0.8" stroke-dasharray="3 3" style="display:none">`)
	for _, l := range b.Lights {
		x, y := v.Px(l.X, l.Y)
		fmt.Fprintf(&s, `<circle cx="%.1f" cy="%.1f" r="%.1f" stroke="%s"/>`+"\n", x, y, l.Range/v.Scale, lightColour(l.Notation))
	}
	fmt.Fprintln(&s, `</g>`)
	// The lights, each a ring in its colour, named and with its character.
	fmt.Fprintln(&s, `<g id="lights" font-size="9">`)
	for _, l := range b.Lights {
		x, y := v.Px(l.X, l.Y)
		r := 4.0
		if l.Role == "main" {
			r = 6
		}
		fmt.Fprintf(&s, `<circle cx="%.1f" cy="%.1f" r="%.1f" fill="%s" stroke="#e8b400" stroke-width="1.5"/>`+"\n", x, y, r, lightColour(l.Notation))
		name := ""
		for _, p := range b.Places {
			if p.Number == l.Place {
				name = p.Name
			}
		}
		fmt.Fprintf(&s, `<text x="%.1f" y="%.1f" fill="#111" stroke="#fff" stroke-width="2" paint-order="stroke">%s · %s</text>`+"\n",
			x+7, y-4, html.EscapeString(name), html.EscapeString(l.Notation))
	}
	fmt.Fprintln(&s, `</g>`)
	// The racing areas and the island courses.
	s.Write(coursesLayer(b, v))
	// The scale: a nautical mile.
	mile := 1852 / v.Scale
	fmt.Fprintf(&s, `<g id="scale" stroke="#fff" fill="#fff" font-size="11"><path d="M20 %.1fh%.1fm0 -4v8m-%.1f -8v8" stroke-width="1.5"/><text x="20" y="%.1f">1 nautical mile</text></g>`+"\n",
		side-24, mile, mile, side-30)
	s.WriteString("</svg>\n")
	return s.Bytes()
}

// chartConfig is what the chart needs of the catalog: its rings, and the
// kinds of place's marks and site rules, by id.
type chartConfig struct {
	calm, mist, disk float64 // m
	marks, sites     map[string]string
	// featureMarks are the kinds of feature's marks, by id; surfaces each
	// surface's colour, by its index.
	featureMarks map[string]string
	surfaces     []color.RGBA
}

// lightColour is a light's colour on the chart, by its notation's: R or G,
// else white.
func lightColour(notation string) string {
	switch {
	case strings.Contains(notation, " R "):
		return "#ff5a3c"
	case strings.Contains(notation, " G "):
		return "#3cff7d"
	}
	return "#fff3c4"
}

// courseColours are the courses' colours, one after another.
var courseColours = []string{"#ff6f59", "#43aa8b", "#f9c74f", "#577590", "#f3722c", "#90be6d", "#f94144", "#4d908e",
	"#f8961e", "#277da1", "#c77dff", "#ffafcc"}

// rayLength is how long a rounding ray is drawn, m.
const rayLength = 260

// coursesLayer draws the racing areas, each a circle lettered A1, A2 …; and
// the island courses, each its way dashed in a colour of its own and
// numbered at its middle, its site a square, its rounding rays as short
// strokes from where they start, and its beacons as triangles.
func coursesLayer(b *worldgen.Bundle, v view) []byte {
	var s bytes.Buffer
	fmt.Fprintln(&s, `<g id="areas" font-size="11" font-weight="bold">`)
	for _, a := range b.Areas {
		x, y := v.Px(a.X, a.Y)
		fmt.Fprintf(&s, `<circle cx="%.1f" cy="%.1f" r="%.1f" fill="#ffffff22" stroke="#ffffff" stroke-width="1.4"><title>racing area %d, %.0f m across, %.1f m deep at least</title></circle>`+"\n",
			x, y, a.Radius/v.Scale, a.Number+1, 2*a.Radius, a.Depth)
		fmt.Fprintf(&s, `<text x="%.1f" y="%.1f" fill="#fff" text-anchor="middle" dy="4">A%d</text>`+"\n", x, y, a.Number+1)
	}
	fmt.Fprintln(&s, `</g>`)
	fmt.Fprintln(&s, `<g id="courses" fill="none" stroke-linecap="round" stroke-linejoin="round">`)
	for i, c := range b.Courses {
		colour := courseColours[i%len(courseColours)]
		var d strings.Builder
		for k, p := range c.Way {
			x, y := v.Px(p[0], p[1])
			if k == 0 {
				fmt.Fprintf(&d, "M%.1f %.1f", x, y)
			} else {
				fmt.Fprintf(&d, "L%.1f %.1f", x, y)
			}
		}
		fmt.Fprintf(&s, `<path d="%s" stroke="%s" stroke-width="2" stroke-dasharray="5 3"><title>%d %s: %s, %.1f NM</title></path>`+"\n",
			d.String(), colour, c.Number+1, html.EscapeString(c.Kind), html.EscapeString(c.Name), c.Length/1852)
		for _, r := range c.Rays {
			x0, y0 := v.Px(r.X, r.Y)
			x1, y1 := v.Px(r.X+rayLength*math.Sin(r.Bearing), r.Y+rayLength*math.Cos(r.Bearing))
			fmt.Fprintf(&s, `<path d="M%.1f %.1fL%.1f %.1f" stroke="%s" stroke-width="1.2"/>`+"\n", x0, y0, x1, y1, colour)
		}
		for _, site := range []worldgen.CourseSite{c.Start, c.Finish} {
			x, y := v.Px(site.X, site.Y)
			fmt.Fprintf(&s, `<rect x="%.1f" y="%.1f" width="7" height="7" fill="%s" stroke="#111" stroke-width="0.8"/>`+"\n", x-3.5, y-3.5, colour)
		}
		mid := c.Way[len(c.Way)/2]
		x, y := v.Px(mid[0], mid[1])
		fmt.Fprintf(&s, `<text x="%.1f" y="%.1f" fill="%s" stroke="#111" stroke-width="2.5" paint-order="stroke" font-size="12" font-weight="bold" text-anchor="middle">%d</text>`+"\n",
			x, y, colour, c.Number+1)
	}
	for _, p := range b.Places {
		if p.Details.Marks == 0 {
			continue
		}
		x, y := v.Px(p.X, p.Y)
		fmt.Fprintf(&s, `<path d="M%.1f %.1fl4 7h-8z" fill="#111" stroke="#fff" stroke-width="1"><title>%s</title></path>`+"\n", x, y-4, html.EscapeString(p.Name))
	}
	fmt.Fprintln(&s, `</g>`)
	return s.Bytes()
}
