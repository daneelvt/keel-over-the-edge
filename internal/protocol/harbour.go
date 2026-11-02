// SPDX-License-Identifier: AGPL-3.0-only

package protocol

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// WireHarbour is a world's harbour as a Welcome carries it, in decimetres;
// nil for none.
func WireHarbour(h *physics.Harbour) *pb.Harbour {
	if h == nil {
		return nil
	}
	return &pb.Harbour{East: decimetres(h.X), North: decimetres(h.Y), Radius: uint32(max(decimetres(h.Radius), 0)),
		MouthEast: decimetres(h.MouthX), MouthNorth: decimetres(h.MouthY), Narrows: uint32(max(decimetres(h.Narrows), 0))}
}

// HarbourOf is the harbour a Welcome carries, in m, as the server computes
// the wind with it: each decimetre over 10; nil for none.
func HarbourOf(w *pb.Harbour) *physics.Harbour {
	if w == nil {
		return nil
	}
	return &physics.Harbour{X: float64(w.GetEast()) / 10, Y: float64(w.GetNorth()) / 10, Radius: float64(w.GetRadius()) / 10,
		MouthX: float64(w.GetMouthEast()) / 10, MouthY: float64(w.GetMouthNorth()) / 10, Narrows: float64(w.GetNarrows()) / 10}
}

// decimetres is a length in m to the nearest decimetre, within an int32's
// range, as the world generator rounds it.
func decimetres(v float64) int32 {
	d := math.Floor(float64(v*10) + 0.5)
	switch {
	case d != d:
		return 0
	case d >= math.MaxInt32:
		return math.MaxInt32
	case d <= math.MinInt32:
		return math.MinInt32
	}
	return int32(d)
}
