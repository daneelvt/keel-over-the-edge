// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// By day each island raises a cap of cumulus and a street of them
// downwind, which the phone draws from the island's centre and width. An
// island is sent once the connection's eye is within sight of its cap, and
// dropped once the eye is further than that by a margin, as a light is: so
// a client learns no more of where land is than the sky would show it.

// Caps are a world's islands as their caps are sent: each with how far
// its cap can be seen from, and the margin past it an island is dropped at.
type Caps struct {
	caps  []*pb.IslandCap
	reach []float64
	drop  float64
}

// NewCaps is the world's islands' caps, each sent within its reach, m,
// and dropped drop m beyond it.
func NewCaps(caps []*pb.IslandCap, reach []float64, drop float64) *Caps {
	return &Caps{caps: caps, reach: reach, drop: drop}
}

// All is every cap, as sent.
func (c *Caps) All() []*pb.IslandCap { return c.caps }

// SetCaps gives the handout the world's islands' caps.
func (h *Handout) SetCaps(c *Caps) { h.caps = c }

// connCaps is which caps a connection has been sent and not dropped.
type connCaps struct {
	sent []bool
}

// islandCaps sends the connection the caps whose sight its eye at (x, y)
// is within that it has not been sent, and drops those it is further from
// than that and the margin. It reports whether the connection is still
// good.
func (c *conn) islandCaps(cs *Caps, x, y float64) bool {
	if cs == nil || len(cs.caps) == 0 {
		return true
	}
	st := &c.capsSent
	if len(st.sent) != len(cs.caps) {
		st.sent = make([]bool, len(cs.caps))
	}
	var m *pb.IslandCaps
	for i, p := range cs.caps {
		d := math.Hypot(float64(p.East)-x, float64(p.North)-y)
		r := cs.reach[i]
		switch {
		case !st.sent[i] && d <= r:
			if m == nil {
				m = &pb.IslandCaps{}
			}
			m.Caps = append(m.Caps, p)
			st.sent[i] = true
		case st.sent[i] && d > r+cs.drop:
			if m == nil {
				m = &pb.IslandCaps{}
			}
			m.Drop = append(m.Drop, p.Number)
			st.sent[i] = false
		}
	}
	if m == nil {
		return true
	}
	return c.send(&pb.ServerMessage{Body: &pb.ServerMessage_IslandCaps{IslandCaps: m}}, outIslandCaps)
}
