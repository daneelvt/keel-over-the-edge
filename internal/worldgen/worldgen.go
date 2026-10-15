// SPDX-License-Identifier: AGPL-3.0-only

// Package worldgen makes a world from a seed: the main port's island at
// the centre, landmark islands and about a hundred smaller ones, groups of
// rocks, coasts, shallows, reefs and beaches, as a height or a depth for
// every hexagon of the lattice; each island named; each sea area's fetch,
// the land's shelter for the wind, and where boats start. A world that does
// not pass the validator's rules is made again from the next seed.
//
// The same seed and Version make the same world on every machine: the
// generator runs on one goroutine, draws every random number from streams
// of its own keyed by the seed (streams.go), and follows the physics
// package's float rules (fmath.go), which go run ./tools/physics -check
// holds it to. Version rises whenever any seed's world changes, and the
// snapshot tests, which hold fixed seeds' digests, fail until it does.
package worldgen

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/names"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Version is the generator's version. Raise it whenever a change to the
// generator or to the catalog's world values changes any seed's world.
const Version = 1

// Island is an island of a made world.
type Island struct {
	Number    int32    `json:"number"`
	Kind      string   `json:"kind"` // main, landmark, island, or group for a group's rock or islet
	Name      string   `json:"name"`
	Biome     string   `json:"biome"`
	Size      string   `json:"size"`
	Zone      string   `json:"zone"`
	Group     int32    `json:"group"` // the group of rocks it is in, or -1
	X         float64  `json:"x"`     // its centre, m east of the world's
	Y         float64  `json:"y"`     // and north
	Across    float64  `json:"across"`
	Area      float64  `json:"area"`    // m²
	Highest   float64  `json:"highest"` // m
	HighX     float64  `json:"highX"`
	HighY     float64  `json:"highY"`
	Cliffs    float64  `json:"cliffs"` // the share of its coast with cliffs
	Stacks    int32    `json:"stacks"`
	Reef      bool     `json:"withReef"`
	Lagoon    float64  `json:"lagoon"` // m
	Twin      bool     `json:"twin"`
	Shoreline float64  `json:"shoreline"`
	Shows     []string `json:"shows"` // the features its terrain shows
	// Box is the columns and rows of the lattice its land and bed lie on:
	// the first column and row, and how many of each.
	Box [4]int32 `json:"box"`
}

// Group is a group of rocks.
type Group struct {
	Number  int32   `json:"number"`
	Name    string  `json:"name"`
	Biome   string  `json:"biome"`
	Zone    string  `json:"zone"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Members []int32 `json:"members"`
}

// Records are a world's records: everything but its chunks.
type Records struct {
	Format    int             `json:"format"`
	Generator int             `json:"generator"`
	Seed      uint64          `json:"seed"`     // the world's seed
	Made      uint64          `json:"made"`     // the seed of the attempt that passed
	Attempts  int             `json:"attempts"` // how many were made
	Islands   []Island        `json:"islands"`  // the main port's first
	Groups    []Group         `json:"groups"`
	Fetch     []physics.Fetch `json:"fetch"` // each sea area's, row by row from the south-west
	Start     Start           `json:"start"`
}

// Format is the bundle's format: its records' and chunks' encoding.
const Format = 1

// Bundle is a made world.
type Bundle struct {
	Records
	Ground  *physics.Ground
	Shelter *physics.Shelter
	Report  Report
	// Digest is the SHA-256 of the records and every chunk's ground and
	// shelter: the same for the same seed and Version on every machine.
	Digest [32]byte
}

// Report says how a world was made: its attempts, what it holds, each
// rule's result and how long each stage took.
type Report struct {
	Attempts  []Attempt          `json:"attempts"`
	Islands   int                `json:"islands"`
	ByClass   map[string]int     `json:"byClass"`
	ByBiome   map[string]int     `json:"byBiome"`
	LandShare float64            `json:"landShare"` // percent
	Open      float64            `json:"open"`      // the furthest water inside the mist band is from land, m
	Rules     []Rule             `json:"rules"`
	Millis    map[string]float64 `json:"millis"`
}

// Attempt is one attempt's seed and the rules it failed.
type Attempt struct {
	Seed   uint64   `json:"seed"`
	Failed []string `json:"failed"`
}

// ErrInvalid is a seed none of whose attempts passed the rules.
var ErrInvalid = errors.New("worldgen: no attempt passed the rules")

// Generate makes the world of a seed: attempts from the seed, then from
// the next seeds, until one passes the rules, at most the catalog's
// attempts. If none passes it returns the last, with ErrInvalid.
func Generate(seed uint64, cat *catalog.Catalog, db *names.DB) (*Bundle, error) {
	c, err := newConfig(cat, db)
	if err != nil {
		return nil, err
	}
	var b *Bundle
	var attempts []Attempt
	for a := range max(c.validator.Attempts, 1) {
		s := attemptSeed(seed, a)
		b = c.generate(s)
		b.Seed, b.Made, b.Attempts = seed, s, a+1
		var failed []string
		for _, r := range b.Report.Rules {
			if !r.Pass {
				failed = append(failed, r.Name)
			}
		}
		attempts = append(attempts, Attempt{Seed: s, Failed: failed})
		b.Report.Attempts = attempts
		if len(failed) == 0 {
			b.Digest = b.digest()
			return b, nil
		}
	}
	b.Digest = b.digest()
	return b, ErrInvalid
}

// attemptSeed is the seed of attempt a: the world's own first, then a hash
// of it and the attempt's number.
func attemptSeed(seed uint64, a int) uint64 {
	if a == 0 {
		return seed
	}
	return mix(seed ^ mix(uint64(a)))
}

// generate makes one attempt's world.
func (c *config) generate(seed uint64) *Bundle {
	b := &Bundle{Records: Records{Format: Format, Generator: Version}}
	b.Report.Millis = map[string]float64{}
	clock := time.Now()
	lap := func(stage string) {
		now := time.Now()
		b.Report.Millis[stage] = float64(now.Sub(clock).Microseconds()) / 1000
		clock = now
	}
	spots, groups := layout(c, seed)
	lap("layout")
	var w work
	islands := make([]*made, len(spots))
	for i, sp := range spots {
		islands[i] = c.makeIsland(seed, int32(i), sp, &w)
	}
	lap("islands")
	b.Ground = c.rasterAll(islands)
	lap("raster")
	k := newCoarse(b.Ground)
	b.Fetch = c.fetchOf(b.Ground, k)
	lap("fetch")
	b.Shelter = c.shelterOf(b.Ground)
	lap("shelter")
	b.Start = c.startOf(b.Ground, islands[0])
	lap("start")
	islandNames := c.nameIslands(seed, islands)
	groupNames := c.nameGroups(seed, groups, islandNames)
	lap("names")

	b.Report.ByClass, b.Report.ByBiome = map[string]int{}, map[string]int{}
	for i, m := range islands {
		d := hypot(m.x, m.y)
		is := Island{
			Number: int32(i), Kind: m.kind, Name: islandNames[i], Biome: c.biomeIDs[m.biome],
			Size: c.sizeOf(m.area), Zone: zoneNames[c.zoneOf(d)], Group: m.group,
			X: m.x, Y: m.y, Across: float64(2 * m.radius), Area: m.area,
			Highest: m.highest, HighX: m.hx, HighY: m.hy, Cliffs: m.cliffs, Stacks: m.stacks,
			Reef: m.reef, Lagoon: m.lagoon, Twin: m.twin, Shoreline: m.shoreline, Shows: c.shows(m),
			Box: [4]int32{m.grid.c0, m.grid.j0, m.grid.w, m.grid.h},
		}
		if is.Shows == nil {
			is.Shows = []string{}
		}
		b.Islands = append(b.Islands, is)
		b.Report.ByClass[is.Size]++
		b.Report.ByBiome[is.Biome]++
	}
	for gi, g := range groups {
		b.Groups = append(b.Groups, Group{Number: int32(gi), Name: groupNames[gi], Biome: c.biomeIDs[g.biome],
			Zone: zoneNames[c.zoneOf(hypot(g.x, g.y))], X: g.x, Y: g.y, Members: g.members})
	}
	b.Report.Islands = len(islands)
	b.Report.LandShare = c.landShare(b.Ground)
	b.Report.Open = c.largestOpen(k)
	allNames := append(append([]string{}, islandNames...), groupNames...)
	b.Report.Rules = c.validate(&world{islands: islands, names: allNames, groups: groups, ground: b.Ground, coarse: k, start: b.Start})
	lap("validate")
	return b
}

// digest is the SHA-256 of the records and every chunk's ground and
// shelter, which neither the report nor the clock enter.
func (b *Bundle) digest() [32]byte {
	h := sha256.New()
	rec, err := json.Marshal(b.Records)
	if err != nil {
		panic(err) // the records are plain data
	}
	h.Write(rec)
	var buf [8]byte
	for n := range physics.ChunkCount {
		ch := b.Ground.Chunks[n]
		if ch == nil {
			h.Write([]byte{0})
		} else {
			h.Write([]byte{1})
			for _, e := range ch.Elevation {
				binary.LittleEndian.PutUint16(buf[:2], uint16(e))
				h.Write(buf[:2])
			}
			h.Write(ch.Surface[:])
		}
		if sh := b.Shelter.Chunks[n]; sh == nil {
			h.Write([]byte{0})
		} else {
			h.Write([]byte{1})
			h.Write(sh.Values[:])
		}
	}
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

// DigestHex is the digest in hexadecimal.
func (b *Bundle) DigestHex() string { return fmt.Sprintf("%x", b.Digest) }

// Passed reports whether every rule passed.
func (b *Bundle) Passed() bool {
	for _, r := range b.Report.Rules {
		if !r.Pass {
			return false
		}
	}
	return true
}

// MainPort is the main port's island.
func (b *Bundle) MainPort() *Island { return &b.Islands[0] }

// stages are the generator's stages, as the report times them.
var stages = []string{"layout", "islands", "raster", "fetch", "shelter", "start", "names", "validate"}

// Generated reports how long making the world's last attempt took.
func (b *Bundle) Generated() time.Duration {
	var ms float64
	for _, s := range stages {
		ms += b.Report.Millis[s]
	}
	return time.Duration(toInt32(ms)) * time.Millisecond
}

// Empty is a world of open sea, with no island: for tests of everything but
// the terrain, which have no time to make a world.
func Empty(seed uint64) *Bundle {
	b := &Bundle{
		Records: Records{Format: Format, Generator: Version, Seed: seed, Made: seed, Attempts: 1},
		Ground:  new(physics.Ground),
		Shelter: new(physics.Shelter),
	}
	b.Report.Millis = map[string]float64{}
	b.Digest = b.digest()
	return b
}
