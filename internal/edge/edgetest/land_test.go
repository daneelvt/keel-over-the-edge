// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"context"
	"encoding/hex"
	"fmt"
	"io"
	"math"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/api"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// landWorld is a world of a sandy beach rising east of the start, 4 m deep
// to x = 50 and dry from x = 150, and a hill far off at (6000, 0): its
// terrain, boats starting at (-40, 0) heading east; the handout; and the
// chunks served.
func landWorld(t testing.TB) Config {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	g := &physics.Ground{Prepared: cat.PrepareGround()}
	elevation := func(x, y float64) float64 {
		if math.Hypot(x-6000, y) < 100 {
			return 30
		}
		if x < -2000 || x > 2000 {
			return -40
		}
		return math.Max(-4, -4+(x-50)/25)
	}
	for n := range int32(physics.ChunkCount) {
		c0, j0 := physics.ChunkCorner(n)
		x0, _ := physics.CellCentre(c0, j0)
		x1, _ := physics.CellCentre(c0+physics.ChunkColumns-1, j0)
		if x1 < -2000 || x0 > 2000 && (x1 < 5800 || x0 > 6200) {
			continue
		}
		ch := new(physics.GroundChunk)
		for i := range int32(physics.ChunkHexes) {
			x, y := physics.CellCentre(c0+i/physics.ChunkRows, j0+i%physics.ChunkRows)
			ch.Elevation[i] = int16(max(min(math.Round(elevation(x, y)*10), 800), physics.DeepWater))
		}
		g.Chunks[n] = ch
	}
	var id [16]byte
	if _, err := hex.Decode(id[:], []byte(strings.ReplaceAll(WorldID, "-", ""))); err != nil {
		t.Fatal(err)
	}
	payloads := make([][]byte, physics.ChunkCount)
	for n := range int32(physics.ChunkCount) {
		if payloads[n], err = worldgen.EncodeChunk(n, id, g.Chunks[n], nil); err != nil {
			t.Fatal(err)
		}
	}
	key := []byte(strings.Repeat("k", store.ChunkKeySize))
	served := api.NewChunks(id, key, payloads)
	h := &cat.World.Handout
	rule := edge.HandoutRule{Near: h.Near, Camera: h.Camera, Dome: h.Dome, Margin: h.Margin, Shallow: h.Shallows, Look: h.Look,
		FarSea: max(h.FarSeaLeast, h.FarSeaHorizon*math.Sqrt(2*h.Dome*h.Camera))}
	return Config{
		Terrain:  &sim.Terrain{Ground: g, Start: []physics.State{{X: -40, Y: -300, Heading: math.Pi / 2}}},
		Chunks:   edge.NewHandout(g, served.Paths(), rule),
		Payloads: served,
	}
}

// TestWelcomeOnLand: with land the Welcome says so, and the chunks about
// the boat follow it; without land it does not, and none come.
func TestWelcomeOnLand(t *testing.T) {
	for _, land := range []bool{true, false} {
		synctest.Test(t, func(t *testing.T) {
			var cfg Config
			if land {
				cfg = landWorld(t)
			}
			srv := NewServer(t, cfg)
			token, _ := srv.Sailor("Ann")
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			ws, w, err := srv.Connect(ctx, DialOptions{Cookie: token})
			if err != nil {
				t.Fatal(err)
			}
			defer ws.CloseNow()
			if w.GetLand() != land {
				t.Fatalf("land %v: the Welcome says %v", land, w.GetLand())
			}
			r, err := client.Receive(ctx, ws)
			if err != nil {
				t.Fatal(err)
			}
			ch := r.Message.GetChunks()
			if land && (ch == nil || len(ch.GetNumber()) == 0) {
				t.Fatalf("after the Welcome: %v", r.Message)
			}
			if !land && ch != nil {
				t.Fatalf("chunks with no land: %v", ch)
			}
			if land {
				near := ch.GetNumber()[0]
				if n, _, _ := physics.ChunkOf(physics.HexCell(physics.HexAt(-40, -300))); uint32(n) != near {
					t.Errorf("the first chunk handed is %d, not the boat's, %d", near, n)
				}
			}
		})
	}
}

// TestSailAground: a boat sails onto a beach, runs aground, stops and is
// pushed off, on the same tick in its client's prediction as on the
// server: not one correction, before the push or after it.
func TestSailAground(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cfg := landWorld(t)
		// The server's boats, each tick: a push-off moves a boat metres.
		var mu sync.Mutex
		pushes, aground := 0, 0
		var last physics.State
		cfg.Record = recorder(func(f *bus.Frame) {
			if len(f.Live) == 0 {
				return
			}
			s := f.State[f.Live[0]]
			mu.Lock()
			if last.X != 0 && math.Hypot(s.X-last.X, s.Y-last.Y) > 3 {
				pushes++
			}
			if s.GroundTimer > 0 {
				aground++
			}
			last = s
			mu.Unlock()
		})
		srv := NewServer(t, cfg)
		if err := srv.World.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.SetWeather, Weather: weather.Steady(12*1852.0/3600, 0)}); err != nil {
			t.Fatal(err)
		}
		time.Sleep(3 * time.Second)
		token, _ := srv.Sailor("Ann")
		// Holding east: the helm against the heading's error, as the golden
		// scenarios steer.
		var s *client.Sailor
		s = srv.NewSailor(DialOptions{Cookie: token}, func(int) client.Input {
			off := math.Remainder(math.Pi/2-s.Predictor.State.Heading, 2*math.Pi)
			helm := max(-1, min(1, 2*off))
			return client.Hand(uint16(math.Round((helm+1)*bus.Steps/2)), 460)
		})
		// The client holds the chunks the server handed: their ground is
		// the server's.
		s.Predictor.Ground = cfg.Terrain.Ground
		if err := s.Connect(t.Context()); err != nil {
			t.Fatal(err)
		}
		if err := s.Sail(t.Context(), 150*time.Second); err != nil {
			t.Fatal(err)
		}
		s.Drop()
		mu.Lock()
		defer mu.Unlock()
		st := s.Stats
		t.Logf("%d snapshots, %d corrections (largest %.3f m), %d resets; pushed off %d times, aground %d ticks; %d chunks handed; the boat ended at (%.1f, %.1f)",
			st.Snapshots, st.Corrections, st.Percentile(100), st.Resets, pushes, aground, st.Chunks, last.X, last.Y)
		if pushes == 0 || aground == 0 {
			t.Fatalf("the boat was pushed off %d times, aground %d ticks", pushes, aground)
		}
		if st.Corrections != 0 {
			t.Errorf("%d corrections, the largest %.3f m", st.Corrections, st.Percentile(100))
		}
		if st.Chunks == 0 {
			t.Error("no chunks handed")
		}
	})
}

// recorder is a function that is told of each frame.
type recorder func(f *bus.Frame)

func (r recorder) Record(f *bus.Frame) { r(f) }

// TestChunksSecret: a client fetches the chunks it was handed, and gets 404
// for every other chunk whatever address it makes from those it holds; a
// boat that sails nowhere near the far hill is never handed its chunk.
func TestChunksSecret(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cfg := landWorld(t)
		srv := NewServer(t, cfg)
		token, _ := srv.Sailor("Ann")
		s := srv.NewSailor(DialOptions{Cookie: token}, func(int) client.Input { return client.Hand(bus.Steps/2, 1024) })
		if err := s.Connect(t.Context()); err != nil {
			t.Fatal(err)
		}
		if err := s.Sail(t.Context(), 20*time.Second); err != nil {
			t.Fatal(err)
		}
		s.Drop()
		if len(s.Handed) == 0 {
			t.Fatal("nothing handed")
		}
		get := func(path string) (int, []byte) {
			t.Helper()
			res, err := srv.Client(nil).Get("http://example.com" + path)
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			body, _ := io.ReadAll(res.Body)
			return res.StatusCode, body
		}
		held := map[int]string{}
		for _, p := range s.Handed {
			code, body := get(p)
			if code != 200 || len(body) == 0 {
				t.Fatalf("a chunk handed, %s: %d", p, code)
			}
			var n int
			if _, err := fmt.Sscanf(p[strings.LastIndexByte(p, '/')+1:], "%d.", &n); err != nil {
				t.Fatal(err)
			}
			held[n] = p
		}
		hill, _, _ := physics.ChunkOf(physics.HexCell(physics.HexAt(6000, 0)))
		if _, ok := held[int(hill)]; ok {
			t.Fatal("the far hill's chunk was handed")
		}
		// Every chunk not held, at the address each held mac would give it.
		tried := 0
		for n := range physics.ChunkCount {
			if _, ok := held[n]; ok {
				continue
			}
			for m, p := range held {
				guess := strings.Replace(p, fmt.Sprintf("/c/%d.", m), fmt.Sprintf("/c/%d.", n), 1)
				if code, _ := get(guess); code != 404 {
					t.Fatalf("chunk %d at %s: %d", n, guess, code)
				}
				tried++
			}
		}
		t.Logf("%d chunks held; %d addresses guessed, all 404", len(held), tried)
		if code, _ := get(cfg.Payloads.Paths()[hill]); code != 200 {
			t.Errorf("the hill's own address: %d", code)
		}
	})
}
