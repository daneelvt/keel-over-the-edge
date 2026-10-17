// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"math"
	"math/rand/v2"
	"os"
	"reflect"
	"slices"
	"sync"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// testRule is the catalog's handout rule.
func testRule(t testing.TB) HandoutRule {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	h := &cat.World.Handout
	return HandoutRule{
		Near: h.Near, Camera: h.Camera, Dome: h.Dome, Margin: h.Margin, Shallow: h.Shallows, Look: h.Look,
		FarSea: max(h.FarSeaLeast, h.FarSeaHorizon*math.Sqrt(2*h.Dome*h.Camera)),
	}
}

// madeGround is ground made of a function of each hexagon's centre, in
// metres, over every chunk that holds any of it.
func madeGround(elevation func(x, y float64) float64) *physics.Ground {
	g := &physics.Ground{}
	for n := range int32(physics.ChunkCount) {
		ch := new(physics.GroundChunk)
		c0, j0 := physics.ChunkCorner(n)
		any := false
		for i := range int32(physics.ChunkHexes) {
			x, y := physics.CellCentre(c0+i/physics.ChunkRows, j0+i%physics.ChunkRows)
			e := int16(max(min(math.Round(elevation(x, y)*10), 800), physics.DeepWater))
			ch.Elevation[i] = e
			any = any || e != physics.DeepWater
		}
		if any {
			g.Chunks[n] = ch
		}
	}
	return g
}

// testIslands is a world of two islands and a bank: a hill 30 m high and
// 200 m across in the middle of a chunk, an islet half a metre high and 60 m
// across in the corner of one, and a bank 5 m deep.
func testIslands(x, y float64) float64 {
	switch {
	case math.Hypot(x-1580, y-528) < 100:
		return 30
	case math.Hypot(x+1100, y+100) < 30:
		return 0.5
	case math.Hypot(x, y+2500) < 200:
		return -5
	}
	return -40
}

var (
	seedOnce   sync.Once
	seedGround *physics.Ground
	seedErr    error
)

// seedWorld is seed 1's world's ground.
func seedWorld(t testing.TB) *physics.Ground {
	t.Helper()
	seedOnce.Do(func() {
		cat, err := catalog.Load()
		if err != nil {
			seedErr = err
			return
		}
		b, err := worldgen.Generate(1, cat)
		if err != nil {
			seedErr = err
			return
		}
		seedGround = b.Ground
	})
	if seedErr != nil {
		t.Fatal(seedErr)
	}
	return seedGround
}

func testPaths() []string {
	p := make([]string, physics.ChunkCount)
	for n := range p {
		p[n] = fmt.Sprintf("/w/test/c/%d.mac.bin", n)
	}
	return p
}

// referenceCell is a cell's highest land and shallowest bed, and its
// centre.
type referenceCell struct{ highest, shallowest, x, y float64 }

// referenceCells are each chunk's cells, scanned hexagon by hexagon once.
type referenceCells map[int][]referenceCell

func (rc referenceCells) of(g *physics.Ground, n int) []referenceCell {
	if cells, ok := rc[n]; ok {
		return cells
	}
	var cells []referenceCell
	if ch := g.Chunks[n]; ch != nil {
		c0, j0 := physics.ChunkCorner(int32(n))
		for a := range int32(physics.ShelterColumns) {
			for b := range int32(physics.ShelterRows) {
				cell := referenceCell{shallowest: math.Inf(1)}
				for dc := range int32(physics.ShelterCell) {
					for dj := range int32(physics.ShelterCell) {
						_, i, _ := physics.ChunkOf(c0+a*physics.ShelterCell+dc, j0+b*physics.ShelterCell+dj)
						e := float64(ch.Elevation[i]) * 0.1
						if e > 0 {
							cell.highest = max(cell.highest, e)
						} else {
							cell.shallowest = min(cell.shallowest, -e)
						}
					}
				}
				cell.x, cell.y = physics.ShelterCellCentre(c0/physics.ShelterCell+a, j0/physics.ShelterCell+b)
				cells = append(cells, cell)
			}
		}
	}
	rc[n] = cells
	return cells
}

// referenceSees is the rule written plainly: a chunk's outline from its
// hexagons' centres, and each of its cells' highest land and shallowest
// bed, scanned hexagon by hexagon.
func (rc referenceCells) sees(g *physics.Ground, r HandoutRule, n int, x, y float64) bool {
	c0, j0 := physics.ChunkCorner(int32(n))
	// The outline: the hexagons' centres' bounds, widened by a corner east
	// and west and half a flat north and south.
	minX, maxX, minY, maxY := math.Inf(1), math.Inf(-1), math.Inf(1), math.Inf(-1)
	for _, c := range []int32{c0, c0 + 1, c0 + physics.ChunkColumns - 2, c0 + physics.ChunkColumns - 1} {
		for _, j := range []int32{j0, j0 + physics.ChunkRows - 1} {
			cx, cy := physics.CellCentre(c, j)
			minX, maxX, minY, maxY = min(minX, cx), max(maxX, cx), min(minY, cy), max(maxY, cy)
		}
	}
	minX -= physics.HexAcross / math.Sqrt(3)
	maxX += physics.HexAcross / math.Sqrt(3)
	minY -= physics.HexAcross / 2
	maxY += physics.HexAcross / 2
	if math.Hypot(max(minX-x, 0, x-maxX), max(minY-y, 0, y-maxY)) <= r.Near {
		return true
	}
	for _, cell := range rc.of(g, n) {
		d := math.Hypot(cell.x-x, cell.y-y)
		if cell.highest > 0 && d <= math.Sqrt(2*r.Dome*r.Camera)+math.Sqrt(2*r.Dome*cell.highest)+r.Margin {
			return true
		}
		if cell.shallowest < r.Shallow && d <= r.FarSea+r.Margin {
			return true
		}
	}
	return false
}

// TestHandoutRule: at a thousand points on the disk, the handout names
// exactly the chunks the rule written plainly names: on a world of three
// islands, and on seed 1's world unless the tests are short.
func TestHandoutRule(t *testing.T) {
	r := testRule(t)
	if r.FarSea != 1.1*math.Sqrt(2*2500*80) {
		t.Fatalf("the far sea reaches %v m from the highest camera", r.FarSea)
	}
	worlds := map[string]func() *physics.Ground{"three islands": func() *physics.Ground { return madeGround(testIslands) }}
	if !testing.Short() {
		worlds["seed 1"] = func() *physics.Ground { return seedWorld(t) }
	}
	for name, make := range worlds {
		t.Run(name, func(t *testing.T) {
			g := make()
			h := NewHandout(g, testPaths(), r)
			ref := referenceCells{}
			rng := rand.New(rand.NewPCG(1, 2))
			points, handed := 1000, 0
			for range points {
				// Within the disk, evenly by area.
				rad, a := 8334*math.Sqrt(rng.Float64()), 2*math.Pi*rng.Float64()
				x, y := rad*math.Cos(a), rad*math.Sin(a)
				for n := range physics.ChunkCount {
					got, want := h.sees(n, x, y), ref.sees(g, r, n, x, y)
					if got != want {
						t.Fatalf("at (%.1f, %.1f) chunk %d: handed %v, the rule says %v", x, y, n, got, want)
					}
					if got {
						handed++
					}
				}
			}
			t.Logf("%.2f chunks handed a point on average", float64(handed)/float64(points))
		})
	}
}

// TestHandoutSeesLand: a boat 1.1 km from the 30 m hill's middle sees it
// over the horizon from the highest camera (632 m + 387 m + 100 m from its
// land's cells), and at 1.3 km does not; the islet half a metre high is
// seen from 730 m (632 m + 39 m + 100 m), and not from 880 m.
func TestHandoutSeesLand(t *testing.T) {
	r := testRule(t)
	g := madeGround(testIslands)
	h := NewHandout(g, testPaths(), r)
	hill := chunkAt(1580, 528)
	islet := chunkAt(-1100, -100)
	diagonal := math.Sqrt(0.5)
	for _, c := range []struct {
		x, y  float64
		chunk int
		want  bool
	}{
		{1580, 528 + 1100, hill, true},
		{1580, 528 + 1300, hill, false},
		{-1100 + 730*diagonal, -100 + 730*diagonal, islet, true},
		{-1100 + 880*diagonal, -100 + 880*diagonal, islet, false},
	} {
		if h.outline(c.chunk, c.x, c.y) <= r.Near {
			t.Fatalf("(%v, %v) is within the near reach of chunk %d", c.x, c.y, c.chunk)
		}
		if got := h.sees(c.chunk, c.x, c.y); got != c.want {
			t.Errorf("at (%v, %v): chunk %d seen %v, want %v", c.x, c.y, c.chunk, got, c.want)
		}
	}
}

func chunkAt(x, y float64) int {
	n, _, _ := physics.ChunkOf(physics.HexCell(physics.HexAt(x, y)))
	return int(n)
}

// handoutConn is a connection on an edge with the handout, whose messages
// queue for the test to read.
func handoutConn(h *Handout) *conn {
	e := &Edge{cfg: Config{Chunks: h, Land: true, Log: slog.New(slog.DiscardHandler)}, m: newMetrics(obs.NewMetrics("test", "test"))}
	return &conn{e: e, queue: make(chan outgoing, 64)}
}

// handed reads the chunks the connection has been sent since last asked,
// in the order sent.
func handed(t *testing.T, c *conn) ([]uint32, []string) {
	t.Helper()
	var numbers []uint32
	var paths []string
	for {
		select {
		case o := <-c.queue:
			var m pb.ServerMessage
			if err := protocol.DecodeServer(o.b, &m); err != nil {
				t.Fatal(err)
			}
			ch := m.GetChunks()
			if ch == nil || o.kind != outChunks || len(ch.Number) != len(ch.Path) || len(ch.Number) == 0 {
				t.Fatalf("a message %v", &m)
			}
			numbers = append(numbers, ch.Number...)
			paths = append(paths, ch.Path...)
		default:
			return numbers, paths
		}
	}
}

// TestHandoutOnce: a connection is handed each chunk once, nearest first,
// with its own address; looked at again only after its boat has moved
// 20 m; and a new connection at the same place is handed the same.
func TestHandoutOnce(t *testing.T) {
	r := testRule(t)
	paths := testPaths()
	h := NewHandout(madeGround(testIslands), paths, r)
	c := handoutConn(h)
	if !c.chunks(c.e.cfg.Chunks, 1000, 0) {
		t.Fatal("the connection went bad")
	}
	first, firstPaths := handed(t, c)
	if len(first) == 0 {
		t.Fatal("nothing handed")
	}
	for i, n := range first {
		if firstPaths[i] != paths[n] {
			t.Errorf("chunk %d's address %q", n, firstPaths[i])
		}
		if i > 0 && h.outline(int(n), 1000, 0) < h.outline(int(first[i-1]), 1000, 0) {
			t.Errorf("chunk %d handed after the further chunk %d", n, first[i-1])
		}
	}
	if !slices.Contains(first, uint32(chunkAt(1580, 528))) {
		t.Error("the hill's chunk is not handed")
	}
	c.chunks(c.e.cfg.Chunks, 1000, 0)
	if again, _ := handed(t, c); len(again) != 0 {
		t.Errorf("handed again: %v", again)
	}
	// Sail east toward the rim: every chunk once, each looked for only
	// after 20 m.
	seen := map[uint32]bool{}
	for _, n := range first {
		seen[n] = true
	}
	looks := 0
	for x := 1000.0; x < 8000; x += 7 {
		before := c.handout.x
		c.chunks(c.e.cfg.Chunks, x, 300)
		if c.handout.x != before {
			looks++
			if math.Abs(x-before) < r.Look && x != 1000 {
				t.Fatalf("looked again at %v, %v m after the last look", x, x-before)
			}
		}
		more, _ := handed(t, c)
		for _, n := range more {
			if seen[n] {
				t.Fatalf("chunk %d handed twice", n)
			}
			seen[n] = true
		}
	}
	if looks < 300 || looks > 360 {
		t.Errorf("looked %d times over 7 km", looks)
	}
	if c.handout.handedCount() != len(seen) {
		t.Errorf("the bitmap holds %d, %d were handed", c.handout.handedCount(), len(seen))
	}
	t.Logf("%d chunks handed from the centre to the rim", len(seen))
	// A new connection where the first began is handed what it was.
	d := handoutConn(h)
	d.chunks(d.e.cfg.Chunks, 1000, 0)
	if got, _ := handed(t, d); !slices.Equal(got, first) {
		t.Errorf("a new connection is handed %v, the first was %v", got, first)
	}
}

// TestHandoutAllocatesNothing: a look that finds nothing new, and a boat
// that has not moved far enough to be looked at, allocate nothing.
func TestHandoutAllocatesNothing(t *testing.T) {
	h := NewHandout(madeGround(testIslands), testPaths(), testRule(t))
	c := handoutConn(h)
	c.chunks(c.e.cfg.Chunks, 1000, 0)
	handed(t, c)
	x := 1000.0
	if n := testing.AllocsPerRun(200, func() {
		// Back and forth over 40 m: looked at every other time, nothing new.
		x = 2040 - x
		c.chunks(c.e.cfg.Chunks, x, 0)
		c.chunks(c.e.cfg.Chunks, x+1, 0)
	}); n != 0 {
		t.Errorf("a look allocates %v times", n)
	}
	if more, _ := handed(t, c); len(more) != 0 {
		t.Errorf("handed %v", more)
	}
}

// TestNoHandoutWithoutLand: an edge without the handout hands nothing.
func TestNoHandoutWithoutLand(t *testing.T) {
	c := handoutConn(nil)
	c.e.cfg.Land = false
	if !c.chunks(c.e.cfg.Chunks, 0, 0) {
		t.Fatal("the connection went bad")
	}
	if got, _ := handed(t, c); len(got) != 0 {
		t.Errorf("handed %v with no land", got)
	}
}

func BenchmarkHandoutLook(b *testing.B) {
	h := NewHandout(seedWorld(b), testPaths(), testRule(b))
	rng := rand.New(rand.NewPCG(3, 4))
	for b.Loop() {
		rad, a := 8334*math.Sqrt(rng.Float64()), 2*math.Pi*rng.Float64()
		x, y := rad*math.Cos(a), rad*math.Sin(a)
		for n := range physics.ChunkCount {
			h.sees(n, x, y)
		}
	}
}

// The handout as Go hands it, for the sandbox's copy of the rule
// (client/src/land/handout.test.ts): testdata/handout.json holds a world
// of round islands, each with a ring of shallows, which the client makes
// again, and the chunks a boat at each of 300 points is handed. Rewrite it
// with go test ./internal/edge -run HandoutFile -update.

var updateHandout = flag.Bool("update", false, "rewrite testdata/handout.json")

type handoutFile struct {
	Comment string       `json:"comment"`
	Islands [][4]float64 `json:"islands"` // east, north, radius, height: shallows 3 m deep 150 m beyond
	Points  [][2]float64 `json:"points"`
	Handed  [][]int      `json:"handed"`
}

// fileIslands are handoutFile's islands as ground: land h high within r of
// each centre, 3 m of water within r + 150, and 40 m elsewhere; distances
// as sqrt of the sum of squares, which JavaScript computes the same.
func fileIslands(islands [][4]float64) func(x, y float64) float64 {
	return func(x, y float64) float64 {
		e := -40.0
		for _, is := range islands {
			dx, dy := x-is[0], y-is[1]
			d := math.Sqrt(dx*dx + dy*dy)
			switch {
			case d < is[2]:
				return is[3]
			case d < is[2]+150:
				e = -3
			}
		}
		return e
	}
}

func TestHandoutFile(t *testing.T) {
	const path = "testdata/handout.json"
	islands := [][4]float64{{1580, 528, 100, 30}, {-1100, -100, 30, 0.5}, {-3000, 2500, 200, 60}, {4200, -3700, 60, 12}}
	g := madeGround(fileIslands(islands))
	h := NewHandout(g, testPaths(), testRule(t))
	got := handoutFile{Comment: "Written by go test ./internal/edge -run HandoutFile -update.", Islands: islands}
	rng := rand.New(rand.NewPCG(5, 6))
	for range 300 {
		rad, a := 6000*math.Sqrt(rng.Float64()), 2*math.Pi*rng.Float64()
		x, y := math.Round(rad*math.Cos(a)*4)/4, math.Round(rad*math.Sin(a)*4)/4
		var handed []int
		for n := range physics.ChunkCount {
			if h.sees(n, x, y) {
				handed = append(handed, n)
			}
		}
		got.Points = append(got.Points, [2]float64{x, y})
		got.Handed = append(got.Handed, handed)
	}
	if *updateHandout {
		data, err := json.Marshal(got)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var want handoutFile
	if err := json.Unmarshal(data, &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatal("the handout differs from testdata/handout.json: rewrite it with -update")
	}
}
