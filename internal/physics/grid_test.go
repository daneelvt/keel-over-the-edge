// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"testing"
)

// TestCellAtBoundaries: a cell holds its west and south edges and not its
// east and north ones, −0 is 0, and what lies beyond the square falls in
// its edge cells.
func TestCellAtBoundaries(t *testing.T) {
	const mid = GridCells / 2
	for _, tc := range []struct {
		v    float64
		want int32
	}{
		{0, mid},
		{math.Copysign(0, -1), mid},
		{math.SmallestNonzeroFloat64, mid},
		{-math.SmallestNonzeroFloat64, mid - 1},
		{CellSize, mid + 1},
		{math.Nextafter(CellSize, 0), mid},
		{-CellSize, mid - 1},
		{math.Nextafter(-CellSize, 0), mid - 1},
		{math.Nextafter(-CellSize, -100), mid - 2},
		{mid * CellSize, GridCells - 1},
		{math.Nextafter(mid*CellSize, 0), GridCells - 1},
		{-mid * CellSize, 0},
		{math.Nextafter(-mid*CellSize, 0), 0},
		{1e9, GridCells - 1},
		{-1e9, 0},
		{math.Inf(1), GridCells - 1},
		{math.Inf(-1), 0},
		{math.NaN(), mid},
	} {
		if got := CellOf(tc.v); got != tc.want {
			t.Errorf("CellOf(%v) = %d, want %d", tc.v, got, tc.want)
		}
	}
	if got, want := Cell(-1, 64), int32((mid+1)*GridCells+mid-1); got != want {
		t.Errorf("Cell(-1, 64) = %d, want %d", got, want)
	}
}

func TestSailByte(t *testing.T) {
	for _, tc := range []struct {
		flat, foot, head float64
		want             uint8
	}{
		{1, FlowAttached, FlowAttached, 15 | 1<<4 | 1<<6},
		{0, FlowLuffing, FlowLuffing, 0},
		{0.5, FlowStalled, FlowAback, 8 | 2<<4 | 3<<6},
		{0.45, FlowAback, FlowLuffing, 7 | 3<<4},
		{2, 7, -1, 15 | 3<<4},
		{math.NaN(), FlowAttached, FlowStalled, 1<<4 | 2<<6},
	} {
		o := Out{Flattening: tc.flat, FootFlow: tc.foot, HeadFlow: tc.head}
		if got := SailByte(&o); got != tc.want {
			t.Errorf("SailByte(%v, %v, %v) = %#02x, want %#02x", tc.flat, tc.foot, tc.head, got, tc.want)
		}
	}
}
