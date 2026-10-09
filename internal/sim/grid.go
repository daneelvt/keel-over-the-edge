// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// buildGrid sorts f's live boats into the grid's cells: a counting sort. The
// first pass counts each cell's boats; a running sum turns the counts into
// each cell's end in Slots; the second pass, over the boats from the last,
// puts each just before its cell's end and moves the end back, so that each
// cell's boats come out in ascending order and each Start ends at its
// cell's first boat. The cells are physics.Cell's, exact on every machine,
// so the grid is the same however the boats were stepped.
func buildGrid(f *bus.Frame) {
	g := &f.Grid
	clear(g.Start)
	for _, s := range f.Live {
		c := physics.Cell(f.State[s].X, f.State[s].Y)
		g.Cell[s] = c
		g.Start[c]++
	}
	var sum int32
	for c := range bus.Cells {
		sum += g.Start[c]
		g.Start[c] = sum
	}
	g.Start[bus.Cells] = sum
	g.Slots = g.Slots[:len(f.Live)]
	for i := len(f.Live) - 1; i >= 0; i-- {
		s := f.Live[i]
		c := g.Cell[s]
		g.Start[c]--
		g.Slots[g.Start[c]] = s
	}
}
