// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"fmt"
	"math"
	"slices"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/edge/edgetest"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// TestNoNameOnTheWire: every message a connection could be sent of seed
// 1's places and lights, the Welcome's light among them, holds no name of
// the world: not an island's, a group's, a place's or a ship's. A player
// learns a name only when the place is charted.
func TestNoNameOnTheWire(t *testing.T) {
	if testing.Short() {
		t.Skip("makes a whole world")
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	b, err := worldgen.Generate(1, cat)
	if err != nil {
		t.Fatal(err)
	}
	places := wirePlaces(b, cat)
	main, lights := wireLights(b, cat)
	if len(places) != len(b.Places) || main == nil {
		t.Fatalf("%d places of %d on the wire, the main light %v", len(places), len(b.Places), main)
	}
	var wire []byte
	for _, m := range []*pb.ServerMessage{
		{Body: &pb.ServerMessage_Places{Places: &pb.Places{Places: places}}},
		{Body: &pb.ServerMessage_Lights{Lights: &pb.Lights{Lights: lights.All()}}},
		{Body: &pb.ServerMessage_Welcome{Welcome: &pb.Welcome{World: "w", Light: main}}},
	} {
		if wire, err = protocol.AppendServer(wire, m); err != nil {
			t.Fatal(err)
		}
	}
	var names []string
	for _, is := range b.Islands {
		names = append(names, is.Name)
	}
	for _, g := range b.Groups {
		names = append(names, g.Name)
	}
	for _, p := range b.Places {
		names = append(names, p.Name)
		if s := p.Details.Ship; s != nil {
			names = append(names, s.Name, s.Cargo)
		}
	}
	for _, n := range names {
		if len(n) >= 3 && bytes.Contains(wire, []byte(n)) {
			t.Errorf("%q is on the wire", n)
		}
	}
	t.Logf("%d bytes for %d places and %d lights, searched for %d names", len(wire), len(places), len(b.Lights), len(names))
}

// TestPlacesAndLightsOnline: a server sailing seed 1's world, land on. Ann
// at the start is welcomed with Port Royal's light, sent the places of the
// chunks she is handed and no other, and the lights whose ranges she is
// within; Bob, put out by an edge light, is sent its light and the places
// about it, which Ann is not.
func TestPlacesAndLightsOnline(t *testing.T) {
	if testing.Short() {
		t.Skip("makes a whole world")
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	world, err := worldgen.Generate(1, cat)
	if err != nil {
		t.Fatal(err)
	}
	var edgeLight worldgen.Light
	for _, l := range world.Lights {
		if l.Role == worldgen.RoleEdge {
			edgeLight = l
			break
		}
	}
	synctest.Test(t, func(t *testing.T) {
		d := &memDB{epoch: bubbleEpoch, sessions: edgetest.NewSessions()}
		ann, _ := d.sessions.Add("Ann", "human")
		bob, _ := d.sessions.Add("Bob", "human")
		gen := func(uint64) (*worldgen.Bundle, error) { return world, nil }
		s := startServer(t, map[string]string{"KEEL_DEV_COMMANDS": "1"}, newMemNet(), d.with(serveOptions{generate: gen}))
		time.Sleep(time.Second)
		heard := func(in *client.Inbox) *got {
			g := &got{}
			go func() {
				for r := range in.C {
					g.add(r.Message)
				}
			}()
			return g
		}
		_, ain, w := connect(t, s, ann)
		if w.GetLight() == nil || w.GetLight().GetRange() < 8000 {
			t.Fatalf("the Welcome's light is %v", w.GetLight())
		}
		a := heard(ain)
		_, bin, _ := connect(t, s, bob)
		b := heard(bin)
		time.Sleep(2 * time.Second)
		synctest.Wait()
		// Bob, by the edge light, 200 m in from it.
		r := math.Hypot(edgeLight.X, edgeLight.Y)
		x, y := edgeLight.X*(r-200)/r, edgeLight.Y*(r-200)/r
		res, err := s.client.Post(fmt.Sprintf("%s/debug/place?east=%.1f&north=%.1f&boat=2", internalURL, x, y), "", nil)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		time.Sleep(3 * time.Second)
		synctest.Wait()
		s.stop(t)
		start := world.Start.Places[0]
		a.mu.Lock()
		b.mu.Lock()
		defer a.mu.Unlock()
		defer b.mu.Unlock()
		if len(a.places) == 0 || len(a.lights) == 0 {
			t.Fatalf("Ann was sent %d places and %d lights", len(a.places), len(a.lights))
		}
		for _, p := range a.places {
			if !a.chunks[chunkOf(float64(p.East)/100, float64(p.North)/100)] {
				t.Errorf("Ann was sent place %d, not in a chunk she was handed", p.Number)
			}
		}
		for _, l := range a.lights {
			if math.Hypot(float64(l.East)/100-start[0], float64(l.North)/100-start[1]) > float64(l.Range) {
				t.Errorf("Ann was sent light %d, out of range", l.Number)
			}
			if l.Number == uint32(edgeLight.Number) {
				t.Error("Ann was sent the edge light")
			}
		}
		if !slices.ContainsFunc(b.lights, func(l *pb.Light) bool { return l.Number == uint32(edgeLight.Number) }) {
			t.Error("Bob was not sent the edge light")
		}
		far := 0
		for _, p := range b.places {
			if math.Hypot(float64(p.East)/100-x, float64(p.North)/100-y) < 500 {
				far++
				if slices.ContainsFunc(a.places, func(q *pb.Place) bool { return q.Number == p.Number }) {
					t.Errorf("Ann was sent place %d, by Bob", p.Number)
				}
			}
		}
		if far == 0 {
			t.Error("Bob was sent no place about him")
		}
	})
}

// got is what a connection was sent of the land: its chunks, places and
// lights.
type got struct {
	mu     sync.Mutex
	chunks map[int]bool
	places []*pb.Place
	lights []*pb.Light
}

func (g *got) add(m *pb.ServerMessage) {
	if m == nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.chunks == nil {
		g.chunks = map[int]bool{}
	}
	if c := m.GetChunks(); c != nil {
		for _, n := range c.Number {
			g.chunks[int(n)] = true
		}
	}
	if p := m.GetPlaces(); p != nil {
		g.places = append(g.places, p.Places...)
	}
	if l := m.GetLights(); l != nil {
		g.lights = append(g.lights, l.Lights...)
	}
}

// chunkOf is the chunk the hexagon at (x, y) is in.
func chunkOf(x, y float64) int {
	n, _, _ := physics.ChunkOf(physics.HexCell(physics.HexAt(x, y)))
	return int(n)
}
