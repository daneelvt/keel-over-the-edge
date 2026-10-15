// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"fmt"
	"html"
	"image"
	"image/color"
	"math"
	"slices"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// The page: the chart with layers that switch on and off (each sea area's
// fetch and the land's shelter for a wind from a chosen direction, and the
// surfaces), the report's rules, and every island.

// directionNames are the 16 directions, from north clockwise.
var directionNames = [physics.FetchDirections]string{"N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"}

// fetchLayer is a wind's fetch in each sea area: a line from the area's
// centre downwind, as long as its fetch over the cap is of half an area.
func fetchLayer(b *worldgen.Bundle, v view, k int, cap float64) string {
	var d strings.Builder
	a := float64(k) * 2 * math.Pi / physics.FetchDirections
	s, c := math.Sin(a), math.Cos(a)
	for r := range int32(physics.SeaAreas) {
		for col := range int32(physics.SeaAreas) {
			f := b.Fetch[r*physics.SeaAreas+col][k]
			x, y := physics.SeaAreaCentre(col, r)
			if math.Hypot(x, y) > 8400 {
				continue
			}
			l := f / cap * physics.SeaAreaSize * 0.9
			px, py := v.px(x, y)
			// Downwind is away from where the wind comes from.
			qx, qy := v.px(x-float64(l*s), y-float64(l*c))
			fmt.Fprintf(&d, "M%.1f %.1fL%.1f %.1f", px, py, qx, qy)
		}
	}
	return d.String()
}

// shelterLayer is the shelter's factor for a wind from direction k at each
// pixel of the view: purple in the lee, orange where it is faster, clear
// where it is whole.
func shelterLayer(b *worldgen.Bundle, v view, k int) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, v.side, v.side))
	from := float64(k) * 2 * math.Pi / physics.ShelterDirections
	for py := range v.side {
		for px := range v.side {
			x := v.x0 + float64((float64(px)+0.5)*v.scale)
			y := v.y0 - float64((float64(py)+0.5)*v.scale)
			f, _ := b.Shelter.At(x, y, from)
			switch {
			case f < 0.995:
				t := (1 - f) / 0.7
				img.SetNRGBA(px, py, color.NRGBA{0x5e, 0x3c, 0x99, uint8(math.Round(40 + float64(200*t)))})
			case f > 1.005:
				t := (f - 1) / 0.3
				img.SetNRGBA(px, py, color.NRGBA{0xe6, 0x61, 0x01, uint8(math.Round(40 + float64(200*t)))})
			}
		}
	}
	return encodePNG(img)
}

// page is the world's page.
func page(b *worldgen.Bundle, c *chartConfig, v view, terrain, surfaces []byte, shelters [][]byte, fetchCap float64) []byte {
	var p bytes.Buffer
	title := fmt.Sprintf("World of seed %d", b.Seed)
	fmt.Fprintf(&p, `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%s</title>
<style>
body { font-family: sans-serif; margin: 16px; background: #fafafa; color: #222; }
#map { overflow: auto; max-width: 100%%; border: 1px solid #ccc; }
table { border-collapse: collapse; font-size: 13px; }
td, th { border-bottom: 1px solid #ddd; padding: 2px 8px; text-align: left; }
.fail { color: #d55e00; font-weight: bold; }
.pass { color: #009e73; }
#controls { margin: 8px 0; }
#controls label { margin-right: 12px; }
</style>
</head>
<body>
<h1>%s</h1>
`, html.EscapeString(title), html.EscapeString(title))
	fmt.Fprintf(&p, "<p>Generator %d; made from seed %d at attempt %d; digest <code>%s</code>. %d islands and %d groups; land %.2f%% of the disk; open water at most %.0f m from land.</p>\n",
		b.Generator, b.Made, b.Attempts, b.DigestHex(), len(b.Islands), len(b.Groups), b.Report.LandShare, b.Report.Open)
	p.WriteString(`<div id="controls">
<label><input type="checkbox" data-layer="names" checked> names</label>
<label><input type="checkbox" data-layer="coasts" checked> coasts</label>
<label><input type="checkbox" data-layer="start" checked> start area</label>
<label><input type="checkbox" data-layer="surfaces"> surfaces</label>
<label><input type="checkbox" data-layer="fetch"> fetch</label>
<label><input type="checkbox" data-layer="shelter"> shelter</label>
<label>wind from <select id="wind">`)
	for k, n := range directionNames {
		fmt.Fprintf(&p, `<option value="%d">%s</option>`, k, n)
	}
	p.WriteString("</select></label>\n</div>\n<div id=\"map\">\n")
	svg := chart(b, c, v, terrain)
	// The layers go in before the names.
	var layers bytes.Buffer
	fmt.Fprintf(&layers, `<image id="surfaces" width="%d" height="%d" href="%s" style="display:none"/>`+"\n", v.side, v.side, dataURI(surfaces))
	layers.WriteString(`<g id="shelter" style="display:none">` + "\n")
	for k, img := range shelters {
		fmt.Fprintf(&layers, `<image class="dir" data-dir="%d" width="%d" height="%d" href="%s" style="display:none"/>`+"\n",
			k, v.side, v.side, dataURI(img))
	}
	layers.WriteString("</g>\n")
	layers.WriteString(`<g id="fetch" style="display:none" stroke="#0072b2" stroke-width="1.2">` + "\n")
	for k := range physics.FetchDirections {
		fmt.Fprintf(&layers, `<path class="dir" data-dir="%d" d="%s" style="display:none"/>`+"\n", k, fetchLayer(b, v, k, fetchCap))
	}
	layers.WriteString("</g>\n")
	svg = bytes.Replace(svg, []byte(`<g id="names"`), append(layers.Bytes(), []byte(`<g id="names"`)...), 1)
	p.Write(svg)
	p.WriteString("</div>\n<h2>Rules</h2>\n<table>\n<tr><th>Rule</th><th>Measured</th><th>Wants</th><th></th></tr>\n")
	for _, r := range b.Report.Rules {
		class, word := "pass", "pass"
		if !r.Pass {
			class, word = "fail", "fails"
		}
		fmt.Fprintf(&p, "<tr><td>%s</td><td>%s</td><td>%s</td><td class=\"%s\">%s</td></tr>\n",
			html.EscapeString(r.Name), html.EscapeString(r.Measured), html.EscapeString(r.Wants), class, word)
	}
	p.WriteString("</table>\n<h2>Islands</h2>\n<table>\n<tr><th>#</th><th>Name</th><th>Kind</th><th>Biome</th><th>Size</th><th>Zone</th><th>Across, m</th><th>Highest, m</th><th>Cliffs</th><th>Shows</th><th>At, m east, north</th></tr>\n")
	for _, is := range b.Islands {
		fmt.Fprintf(&p, "<tr><td>%d</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%.0f</td><td>%.1f</td><td>%.0f%%</td><td>%s</td><td>%.0f, %.0f</td></tr>\n",
			is.Number, html.EscapeString(is.Name), is.Kind, is.Biome, is.Size, is.Zone, 2*math.Sqrt(is.Area/math.Pi), is.Highest, 100*is.Cliffs,
			strings.Join(is.Shows, ", "), is.X, is.Y)
	}
	p.WriteString("</table>\n")
	if len(b.Groups) > 0 {
		p.WriteString("<h2>Groups</h2>\n<table>\n<tr><th>Name</th><th>Biome</th><th>Zone</th><th>Rocks</th></tr>\n")
		for _, g := range b.Groups {
			fmt.Fprintf(&p, "<tr><td>%s</td><td>%s</td><td>%s</td><td>%d</td></tr>\n", html.EscapeString(g.Name), g.Biome, g.Zone, len(g.Members))
		}
		p.WriteString("</table>\n")
	}
	p.WriteString(`<script>
const wind = document.getElementById('wind');
function show() {
  for (const box of document.querySelectorAll('[data-layer]')) {
    document.getElementById(box.dataset.layer).style.display = box.checked ? '' : 'none';
  }
  for (const el of document.querySelectorAll('.dir')) {
    el.style.display = el.dataset.dir === wind.value ? '' : 'none';
  }
}
for (const el of document.querySelectorAll('[data-layer], #wind')) { el.addEventListener('change', show); }
show();
</script>
</body>
</html>
`)
	return p.Bytes()
}

// seedsPage is several seeds' charts side by side, each with its rules.
func seedsPage(bundles []*worldgen.Bundle, charts [][]byte) []byte {
	var p bytes.Buffer
	p.WriteString(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Seeds side by side</title>
<style>
body { font-family: sans-serif; margin: 16px; background: #fafafa; color: #222; }
.seeds { display: flex; flex-wrap: wrap; gap: 16px; }
.seed { width: 540px; }
.seed svg { width: 100%; height: auto; }
.fail { color: #d55e00; }
ul { font-size: 12px; padding-left: 16px; }
</style>
</head>
<body>
<h1>Seeds side by side</h1>
<div class="seeds">
`)
	for i, b := range bundles {
		fmt.Fprintf(&p, "<div class=\"seed\"><h2>Seed %d</h2><p>%d islands, land %.2f%%, attempt %d</p>\n", b.Seed, len(b.Islands), b.Report.LandShare, b.Attempts)
		p.Write(charts[i])
		p.WriteString("<ul>\n")
		for _, r := range b.Report.Rules {
			class := ""
			if !r.Pass {
				class = ` class="fail"`
			}
			fmt.Fprintf(&p, "<li%s>%s: %s</li>\n", class, html.EscapeString(r.Name), html.EscapeString(r.Measured))
		}
		p.WriteString("</ul></div>\n")
	}
	p.WriteString("</div>\n</body>\n</html>\n")
	return p.Bytes()
}

// islandChart is one island at the lattice's resolution: every hexagon of
// its land and the water about it, as a polygon in its colour.
func islandChart(b *worldgen.Bundle, i int) ([]byte, error) {
	if i < 0 || i >= len(b.Islands) {
		return nil, fmt.Errorf("no island %d: the world has %d", i, len(b.Islands))
	}
	is := &b.Islands[i]
	box := is.Box
	// The hexagons within a margin of its land.
	const margin = 15
	c0, j0, c1, j1 := box[0]+box[2], box[1]+box[3], box[0], box[1]
	for c := box[0]; c < box[0]+box[2]; c++ {
		for j := box[1]; j < box[1]+box[3]; j++ {
			if elevation(b.Ground, c, j) > 0 && island(b, c, j, is) {
				c0, j0, c1, j1 = min(c0, c), min(j0, j), max(c1, c), max(j1, j)
			}
		}
	}
	c0, j0, c1, j1 = c0-margin, j0-margin, c1+margin, j1+margin
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
			col := elevationColour(float64(elevation(b.Ground, c, j)) / 10)
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
	fmt.Fprintf(&s, `<text x="10" y="24" font-size="18" fill="#111">%s: %s, %s, %.0f m across, %.1f m high</text>`+"\n",
		html.EscapeString(is.Name), is.Biome, is.Size, 2*math.Sqrt(is.Area/math.Pi), is.Highest)
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

// island reports whether the hexagon at column c and row j is nearer the
// island's centre than any other's: its own land rather than a neighbour's.
func island(b *worldgen.Bundle, c, j int32, is *worldgen.Island) bool {
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
