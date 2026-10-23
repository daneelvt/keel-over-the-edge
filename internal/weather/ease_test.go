// SPDX-License-Identifier: AGPL-3.0-only

package weather

import (
	"math/rand/v2"
	"os"
	"strconv"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// A change of spell with no front moves the barometer as a change of
// weather does, over its ease, never "very rapidly", which is a storm's
// fall or a front's rise (Met Office, Marine forecasts glossary: over 6 hPa
// in three hours, a quarter of an hour at the sky's pace). Over five
// weeks, or two hundred in the long run, at points over the disk each
// minute from a change's start until a quarter of an hour after its ease,
// the spells' own pressure, the systems aside, is read as the barometer
// reads it.
func TestPlainChangeIsNotRapid(t *testing.T) {
	_, tl := load(t)
	cfg := tl.Config()
	n := 5
	if v := os.Getenv("KEEL_WEEKS"); v != "" {
		if k, err := strconv.Atoi(v); err == nil && k >= 200 {
			n = 200
		}
	}
	p := tl.Prepared()
	ease := p.EaseTicks()
	const minute = 60 * physics.StepsPerSecond
	rng := rand.New(rand.NewPCG(3, 4))
	changes, readings, rapid := 0, 0, 0
	var spells [physics.WeatherSpells]physics.Spell
	w := physics.Weather{Prepared: p}
	var at physics.WeatherTick
	pressure := func(tick int64, x, y float64) float64 {
		n := tl.Spells(tick, nil, &spells)
		w.Set(spells[:n])
		physics.WeatherAt(&w, &at, float64(tick))
		return physics.PressureAt(&at, x, y)
	}
	for seed := uint64(1); seed <= uint64(n); seed++ {
		epoch := SampleEpoch + int64(seed%24)*3600*1_000_000
		wk := Generate(cfg, seed, epoch, epoch+SampleWeek, testIslands)
		wt, err := New(cfg, wk)
		if err != nil {
			t.Fatal(err)
		}
		tl = wt
		for i, s := range wk.Spells {
			if i == 0 || s.Front != 0 || !(s.Change > 0) {
				continue
			}
			changes++
			begin := int64(s.Begin)
			for range 8 {
				x, y := (2*rng.Float64()-1)*4.2*nauticalMile/1.5, (2*rng.Float64()-1)*4.2*nauticalMile/1.5
				for tick := begin; tick <= begin+ease+15*minute; tick += minute {
					words, _ := physics.Tendency(pressure(tick, x, y), pressure(tick-5*minute, x, y), pressure(tick-15*minute, x, y))
					readings++
					if words == physics.TendencyRapidly || words == -physics.TendencyRapidly {
						rapid++
					}
				}
			}
		}
	}
	if changes == 0 {
		t.Fatal("no change of spell without a front")
	}
	if rapid > 0 {
		t.Errorf("%d of %d readings over %d changes of spell with no front read very rapidly", rapid, readings, changes)
	}
	t.Logf("%d readings over %d changes of spell with no front, none very rapidly", readings, changes)
}
