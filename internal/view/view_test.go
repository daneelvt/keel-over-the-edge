// SPDX-License-Identifier: AGPL-3.0-only

package view

import "testing"

func TestNearestKeepsTheNearest(t *testing.T) {
	for n := range 200 {
		cs := make([]Candidate, n)
		for i := range cs {
			cs[i] = Candidate{Slot: int32(i), D2: float64((i * 7919) % 97)}
		}
		k := min(n, Slots)
		Nearest(cs, k)
		worst := -1.0
		for _, c := range cs[:k] {
			worst = max(worst, c.D2)
		}
		for _, c := range cs[k:] {
			if c.D2 < worst {
				t.Fatalf("%d candidates: %v left out while %v kept", n, c.D2, worst)
			}
		}
	}
}
