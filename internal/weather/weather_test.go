// SPDX-License-Identifier: AGPL-3.0-only

package weather

import (
	"math/rand/v2"
	"slices"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

func load(t testing.TB) (*catalog.Catalog, *Timeline) {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	tl, err := FromCatalog(cat)
	if err != nil {
		t.Fatal(err)
	}
	return cat, tl
}

// spells is the spells in play at a tick.
func spells(tl *Timeline, tick int64, ws []bus.Weather) []physics.Spell {
	var s [physics.WeatherSpells]physics.Spell
	n := tl.Spells(tick, ws, &s)
	return slices.Clone(s[:n])
}

// The same tick gives the same spells, from a fresh start and after any
// history of ticks asked about: the timeline remembers only to save time.
func TestSpellsAreAFunctionOfTheTick(t *testing.T) {
	_, walked := load(t)
	rng := rand.New(rand.NewPCG(1, 2))
	for range 300 {
		tick := rng.Int64N(40*tl20h) - 5*tl20h
		_, fresh := load(t)
		if a, b := spells(fresh, tick, nil), spells(walked, tick, nil); !slices.Equal(a, b) {
			t.Fatalf("tick %d: a fresh timeline gives %+v, one that has walked %+v", tick, a, b)
		}
	}
}

const (
	tl20h = 20 * hourTicks
	deg   = turn / 360.0
)

// Over a thousand turns of the sequence each regime has the catalog's share
// of the time; every spell begins where the one before ends, with numbers
// in its regime's ranges; and the wind veers by 40–90° as a spell of a
// frontal regime arrives or leaves, and moves by at most 30° either way
// between other spells.
func TestSequence(t *testing.T) {
	cat, tl := load(t)
	if tl.cycle != tl20h {
		t.Fatalf("the sequence takes %d ticks", tl.cycle)
	}
	cycles := int64(1000)
	if testing.Short() {
		cycles = 100
	}
	ticks := make([]int64, len(cat.Weather.Regimes))
	n := cycles * int64(len(tl.spells))
	prev := tl.seqSpell(-1)
	for i := range n {
		s := tl.seqSpell(i)
		r := int(s.Regime)
		ticks[r] += int64(s.Length)
		if s.Begin != prev.Begin+prev.Length || s.Start != s.Begin || s.Change != float64(tl.change) {
			t.Fatalf("spell %d begins at %v, the one before at %v for %v", i, s.Begin, prev.Begin, prev.Length)
		}
		w := cat.Weather.Regimes[r].Wind
		knots := s.Speed * physics.SeaSpeedStep / (1852.0 / 3600)
		if knots < w.Speed[0]-0.01 || knots > w.Speed[1]+0.01 || s.Gust != float64(int(w.GustFactor*1000+0.5)) {
			t.Fatalf("spell %d of %s: %.2f knots, gust factor %v", i, cat.Weather.Regimes[r].ID, knots, s.Gust)
		}
		// The direction at the start, from the direction at the end of the
		// spell before.
		turned := wrap(int32(s.From) - wrap(int32(prev.From)+int32(prev.Drift)))
		if turned > turn/2 {
			turned -= turn
		}
		d := float64(turned) / deg
		if tl.frontal[r] || tl.frontal[int(prev.Regime)] {
			if d < 39.99 || d > 90.01 {
				t.Fatalf("spell %d, %s after %s: the wind turns %.2f°, not a veer of 40–90°", i, cat.Weather.Regimes[r].ID, cat.Weather.Regimes[int(prev.Regime)].ID, d)
			}
		} else if d < -30.01 || d > 30.01 {
			t.Fatalf("spell %d, %s after %s: the wind turns %.2f°, more than 30°", i, cat.Weather.Regimes[r].ID, cat.Weather.Regimes[int(prev.Regime)].ID, d)
		}
		prev = s
	}
	for r, reg := range cat.Weather.Regimes {
		share := float64(ticks[r]) / float64(cycles*tl.cycle)
		if share < reg.Share-0.05 || share > reg.Share+0.05 {
			t.Errorf("%s has %.1f%% of the time, its share is %.0f%%", reg.ID, 100*share, 100*reg.Share)
		}
	}
	// Each spell may follow the one before it.
	for i := range tl.spells {
		from, to := cat.Weather.Regimes[tl.spells[i].Regime], cat.Weather.Regimes[tl.spells[(i+1)%len(tl.spells)].Regime]
		if !slices.Contains(from.Next, to.ID) {
			t.Errorf("a %s spell gives way to a %s one", from.ID, to.ID)
		}
	}
}

// A spell is in play from ten seconds before its change begins, never
// earlier, and the one before it until ten seconds after the change has
// ended: a client holds what it needs and nothing of what is to come.
func TestSpellsInPlay(t *testing.T) {
	_, tl := load(t)
	// The second spell of the sequence's fourth turn.
	next := tl.seqSpell(3*int64(len(tl.spells)) + 1)
	begin, change := int64(next.Begin), tl.change
	cur := tl.seqSpell(3 * int64(len(tl.spells)))
	for _, c := range []struct {
		tick int64
		want []physics.Spell
	}{
		{begin - Announce - 1, []physics.Spell{cur}},
		{begin - Announce, []physics.Spell{cur, next}},
		{begin - 1, []physics.Spell{cur, next}},
		{begin, []physics.Spell{cur, next}},
		{begin + change/2, []physics.Spell{cur, next}},
		{begin + change + Grace - 1, []physics.Spell{cur, next}},
		{begin + change + Grace, []physics.Spell{next}},
	} {
		if got := spells(tl, c.tick, nil); !slices.Equal(got, c.want) {
			t.Errorf("%d ticks from the change: %d spells in play beginning %v, want %d", c.tick-begin, len(got), begins(got), len(c.want))
		}
	}
	if n := testing.AllocsPerRun(100, func() {
		var s [physics.WeatherSpells]physics.Spell
		tl.Spells(begin+5, nil, &s)
	}); n != 0 {
		t.Errorf("the spells in play allocate %v times", n)
	}
}

func begins(s []physics.Spell) []float64 {
	out := make([]float64, len(s))
	for i := range s {
		out[i] = s[i].Begin
	}
	return out
}

// A developer's weather takes effect from the second after next: a steady
// wind, a regime held as one endless spell, or the world's own again, each
// at once, with the spell before kept in play for those replaying.
func TestDevelopersWeather(t *testing.T) {
	cat, tl := load(t)
	const tick = 1_000_007
	from := int64(1_000_050)
	var ws []bus.Weather
	ws = tl.Set(ws, Steady(6.17, 1.5708), tick)
	if len(ws) != 1 || ws[0].From != from || ws[0].Mode != bus.WeatherSteady || ws[0].Speed != 617 || ws[0].Dir != 16384 {
		t.Fatalf("a steady wind set at tick %d: %+v", tick, ws)
	}
	own := tl.Effective(tick, nil)
	got := spells(tl, tick, ws)
	if len(got) != 2 || got[0] != own || got[1].Begin != float64(from) || got[1].Steady != 1 || got[1].Change != 0 {
		t.Fatalf("at the tick it is set: %+v", got)
	}
	if got := spells(tl, from+Grace, ws); len(got) != 1 || got[0].Steady != 1 {
		t.Fatalf("ten seconds after it blows: %+v", got)
	}
	// Set again in the same second: the later replaces the earlier.
	ws = tl.Set(ws, bus.Weather{Mode: bus.WeatherHeld, Regime: 3}, tick+5)
	if len(ws) != 1 || ws[0].Mode != bus.WeatherHeld {
		t.Fatalf("set twice in a second: %+v", ws)
	}
	held := tl.Effective(from, ws)
	w := cat.Weather.Regimes[3].Wind
	if held.Regime != 3 || held.Steady != 0 || held.Begin != float64(from) || held.Start != float64(from) || held.Length != 0 || held.Drift != 0 ||
		held.Gust != float64(int(w.GustFactor*1000+0.5)) || held.Shift[0] == 0 {
		t.Fatalf("a regime held: %+v", held)
	}
	if again := tl.Effective(from+50*hourTicks, ws); again != held {
		t.Fatalf("fifty hours on the held spell is %+v", again)
	}
	// The world's own again, from a later second: the sequence's spell,
	// taking over at once.
	later := from + 9000
	ws = tl.Set(ws, bus.Weather{Mode: bus.WeatherAuto}, later-45)
	back := tl.Effective(later, ws)
	seq := tl.Effective(later, nil)
	seq.Begin, seq.Change = float64(later), 0
	if len(ws) != 2 || ws[1].From != later || back != seq {
		t.Fatalf("the world's own again: %+v, the sequence's %+v", back, seq)
	}
	// And its next spell is announced as ever.
	nextBegin, _ := tl.ownAfter(later)
	if got := spells(tl, nextBegin-Announce, ws); len(got) != 2 || got[1].Begin != float64(nextBegin) || got[1].Change != float64(tl.change) {
		t.Fatalf("the next spell of the sequence: %+v", got)
	}
	// Weathers that gave way long ago are dropped, and never more than the
	// frame holds are kept.
	ws = tl.Set(ws, Steady(3, 0), later+tl.Keep()+60)
	if len(ws) != 2 || ws[0].Mode != bus.WeatherAuto {
		t.Fatalf("a weather that gave way more than %d ticks ago is kept: %+v", tl.Keep(), ws)
	}
	for i := range 20 {
		ws = tl.Set(ws, Steady(float64(i), 0), later+tl.Keep()+100+int64(i)*40)
	}
	if len(ws) != bus.WeatherHistory {
		t.Fatalf("%d developer's weathers kept", len(ws))
	}
	if n := len(spells(tl, ws[len(ws)-1].From, ws)); n != physics.WeatherSpells {
		t.Fatalf("%d spells in play after changes a second apart", n)
	}
}

// A world given one spell for ever has that spell, whatever the tick, and
// a developer's weather over it.
func TestFixed(t *testing.T) {
	s := physics.SteadySpell(5.14, 0, 0)
	tl := Fixed(s)
	for _, tick := range []int64{-5, 0, 1 << 40} {
		if got := spells(tl, tick, nil); len(got) != 1 || got[0] != s {
			t.Fatalf("tick %d: %+v", tick, got)
		}
	}
	ws := tl.Set(nil, Steady(10, 1), 95)
	if got := spells(tl, 100, ws); len(got) != 2 || got[0] != s || got[1].Begin != 150 || got[1].Speed != 1000 {
		t.Fatalf("a steady wind over a fixed spell: %+v", got)
	}
	ws = tl.Set(ws, bus.Weather{Mode: bus.WeatherAuto}, 400)
	if got := tl.Effective(460, ws); got.Speed != s.Speed || got.Begin != 450 {
		t.Fatalf("the world's own again: %+v", got)
	}
}
