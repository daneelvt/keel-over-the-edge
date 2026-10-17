// SPDX-License-Identifier: AGPL-3.0-only

package chart

import (
	"bytes"
	"fmt"
	"html"
	"image/color"
	"math"
	"slices"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// TownLook is how Town draws a town: the colours of the town's surfaces,
// by the surface's index, #rrggbb; each kind of building's, by the kind's
// index; and which kinds are props, drawn as dots.
type TownLook struct {
	Surfaces map[int32]string
	Kinds    []string
	Props    []bool
}

// TownBounds are the world's bounds of what Town draws of town n: west,
// south, east and north, m.
func TownBounds(b *worldgen.Bundle, n int) (x0, y0, x1, y1 float64, ok bool) {
	if n < 0 || n >= len(b.Towns) {
		return 0, 0, 0, 0, false
	}
	t := &b.Towns[n]
	x0, y0, x1, y1 = t.X-60, t.Y-60, t.X+60, t.Y+60
	for _, bd := range b.Buildings {
		if int(bd.Town) == n {
			x0, y0, x1, y1 = min(x0, bd.X-30), min(y0, bd.Y-30), max(x1, bd.X+30), max(y1, bd.Y+30)
		}
	}
	for _, d := range t.Harbour {
		x0, y0, x1, y1 = min(x0, d.X-20), min(y0, d.Y-20), max(x1, d.X+20), max(y1, d.Y+20)
	}
	return x0, y0, x1, y1, true
}

// Town is town n at the lattice's resolution, as an SVG: its ground
// hexagon by hexagon, the land by height and its streets, quays, piers and
// yards by their surfaces; each building's footprint, facing its way, in
// its kind's colour, with a tick at its front; its props as dots; Port
// Royal's moorings; and a line naming it with its counts.
func Town(b *worldgen.Bundle, n int, look TownLook) ([]byte, error) {
	x0, y0, x1, y1, ok := TownBounds(b, n)
	if !ok {
		return nil, fmt.Errorf("no town %d: the world has %d", n, len(b.Towns))
	}
	t := &b.Towns[n]
	const scale = 4.0 // pixels a metre
	w, h := (x1-x0)*scale, (y1-y0)*scale
	px := func(x, y float64) (float64, float64) { return float64((x - x0) * scale), float64((y1 - y) * scale) }
	var s bytes.Buffer
	fmt.Fprintf(&s, `<svg xmlns="http://www.w3.org/2000/svg" width="%.0f" height="%.0f" viewBox="0 0 %.0f %.0f" font-family="sans-serif">`+"\n", w, h, w, h)
	s.WriteString(`<rect width="100%" height="100%" fill="#1d4e89"/>` + "\n")
	q0, _ := physics.HexAt(x0, y0)
	q1, _ := physics.HexAt(x1, y1)
	r := 4 / math.Sqrt(3)
	byColour := map[string]*strings.Builder{}
	var order []string
	for q := q0 - 1; q <= q1+1; q++ {
		// The rows of this column within the bounds.
		ylo := y0 - float64(4*(float64(q)/2))
		yhi := y1 - float64(4*(float64(q)/2))
		for rr := int32(math.Floor(ylo/4)) - 1; rr <= int32(math.Ceil(yhi/4))+1; rr++ {
			x, y := physics.HexCentre(q, rr)
			if x < x0-4 || x > x1+4 || y < y0-4 || y > y1+4 {
				continue
			}
			c, j := physics.HexCell(q, rr)
			e := float64(elevation(b.Ground, c, j)) / 10
			col := ElevationColour(e)
			hex := fmt.Sprintf("#%02x%02x%02x", col.R, col.G, col.B)
			if e > 0 {
				if ch, k, ok := physics.ChunkOf(c, j); ok && b.Ground.Chunks[ch] != nil {
					if sc, ok := look.Surfaces[int32(b.Ground.Chunks[ch].Surface[k])]; ok {
						hex = shade(sc, e)
					}
				}
			}
			sb, ok := byColour[hex]
			if !ok {
				sb = &strings.Builder{}
				byColour[hex] = sb
				order = append(order, hex)
			}
			cx, cy := px(x, y)
			fmt.Fprintf(sb, "M%.1f %.1f", cx+float64(r*scale), cy)
			for k := 1; k < 6; k++ {
				fmt.Fprintf(sb, "L%.1f %.1f", cx+float64(r*scale*hexCos[k]), cy-float64(r*scale*hexSin[k]))
			}
			sb.WriteString("Z")
		}
	}
	slices.Sort(order)
	for _, col := range order {
		fmt.Fprintf(&s, `<path fill="%s" d="%s"/>`+"\n", col, byColour[col].String())
	}
	// The harbour: in port.
	for _, d := range t.Harbour {
		cx, cy := px(d.X, d.Y)
		fmt.Fprintf(&s, `<circle cx="%.1f" cy="%.1f" r="%.1f" fill="none" stroke="#ffffff" stroke-opacity="0.15"/>`+"\n", cx, cy, float64(d.R*scale))
	}
	// The buildings.
	for _, bd := range b.Buildings {
		if int(bd.Town) != n {
			continue
		}
		colour := "#888888"
		if int(bd.Kind) < len(look.Kinds) {
			colour = look.Kinds[bd.Kind]
		}
		cx, cy := px(bd.X, bd.Y)
		if int(bd.Kind) < len(look.Props) && look.Props[bd.Kind] {
			fmt.Fprintf(&s, `<circle cx="%.1f" cy="%.1f" r="%.1f" fill="%s" stroke="#000" stroke-width="0.5"/>`+"\n", cx, cy, max(float64(bd.Frontage*scale)/2, 2), colour)
			continue
		}
		sh, ch := math.Sincos(bd.Heading)
		corner := func(a, f float64) string {
			x := bd.X + float64(a*sh) + float64(f*ch)
			y := bd.Y + float64(a*ch) - float64(f*sh)
			qx, qy := px(x, y)
			return fmt.Sprintf("%.1f,%.1f", qx, qy)
		}
		hd, hf := bd.Depth/2, bd.Frontage/2
		fmt.Fprintf(&s, `<polygon points="%s %s %s %s" fill="%s" stroke="#222" stroke-width="1"/>`+"\n",
			corner(hd, hf), corner(hd, -hf), corner(-hd, -hf), corner(-hd, hf), colour)
		fx, fy := px(bd.X+float64(hd*sh), bd.Y+float64(hd*ch))
		tx, ty := px(bd.X+float64((hd+1.5)*sh), bd.Y+float64((hd+1.5)*ch))
		fmt.Fprintf(&s, `<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="#fff" stroke-width="1.5"/>`+"\n", fx, fy, tx, ty)
	}
	// Port Royal's moorings.
	if t.Kind == "main" {
		for i, p := range b.Start.Places[:b.Start.Moorings] {
			cx, cy := px(p[0], p[1])
			fmt.Fprintf(&s, `<circle cx="%.1f" cy="%.1f" r="5" fill="#ffffff" stroke="#000"/>`, cx, cy)
			hd := b.Start.HeadingOf(i)
			ex, ey := px(p[0]+float64(8*math.Sin(hd)), p[1]+float64(8*math.Cos(hd)))
			fmt.Fprintf(&s, `<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="#fff" stroke-width="2"/>`+"\n", cx, cy, ex, ey)
		}
	}
	fmt.Fprintf(&s, `<text x="10" y="24" font-size="18" fill="#fff">%s: %s, %d buildings, %d piers, %d hexagons of street</text>`+"\n",
		html.EscapeString(t.Name), t.Kind, t.Buildings, len(t.Piers), t.Streets)
	s.WriteString("</svg>\n")
	return s.Bytes(), nil
}

// shade is a surface's colour, a little lighter the higher the ground, so
// that terraces show.
func shade(hex string, e float64) string {
	var c color.RGBA
	fmt.Sscanf(hex, "#%02x%02x%02x", &c.R, &c.G, &c.B)
	f := 0.85 + 0.3*math.Min(e/40, 1)
	l := func(v uint8) uint8 { return uint8(math.Min(float64(float64(v)*f), 255)) }
	return fmt.Sprintf("#%02x%02x%02x", l(c.R), l(c.G), l(c.B))
}
