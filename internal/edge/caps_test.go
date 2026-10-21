// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"math"
	"slices"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// An island's cap is sent once the eye is within its sight, dropped beyond
// it and the margin, and never sent to an eye beyond.
func TestCapsBySight(t *testing.T) {
	h := NewHandout(madeGround(testIslands), testPaths(), testRule(t))
	near := &pb.IslandCap{Number: 2, East: 5000, North: 0, Width: 900}
	far := &pb.IslandCap{Number: 5, East: -9000, North: 0, Width: 2000}
	h.SetCaps(NewCaps([]*pb.IslandCap{near, far}, []float64{2000, 3000}, 200))
	c := handoutConn(h)
	shown := false
	var events []string
	for _, x := range []float64{-200, 2900, 3001, 3100, 5000, 7000, 7150, 7250, 7000, 5000} {
		c.handout.looked = false // look every time
		c.chunks(h, x, 0)
		for _, m := range sent(t, c) {
			l := m.GetIslandCaps()
			if l == nil {
				continue
			}
			for _, got := range l.Caps {
				if got.Number != 2 || shown {
					t.Errorf("at %v: island %d sent while shown", x, got.Number)
				}
				shown = true
				events = append(events, "sent")
			}
			for _, n := range l.Drop {
				if n != 2 || !shown {
					t.Errorf("at %v: island %d dropped while not shown", x, n)
				}
				shown = false
				events = append(events, "dropped")
			}
		}
		d := math.Abs(x - 5000)
		switch {
		case d <= 2000 && !shown:
			t.Errorf("at %v m from the island, within its cap's sight, it is not sent", d)
		case d > 2200 && shown:
			t.Errorf("at %v m from the island, beyond its cap's sight and the margin, it is still shown", d)
		}
	}
	if !slices.Equal(events, []string{"sent", "dropped", "sent"}) {
		t.Errorf("the island was %v", events)
	}
}
