// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"encoding/json"
	"fmt"
	"image/color"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"

	position "github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen/chart"
)

// LandScale is the land's chart, metres a pixel: two hexagons a pixel, a
// coast of rocks still sharp, 2,100 pixels a side.
const LandScale = 8

// The land's drawings, each made once per world on the first request for
// it, and kept: an ETag of the world's digest lets the browser keep them
// too.
const (
	landPNG = iota
	coastsSVG
	drawings
)

type land struct {
	cfg  *Config
	etag string
	once [drawings]sync.Once
	body [drawings][]byte

	mu      sync.Mutex
	islands map[int][]byte
}

func (l *land) init(cfg *Config) {
	l.cfg = cfg
	l.etag = `"none"`
	if b := cfg.Bundle; b != nil {
		l.etag = `"` + b.DigestHex() + `"`
	}
	l.islands = map[int][]byte{}
}

// LandView is the view the land's chart is drawn in: the whole disk.
func LandView() chart.View { return chart.WorldView(LandScale) }

// draw makes drawing d.
func (l *land) draw(d int) []byte {
	b := l.cfg.Bundle
	if b == nil {
		return nil
	}
	v := LandView()
	switch d {
	case landPNG:
		// The towns' streets, quays, piers and yards in their own colours.
		look := l.cfg.TownLook.Surfaces
		return chart.Raster(b.Ground, v, func(e float64, s int32) color.RGBA {
			if c, ok := look[s]; ok && e > 0 {
				var rgb color.RGBA
				fmt.Sscanf(c, "#%02x%02x%02x", &rgb.R, &rgb.G, &rgb.B)
				rgb.A = 255
				return rgb
			}
			return chart.Terrain(e, s)
		})
	default:
		var s strings.Builder
		fmt.Fprintf(&s, `<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">`+"\n", v.Side, v.Side, v.Side, v.Side)
		fmt.Fprintf(&s, `<path d="%s" fill="none" stroke="#3b2f22" stroke-width="0.8"/>`+"\n", chart.Coasts(b.Ground, v))
		s.WriteString("</svg>\n")
		return []byte(s.String())
	}
}

var drawingTypes = [drawings]string{"image/png", "image/svg+xml"}

// serve serves drawing d.
func (l *land) serve(d int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if l.cfg.Bundle == nil {
			http.Error(w, "the world has no terrain", http.StatusNotFound)
			return
		}
		h := w.Header()
		h.Set("Cache-Control", "no-cache")
		h.Set("ETag", l.etag)
		if r.Header.Get("If-None-Match") == l.etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		l.once[d].Do(func() { l.body[d] = l.draw(d) })
		h.Set("Content-Type", drawingTypes[d])
		_, _ = w.Write(l.body[d])
	}
}

// island serves island n at the lattice's resolution: GET
// /owner/api/island/{n}.svg.
func (l *land) island(w http.ResponseWriter, r *http.Request) {
	name, ok := strings.CutSuffix(r.PathValue("file"), ".svg")
	n, err := strconv.Atoi(name)
	b := l.cfg.Bundle
	if !ok || err != nil || b == nil || n < 0 || n >= len(b.Islands) {
		http.Error(w, "no such island", http.StatusNotFound)
		return
	}
	h := w.Header()
	h.Set("Cache-Control", "no-cache")
	h.Set("ETag", l.etag)
	if r.Header.Get("If-None-Match") == l.etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	l.mu.Lock()
	svg, ok := l.islands[n]
	l.mu.Unlock()
	if !ok {
		if svg, err = chart.Island(b, n); err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		l.mu.Lock()
		l.islands[n] = svg
		l.mu.Unlock()
	}
	h.Set("Content-Type", "image/svg+xml")
	_, _ = w.Write(svg)
}

// point says what is at a point the page clicked: its position as charts
// write it, its height (above 0) or depth (below), the distance inside the
// lip, the nearest island and how far its centre is, whether a boat may be
// put there, and its sky now: its rain, its sheets and the heaped cloud
// over it.
//
//	GET /owner/api/point?east=…&north=…
func (o *Owner) point(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	x, err1 := strconv.ParseFloat(q.Get("east"), 64)
	y, err2 := strconv.ParseFloat(q.Get("north"), 64)
	if err1 != nil || err2 != nil || math.IsNaN(x) || math.IsNaN(y) || math.Abs(x) > 20000 || math.Abs(y) > 20000 {
		http.Error(w, "east and north, m within 20 km of the centre, are required", http.StatusBadRequest)
		return
	}
	out := struct {
		East      float64 `json:"east"`
		North     float64 `json:"north"`
		Position  string  `json:"position"`
		Elevation float64 `json:"elevation"` // m: below 0 the depth
		FromLip   float64 `json:"fromLip"`
		Island    string  `json:"island"`
		Number    int32   `json:"number"`
		Off       float64 `json:"off"` // m from its centre
		Water     string  `json:"water"`
		// Sky is null for a world not yet sailed.
		Sky *skyPoint `json:"sky"`
	}{East: round2(x), North: round2(y), Position: position.Format(x, y), FromLip: round2(physics.EdgeDistance(o.cfg.Weather, x, y)), Number: -1}
	if b := o.cfg.Bundle; b != nil {
		e, _ := b.Ground.At(x, y)
		out.Elevation = round2(e)
		best := math.Inf(1)
		for i := range b.Islands {
			is := &b.Islands[i]
			if d := math.Hypot(is.X-x, is.Y-y); d < best {
				best, out.Island, out.Number = d, is.Name, is.Number
			}
		}
		if !math.IsInf(best, 1) {
			out.Off = round2(best)
		}
	}
	// What a teleport would say of it, the other boats aside.
	if err := o.water(x, y, nil); err != nil {
		out.Water = err.Error()
	}
	out.Sky = o.skyAt(x, y)
	writeJSON(w, &out)
}

// islandsList is islands.json: every island, by number and name, with
// where it is, how big and high, and the bounds of its drawing; the groups
// of rocks; and the start area's places.
func islandsList(cfg *Config) []byte {
	type islandJSON struct {
		Number   int32      `json:"number"`
		Name     string     `json:"name"`
		Kind     string     `json:"kind"`
		Biome    string     `json:"biome"`
		Size     string     `json:"size"`
		Zone     string     `json:"zone"`
		Group    int32      `json:"group"`
		East     float64    `json:"east"`
		North    float64    `json:"north"`
		Across   float64    `json:"across"`
		Area     float64    `json:"area"`
		Highest  float64    `json:"highest"`
		Bounds   [4]float64 `json:"bounds"` // west, south, east, north of its drawing
		Approach [2]float64 `json:"approach"`
		// Its scenic quality, by each factor, and its class; its age, if
		// volcanic; its features' kinds; and the plants that grow on it.
		Score    float64          `json:"score"`
		Class    string           `json:"class"`
		Scenery  worldgen.Scenery `json:"scenery"`
		Age      string           `json:"age,omitempty"`
		Features []string         `json:"features"`
		Flora    []string         `json:"flora"`
	}
	type groupJSON struct {
		Number  int32   `json:"number"`
		Name    string  `json:"name"`
		East    float64 `json:"east"`
		North   float64 `json:"north"`
		Members []int32 `json:"members"`
	}
	out := struct {
		Islands []islandJSON `json:"islands"`
		Groups  []groupJSON  `json:"groups"`
		Start   [][2]float64 `json:"start"`
	}{Islands: []islandJSON{}, Groups: []groupJSON{}, Start: [][2]float64{}}
	b := cfg.Bundle
	if b != nil {
		for i := range b.Islands {
			is := &b.Islands[i]
			x0, y0, x1, y1, _ := chart.IslandBounds(b, i)
			j := islandJSON{
				Number: is.Number, Name: is.Name, Kind: is.Kind, Biome: is.Biome, Size: is.Size, Zone: is.Zone, Group: is.Group,
				East: round2(is.X), North: round2(is.Y), Across: round2(is.Across), Area: math.Round(is.Area), Highest: round2(is.Highest),
				Bounds: [4]float64{x0, y0, x1, y1},
				Score:  is.Score, Class: is.Class, Scenery: is.Scenery, Age: is.Age, Features: []string{},
				Flora: islandFlora(cfg, b, is),
			}
			for _, f := range b.Features {
				if f.Island == is.Number && !slices.Contains(j.Features, f.Kind) {
					j.Features = append(j.Features, f.Kind)
				}
			}
			if x, y, ok := approach(b.Ground, is, cfg.Rules.Approach); ok {
				j.Approach = [2]float64{round2(x), round2(y)}
			}
			out.Islands = append(out.Islands, j)
		}
		out.Start = b.Start.Places
		for _, g := range b.Groups {
			out.Groups = append(out.Groups, groupJSON{Number: g.Number, Name: g.Name, East: round2(g.X), North: round2(g.Y), Members: g.Members})
		}
	}
	body, err := json.Marshal(&out)
	if err != nil {
		panic(err)
	}
	return body
}

// approach is where a boat is put to sail to island is: the first point
// at least deep metres deep on the line from its highest point toward the
// centre of the disk, a metre at a time; past the centre if the island
// holds it. ok is false if there is none within 5 km.
func approach(g *physics.Ground, is *worldgen.Island, deep float64) (x, y float64, ok bool) {
	dx, dy := -is.HighX, -is.HighY
	if d := math.Hypot(dx, dy); d > 1 {
		dx, dy = dx/d, dy/d
	} else {
		dx, dy = 0, -1
	}
	for k := range 5000 {
		x, y = is.HighX+float64(k)*dx, is.HighY+float64(k)*dy
		if e, _ := g.At(x, y); -e >= deep {
			return x, y, true
		}
	}
	return 0, 0, false
}

// currentGrid is current.json: the current every Grids.Current metres
// over the disk where it runs, east and north, m/s.
func currentGrid(cfg *Config) []byte {
	step := cfg.Grids.Current
	lip := cfg.Weather.Edge()
	out := struct {
		Step   float64      `json:"step"`
		Points [][4]float64 `json:"points"`
	}{Step: step, Points: [][4]float64{}}
	n := int(math.Floor(lip / step))
	for j := -n; j <= n; j++ {
		for i := -n; i <= n; i++ {
			x, y := float64(i)*step, float64(j)*step
			if math.Hypot(x, y) > lip {
				continue
			}
			e, no := physics.CurrentAt(cfg.Weather, cfg.Circulation, x, y, cfg.Ground)
			if e == 0 && no == 0 {
				continue
			}
			out.Points = append(out.Points, [4]float64{x, y, math.Round(e*1000) / 1000, math.Round(no*1000) / 1000})
		}
	}
	body, err := json.Marshal(&out)
	if err != nil {
		panic(err)
	}
	return body
}
