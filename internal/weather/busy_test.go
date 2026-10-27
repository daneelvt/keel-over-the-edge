// SPDX-License-Identifier: AGPL-3.0-only

package weather

import (
	"fmt"
	"math"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The weather is busy: opened at any minute of a week after its opening,
// the chart has weather on it. Each minute the systems on the disk are
// counted, any part of them within the lip, from their records as the
// keyframes have them, with the fronts crossing it.

// busyTally is the weeks' minutes after their openings: how many, and of
// them how many had nothing on the disk, rain on it, a storm or a low, a
// storm, a front or a trough; the systems on the disk summed over the
// minutes; and the same by the regime in effect.
type busyTally struct {
	minutes, empty, rain, lows, storms, lines int
	systems                                   int
	byRegime                                  []busyRegime
}

// busyRegime is a regime's minutes, and the systems on the disk over them.
type busyRegime struct{ minutes, empty, systems int }

// The weather's targets: the shares of the minutes, %, and the systems on
// the disk at once on average, over the week and in a frontal spell.
const (
	busyRain    = 95
	busyLows    = 70
	busyStorms  = 40
	busyLines   = 50
	busyMean    = 5
	busyFrontal = 8
)

// busyKinds are what the tally knows of each kind: whether it rains, is a
// low, the week's storm or a trough.
type busyKind struct{ rain, low, storm, trough bool }

func busyKindsOf(cat *catalog.Catalog, cfg *Config) []busyKind {
	out := make([]busyKind, len(cfg.Kinds))
	for i, k := range cat.Weather.Systems {
		out[i] = busyKind{
			rain:   k.Rain.Rate > 0,
			low:    cfg.Kinds[i].Shape == physics.ShapeLow,
			storm:  i == cfg.Week.Storms,
			trough: k.Symbol == catalog.SystemKindSymbolDashed,
		}
	}
	return out
}

// checkBusy tallies a week's minutes from its opening to its end.
func checkBusy(cfg *Config, kinds []busyKind, w *Week, b *busyTally) {
	p := cfg.Prepared
	edge := p.Edge()
	reach := p.FrontReach()
	if b.byRegime == nil {
		b.byRegime = make([]busyRegime, len(cfg.Regimes))
	}
	ends := TicksOf(w.Epoch, w.Ends)
	first := 0
	spell := 0
	for tick := cfg.Week.Opening; tick < ends; tick += ticksPerMinute {
		for spell+1 < len(w.Spells) && w.Spells[spell+1].Begin <= float64(tick) {
			spell++
		}
		for first < len(w.Systems) && w.Systems[first].Born < float64(tick)-float64(4*hourTicks) {
			first++
		}
		front := false
		for _, s := range w.Spells[max(spell-1, 0) : spell+1] {
			if s.Front != 0 && s.Change > 0 && float64(tick) >= s.Begin && float64(tick) <= s.Begin+s.Change {
				line := 2*reach*(float64(tick)-s.Begin)/s.Change - reach
				front = front || math.Abs(line) < edge
			}
		}
		n := 0
		var rain, low, storm, trough bool
		for i := first; i < len(w.Systems) && w.Systems[i].Born <= float64(tick); i++ {
			s := physics.SystemAt(&w.Systems[i].SystemRecord, float64(tick))
			if s.On == 0 || !OnDisk(&s, edge) {
				continue
			}
			n++
			k := kinds[int(s.Kind)]
			rain = rain || k.rain
			low = low || k.low
			storm = storm || k.storm
			trough = trough || k.trough
		}
		r := &b.byRegime[int(w.Spells[spell].Regime)]
		b.minutes++
		r.minutes++
		b.systems += n
		r.systems += n
		if n == 0 && !front {
			b.empty++
			r.empty++
		}
		if rain || front {
			b.rain++
		}
		if low {
			b.lows++
		}
		if storm {
			b.storms++
		}
		if trough || front {
			b.lines++
		}
	}
}

// failures are the targets the weeks missed.
func (b *busyTally) failures(cat *catalog.Catalog, cfg *Config) []string {
	var out []string
	if b.empty > 0 {
		out = append(out, fmt.Sprintf("nothing on the disk for %d minutes", b.empty))
	}
	for _, c := range []struct {
		name   string
		n, pct int
	}{{"rain", b.rain, busyRain}, {"a storm or a low", b.lows, busyLows}, {"a storm", b.storms, busyStorms}, {"a front or a trough", b.lines, busyLines}} {
		if s := share(c.n, b.minutes); s < float64(c.pct) {
			out = append(out, fmt.Sprintf("%s on the disk %.1f%% of the time, under %d%%", c.name, s, c.pct))
		}
	}
	if m := float64(b.systems) / float64(b.minutes); m < busyMean {
		out = append(out, fmt.Sprintf("%.1f systems on the disk on average, under %d", m, busyMean))
	}
	for i, r := range b.byRegime {
		if m := float64(r.systems) / float64(max(r.minutes, 1)); cfg.Regimes[i].Frontal && r.minutes > 0 && m < busyFrontal {
			out = append(out, fmt.Sprintf("%.1f systems on the disk on average in %s spells, under %d", m, cat.Weather.Regimes[i].ID, busyFrontal))
		}
	}
	return out
}

func (b *busyTally) markdown(cat *catalog.Catalog) string {
	var s strings.Builder
	s.WriteString("\nThe weather on the disk, each minute after the opening.\n\n| | Share of the time |\n|---|---|\n")
	fmt.Fprintf(&s, "| Nothing on the disk | %.2f%% |\n| Rain somewhere | %.1f%% |\n| A storm or a low | %.1f%% |\n| A storm | %.1f%% |\n| A front or a trough | %.1f%% |\n",
		share(b.empty, b.minutes), share(b.rain, b.minutes), share(b.lows, b.minutes), share(b.storms, b.minutes), share(b.lines, b.minutes))
	fmt.Fprintf(&s, "\nSystems on the disk at once on average: %.1f.\n\n| Regime | Its minutes | Nothing on the disk | Systems on average |\n|---|---|---|---|\n", float64(b.systems)/float64(max(b.minutes, 1)))
	for i, r := range b.byRegime {
		fmt.Fprintf(&s, "| %s | %d | %.2f%% | %.1f |\n", cat.Weather.Regimes[i].ID, r.minutes, share(r.empty, r.minutes), float64(r.systems)/float64(max(r.minutes, 1)))
	}
	return s.String()
}
