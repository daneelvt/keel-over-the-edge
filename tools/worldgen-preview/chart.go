// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"html"
	"image"
	"image/color"
	"image/png"
	"math"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// Colours: the sea by depth and the land by height in hypsometric tints,
// and the marks in colours distinguishable in colour-blind vision (Okabe
// and Ito), as tools/polar's.
var (
	markBlue   = "#0072b2"
	markGreen  = "#009e73"
	markOrange = "#d55e00"
	markPink   = "#cc79a7"
	markYellow = "#e69f00"
	markSky    = "#56b4e9"
)

// seaTints run from the shore to the deep; landTints from the shore to the
// highest land, each at its height in m.
var (
	seaTints = []tint{{0, 0xd4, 0xf0, 0xf4}, {2, 0xa8, 0xdc, 0xe8}, {8, 0x74, 0xbd, 0xdb}, {20, 0x3f, 0x8f, 0xc4}, {40, 0x1d, 0x4e, 0x89}}
	landTints = []tint{{0, 0xe8, 0xdc, 0xa8}, {2, 0xb5, 0xc9, 0x7a}, {10, 0x7f, 0xae, 0x5a}, {25, 0x9e, 0x9a, 0x55}, {45, 0xa6, 0x7b, 0x4a}, {80, 0x7a, 0x55, 0x3d}}
)

type tint struct {
	at      float64
	r, g, b uint8
}

// tintAt is the colour at a height between the tints given.
func tintAt(ts []tint, h float64) color.RGBA {
	if h <= ts[0].at {
		return color.RGBA{ts[0].r, ts[0].g, ts[0].b, 255}
	}
	for i := 1; i < len(ts); i++ {
		if h <= ts[i].at {
			a, b := ts[i-1], ts[i]
			t := (h - a.at) / (b.at - a.at)
			mix := func(x, y uint8) uint8 { return uint8(math.Round(float64(x) + float64(t*(float64(y)-float64(x))))) }
			return color.RGBA{mix(a.r, b.r), mix(a.g, b.g), mix(a.b, b.b), 255}
		}
	}
	l := ts[len(ts)-1]
	return color.RGBA{l.r, l.g, l.b, 255}
}

// elevationColour is a hexagon's colour by its elevation, in m.
func elevationColour(e float64) color.RGBA {
	if e > 0 {
		return tintAt(landTints, e)
	}
	return tintAt(seaTints, -e)
}

// surfaceColours are the surfaces' colours, by their index.
var surfaceColours = []color.RGBA{
	{0xe8, 0xdc, 0xa8, 255}, {0xc2, 0xd1, 0x7f, 255}, {0x8f, 0xbf, 0x5e, 255}, {0x3e, 0x7d, 0x45, 255},
	{0x8a, 0x86, 0x80, 255}, {0x4a, 0x45, 0x48, 255}, {0xa7, 0x9c, 0x5a, 255}, {0xd5, 0x5e, 0x00, 255},
}

// view maps the world to the chart: metres per pixel and the chart's side.
type view struct {
	x0, y0 float64 // the world point at the chart's top left
	scale  float64 // metres a pixel
	side   int
}

func (v view) px(x, y float64) (float64, float64) {
	return (x - v.x0) / v.scale, (v.y0 - y) / v.scale
}

// worldView is the whole disk.
func worldView(scale float64) view {
	const half = 8400.0
	return view{x0: -half, y0: half, scale: scale, side: int(2 * half / scale)}
}

// The tool's arithmetic writes every product that is added to as
// float64(…), as the physics package does, so that Go fuses no multiply-add
// on arm64 and its charts are the same bits on every machine: the tests hold
// a fixed seed's chart to a digest.

// raster draws an image of the view, a pixel each, coloured by colour of
// the ground at its centre.
func raster(g *physics.Ground, v view, colour func(elevation float64, surface int32) color.RGBA) []byte {
	img := image.NewRGBA(image.Rect(0, 0, v.side, v.side))
	for py := range v.side {
		for px := range v.side {
			x := v.x0 + float64((float64(px)+0.5)*v.scale)
			y := v.y0 - float64((float64(py)+0.5)*v.scale)
			e, s := g.At(x, y)
			img.SetRGBA(px, py, colour(e, s))
		}
	}
	return encodePNG(img)
}

func encodePNG(img image.Image) []byte {
	var b bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&b, img); err != nil {
		panic(err) // writing to memory
	}
	return b.Bytes()
}

func dataURI(p []byte) string { return "data:image/png;base64," + base64.StdEncoding.EncodeToString(p) }

// coasts are the coast lines in the view: marching squares over the ground
// sampled at each pixel's corners, with the line laid where elevation
// crosses nought between samples.
func coasts(g *physics.Ground, v view) string {
	n := v.side + 1
	e := make([]float64, n*n)
	for j := range n {
		for i := range n {
			x := v.x0 + float64(float64(i)*v.scale)
			y := v.y0 - float64(float64(j)*v.scale)
			e[j*n+i], _ = g.At(x, y)
			if e[j*n+i] <= 0 {
				e[j*n+i] = -0.5
			}
		}
	}
	var b strings.Builder
	cross := func(a, c float64) float64 { return a / (a - c) }
	for j := range n - 1 {
		for i := range n - 1 {
			a, bb, c, d := e[j*n+i], e[j*n+i+1], e[(j+1)*n+i+1], e[(j+1)*n+i]
			var pts [4][2]float64
			k := 0
			if (a > 0) != (bb > 0) {
				pts[k] = [2]float64{float64(i) + cross(a, bb), float64(j)}
				k++
			}
			if (bb > 0) != (c > 0) {
				pts[k] = [2]float64{float64(i + 1), float64(j) + cross(bb, c)}
				k++
			}
			if (c > 0) != (d > 0) {
				pts[k] = [2]float64{float64(i+1) - cross(c, d), float64(j + 1)}
				k++
			}
			if (d > 0) != (a > 0) {
				pts[k] = [2]float64{float64(i), float64(j+1) - cross(d, a)}
				k++
			}
			for s := 0; s+1 < k; s += 2 {
				fmt.Fprintf(&b, "M%.1f %.1fL%.1f %.1f", pts[s][0], pts[s][1], pts[s+1][0], pts[s+1][1])
			}
		}
	}
	return b.String()
}

// chart is the world's chart as an SVG: the terrain, its coasts, the rings
// of the calm water and the mist band and the disk's edge, the start area,
// every island's name but the rocks', each group's, and a scale.
func chart(b *worldgen.Bundle, c *chartConfig, v view, terrain []byte) []byte {
	var s bytes.Buffer
	side := float64(v.side)
	fmt.Fprintf(&s, `<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d" font-family="sans-serif">`+"\n", v.side, v.side, v.side, v.side)
	fmt.Fprintf(&s, `<rect width="100%%" height="100%%" fill="#14365e"/>`+"\n")
	fmt.Fprintf(&s, `<image id="terrain" width="%d" height="%d" href="%s"/>`+"\n", v.side, v.side, dataURI(terrain))
	fmt.Fprintf(&s, `<path id="coasts" d="%s" fill="none" stroke="#3b2f22" stroke-width="0.6"/>`+"\n", coasts(b.Ground, v))
	cx, cy := v.px(0, 0)
	for _, r := range []struct {
		radius float64
		label  string
		colour string
	}{{c.calm, "calm water", markGreen}, {c.mist, "mist band", markPink}, {c.disk, "the edge", markOrange}} {
		fmt.Fprintf(&s, `<circle cx="%.1f" cy="%.1f" r="%.1f" fill="none" stroke="%s" stroke-width="1.2" stroke-dasharray="6 4"/>`+"\n", cx, cy, r.radius/v.scale, r.colour)
		fmt.Fprintf(&s, `<text x="%.1f" y="%.1f" font-size="11" fill="%s">%s</text>`+"\n", cx+4, cy-r.radius/v.scale-3, r.colour, r.label)
	}
	// The start area: a dot at each place.
	var d strings.Builder
	for _, p := range b.Start.Places {
		x, y := v.px(p[0], p[1])
		fmt.Fprintf(&d, "M%.1f %.1fh.01", x, y)
	}
	fmt.Fprintf(&s, `<path id="start" d="%s" stroke="%s" stroke-width="1.6" stroke-linecap="round"/>`+"\n", d.String(), markYellow)
	// Names: a landmark's larger.
	fmt.Fprintln(&s, `<g id="names" fill="#111" stroke="#fff" stroke-width="2.5" paint-order="stroke" text-anchor="middle">`)
	for _, is := range b.Islands {
		if is.Group >= 0 {
			continue // its group's name is shown, and the page lists it
		}
		x, y := v.px(is.X, is.Y)
		size := 9
		switch is.Kind {
		case "main":
			size = 14
		case "landmark":
			size = 12
		}
		fmt.Fprintf(&s, `<text x="%.1f" y="%.1f" font-size="%d">%s</text>`+"\n", x, y-float64(is.Across)/2/v.scale-3, size, html.EscapeString(is.Name))
	}
	for _, g := range b.Groups {
		x, y := v.px(g.X, g.Y)
		fmt.Fprintf(&s, `<text x="%.1f" y="%.1f" font-size="10" font-style="italic">%s</text>`+"\n", x, y+14, html.EscapeString(g.Name))
	}
	fmt.Fprintln(&s, `</g>`)
	// The scale: a nautical mile.
	mile := 1852 / v.scale
	fmt.Fprintf(&s, `<g id="scale" stroke="#fff" fill="#fff" font-size="11"><path d="M20 %.1fh%.1fm0 -4v8m-%.1f -8v8" stroke-width="1.5"/><text x="20" y="%.1f">1 nautical mile</text></g>`+"\n",
		side-24, mile, mile, side-30)
	s.WriteString("</svg>\n")
	return s.Bytes()
}

// chartConfig is what the chart needs of the catalog: its rings.
type chartConfig struct {
	calm, mist, disk float64 // m
}
