// SPDX-License-Identifier: AGPL-3.0-only

package weather

import (
	"math"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// A coming front is sent from when its cirrus can first be seen on the
// disk, no earlier, until its spell is announced, and it carries the line
// alone: its spell is not in play while it is coming.
func TestComingFront(t *testing.T) {
	cat, tl := load(t)
	p := tl.Prepared()
	dome := cat.World.Handout.Dome
	edge := cat.World.Disk.Radius
	sight := physics.CloudSight(dome, p.LayerHeight(physics.LayerCirrus))
	fronts := 0
	for i, s := range tl.week.Spells {
		if s.Front == 0 || i == 0 {
			continue
		}
		fronts++
		begin := int64(s.Begin)
		speed := 2 * p.FrontReach() / s.Change // m a tick
		first := int64(0)
		for tick := begin - 3*hourTicks; tick < begin; tick++ {
			c := tl.Coming(tick, nil)
			if c.On == 0 || c.Begin != s.Begin {
				// None, or an earlier front's.
				if first != 0 && tick < begin-Announce {
					t.Fatalf("front %d: the coming front went at tick %d, before its spell was announced", i, tick)
				}
				continue
			}
			if first == 0 {
				first = tick
			}
			if c.Change != s.Change || c.Toward != s.Toward {
				t.Fatalf("front %d: coming as %+v, its spell changes over %v, toward %v", i, c, s.Change, s.Toward)
			}
			for _, sp := range spells(tl, tick, nil) {
				if sp.Begin == s.Begin {
					t.Fatalf("front %d: its spell is in play at tick %d while it is coming", i, tick)
				}
			}
		}
		if first == 0 {
			t.Fatalf("front %d never comes", i)
		}
		// Its cirrus, which begins frontCirrus ahead of the line, reaches
		// as far beyond the lip as the cirrus is seen from it then, and not
		// a tick before.
		var w physics.Weather
		w.Prepared = p
		w.Set(spells(tl, first, nil))
		c := tl.Coming(first, nil)
		w.SetComing(&c)
		var at physics.WeatherTick
		line := speed*float64(first-begin) - p.FrontReach()
		lead := line + 3*1852 // where the cirrus begins
		if seen := -edge - sight; lead < seen-speed || lead > seen+speed {
			t.Errorf("front %d is sent with its cirrus beginning %.0f m along its way, seen from %.0f", i, lead, seen)
		}
		physics.WeatherAt(&w, &at, float64(first)+10*60*physics.StepsPerSecond)
		sin, cos := math.Sincos(float64(s.Toward) / physics.TurnSteps * 2 * math.Pi)
		far := -edge - sight + 1000
		if sh := physics.SheetAt(&at, sin*far, cos*far); !(sh.Cirrus > 0) {
			t.Errorf("front %d: ten minutes after it is sent its cirrus over the horizon covers %.3f", i, sh.Cirrus)
		}
	}
	if fronts < 3 {
		t.Errorf("only %d fronts in the week", fronts)
	}
	// A developer's held weather sends none.
	held := []bus.Weather{{From: 0, Mode: bus.WeatherHeld}}
	for i, s := range tl.week.Spells {
		if s.Front != 0 && i > 0 {
			if c := tl.Coming(int64(s.Begin)-11*physics.StepsPerSecond, held); c.On != 0 {
				t.Errorf("a front is coming under a developer's held weather")
			}
			break
		}
	}
}
