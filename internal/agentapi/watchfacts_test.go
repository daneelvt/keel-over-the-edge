// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sight"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/watch"
)

// The list's facts and the card in seed 1's world: told as the lookout
// report tells them, and naming no land the boat's lookout cannot see.

// TestWatchFactsAsTheReport: near the lip, a boat's facts and card say
// what its full report says: the edge, the wind's force, the barometer,
// the visibility.
func TestWatchFactsAsTheReport(t *testing.T) {
	sc := newScene(t, 12, 0)
	r := sc.cat.World.Disk.Radius
	me := sc.boat(physics.State{X: 0, Y: -(r - 600), Heading: math.Pi / 2, Surge: 2}, true)
	sc.steer(me, -90, 40)
	sc.sail(2 * time.Second)
	_, rep := sc.report(me)
	f := sc.w.Bus().Frames.Acquire()
	defer f.Release()
	facts := make([]watch.Facts, 1)
	sc.sea.Facts(f, []int32{me}, facts)
	x := facts[0]
	if x.Edge != rep.Where.Edge || x.Edge > watch.LivelyEdge {
		t.Errorf("the edge: %v, the report %v", x.Edge, rep.Where.Edge)
	}
	if x.Force != rep.Wind.Force || x.Sky == "" || x.State != watch.StateSailing || x.Knots <= 0 {
		t.Errorf("the facts: %+v, the report's force %d", x, rep.Wind.Force)
	}
	c := sc.sea.Card(f, me)
	if c.Weather.Barometer != rep.Weather.Barometer || c.Weather.Visibility != rep.Weather.Visibility || c.Weather.Rain != rep.Weather.Rain {
		t.Errorf("the card's weather %+v, the report's %+v", c.Weather, rep.Weather)
	}
	if d := math.Abs(float64(c.Weather.WindFrom) - float64(rep.Wind.From)); d > 20 && d < 340 {
		t.Errorf("the wind from %d°, the report %d°", c.Weather.WindFrom, rep.Wind.From)
	}
}

// TestWatchCardUnchartedLand: off an island nobody has charted, the card
// tells it by its look, as the report does, and never by its name, nor
// as the nearest island; once it is charted by the boat, the card names
// it, and the facts say the boat charted it, and when.
func TestWatchCardUnchartedLand(t *testing.T) {
	sc := newScene(t, 12, 270)
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
	me := sc.boat(physics.State{X: is.Bounds[2] + 150, Y: is.Y, Heading: 0, Surge: 1}, true)
	sc.steer(me, -90, 40)
	sc.sail(time.Second)
	_, rep := sc.report(me)
	f := sc.w.Bus().Frames.Acquire()
	c := sc.sea.Card(f, me)
	if !slices.Equal(c.Where.InSight, rep.InSight) {
		t.Errorf("in sight on the card:\n%s\nin the report:\n%s", strings.Join(c.Where.InSight, "\n"), strings.Join(rep.InSight, "\n"))
	}
	text := strings.Join(c.Where.InSight, "\n")
	if !strings.Contains(text, "land (uncharted)") || strings.Contains(text, is.Name) {
		t.Fatalf("the uncharted island on the card:\n%s", text)
	}
	if c.Where.Island != nil && c.Where.Island.Name == is.Name {
		t.Fatalf("the nearest island is one not charted: %+v", c.Where.Island)
	}
	tick, boat := f.Tick, f.Boat[me]
	f.Release()

	sc.sea.Chart.Add([]store.Charting{{Subject: chart.KindWord(is.Kind), Number: is.Number, Boat: boat,
		Tick: tick - 4*60*physics.StepsPerSecond, At: time.Now()}})
	f = sc.w.Bus().Frames.Acquire()
	defer f.Release()
	c = sc.sea.Card(f, me)
	if c.Where.Island == nil || c.Where.Island.Name != is.Name || c.Where.Island.NM > 2 {
		t.Fatalf("the nearest island once charted: %+v", c.Where.Island)
	}
	facts := make([]watch.Facts, 1)
	sc.sea.Facts(f, []int32{me}, facts)
	if facts[0].Charted != is.Name || facts[0].Minutes != 4 {
		t.Fatalf("charted: %q %d minutes ago", facts[0].Charted, facts[0].Minutes)
	}
}

// BenchmarkWatchFacts makes the facts of a world's boats at its limit,
// in its own weather, as the list does once a cache window: the
// weather's ticks first, then every boat's. It reports a page of the
// list's size, gzipped.
func BenchmarkWatchFacts(b *testing.B) {
	const boats = 1000
	sc := newSceneOf(b, boats, -1, 0)
	r := sc.cat.World.Disk.Radius
	dev := sc.w.Bus().Commands.Developer()
	for i := range boats {
		a := float64(i) * 2.399963
		d := r * (0.25 + 0.7*float64(i)/boats)
		reply := make(chan bus.Reply, 1)
		dev.TrySend(bus.Command{Op: bus.Join, Account: bus.Account{0x02, byte(i >> 8), byte(i)}, Conn: uint64(i + 1), Machine: i%2 == 0, Reply: reply})
		sc.w.Tick()
		rep := <-reply
		dev.TrySend(bus.Command{Op: bus.Place, Boat: rep.Boat, State: physics.State{X: d * math.Sin(a), Y: d * math.Cos(a), Heading: a, Surge: 2}})
		sc.w.Tick()
	}
	sc.sail(time.Second)
	f := sc.w.Bus().Frames.Acquire()
	defer f.Release()
	if len(f.Live) != boats {
		b.Fatalf("%d boats", len(f.Live))
	}
	out := make([]watch.Facts, boats)
	for b.Loop() {
		sc.sea.air.mu.Lock()
		sc.sea.air.tick, sc.sea.air.at, sc.sea.air.past = 0, nil, nil
		sc.sea.air.mu.Unlock()
		sc.sea.Facts(f, f.Live, out)
	}
	page := make([]watch.Item, 0, watch.PageSize)
	for i := range watch.PageSize {
		x := &out[i]
		e := x.Edge
		page = append(page, watch.Item{Name: fmt.Sprintf("Sailor %d with a long name", i), Machine: i%2 == 0, Kind: "jolly",
			Watchers: i % 4, Sky: x.Sky, Force: x.Force, Knots: x.Knots, State: x.State, EdgeNM: &e,
			Lively: []watch.Lively{{Why: watch.WhySqualls}, {Why: watch.WhyCharted, Subject: "Gull Island", Minutes: new(int)}}})
	}
	raw, _ := json.Marshal(watch.Page{Sailors: page, More: true, AtSea: boats})
	var gz bytes.Buffer
	w := gzip.NewWriter(&gz)
	_, _ = w.Write(raw)
	_ = w.Close()
	b.ReportMetric(float64(gz.Len()), "page-gz-bytes")
}
