// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// A world's places go to a connection with the chunks they stand in: each
// place once, after its chunk's Chunks, so that a place reaches only a
// client that could see the land about it, as the land itself does. Its
// lighthouses' lights reach farther, as a sailor sees a light long before
// the land it stands on: a light is sent once the connection's eye is
// within its range, and dropped once the eye is further than its range by
// a margin, so that a light is not sent and dropped again and again by an
// eye on its range's edge. Neither ever carries a name: a player learns a
// place's name only when it is charted.

// SetPlaces gives the handout the world's places, each to go with the chunk
// it stands in.
func (h *Handout) SetPlaces(places []*pb.Place) {
	for i := range h.places {
		h.places[i] = nil
	}
	for _, p := range places {
		q, r := physics.HexAt(float64(p.East)/100, float64(p.North)/100)
		if n, _, ok := physics.ChunkOf(physics.HexCell(q, r)); ok {
			h.places[n] = append(h.places[n], p)
		}
	}
}

// Lights are a world's lights as they are sent: each with its range, and
// the margin past it a light is dropped at.
type Lights struct {
	lights []*pb.Light
	drop   float64
}

// NewLights is the world's lights, but the main port's, which the Welcome
// carries, to be sent within their ranges and dropped drop m beyond them.
func NewLights(lights []*pb.Light, drop float64) *Lights {
	return &Lights{lights: lights, drop: drop}
}

// All is every light, as sent.
func (l *Lights) All() []*pb.Light { return l.lights }

// SetLights gives the handout the world's lights.
func (h *Handout) SetLights(l *Lights) { h.lights = l }

// connLights is which lights a connection has been sent and not dropped.
type connLights struct {
	sent []bool
}

// lights sends the connection the lights whose range its eye at (x, y) is
// within that it has not been sent, and drops those it is further from
// than their range and the margin. It reports whether the connection is
// still good.
func (c *conn) lights(l *Lights, x, y float64) bool {
	if l == nil || len(l.lights) == 0 {
		return true
	}
	st := &c.lightsSent
	if len(st.sent) != len(l.lights) {
		st.sent = make([]bool, len(l.lights))
	}
	var m *pb.Lights
	for i, lt := range l.lights {
		d := math.Hypot(float64(lt.East)/100-x, float64(lt.North)/100-y)
		r := float64(lt.Range)
		switch {
		case !st.sent[i] && d <= r:
			if m == nil {
				m = &pb.Lights{}
			}
			m.Lights = append(m.Lights, lt)
			st.sent[i] = true
		case st.sent[i] && d > r+l.drop:
			if m == nil {
				m = &pb.Lights{}
			}
			m.Drop = append(m.Drop, lt.Number)
			st.sent[i] = false
		}
	}
	if m == nil {
		return true
	}
	return c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Lights{Lights: m}}, outLights)
}
