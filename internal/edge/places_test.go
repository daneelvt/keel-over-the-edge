// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"math"
	"slices"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// sent reads every message the connection has been sent since last asked.
func sent(t *testing.T, c *conn) []*pb.ServerMessage {
	t.Helper()
	var out []*pb.ServerMessage
	for {
		select {
		case o := <-c.queue:
			var m pb.ServerMessage
			if err := protocol.DecodeServer(o.b, &m); err != nil {
				t.Fatal(err)
			}
			out = append(out, &m)
		default:
			return out
		}
	}
}

// TestPlacesWithTheirChunks: a place reaches a connection only with the
// chunk it stands in, after that chunk's Chunks, and once; a place in a
// chunk the connection could not see does not reach it.
func TestPlacesWithTheirChunks(t *testing.T) {
	h := NewHandout(madeGround(testIslands), testPaths(), testRule(t))
	near := &pb.Place{Number: 200, Kind: 1, East: 105_000, North: 1_000}
	far := &pb.Place{Number: 201, Kind: 8, East: -780_000, North: 10_000}
	h.SetPlaces([]*pb.Place{near, far})
	c := handoutConn(h)
	c.chunks(h, 1000, 0)
	var handed []uint32
	var places []uint32
	for _, m := range sent(t, c) {
		if ch := m.GetChunks(); ch != nil {
			handed = append(handed, ch.Number...)
		}
		if p := m.GetPlaces(); p != nil {
			for _, pl := range p.Places {
				if !slices.Contains(handed, uint32(chunkAt(float64(pl.East)/100, float64(pl.North)/100))) {
					t.Errorf("place %d came before its chunk", pl.Number)
				}
				places = append(places, pl.Number)
			}
		}
	}
	if !slices.Equal(places, []uint32{200}) {
		t.Errorf("places %v reached a boat at (1000, 0)", places)
	}
	// Sailing to the far place's chunk brings it, once.
	for x := 1000.0; x > -7800; x -= 15 {
		c.chunks(h, x, 100)
		for _, m := range sent(t, c) {
			if p := m.GetPlaces(); p != nil {
				for _, pl := range p.Places {
					places = append(places, pl.Number)
				}
			}
		}
	}
	if !slices.Equal(places, []uint32{200, 201}) {
		t.Errorf("places %v reached the boat sailing west", places)
	}
}

// TestLightsByRange: a light reaches a connection once its eye is within
// the light's range, and is dropped only beyond its range and the margin;
// sent again once the eye comes back.
func TestLightsByRange(t *testing.T) {
	h := NewHandout(madeGround(testIslands), testPaths(), testRule(t))
	lt := &pb.Light{Number: 3, East: 500_000, North: 0, Focal: 3000, Character: 7, Phase: 1, Range: 2000}
	h.SetLights(NewLights([]*pb.Light{lt}, 200))
	c := handoutConn(h)
	shown := false
	var events []string
	for _, x := range []float64{-200, 2900, 3001, 3100, 5000, 7000, 7150, 7250, 7000, 5000} {
		c.handout.looked = false // look every time
		c.chunks(h, x, 0)
		for _, m := range sent(t, c) {
			l := m.GetLights()
			if l == nil {
				continue
			}
			for _, got := range l.Lights {
				if got.Number != 3 || shown {
					t.Errorf("at %v: light %d sent while shown", x, got.Number)
				}
				shown = true
				events = append(events, "sent")
			}
			for _, n := range l.Drop {
				if n != 3 || !shown {
					t.Errorf("at %v: light %d dropped while not shown", x, n)
				}
				shown = false
				events = append(events, "dropped")
			}
		}
		d := math.Abs(x - 5000)
		switch {
		case d <= 2000 && !shown:
			t.Errorf("at %v m from the light, within its range, it is not shown", d)
		case d > 2200 && shown:
			t.Errorf("at %v m from the light, beyond its range and the margin, it is shown", d)
		}
	}
	if !slices.Equal(events, []string{"sent", "dropped", "sent"}) {
		t.Errorf("the light was %v", events)
	}
}
