// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"cmp"
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
			px, py := v.Px(x, y)
			// Downwind is away from where the wind comes from.
			qx, qy := v.Px(x-float64(l*s), y-float64(l*c))
			fmt.Fprintf(&d, "M%.1f %.1fL%.1f %.1f", px, py, qx, qy)
		}
	}
	return d.String()
}

// shelterLayer is the shelter's factor for a wind from direction k at each
// pixel of the view: purple in the lee, orange where it is faster, clear
// where it is whole.
func shelterLayer(b *worldgen.Bundle, v view, k int) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, v.Side, v.Side))
	from := float64(k) * 2 * math.Pi / physics.ShelterDirections
	for py := range v.Side {
		for px := range v.Side {
			x := v.X0 + float64((float64(px)+0.5)*v.Scale)
			y := v.Y0 - float64((float64(py)+0.5)*v.Scale)
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
<label><input type="checkbox" data-layer="places" checked> places</label>
<label><input type="checkbox" data-layer="features" checked> features</label>
<label><input type="checkbox" data-layer="classes" checked> worth seeing</label>
<label><input type="checkbox" data-layer="lights" checked> lights</label>
<label><input type="checkbox" data-layer="ranges"> ranges</label>
<label><input type="checkbox" data-layer="surfaces"> surfaces</label>
<label><input type="checkbox" data-layer="fetch"> fetch</label>
<label><input type="checkbox" data-layer="shelter"> shelter</label>
<label>wind from <select id="wind">`)
	for k, n := range directionNames {
		fmt.Fprintf(&p, `<option value="%d">%s</option>`, k, n)
	}
	p.WriteString("</select></label>\n</div>\n<div id=\"map\">\n")
	svg := worldChart(b, c, v, terrain)
	// The layers go in before the names.
	var layers bytes.Buffer
	fmt.Fprintf(&layers, `<image id="surfaces" width="%d" height="%d" href="%s" style="display:none"/>`+"\n", v.Side, v.Side, dataURI(surfaces))
	layers.WriteString(`<g id="shelter" style="display:none">` + "\n")
	for k, img := range shelters {
		fmt.Fprintf(&layers, `<image class="dir" data-dir="%d" width="%d" height="%d" href="%s" style="display:none"/>`+"\n",
			k, v.Side, v.Side, dataURI(img))
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
	p.WriteString("</table>\n<h2>Islands</h2>\n<p>By score, the US Bureau of Land Management's seven factors: landform, vegetation, water, colour, adjacent scenery, scarcity, cultural.</p>\n<table>\n<tr><th>#</th><th>Name</th><th>Kind</th><th>Biome</th><th>Size</th><th>Zone</th><th>Across, m</th><th>Highest, m</th><th>Cliffs</th><th>Class</th><th>Score</th><th>Factors</th><th>Shows</th><th>At, m east, north</th></tr>\n")
	byScore := slices.Clone(b.Islands)
	slices.SortStableFunc(byScore, func(a, c worldgen.Island) int { return cmp.Compare(c.Score, a.Score) })
	for _, is := range byScore {
		sc := is.Scenery
		age := ""
		if is.Age != "" {
			age = " (" + is.Age + ")"
		}
		fmt.Fprintf(&p, "<tr><td>%d</td><td>%s</td><td>%s</td><td>%s%s</td><td>%s</td><td>%s</td><td>%.0f</td><td>%.1f</td><td>%.0f%%</td><td>%s</td><td>%.1f</td><td>%.1f %.1f %.1f %.1f %.1f %.1f %.1f</td><td>%s</td><td>%.0f, %.0f</td></tr>\n",
			is.Number, html.EscapeString(is.Name), is.Kind, is.Biome, age, is.Size, is.Zone, 2*math.Sqrt(is.Area/math.Pi), is.Highest, 100*is.Cliffs,
			is.Class, is.Score, sc.Landform, sc.Vegetation, sc.Water, sc.Colour, sc.Adjacent, sc.Scarcity, sc.Cultural,
			strings.Join(is.Shows, ", "), is.X, is.Y)
	}
	p.WriteString("</table>\n<h2>Features</h2>\n<p>Each island's own sheet, its roofs and features: <code>-island N</code>.</p>\n<table>\n<tr><th>#</th><th>Kind</th><th>Island</th><th>Height, m</th><th>Size, m</th><th>Seen from</th><th>At, m east, north</th></tr>\n")
	for _, f := range b.Features {
		seen := "not from the water"
		if f.Seen {
			seen = fmt.Sprintf("%.0f, %.0f", f.SightX, f.SightY)
		}
		fmt.Fprintf(&p, "<tr><td>%d</td><td>%s</td><td>%s</td><td>%.1f</td><td>%.1f</td><td>%s</td><td>%.0f, %.0f</td></tr>\n",
			f.Number, f.Kind, html.EscapeString(b.Islands[f.Island].Name), f.Height, f.Size, seen, f.X, f.Y)
	}
	p.WriteString("</table>\n")
	p.WriteString("<h2>Places</h2>\n<table>\n<tr><th>#</th><th>Name</th><th>Kind</th><th>Island</th><th>Zone</th><th>Offers</th><th>At, m east, north</th></tr>\n")
	for _, pl := range b.Places {
		island := ""
		if pl.Island >= 0 && int(pl.Island) < len(b.Islands) {
			island = b.Islands[pl.Island].Name
		}
		what := strings.Join(pl.Details.Offers, ", ")
		if s := pl.Details.Ship; s != nil {
			what = fmt.Sprintf("the %s %s (%s), %s, %s, sunk %v", s.Rig, s.Name, s.Language, s.Cargo, s.Age, s.Sunk)
		}
		fmt.Fprintf(&p, "<tr><td>%d</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%.0f, %.0f</td></tr>\n",
			pl.Number, html.EscapeString(pl.Name), pl.Kind, html.EscapeString(island), pl.Zone, html.EscapeString(what), pl.X, pl.Y)
	}
	p.WriteString("</table>\n<h2>Towns</h2>\n<p>Each town's own sheet: <code>-town N</code>.</p>\n<table>\n<tr><th>#</th><th>Name</th><th>Kind</th><th>Buildings</th><th>Streets, hexagons</th><th>Quay, m</th><th>Piers, m</th><th>Harbour, discs</th><th>At, m east, north</th></tr>\n")
	for _, t := range b.Towns {
		var piers []string
		for _, pr := range t.Piers {
			piers = append(piers, fmt.Sprintf("%.0f", pr.Length))
		}
		fmt.Fprintf(&p, "<tr><td>%d</td><td>%s</td><td>%s</td><td>%d</td><td>%d</td><td>%d</td><td>%s</td><td>%d</td><td>%.0f, %.0f</td></tr>\n",
			t.Number, html.EscapeString(t.Name), t.Kind, t.Buildings, t.Streets, len(t.Quay)*physics.HexAcross, strings.Join(piers, ", "),
			len(t.Harbour), t.X, t.Y)
	}
	if b.Start.Moorings > 0 {
		fmt.Fprintf(&p, "<tr><td colspan=\"9\">%d moorings in Port Royal's basin, then %d places in the roads.</td></tr>\n",
			b.Start.Moorings, len(b.Start.Places)-b.Start.Moorings)
	}
	p.WriteString("</table>\n<h2>Lights</h2>\n<table>\n<tr><th>#</th><th>Role</th><th>Character</th><th>Focal, m</th><th>Range, NM</th><th>At, m east, north</th></tr>\n")
	for _, l := range b.Lights {
		fmt.Fprintf(&p, "<tr><td>%d</td><td>%s</td><td>%s</td><td>%.1f</td><td>%.1f</td><td>%.0f, %.0f</td></tr>\n",
			l.Number, l.Role, html.EscapeString(l.Notation), l.Focal, l.Range/1852, l.X, l.Y)
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
		kinds := map[string]int{}
		var order []string
		for _, pl := range b.Places {
			if kinds[pl.Kind] == 0 {
				order = append(order, pl.Kind)
			}
			kinds[pl.Kind]++
		}
		var counts []string
		for _, k := range order {
			counts = append(counts, fmt.Sprintf("%s %d", k, kinds[k]))
		}
		fmt.Fprintf(&p, "<p>%s; %d lights</p>\n", html.EscapeString(strings.Join(counts, ", ")), len(b.Lights))
		// The islands by class, and the features by kind.
		classes := map[string]int{}
		for _, is := range b.Islands {
			classes[is.Class]++
		}
		fkinds := map[string]int{}
		var forder []string
		for _, f := range b.Features {
			if fkinds[f.Kind] == 0 {
				forder = append(forder, f.Kind)
			}
			fkinds[f.Kind]++
		}
		var fcounts []string
		for _, k := range forder {
			fcounts = append(fcounts, fmt.Sprintf("%s %d", k, fkinds[k]))
		}
		fmt.Fprintf(&p, "<p>Class A %d, B %d, C %d; %s</p>\n", classes["A"], classes["B"], classes["C"], html.EscapeString(strings.Join(fcounts, ", ")))
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
