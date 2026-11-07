// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/chart"
	sailorlooks "github.com/daneelvt/keel-over-the-edge/internal/looks"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sight"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/sky"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/view"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// The lookout report in seeded scenes of seed 1's world, ticked by hand:
// each report is held to a golden file, and none names what its boat's
// phone would not be sent, or a place not yet charted.

// seed1 is seed 1's world and its chart, made once.
var seed1 = sync.OnceValues(func() (*worldgen.Bundle, error) {
	cat, err := catalog.Load()
	if err != nil {
		return nil, err
	}
	return worldgen.Generate(1, cat)
})

// scene is a world to set a scene in: seed 1's land, its chart with only
// what is known from the start charted, a steady wind.
type scene struct {
	t    testing.TB
	cat  *catalog.Catalog
	w    *sim.World
	sea  *Sea
	core *Core
	cw   *chart.World
	next byte
}

func newScene(t testing.TB, knots, from float64) *scene {
	return newSceneOf(t, 64, knots, from)
}

// newSceneOf is a scene of capacity boats.
func newSceneOf(t testing.TB, capacity int, knots, from float64) *scene {
	t.Helper()
	if testing.Short() {
		t.Skip("makes a whole world")
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	b, err := seed1()
	if err != nil {
		t.Fatal(err)
	}
	waves, kinds := cat.Prepare()
	tl := weather.FixedIn(cat.PrepareWeather(), physics.SteadySpell(knots*nm/3600, from*math.Pi/180, 0))
	if knots < 0 {
		// The world's own weather, its gusts and shifts.
		if tl, err = weather.FromCatalog(cat); err != nil {
			t.Fatal(err)
		}
	}
	cw := chart.Build(b, cat)
	model := chart.NewModel(cw, cat, nil)
	var known []store.Charting
	for _, s := range cw.Known {
		sub := &cw.Subjects[s]
		known = append(known, store.Charting{Subject: chart.KindWord(sub.Kind), Number: sub.Number, At: time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)})
	}
	model.Add(known)
	sg := &sim.Sight{Table: cw.Table, Every: int64(cat.World.Chart.Sight.Every), Lookouts: cw.Lookouts,
		Sky: cat.PrepareSky(), Epoch: sceneEpoch.UnixMicro(), Night: cat.World.Lights.Threshold, Day: cat.World.Lights.DayThreshold}
	enc := cat.PrepareEncounters()
	terrain := b.Terrain(cat.PrepareGround())
	w, err := sim.New(sim.Config{Capacity: capacity, Kinds: kinds, Waves: waves, Weather: tl, Encounters: enc, Terrain: terrain, Sight: sg, Tick: 1000})
	if err != nil {
		t.Fatal(err)
	}
	w.SetCharted(cw.Known)
	t.Cleanup(w.Close)
	s := &Sea{Number: 1, Epoch: sceneEpoch, Bus: w.Bus(), Boats: cat.Boats, Limit: capacity, Timeline: tl, Waves: waves, Ground: terrain.Ground, Shelter: terrain.Shelter,
		Bundle: b, Chart: model, Sight: sg, Words: weather.WordsOf(cat), Catalog: cat, Kinds: kinds, Encounters: enc,
		Biomes: map[string]string{}, Sky: cat.PrepareSky(), Looks: sailorlooks.New(cat)}
	for _, is := range b.Islands {
		if is.Kind == worldgen.KindMain {
			s.Start = is.Name
			break
		}
	}
	for _, bm := range cat.World.Biomes {
		s.Biomes[string(bm.ID)] = strings.ReplaceAll(string(bm.ID), "-", " ")
	}
	for _, k := range cat.World.Places.Kinds {
		s.PlaceKinds = append(s.PlaceKinds, k.Name)
	}
	for _, k := range cat.World.Features.Kinds {
		s.FeatureKinds = append(s.FeatureKinds, k.Name)
	}
	copy(s.RainWords[:], cat.Weather.Clouds.RainWords)
	return &scene{t: t, cat: cat, w: w, sea: s, core: NewCore(CoreConfig{}), cw: cw}
}

// sceneEpoch is the scenes' world's epoch: its tick 1000 is by day at
// Port Royal.
var sceneEpoch = time.Date(2026, 11, 3, 11, 19, 30, 0, time.UTC)

// at sets the scene's epoch so that the sun stands at alt degrees at (x,
// y) on the world's tick now, rising or setting, to five seconds.
func (sc *scene) at(x, y, alt float64, rising bool) {
	sc.t.Helper()
	tick := float64(sc.w.Latest().Tick)
	sun := func(e time.Time) float64 {
		t := sky.Time(sc.sea.Sky, float64(e.UnixMicro()), float64(int64(tick*1e6/physics.StepsPerSecond)))
		return deg(sky.SunAltitude(sc.sea.Sky, t, x, y))
	}
	day := time.Duration(sc.sea.Sky.Day()) * time.Microsecond
	for e := sceneEpoch; e.Before(sceneEpoch.Add(day)); e = e.Add(5 * time.Second) {
		now, next := sun(e), sun(e.Add(5*time.Second))
		if (next > now) == rising && math.Abs(now-alt) < 0.3 {
			sc.sea.Epoch, sc.sea.Sight.Epoch = e, e.UnixMicro()
			return
		}
	}
	sc.t.Fatalf("the sun is never at %v° there", alt)
}

// boat puts a boat in the world at st, a machine sailor's or a human's,
// and returns its slot.
func (sc *scene) boat(st physics.State, machine bool) int32 {
	sc.t.Helper()
	sc.next++
	reply := make(chan bus.Reply, 1)
	dev := sc.w.Bus().Commands.Developer()
	look := sc.sea.Looks.Draw(uint64(sc.next))
	if machine {
		look = sc.sea.Looks.DrawMachine(uint64(sc.next))
	}
	dev.TrySend(bus.Command{Op: bus.Join, Account: bus.Account{0x01, 0x9a, sc.next}, Conn: uint64(sc.next), Machine: machine,
		Look: sc.sea.Looks.Code(look), Reply: reply})
	sc.w.Tick()
	r := <-reply
	dev.TrySend(bus.Command{Op: bus.Place, Boat: r.Boat, State: st})
	sc.w.Tick()
	return r.Slot
}

// sail ticks the world for d, every boat holding its controls.
func (sc *scene) sail(d time.Duration) {
	for range int(d.Seconds() * physics.StepsPerSecond) {
		sc.w.Tick()
	}
}

// steer sets a boat's controls: the autopilot on wind at angle degrees,
// positive on starboard, the boom let out to boom degrees.
func (sc *scene) steer(sl int32, angle, boom float64) {
	f := sc.w.Latest()
	seq := uint32(f.Tick + 1)
	sheet := sheetOf(&sc.cat.Boats[0], boom)
	sc.w.Bus().Controls.Store(sl, bus.Pack(seq, bus.Steps/2, sheet, f.Gen[sl]), bus.PackPilot(seq, bus.PilotWind, bus.WayHold, 0, turnTarget(angle), f.Gen[sl]), bus.PackRig(seq, 0, f.Gen[sl]))
}

// report is the full report of the machine sailor's boat in slot sl.
func (sc *scene) report(sl int32) (string, *report) { return sc.reportOf(sl, detailFull) }

// reportOf is the report of the machine sailor's boat in slot sl, in
// detail.
func (sc *scene) reportOf(sl int32, detail string) (string, *report) {
	f := sc.w.Bus().Frames.Acquire()
	defer f.Release()
	h := sc.core.helmOf(sailor(byte(sl)+1, "Iron Mary"))
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sea, h.slot, h.boat = sc.sea, sl, f.Boat[sl]
	r := h.reportFor(sc.sea, f, sl, detail, 0)
	return r.text(), r
}

// golden holds text to testdata/scenes/name.txt, its size in its first
// line.
func golden(t *testing.T, name, text string) {
	t.Helper()
	path := filepath.Join("testdata", "scenes", name+".txt")
	got := fmt.Sprintf("# about %d tokens\n%s\n", estimateTokens(text), text)
	if *update {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != string(want) {
		t.Errorf("the %s report differs from %s:\n%s", name, path, got)
	}
}

// parity checks that the report of the boat in slot sl names nothing its
// phone would not be sent: no boat out of its view, none the owner's
// tools keep unseen, and no subject not yet charted by name.
func (sc *scene) parity(sl int32, text string) {
	sc.t.Helper()
	f := sc.w.Latest()
	st := &f.State[sl]
	cands := view.Candidates(f, sl, st.X, st.Y, nil, nil)
	viewed := 0
	for _, c := range cands {
		if !f.Unseen[c.Slot] {
			viewed++
		}
	}
	contacts := strings.Count(text, "\n B")
	if more := strings.Index(text, "and "); more >= 0 {
		var n int
		fmt.Sscanf(text[more:], "and %d more boats", &n)
		contacts += n
	}
	if contacts > viewed {
		sc.t.Errorf("the report tells of %d boats, the phone is sent %d:\n%s", contacts, viewed, text)
	}
	charted := map[int32]bool{}
	for _, s := range sc.sea.Chart.Charted() {
		charted[s] = true
	}
	for i, sub := range sc.cw.Subjects {
		if charted[int32(i)] || sub.Name == "" {
			continue
		}
		if strings.Contains(text, sub.Name) && !sc.namedAlso(sub.Name, charted) {
			sc.t.Errorf("the report names %s, not charted:\n%s", sub.Name, text)
		}
	}
}

// namedAlso reports whether a name is a charted subject's too.
func (sc *scene) namedAlso(name string, charted map[int32]bool) bool {
	for i, sub := range sc.cw.Subjects {
		if charted[int32(i)] && (strings.Contains(sub.Name, name) || strings.Contains(sub.Title, name)) {
			return true
		}
	}
	return false
}

// start is Port Royal's first mooring, in its basin, facing the narrows.
func (sc *scene) start() physics.State {
	b, _ := seed1()
	m := b.Start.Moorings[0]
	return physics.State{X: m.X, Y: m.Y, Heading: m.Heading}
}

func TestSceneACrossing(t *testing.T) {
	sc := newScene(t, 12, 0)
	at := sc.start()
	// Out of the basin, in open water to the east: a machine boat on port
	// tack, the wind from the north over its port side, heading east; a
	// human's on starboard, heading west, 60 m off, on a collision course.
	at.X, at.Y = 1500, -1500
	own := at
	own.Heading, own.Surge = math.Pi/2, 2
	other := at
	other.X, other.Y, other.Heading, other.Surge = at.X+60, at.Y, -math.Pi/2+0.2, 2
	me := sc.boat(own, true)
	you := sc.boat(other, false)
	sc.steer(me, -90, 40)
	sc.steer(you, 70, 30)
	sc.sail(3 * time.Second)
	text, _ := sc.report(me)
	if !strings.Contains(text, "B1 human") {
		t.Fatalf("no human in sight:\n%s", text)
	}
	golden(t, "crossing", text)
	sc.parity(me, text)
}

// A boat within 60 m is named by its sailor's look, as a sailor on deck
// sees it; one beyond is not.
func TestSceneLooksClose(t *testing.T) {
	sc := newScene(t, 12, 0)
	at := sc.start()
	at.X, at.Y = 1500, -1500
	me := sc.boat(at, true)
	near, far := at, at
	near.X += 40
	far.Y += 150
	n := sc.boat(near, false)
	m := sc.boat(far, true)
	sc.sail(time.Second)
	text, _ := sc.report(me)
	f := sc.w.Latest()
	nearLook, _ := sc.sea.Looks.Of(f.Look[n])
	farLook, _ := sc.sea.Looks.Of(f.Look[m])
	if !strings.Contains(text, "human · "+sc.sea.Looks.Seen(nearLook)+" · ") {
		t.Fatalf("the near boat is not named %q:\n%s", sc.sea.Looks.Seen(nearLook), text)
	}
	if !strings.Contains(text, "B2 machine · ") || strings.Contains(text, sc.sea.Looks.Seen(farLook)) || strings.Contains(text, "machine sailor in") {
		t.Fatalf("the far boat is named:\n%s", text)
	}
	t.Logf("a report with a boat close by:\n%s", text)
	sc.parity(me, text)
}

func TestSceneAFullHarbour(t *testing.T) {
	sc := newScene(t, 10, 45)
	at := sc.start()
	me := sc.boat(at, true)
	var hidden int32
	for i := range 20 {
		st := at
		st.X += float64((i%5)-2) * 25
		st.Y += float64(i/5+1) * 25
		sl := sc.boat(st, i%3 == 0)
		if i == 7 {
			hidden = sl
		}
	}
	// One kept unseen by the owner's tools: in no view.
	f := sc.w.Latest()
	sc.w.Bus().Commands.Owner().TrySend(bus.Command{Op: bus.Unseen, Boat: f.Boat[hidden], On: true})
	sc.sail(2 * time.Second)
	text, r := sc.report(me)
	if len(r.InSight) == 0 || r.More == "" {
		t.Fatalf("a full harbour:\n%s", text)
	}
	golden(t, "harbour", text)
	sc.parity(me, text)
	if !strings.Contains(text, "Port Royal") && sc.sea.Start == "" {
		t.Logf("the start's island is not named:\n%s", text)
	}
}

func TestSceneTheLip(t *testing.T) {
	sc := newScene(t, 12, 0)
	r := sc.cat.World.Disk.Radius
	st := physics.State{X: 0, Y: -(r - 600), Heading: math.Pi / 2, Surge: 2}
	me := sc.boat(st, true)
	sc.steer(me, -90, 40)
	sc.sail(2 * time.Second)
	text, rep := sc.report(me)
	if rep.Where == nil || rep.Where.Edge > 0.5 {
		t.Fatalf("near the lip:\n%s", text)
	}
	if !slices.ContainsFunc(rep.Hear, func(s string) bool { return strings.Contains(s, "falls") }) {
		t.Errorf("the falls are not heard 600 m from the lip:\n%s", text)
	}
	golden(t, "lip", text)
	sc.parity(me, text)
}

func TestSceneOffAnIsland(t *testing.T) {
	sc := newScene(t, 12, 270)
	// Off the east coast of an island of the middle waters not charted.
	target := -1
	for i, s := range sc.cw.Subjects {
		if s.Kind == sight.Island && s.Highest > 10 && s.Zone == "middle" && !slices.Contains(sc.cw.Known, int32(i)) {
			target = i
			break
		}
	}
	if target < 0 {
		t.Fatal("no island of the middle waters")
	}
	is := sc.cw.Subjects[target]
	st := physics.State{X: is.Bounds[2] + 150, Y: is.Y, Heading: 0, Surge: 1}
	me := sc.boat(st, true)
	sc.steer(me, -90, 40)
	sc.sail(time.Second)
	text, _ := sc.report(me)
	if !strings.Contains(text, "land (uncharted)") {
		t.Fatalf("the island is not seen:\n%s", text)
	}
	if strings.Contains(text, is.Name) {
		t.Fatalf("the uncharted island is named:\n%s", text)
	}
	golden(t, "island", text)
	sc.parity(me, text)
}

// roads is the first place of the world's start, in the roads off Port
// Royal's harbour mouth.
func (sc *scene) roads() physics.State {
	b, _ := seed1()
	return b.Terrain(sc.cat.PrepareGround()).Start[0]
}

// A boat at rest in the roads in light air: its brief report has no
// steerage, and the Shoal line while shoal water is near.
func TestSceneTheRoads(t *testing.T) {
	sc := newScene(t, 3, 0)
	me := sc.boat(sc.roads(), true)
	sc.sail(time.Second)
	text, r := sc.reportOf(me, detailBrief)
	if !r.Boat.NoSteerage {
		t.Errorf("at rest, the rudder has steerage:\n%s", text)
	}
	golden(t, "roads", text)
	sc.parity(me, text)
}

// A machine sailor's report says how its sail draws once it has for a
// second and a half, as the phone's sheet does, with what to do: luffing
// with the sheet let fly on a close reach, stalled with it hauled in hard
// on a broad one.
func TestSceneTheSailsState(t *testing.T) {
	sc := newScene(t, 8, 0)
	me := sc.boat(sc.roads(), true)
	sc.steer(me, -60, 85)
	sc.sail(5 * time.Second)
	text, r := sc.reportOf(me, detailBrief)
	if r.Pilot == nil || r.Pilot.Sail != "luffing: trim in" {
		t.Errorf("the sheet let fly on a close reach:\n%s", text)
	}
	golden(t, "luffing", text)
	// Another on a broad reach, under way, its sheet hauled in hard.
	st := sc.roads()
	st.X, st.Heading, st.Surge = st.X+40, 130*math.Pi/180, 2
	other := sc.boat(st, true)
	sc.steer(other, -130, 4)
	sc.sail(5 * time.Second)
	text, r = sc.reportOf(other, detailBrief)
	if r.Pilot == nil || r.Pilot.Sail != "stalled: ease" {
		t.Errorf("the sheet hauled in hard on a broad reach:\n%s", text)
	}
	golden(t, "stalled", text)
}

// A boat moored in Port Royal's basin: its brief report.
func TestSceneTheBasin(t *testing.T) {
	sc := newScene(t, 3, 0)
	me := sc.boat(sc.start(), true)
	sc.sail(time.Second)
	text, _ := sc.reportOf(me, detailBrief)
	golden(t, "basin", text)
	sc.parity(me, text)
}

// A boat at rest on the nearest bank to the roads: its brief report says
// the water under it, and where the water deepens.
func TestSceneOnABank(t *testing.T) {
	sc := newScene(t, 3, 0)
	at := sc.roads()
	// The nearest water 5 to 50 cm deep.
	var bank physics.State
	found := false
	for r := 20.0; r < 3000 && !found; r += 4 {
		for k := range 128 {
			sin, cos := physics.SinCos(float64(k) * 2 * math.Pi / 128)
			x, y := at.X+sin*r, at.Y+cos*r
			if e, _ := sc.sea.Ground.At(x, y); e < -0.05 && e > -0.5 {
				bank, found = at, true
				bank.X, bank.Y = x, y
				break
			}
		}
	}
	if !found {
		t.Fatal("no bank within 3 km of the roads")
	}
	me := sc.boat(bank, true)
	sc.sail(time.Second)
	text, r := sc.reportOf(me, detailBrief)
	if r.Shoal == nil || !r.Shoal.Here || r.Boat.Depth == nil || !strings.Contains(text, "Shoal: under 1.5 m here · deeper ") {
		t.Fatalf("on a bank:\n%s", text)
	}
	golden(t, "bank", text)
	sc.parity(me, text)
}

// In open water the brief report has no Shoal line, and no more than it
// had; the one after it tells only what changed.
func TestSceneOpenSeaBrief(t *testing.T) {
	sc := newScene(t, 12, 0)
	own := sc.start()
	own.X, own.Y, own.Heading, own.Surge = 1500, -1500, math.Pi/2, 2
	me := sc.boat(own, true)
	sc.steer(me, -90, 40)
	sc.sail(3 * time.Second)
	text, r := sc.reportOf(me, detailBrief)
	if r.Shoal != nil || r.Boat.Depth != nil || r.Boat.NoSteerage || r.Boat.Astern {
		t.Errorf("open water, sailing:\n%s", text)
	}
	golden(t, "open-brief", text)
	// The next, nothing having changed, tells neither the sky nor the
	// boat's sounds again.
	sc.sail(time.Second)
	f := sc.w.Latest()
	h := sc.core.helmOf(sailor(byte(me)+1, "Iron Mary"))
	h.mu.Lock()
	again := h.reportFor(sc.sea, f, me, detailBrief, 0)
	h.mu.Unlock()
	if again.Sky != nil || len(again.Hear) > 0 || estimateTokens(again.text()) > estimateTokens(text) {
		t.Errorf("the quiet brief report after:\n%s", again.text())
	}
}

// Going astern, the Boat line says so.
func TestSceneAstern(t *testing.T) {
	sc := newScene(t, 3, 0)
	own := sc.start()
	own.X, own.Y, own.Heading, own.Surge = 1500, -1500, math.Pi/2, -0.6
	me := sc.boat(own, true)
	text, r := sc.reportOf(me, detailBrief)
	if !r.Boat.Astern || !strings.Contains(text, "astern ") {
		t.Errorf("going astern:\n%s", text)
	}
}

// The Shoal line tells only of ground the boat's phone is sent: the
// chunks within the handout's near reach.
func TestShoalWithinTheHandout(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	if near := cat.World.Handout.Near; shoalReach > near {
		t.Errorf("the Shoal line reads %.0f m out, the phone is sent the ground within %.0f m", shoalReach, near)
	}
}

// BenchmarkReport times a report's making in a crowded harbour: full and
// brief.
func BenchmarkReport(b *testing.B) {
	sc := newScene(b, 10, 45)
	at := sc.start()
	me := sc.boat(at, true)
	for i := range 30 {
		st := at
		st.X += float64((i%6)-3) * 25
		st.Y += float64(i/6+1) * 25
		sc.boat(st, i%3 == 0)
	}
	sc.sail(2 * time.Second)
	f := sc.w.Bus().Frames.Acquire()
	defer f.Release()
	h := sc.core.helmOf(sailor(1, "Iron Mary"))
	h.sea, h.slot, h.boat = sc.sea, me, f.Boat[me]
	for _, detail := range []string{detailBrief, detailFull} {
		b.Run(detail, func(b *testing.B) {
			var text string
			for b.Loop() {
				text = h.reportFor(sc.sea, f, me, detail, 0).text()
			}
			b.ReportMetric(float64(estimateTokens(text)), "tokens")
		})
	}
	b.Run("order", func(b *testing.B) {
		o := &steerOrder{WindAngle: new(int), Boom: new(int)}
		*o.WindAngle, *o.Boom = 90, 40
		for b.Loop() {
			h.steer(sc.sea, f, me, o)
			_ = orderLine(sc.sea, f, me, written{})
		}
	})
}

// BenchmarkHub times the hub's look at the boats with 500 machine sailors
// waiting, each for the wakes a wait has by default, in the world's own
// weather: what it does ten times a second.
func BenchmarkHub(b *testing.B) {
	sc := newSceneOf(b, 600, -1, 0)
	at := sc.start()
	at.X, at.Y = 0, -1500
	var waiters []*waiter
	for i := range 500 {
		st := at
		st.X += float64(i%25) * 40
		st.Y -= float64(i/25) * 40
		sl := sc.boat(st, true)
		h := sc.core.helmOf(sailor(byte(i%250), "Iron Mary"))
		h.account[3] = byte(i / 250)
		f := sc.w.Latest()
		h.sea, h.slot, h.boat = sc.sea, sl, f.Boat[sl]
		sc.core.mu.Lock()
		sc.core.helms[h.account] = h
		sc.core.mu.Unlock()
		w := newWaiter(time.Now(), wakeDefault)
		h.waiter = w
		waiters = append(waiters, w)
	}
	sc.sail(time.Second)
	hub := sc.core.hub
	f := sc.w.Bus().Frames.Acquire()
	defer f.Release()
	hub.reset(sc.sea, f)
	hub.look(sc.sea, f)
	b.ResetTimer()
	n := 0
	for b.Loop() {
		// The lookouts look every half second: every fifth look.
		hub.sightAt = f.Tick
		if n%5 == 0 {
			hub.sightAt = f.Tick - sightEvery
		}
		f.Tick += checkEvery
		hub.look(sc.sea, f)
		n++
	}
	b.ReportMetric(float64(len(waiters)), "waiting")
}

// chart with a place, from the roads: Port Royal gives its harbour's
// mouth, and its island its coast and size, as the chart draws them.
func TestSceneChartPortRoyal(t *testing.T) {
	sc := newScene(t, 3, 0)
	at := sc.roads()
	var lines []string
	for _, e := range charted(sc.sea) {
		if e.sub.Kind != sight.Island && e.sub.Name != "Port Royal" {
			continue
		}
		text, r := chartList(sc.sea, &chartArgs{Place: titleOf(e.sub)}, at.X, at.Y, true)
		if r != nil {
			t.Fatal(r)
		}
		lines = append(lines, text)
	}
	text := strings.Join(lines, "\n")
	if !strings.Contains(text, "harbour mouth ") || !strings.Contains(text, "coast ") {
		t.Fatalf("chart from the roads:\n%s", text)
	}
	golden(t, "chart-port-royal", text)
}
