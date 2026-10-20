// SPDX-License-Identifier: AGPL-3.0-only

package weather

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"slices"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

var update = flag.Bool("update", false, "write testdata/weeks.json again")

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

const (
	deg = turn / 360.0
	day = 24 * 3600 * int64(1_000_000)
)

// testIslands are islands for the showers to form over: Port Royal's and
// two others.
var testIslands = []Island{{X: -36, Y: 71, Area: 2.4e6, Across: 2000}, {X: 4000, Y: -2500, Area: 6e5, Across: 900}, {X: -3000, Y: 3500, Area: 3e5, Across: 700}}

// A week is a function of the seed, the epoch, the end and the islands:
// made twice it is the same bytes, and another seed makes another.
func TestWeekIsAFunctionOfItsInputs(t *testing.T) {
	_, tl := load(t)
	cfg := tl.Config()
	a, _, err := Generate(cfg, 7, SampleEpoch, SampleEpoch+SampleWeek, testIslands).Encode()
	if err != nil {
		t.Fatal(err)
	}
	b, _, _ := Generate(cfg, 7, SampleEpoch, SampleEpoch+SampleWeek, testIslands).Encode()
	if !bytes.Equal(a, b) {
		t.Fatal("the same seed made two weeks")
	}
	c, _, _ := Generate(cfg, 8, SampleEpoch, SampleEpoch+SampleWeek, testIslands).Encode()
	if bytes.Equal(a, c) {
		t.Fatal("two seeds made one week")
	}
}

// A week stored reads back as it was, and a week whose bytes do not match
// its digest is refused.
func TestWeekStored(t *testing.T) {
	_, tl := load(t)
	w := Generate(tl.Config(), 3, SampleEpoch, SampleEpoch+SampleWeek, testIslands)
	b, sum, err := w.Encode()
	if err != nil {
		t.Fatal(err)
	}
	back, err := Decode(b, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(back.Spells, w.Spells) || !slices.Equal(back.Systems, w.Systems) || back.Epoch != w.Epoch || back.Until != w.Until {
		t.Fatal("the week read back differs")
	}
	b2, _, _ := back.Encode()
	if !bytes.Equal(b, b2) {
		t.Fatal("the week read back encodes to other bytes")
	}
	b[len(b)/2] ^= 1
	if _, err := Decode(b, sum[:]); err == nil {
		t.Fatal("a week that does not match its digest was read")
	}
}

type weeksFile struct {
	Comment string            `json:"comment"`
	Version int               `json:"version"`
	Epoch   int64             `json:"epoch"`
	Ends    int64             `json:"ends"`
	Digests map[string]string `json:"digests"`
}

// Seeds 1–8 make the weeks they made when testdata/weeks.json was written,
// for the sample epoch: a change that moves any is a new version.
func TestWeekDigests(t *testing.T) {
	_, tl := load(t)
	got := weeksFile{
		Comment: "Written by go test ./internal/weather -run WeekDigests -update: the SHA-256 of seeds 1–8's weeks, as stored, for a week from epoch to ends (µs of UTC), with testIslands.",
		Version: Version, Epoch: SampleEpoch, Ends: SampleEpoch + SampleWeek, Digests: map[string]string{},
	}
	for seed := uint64(1); seed <= 8; seed++ {
		_, sum, err := Generate(tl.Config(), seed, got.Epoch, got.Ends, testIslands).Encode()
		if err != nil {
			t.Fatal(err)
		}
		got.Digests[fmt.Sprint(seed)] = hex.EncodeToString(sum[:])
	}
	const path = "testdata/weeks.json"
	if *update {
		data, _ := json.MarshalIndent(got, "", "  ")
		if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var want weeksFile
	if err := json.Unmarshal(data, &want); err != nil {
		t.Fatal(err)
	}
	if want.Version != Version {
		t.Fatalf("weeks.json is of version %d, the generator %d: write it again with -update", want.Version, Version)
	}
	for seed, d := range got.Digests {
		if want.Digests[seed] != d {
			t.Errorf("seed %s's week is %s, weeks.json has %s: raise weather.Version if the change is meant", seed, d, want.Digests[seed])
		}
	}
}

// Worlds of a day and of eight days are covered, with a day to spare, and
// open and close as a week should.
func TestWeekCovers(t *testing.T) {
	_, tl := load(t)
	for _, days := range []int64{1, 8} {
		w := Generate(tl.Config(), 11, SampleEpoch, SampleEpoch+days*day, testIslands)
		last := w.Spells[len(w.Spells)-1]
		end := TicksOf(SampleEpoch, SampleEpoch+days*day)
		if w.Until < end+24*hourTicks || int64(last.Begin+last.Length) < w.Until {
			t.Errorf("a world of %d days: the week reaches tick %d, its spells %v; the world ends at %d", days, w.Until, last.Begin+last.Length, end)
		}
		if !w.Report.Passed {
			t.Errorf("a world of %d days failed %v", days, w.Report.Failed)
		}
	}
}

// A spell is in play from ten seconds before its change begins, never
// earlier, and the one before it until ten seconds after the change has
// ended: for a front, until ten seconds after its line has left the disk's
// reach. A client holds what it needs and nothing of what is to come.
func TestSpellsInPlay(t *testing.T) {
	_, tl := load(t)
	week := tl.Week()
	for _, front := range []bool{false, true} {
		i := slices.IndexFunc(week.Spells[1:], func(s physics.Spell) bool { return (s.Front != 0) == front }) + 1
		cur, next := week.Spells[i-1], week.Spells[i]
		begin, change := int64(next.Begin), int64(next.Change)
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
			got := spells(tl, c.tick, nil)
			// Ask only about the two spells: another may be announced near
			// the end of a short one.
			if len(got) < len(c.want) || !slices.Equal(got[:len(c.want)], c.want) && !slices.Equal(got[len(got)-len(c.want):], c.want) {
				t.Errorf("front %v: %d ticks from the change: spells beginning %v, want %d", front, c.tick-begin, begins(got), len(c.want))
			}
		}
	}
	if n := testing.AllocsPerRun(100, func() {
		var s [physics.WeatherSpells]physics.Spell
		tl.Spells(int64(week.Spells[3].Begin)+5, nil, &s)
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
// wind, a regime held as one endless spell, a front bringing one, or the
// world's own again, each at once, with the spell before kept in play for
// those replaying.
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
	if got[len(got)-1].Begin != float64(from) || got[len(got)-1].Steady != 1 || got[len(got)-2] != own {
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
		held.Gust != float64(int(w.GustFactor*1000+0.5)) || held.Shift[0] == 0 || held.Pressure == 0 {
		t.Fatalf("a regime held: %+v", held)
	}
	if again := tl.Effective(from+50*hourTicks, ws); again != held {
		t.Fatalf("fifty hours on the held spell is %+v", again)
	}
	// A front: the held spell behind a line crossing the disk, the spell
	// before in play until it has crossed.
	fws := tl.Set(nil, bus.Weather{Mode: bus.WeatherFront, Regime: 2}, tick)
	f := tl.Effective(from, fws)
	if f.Front != 1 || f.Change <= 0 || f.Trough <= 0 || f.Begin != float64(from) {
		t.Fatalf("a front: %+v", f)
	}
	if got := spells(tl, from+int64(f.Change)-1, fws); len(got) < 2 || got[len(got)-1] != f {
		t.Fatalf("while the front crosses: %+v", got)
	}
	// The world's own again, from a later second: the week's spell, taking
	// over at once.
	later := from + 9000
	ws = tl.Set(ws, bus.Weather{Mode: bus.WeatherAuto}, later-45)
	back := tl.Effective(later, ws)
	seq := tl.Effective(later, nil)
	seq.Begin, seq.Change = float64(later), 0
	if len(ws) != 2 || ws[1].From != later || back != seq {
		t.Fatalf("the world's own again: %+v, the week's %+v", back, seq)
	}
	// And its next spell is announced as ever.
	nextBegin, _ := tl.ownAfter(later)
	if got := spells(tl, nextBegin-Announce, ws); got[len(got)-1].Begin != float64(nextBegin) {
		t.Fatalf("the next spell of the week: %+v", got)
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
	var keys [bus.KeyFrames]physics.Keyframe
	tl.Keyframes(500, nil, &keys)
	for _, k := range keys {
		for _, s := range k.Systems {
			if s.On != 0 {
				t.Fatal("a fixed world has a system")
			}
		}
	}
}

// A keyframe holds the week's systems alive at its tick, each in its slot
// as SystemAt makes it; a held weather or a steady one has none.
func TestKeyframes(t *testing.T) {
	_, tl := load(t)
	week := tl.Week()
	s := week.Systems[len(week.Systems)/2]
	at := (int64(s.Mature) / tl.Every()) * tl.Every()
	var k physics.Keyframe
	tl.Keyframe(at, nil, &k)
	if got, want := k.Systems[s.Slot], physics.SystemAt(&s.SystemRecord, float64(at)); got != want {
		t.Fatalf("slot %d: %+v, SystemAt gives %+v", s.Slot, got, want)
	}
	alive := 0
	for _, x := range week.Systems {
		if x.Born <= float64(at) && float64(at) < x.Gone {
			alive++
		}
	}
	on := 0
	for _, x := range k.Systems {
		if x.On != 0 {
			on++
		}
	}
	if on != alive {
		t.Errorf("%d systems on at tick %d, %d alive", on, at, alive)
	}
	// A developer's weather stills the week's systems from the tick it
	// blows, and not before.
	for _, w := range []bus.Weather{{Mode: bus.WeatherHeld, Regime: 1}, Steady(5, 0), {Mode: bus.WeatherFront, Regime: 2}} {
		ws := tl.Set(nil, w, at-300)
		for _, c := range []struct {
			tick int64
			want bool
		}{{ws[0].From - 1, true}, {ws[0].From, false}, {at, false}} {
			pw := &physics.Weather{Prepared: tl.Prepared()}
			var sp [physics.WeatherSpells]physics.Spell
			pw.Set(sp[:tl.Spells(c.tick, ws, &sp)])
			var keys [bus.KeyFrames]physics.Keyframe
			tl.Keyframes(c.tick, nil, &keys)
			pw.SetKeys(keys[:2])
			var wt physics.WeatherTick
			physics.WeatherAt(pw, &wt, float64(c.tick))
			if got := physics.SystemsAt(&wt) > 0; got != c.want {
				t.Errorf("a developer's weather of mode %d set for tick %d: at tick %d systems blow: %v", w.Mode, ws[0].From, c.tick, got)
			}
		}
	}
}

// A developer's system placed to reach a point in five minutes reaches it
// within ten seconds of then, at its strongest, in a developer's slot.
func TestPlacedSystem(t *testing.T) {
	cat, tl := load(t)
	squall := uint16(KindIndex(cat, "squall"))
	const tick = 2_000_011
	in := uint32(5 * 60 * physics.StepsPerSecond)
	point := [2]int32{4 * 3000, 4 * -1500}
	ss := tl.Place(nil, bus.Weather{Mode: bus.WeatherSystem, Kind: squall, East: point[0], North: point[1], In: in}, tick, nil)
	if len(ss) != 1 || ss[0].Born%tl.Every() != 0 || ss[0].Born < tick {
		t.Fatalf("placed: %+v", ss)
	}
	r := tl.DeveloperRecord(ss[0])
	arrive := float64(tick) + float64(in)
	best := math.Inf(1)
	var bestAt float64
	for at := arrive - 600; at <= arrive+600; at += 30 {
		s := physics.SystemAt(&r, at)
		if d := math.Hypot(s.East-float64(point[0]), s.North-float64(point[1])) / 4; d < best {
			best, bestAt = d, at
		}
	}
	if math.Abs(bestAt-arrive) > 10*physics.StepsPerSecond || best > 5 {
		t.Errorf("it comes within %.1f m of its point %.0f s after the time asked", best, (bestAt-arrive)/physics.StepsPerSecond)
	}
	if s := physics.SystemAt(&r, arrive); s.Strength != 4096 {
		t.Errorf("at its point its strength is %v", s.Strength)
	}
	var k physics.Keyframe
	tl.Keyframe(int64(arrive)/tl.Every()*tl.Every(), ss, &k)
	if k.Systems[weekSlots].On == 0 {
		t.Error("the keyframe has not the developer's system in its slot")
	}
	for range 6 {
		ss = tl.Place(ss, bus.Weather{Mode: bus.WeatherSystem, Kind: squall, In: in}, tick+100, nil)
	}
	if len(ss) != bus.SystemSlots {
		t.Errorf("%d developer's systems kept", len(ss))
	}
	if ss = tl.Trim(ss, int64(arrive)+10*hourTicks); len(ss) != 0 {
		t.Errorf("%d systems kept long after they have gone", len(ss))
	}
}
