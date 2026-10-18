// SPDX-License-Identifier: AGPL-3.0-only

// Package chart draws a world's terrain as a chart: the land by height and
// the sea by depth in hypsometric tints, a pixel each (Raster), the coast
// lines (Coasts), and one island hexagon by hexagon (Island). The world
// generator's preview and keel's world page draw with it.
//
// Its arithmetic writes every product that is added to as float64(…), as
// the physics package does, so that Go fuses no multiply-add on arm64 and
// its charts are the same bits on every machine: the preview's tests hold a
// fixed seed's chart to a digest.
package chart

import (
	"bytes"
	"fmt"
	"html"
	"image"
	"image/color"
	"image/png"
	"math"
	"slices"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// The marks' colours, distinguishable in colour-blind vision (Okabe and
// Ito 2002).
const (
	MarkGreen  = "#009e73"
	MarkOrange = "#d55e00"
	MarkPink   = "#cc79a7"
	MarkYellow = "#e69f00"
)

// seaTints run from the shore to the deep; landTints from the shore to the
// highest land, each at its height in m.
var (
	seaTints  = []tint{{0, 0xd4, 0xf0, 0xf4}, {2, 0xa8, 0xdc, 0xe8}, {8, 0x74, 0xbd, 0xdb}, {20, 0x3f, 0x8f, 0xc4}, {40, 0x1d, 0x4e, 0x89}}
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

// ElevationColour is a hexagon's colour by its elevation, in m.
func ElevationColour(e float64) color.RGBA {
	if e > 0 {
		return tintAt(landTints, e)
	}
	return tintAt(seaTints, -e)
}

// View maps the world to a chart: the world point at its top left, metres
// a pixel and the chart's side in pixels.
type View struct {
	X0, Y0 float64
	Scale  float64
	Side   int
}

// Px is the chart's pixel at the world point (x, y): x east and y north of
// the centre, m.
func (v View) Px(x, y float64) (float64, float64) {
	return (x - v.X0) / v.Scale, (v.Y0 - y) / v.Scale
}

// Half is half the side of the square WorldView draws, m: the disk and a
// little beyond its lip.
const Half = 8400.0

// WorldView is the whole disk, at scale metres a pixel.
func WorldView(scale float64) View {
	return View{X0: -Half, Y0: Half, Scale: scale, Side: int(2 * Half / scale)}
}

// Raster draws an image of the view, a pixel each, coloured by colour of
// the ground at its centre, as a PNG.
func Raster(g *physics.Ground, v View, colour func(elevation float64, surface int32) color.RGBA) []byte {
	img := image.NewRGBA(image.Rect(0, 0, v.Side, v.Side))
	for py := range v.Side {
		for px := range v.Side {
			x := v.X0 + float64((float64(px)+0.5)*v.Scale)
			y := v.Y0 - float64((float64(py)+0.5)*v.Scale)
			e, s := g.At(x, y)
			img.SetRGBA(px, py, colour(e, s))
		}
	}
	return EncodePNG(img)
}

// Terrain is the ground's colour by its elevation alone, for Raster.
func Terrain(e float64, _ int32) color.RGBA { return ElevationColour(e) }

// EncodePNG encodes an image as a PNG at the best compression.
func EncodePNG(img image.Image) []byte {
	var b bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&b, img); err != nil {
		panic(err) // writing to memory
	}
	return b.Bytes()
}

// Coasts are the coast lines in the view, as an SVG path's data in the
// view's pixels: marching squares over the ground sampled at each pixel's
// corners, with the line laid where elevation crosses nought between
// samples.
func Coasts(g *physics.Ground, v View) string {
	n := v.Side + 1
	e := make([]float64, n*n)
	for j := range n {
		for i := range n {
			x := v.X0 + float64(float64(i)*v.Scale)
			y := v.Y0 - float64(float64(j)*v.Scale)
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

// IslandBounds are the world's bounds of what Island draws of island i:
// west, south, east and north, m. ok is false for an island the world has
// not.
func IslandBounds(b *worldgen.Bundle, i int) (x0, y0, x1, y1 float64, ok bool) {
	if i < 0 || i >= len(b.Islands) {
		return 0, 0, 0, 0, false
	}
	c0, j0, c1, j1 := islandCells(b, &b.Islands[i])
	x0, _ = physics.CellCentre(c0, 0)
	x1, _ = physics.CellCentre(c1, 0)
	_, y0 = physics.CellCentre(0, j0)
	_, y1 = physics.CellCentre(0, j1)
	return x0 - 4, y0 - 4, x1 + 4, y1 + 4, true
}

// islandMargin is how many hexagons of water about an island's land Island
// draws.
const islandMargin = 15

// islandCells are the columns and rows of the hexagons within islandMargin
// of is's own land.
func islandCells(b *worldgen.Bundle, is *worldgen.Island) (c0, j0, c1, j1 int32) {
	box := is.Box
	c0, j0, c1, j1 = box[0]+box[2], box[1]+box[3], box[0], box[1]
	for c := box[0]; c < box[0]+box[2]; c++ {
		for j := box[1]; j < box[1]+box[3]; j++ {
			if elevation(b.Ground, c, j) > 0 && own(b, c, j, is) {
				c0, j0, c1, j1 = min(c0, c), min(j0, j), max(c1, c), max(j1, j)
			}
		}
	}
	return c0 - islandMargin, j0 - islandMargin, c1 + islandMargin, j1 + islandMargin
}

// Island is island i at the lattice's resolution, as an SVG: every hexagon
// of its land and the water about it, as a polygon in its colour, three
// pixels a metre; its roofs, an arch's span or a cave's roof, at their
// tops' colour, outlined, over the rock awash; its features, each named
// where it is; and a line naming it.
func Island(b *worldgen.Bundle, i int) ([]byte, error) {
	if i < 0 || i >= len(b.Islands) {
		return nil, fmt.Errorf("no island %d: the world has %d", i, len(b.Islands))
	}
	is := &b.Islands[i]
	c0, j0, c1, j1 := islandCells(b, is)
	x0, _ := physics.CellCentre(c0, 0)
	x1, _ := physics.CellCentre(c1, 0)
	_, y0 := physics.CellCentre(0, j0)
	_, y1 := physics.CellCentre(0, j1)
	const scale = 3.0 // pixels a metre
	w, h := (x1-x0+8)*scale, (y1-y0+8)*scale
	var s bytes.Buffer
	fmt.Fprintf(&s, `<svg xmlns="http://www.w3.org/2000/svg" width="%.0f" height="%.0f" viewBox="0 0 %.0f %.0f" font-family="sans-serif">`+"\n", w, h, w, h)
	r := 4 / math.Sqrt(3)
	byColour := map[color.RGBA]*strings.Builder{}
	var order []color.RGBA
	for c := c0; c <= c1; c++ {
		for j := j0; j <= j1; j++ {
			x, y := physics.CellCentre(c, j)
			px, py := float64((x-x0+4)*scale), float64((y1-y+4)*scale)
			col := ElevationColour(float64(elevation(b.Ground, c, j)) / 10)
			sb, ok := byColour[col]
			if !ok {
				sb = &strings.Builder{}
				byColour[col] = sb
				order = append(order, col)
			}
			fmt.Fprintf(sb, "M%.1f %.1f", px+float64(r*scale), py)
			for k := 1; k < 6; k++ {
				fmt.Fprintf(sb, "L%.1f %.1f", px+float64(r*scale*hexCos[k]), py-float64(r*scale*hexSin[k]))
			}
			sb.WriteString("Z")
		}
	}
	slices.SortFunc(order, func(a, b color.RGBA) int {
		return int(uint32(a.R)<<16|uint32(a.G)<<8|uint32(a.B)) - int(uint32(b.R)<<16|uint32(b.G)<<8|uint32(b.B))
	})
	for _, col := range order {
		fmt.Fprintf(&s, `<path fill="#%02x%02x%02x" d="%s"/>`+"\n", col.R, col.G, col.B, byColour[col].String())
	}
	at := func(x, y float64) (float64, float64) {
		return float64((x - x0 + 4) * scale), float64((y1 - y + 4) * scale)
	}
	for _, rf := range b.Roofs {
		if rf.C < c0 || rf.C > c1 || rf.J < j0 || rf.J > j1 {
			continue
		}
		x, y := physics.CellCentre(rf.C, rf.J)
		px, py := at(x, y)
		col := ElevationColour(float64(rf.Top) / 10)
		fmt.Fprintf(&s, `<path fill="#%02x%02x%02x" fill-opacity="0.75" stroke="#111" stroke-width="1.2" stroke-dasharray="3 2" d="M%.1f %.1f`, col.R, col.G, col.B, px+float64(r*scale), py)
		for k := 1; k < 6; k++ {
			fmt.Fprintf(&s, "L%.1f %.1f", px+float64(r*scale*hexCos[k]), py-float64(r*scale*hexSin[k]))
		}
		fmt.Fprintf(&s, `Z"><title>a roof from %.1f m to %.1f m</title></path>`+"\n", float64(rf.Under)/10, float64(rf.Top)/10)
	}
	for _, f := range b.Features {
		if f.Island != is.Number {
			continue
		}
		px, py := at(f.X, f.Y)
		fmt.Fprintf(&s, `<circle cx="%.1f" cy="%.1f" r="5" fill="#fff" stroke="#111"/><text x="%.1f" y="%.1f" font-size="13" fill="#111" stroke="#fff" stroke-width="3" paint-order="stroke">%s, %.0f m</text>`+"\n",
			px, py, px+8, py+4, html.EscapeString(f.Kind), f.Height)
	}
	fmt.Fprintf(&s, `<text x="10" y="24" font-size="18" fill="#111">%s: %s, %s, %.0f m across, %.1f m high, class %s (%.1f)</text>`+"\n",
		html.EscapeString(is.Name), is.Biome, is.Size, 2*math.Sqrt(is.Area/math.Pi), is.Highest, is.Class, is.Score)
	s.WriteString("</svg>\n")
	return s.Bytes(), nil
}

// The corners' directions from a hexagon's centre, every 60°.
var (
	hexCos = [6]float64{1, 0.5, -0.5, -1, -0.5, 0.5}
	hexSin = [6]float64{0, 0.8660254037844386, 0.8660254037844386, 0, -0.8660254037844386, -0.8660254037844386}
)

// elevation is the ground's elevation at column c and row j, decimetres.
func elevation(g *physics.Ground, c, j int32) int16 {
	n, i, ok := physics.ChunkOf(c, j)
	if !ok || g.Chunks[n] == nil {
		return physics.DeepWater
	}
	return g.Chunks[n].Elevation[i]
}

// own reports whether the hexagon at column c and row j is nearer the
// island's centre than any other's: its own land rather than a neighbour's.
func own(b *worldgen.Bundle, c, j int32, is *worldgen.Island) bool {
	x, y := physics.CellCentre(c, j)
	d := math.Sqrt(float64((x-is.X)*(x-is.X))+float64((y-is.Y)*(y-is.Y))) - is.Across/2
	for k := range b.Islands {
		o := &b.Islands[k]
		if o.Number != is.Number && math.Sqrt(float64((x-o.X)*(x-o.X))+float64((y-o.Y)*(y-o.Y)))-o.Across/2 < d {
			return false
		}
	}
	return true
}
