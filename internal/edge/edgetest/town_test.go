// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"context"
	"encoding/hex"
	"math"
	"slices"
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
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// TestTownHanded: a town travels in its land's chunks. A boat starting by
// it, on a reach, is handed its chunk, buildings and harbour in it; a boat
// starting far off is handed no chunk of it.
func TestTownHanded(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cfg := landWorld(t)
		// A town on the beach east of the start: a church and a house, and
		// its harbour's water.
		town := &worldgen.ChunkTown{
			Buildings: []worldgen.Building{
				{Kind: 6, X: 200, Y: -290, Heading: -math.Pi / 2, Level: 24, Storeys: 1, Frontage: 11, Depth: 20, Top: 26.4},
				{Kind: 0, X: 190, Y: -320, Heading: -math.Pi / 2, Level: 24, Storeys: 2, Frontage: 6, Depth: 8, Top: 11.4},
			},
			Harbour: []worldgen.Disc{{X: 0, Y: -300, R: 150}},
		}
		at, _, _ := physics.ChunkOf(physics.HexCell(physics.HexAt(200, -290)))
		g := cfg.Terrain.Ground
		var id [16]byte
		if _, err := hex.Decode(id[:], []byte(strings.ReplaceAll(WorldID, "-", ""))); err != nil {
			t.Fatal(err)
		}
		payloads := make([][]byte, physics.ChunkCount)
		for n := range int32(physics.ChunkCount) {
			var tn *worldgen.ChunkTown
			if n == at {
				tn = town
			}
			p, err := worldgen.EncodeChunkTown(n, id, g.Chunks[n], nil, tn)
			if err != nil {
				t.Fatal(err)
			}
			payloads[n] = p
		}
		cat, err := catalog.Load()
		if err != nil {
			t.Fatal(err)
		}
		h := &cat.World.Handout
		rule := edge.HandoutRule{Near: h.Near, Camera: h.Camera, Dome: h.Dome, Margin: h.Margin, Shallow: h.Shallows, Look: h.Look,
			FarSea: max(h.FarSeaLeast, h.FarSeaHorizon*math.Sqrt(2*h.Dome*h.Camera))}
		served := api.NewChunks(id, []byte(strings.Repeat("k", store.ChunkKeySize)), payloads)
		var tops []edge.Top
		for _, b := range town.Buildings {
			tops = append(tops, edge.Top{X: b.X, Y: b.Y, Height: b.Top})
		}
		cfg.Chunks = edge.NewHandout(g, served.Paths(), rule).WithTops(tops)
		cfg.Payloads = served
		// The first place by the town; the second far off.
		cfg.Terrain.Start = []physics.State{{X: -40, Y: -300, Heading: 2.5}, {X: -40, Y: -6000, Heading: 0}}
		// The first state each boat is seen in.
		var mu sync.Mutex
		first := map[int32]physics.State{}
		cfg.Record = recorder(func(f *bus.Frame) {
			mu.Lock()
			defer mu.Unlock()
			for _, s := range f.Live {
				if _, ok := first[s]; !ok {
					first[s] = f.State[s]
				}
			}
		})
		srv := NewServer(t, cfg)
		ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
		defer cancel()
		handed := func(name string) []uint32 {
			token, _ := srv.Sailor(name)
			ws, _, err := srv.Connect(ctx, DialOptions{Cookie: token})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { ws.CloseNow() })
			r, err := client.Receive(ctx, ws)
			if err != nil {
				t.Fatal(err)
			}
			return r.Message.GetChunks().GetNumber()
		}
		ann := handed("Ann")
		if !slices.Contains(ann, uint32(at)) {
			t.Fatalf("the boat starting by the town was handed %v, not its chunk %d", ann, at)
		}
		_, _, read, err := worldgen.DecodeChunkOf(payloads[at], at, id, worldgen.Version)
		if err != nil || read == nil || len(read.Buildings) != 2 || len(read.Harbour) != 1 {
			t.Fatalf("the town's chunk reads %+v, %v", read, err)
		}
		// Started at its place, on a reach 110° off the wind.
		time.Sleep(time.Second)
		mu.Lock()
		started := false
		from := sim.DefaultSpell.From * 2 * math.Pi / physics.TurnSteps
		for _, st := range first {
			off := math.Abs(math.Remainder(st.Heading-from, 2*math.Pi))
			if math.Hypot(st.X+40, st.Y+300) < 1 && math.Abs(off-110*math.Pi/180) < 0.01 {
				started = true
			}
		}
		mu.Unlock()
		if !started {
			t.Errorf("no boat started at its place, on a reach: %+v", first)
		}
		bob := handed("Bob")
		if slices.Contains(bob, uint32(at)) {
			t.Errorf("the boat far off was handed the town's chunk: %v", bob)
		}
	})
}
