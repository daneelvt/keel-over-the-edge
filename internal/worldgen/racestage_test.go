// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"fmt"
	"math"
	"os"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/race/committee"
)

// firstLegOff is how far off a wind from from, rad, a laid island course's
// first leg lies: its way's first 500 m from its start, or to where it
// first crosses a rounding ray if sooner, degrees.
func firstLegOff(c *bus.RaceCourse, from float64) float64 {
	first := min(c.Length, 500)
	for _, ch := range c.Checks[1:] {
		if !ch.Line {
			first = min(first, ch.Along)
			break
		}
	}
	x, y := c.Way[0][0], c.Way[0][1]
	along := 0.0
	for i := 1; i < len(c.Way); i++ {
		a, b := c.Way[i-1], c.Way[i]
		seg := math.Hypot(b[0]-a[0], b[1]-a[1])
		if along+seg >= first {
			t := (first - along) / seg
			x, y = a[0]+t*(b[0]-a[0]), a[1]+t*(b[1]-a[1])
			break
		}
		along += seg
		x, y = b[0], b[1]
	}
	b := math.Atan2(x-c.Way[0][0], y-c.Way[0][1])
	return math.Abs(math.Remainder(b-from, 2*math.Pi)) * 180 / math.Pi
}

// winds are n directions the wind may come from, rad.
func winds(n int) []float64 {
	out := make([]float64, n)
	for i := range out {
		out[i] = float64(i) * 2 * math.Pi / float64(n)
	}
	return out
}

// TestIslandRacesStartWhereTheWindIsKind: in seed 1's world, an island
// race from Port Royal is laid, in each of eight winds, with its first leg
// no closer than 70° to the wind, or marked upwind; a start it was moved
// to lies within the racing areas' reach of Port Royal, out of its harbour
// and clear of its mouth; the course is the way from there, its length and
// expected time worked out afresh. A trial on the same course is laid as
// made, and a race on a course from another port is only marked.
func TestIslandRacesStartWhereTheWindIsKind(t *testing.T) {
	if testing.Short() {
		t.Skip("makes seed 1's world")
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	b, err := Generate(1, cat)
	if err != nil {
		t.Fatal(err)
	}
	st := b.RaceStage(cat)
	port := b.MainPort()
	h, hasHarbour := b.Harbour()
	within := cat.World.Courses.Areas.Within * nauticalMile
	jolly := uint16(0)
	home, moved, upwind := 0, 0, 0
	for _, ic := range st.Courses {
		if !ic.Home {
			continue
		}
		home++
		for _, m := range append(append([]committee.Move{}, ic.Moves...), ic.BackMoves...) {
			s := m.Site
			if d := math.Hypot(s.X-port.X, s.Y-port.Y); d > within+1e-6 {
				t.Errorf("course %d: a start %.0f m from Port Royal", ic.Number, d)
			}
			if hasHarbour && (physics.InHarbour(&h, s.X, s.Y) || math.Hypot(s.X-h.MouthX, s.Y-h.MouthY) < cat.World.Courses.Areas.Mouth) {
				t.Errorf("course %d: a start at (%.0f, %.0f), in the harbour or its mouth", ic.Number, s.X, s.Y)
			}
		}
		for _, from := range winds(8) {
			call := &bus.RaceCall{Island: true, Course: ic.Number, Kind: jolly}
			c := st.Lay(bus.NewFrame(4), call, 6, from, 4)
			asMade := st.Lay(bus.NewFrame(4), &bus.RaceCall{Island: true, Course: ic.Number, Kind: jolly, Trial: true}, 6, from, 4)
			if asMade.Upwind || asMade.Way[0] != ic.Way[0] {
				t.Errorf("course %d: a trial laid other than as made", ic.Number)
			}
			off := firstLegOff(c, from)
			switch {
			case c.Upwind:
				upwind++
				if firstLegOff(asMade, from) >= 70 {
					t.Errorf("course %d in a wind from %.0f°: marked upwind, made %.0f° off", ic.Number, from*180/math.Pi, firstLegOff(asMade, from))
				}
			case off < 70:
				t.Errorf("course %d in a wind from %.0f°: its first leg %.0f° off the wind, unmarked", ic.Number, from*180/math.Pi, off)
			}
			if c.Way[0] != asMade.Way[0] || c.Way[len(c.Way)-1] != asMade.Way[len(asMade.Way)-1] {
				moved++
				length := 0.0
				for i := 1; i < len(c.Way); i++ {
					length += math.Hypot(c.Way[i][0]-c.Way[i-1][0], c.Way[i][1]-c.Way[i-1][1])
				}
				if math.Abs(length-c.Length) > 1 || !(c.Expected > 0) || c.Expected == asMade.Expected {
					t.Errorf("course %d: moved, its length %.0f of %.0f, expected %.0f s (as made %.0f)", ic.Number, c.Length, length,
						c.Expected, asMade.Expected)
				}
			}
		}
	}
	for _, ic := range st.Courses {
		if ic.Home || len(ic.Way) < 2 {
			continue
		}
		for _, from := range winds(8) {
			c := st.Lay(bus.NewFrame(4), &bus.RaceCall{Island: true, Course: ic.Number, Kind: jolly}, 6, from, 4)
			if c.Way[0] != ic.Way[0] {
				t.Errorf("course %d from another port: its start moved", ic.Number)
			}
		}
	}
	if home == 0 || moved == 0 {
		t.Errorf("%d courses from Port Royal, %d races laid off them other than as made", home, moved)
	}
	t.Logf("%d courses from Port Royal in 8 winds: %d laid other than as made, %d still upwind", home, moved, upwind)
}

// TestIslandStartsTally lays every island race from Port Royal in sixteen
// winds in each world of seeds 1 to 8, and prints how often its first leg
// is upwind as made, and still upwind after the committee's tries: with
// KEEL_ISLAND_STARTS=1.
func TestIslandStartsTally(t *testing.T) {
	if os.Getenv("KEEL_ISLAND_STARTS") == "" {
		t.Skip("set KEEL_ISLAND_STARTS=1 to make eight worlds and print the table")
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	var table strings.Builder
	total, made, still := 0, 0, 0
	for seed := uint64(1); seed <= 8; seed++ {
		b, err := Generate(seed, cat)
		if err != nil {
			t.Fatal(err)
		}
		st := b.RaceStage(cat)
		n, m, s := 0, 0, 0
		for _, ic := range st.Courses {
			if !ic.Home {
				continue
			}
			for _, from := range winds(16) {
				asMade := st.Lay(bus.NewFrame(4), &bus.RaceCall{Island: true, Course: ic.Number, Trial: true}, 6, from, 4)
				c := st.Lay(bus.NewFrame(4), &bus.RaceCall{Island: true, Course: ic.Number}, 6, from, 4)
				n++
				if firstLegOff(asMade, from) < 70 {
					m++
				}
				if c.Upwind {
					s++
				}
			}
		}
		total, made, still = total+n, made+m, still+s
		fmt.Fprintf(&table, "seed %d: %3d races (courses from Port Royal × 16 winds): upwind as made %3d (%2.0f%%), after the tries %3d (%2.0f%%)\n",
			seed, n, m, percent(m, n), s, percent(s, n))
	}
	fmt.Fprintf(&table, "all:    %3d races: upwind as made %3d (%2.0f%%), after the tries %3d (%2.0f%%)\n", total, made, percent(made, total), still,
		percent(still, total))
	t.Logf("island races from Port Royal:\n%s", table.String())
}

// percent is a of b in hundredths.
func percent(a, b int) float64 {
	if b == 0 {
		return 0
	}
	return 100 * float64(a) / float64(b)
}
