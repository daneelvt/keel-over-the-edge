// SPDX-License-Identifier: AGPL-3.0-only

package client

import (
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// MaxSeaWindow is the most sea areas a side a client takes in a SeaAreas.
const MaxSeaWindow = physics.SeaClientWindow

// Seas is the sea about the boat as the server sent it: the two SeaAreas
// with the latest ticks, each turned into the waves' amplitudes exactly as
// the server derives its own. At each tick the prediction sails in the later
// of those whose tick has come. It is client/src/predict/seas.ts's twin.
type Seas struct {
	waves *physics.Waves
	held  [2]heldSea
	time  physics.SeaTick
	view  physics.Sea
}

type heldSea struct {
	have bool
	tick int64
	win  physics.SeaWindow
}

// NewSeas keeps the sea for waves; with none, the water is flat.
func NewSeas(waves *physics.Waves) *Seas {
	s := &Seas{waves: waves}
	s.view = physics.Sea{Waves: waves, Tick: &s.time}
	return s
}

// Reset forgets what was sent: a new connection sends it again.
func (s *Seas) Reset() {
	for i := range s.held {
		s.held[i].have = false
	}
}

// Receive takes a SeaAreas: it replaces the one held for the same tick, or
// else the one with the earlier tick. One that is malformed is let go.
func (s *Seas) Receive(m *pb.SeaAreas) {
	n := int(m.GetSize())
	if s.waves == nil || n < 1 || n > MaxSeaWindow || len(m.GetSpeed()) != n*n || len(m.GetFrom()) != n*n || len(m.GetFetch()) != n*n {
		return
	}
	h := &s.held[0]
	switch a, b := &s.held[0], &s.held[1]; {
	case a.have && a.tick == m.GetTick():
	case b.have && b.tick == m.GetTick():
		h = b
	case !a.have:
	case !b.have || b.tick < a.tick:
		h = b
	}
	if int(h.win.Size) != n {
		h.win = physics.SeaWindow{
			Size:   int32(n),
			Inputs: make([]physics.SeaInput, n*n),
			Amp:    make([]float64, n*n*physics.SeaComponents),
			Hs:     make([]float64, n*n),
			Peak:   make([]float64, n*n),
		}
	}
	h.have, h.tick = true, m.GetTick()
	h.win.Col, h.win.Row = m.GetCol(), m.GetRow()
	for i := range n * n {
		physics.SeaArea(s.waves, &h.win, int32(i), physics.SeaInput{
			Speed: m.GetSpeed()[i], From: m.GetFrom()[i] % physics.SeaFromSteps, Fetch: m.GetFetch()[i],
		})
	}
	h.win.Seal()
}

// At is the sea a step for tick sails in: nil, flat water, until a SeaAreas
// has come.
func (s *Seas) At(tick int64) *physics.Sea {
	var use *heldSea
	for i := range s.held {
		h := &s.held[i]
		if !h.have {
			continue
		}
		switch {
		case use == nil:
			use = h
		case h.tick <= tick && (use.tick > tick || h.tick > use.tick):
			// The later of those whose tick has come.
			use = h
		case h.tick > tick && use.tick > tick && h.tick < use.tick:
			// Neither has: the earlier is the nearer guess.
			use = h
		}
	}
	if use == nil {
		return nil
	}
	s.view.Window = &use.win
	physics.SeaAtTick(s.waves, &s.time, tick)
	return &s.view
}
