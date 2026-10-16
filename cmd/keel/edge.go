// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
)

// edgeOf is how the world's boats meet its edge, by the catalog: how long a
// boat that has gone over falls, in whole ticks, and how far back out of
// the mist band an approach is survived.
func edgeOf(cat *catalog.Catalog) *sim.Edge {
	e := &cat.World.Edge
	return &sim.Edge{Fall: int64(math.Round(e.Fall * physics.StepsPerSecond)), Clear: e.Clear}
}

// circulationOf is the world's way round the disk, as its terrain gives it:
// 0 for a world sailed as open sea.
func circulationOf(t *sim.Terrain) int32 {
	if t == nil {
		return 0
	}
	return int32(t.Circulation)
}
