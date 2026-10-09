// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"math"
	"sync/atomic"

	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
)

// marginOf is how many ticks an input stamped seq arrived before its tick,
// when the latest published tick is latest: the next tick to run is
// latest + 1, so a margin of 0 is just in time, and a negative one late. It
// is reckoned modulo 2³², as the tick compares words, and kept within an
// int16, the snapshot's room for it.
func marginOf(seq uint32, latest int64) int16 {
	d := int32(seq - uint32(latest+1))
	return int16(max(-math.MaxInt16, min(math.MaxInt16, d)))
}

// margin is the lowest arrival margin since it was last taken, written by a
// connection's reader and taken by the encoder for each snapshot.
type margin struct{ v atomic.Int32 }

func (m *margin) init() { m.v.Store(protocol.NoMargin) }

// record keeps d if it is the lowest yet.
func (m *margin) record(d int16) {
	for {
		cur := m.v.Load()
		if cur != protocol.NoMargin && int32(d) >= cur {
			return
		}
		if m.v.CompareAndSwap(cur, int32(d)) {
			return
		}
	}
}

// take returns the lowest margin recorded since the last take, or
// protocol.NoMargin, and starts again.
func (m *margin) take() int16 { return int16(m.v.Swap(protocol.NoMargin)) }
