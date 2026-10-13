// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"net"
	"os"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/sim/loop"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

var update = flag.Bool("update", false, "record the traces in shared/protocol/testdata again")

// recorded is the controls of the sandbox's recorded sail, a minute long,
// as indices for each step, played again and again.
func recorded(t *testing.T) client.Controls {
	t.Helper()
	data, err := os.ReadFile("../../physics/testdata/recordings/sandbox-sail.json")
	if err != nil {
		t.Fatal(err)
	}
	var rec struct {
		Scenarios []struct {
			Steps   int                `json:"steps"`
			Control map[string]float64 `json:"control"`
			Changes []struct {
				At      int                `json:"at"`
				Control map[string]float64 `json:"control"`
			} `json:"changes"`
		} `json:"scenarios"`
	}
	if err := json.Unmarshal(data, &rec); err != nil {
		t.Fatal(err)
	}
	sc := rec.Scenarios[0]
	index := func(v, lo, hi float64) uint16 {
		k := (v - lo) / (hi - lo) * 1024
		if k != math.Trunc(k) {
			t.Fatalf("%v is not a step", v)
		}
		return uint16(k)
	}
	helm := make([]uint16, sc.Steps)
	sheet := make([]uint16, sc.Steps)
	h, s := sc.Control["helm"], sc.Control["sheet"]
	next := 0
	for i := range sc.Steps {
		for ; next < len(sc.Changes) && sc.Changes[next].At == i; next++ {
			if v, ok := sc.Changes[next].Control["helm"]; ok {
				h = v
			}
			if v, ok := sc.Changes[next].Control["sheet"]; ok {
				s = v
			}
		}
		helm[i], sheet[i] = index(h, -1, 1), index(s, 0, 1)
	}
	return func(n int) (uint16, uint16) { return helm[n%sc.Steps], sheet[n%sc.Steps] }
}

// sail sails the recording for d through lag, in a bubble of its own.
func sail(t *testing.T, lag client.Lag, d time.Duration, trace *client.Trace) client.Stats {
	t.Helper()
	return sailIn(t, nil, lag, d, trace)
}

// gale is 34 knots from the south-west, steady.
var gale = weather.Steady(34*1852.0/3600, 3.9)

// sailIn is sail in a steady wind that has blown long enough to raise its
// sea, or the world's own if wind is nil.
func sailIn(t *testing.T, wind *bus.Weather, lag client.Lag, d time.Duration, trace *client.Trace) client.Stats {
	t.Helper()
	return sailWith(t, nil, wind, lag, d, trace)
}

// inTrade is the catalog's weather two hours into its sequence's first
// spell, a trade spell: gusts, shifts, and a sea that changes every second.
// It reads the time, so it is called inside a test's bubble.
func inTrade(t *testing.T) *weather.Timeline {
	t.Helper()
	return sequenceFrom(t, loop.TickAt(time.Now(), Epoch)-2*3600*physics.StepsPerSecond)
}

// sailWith is sailIn in the weather a timeline gives, or the server's
// steady one if it is nil.
func sailWith(t *testing.T, timeline func(*testing.T) *weather.Timeline, wind *bus.Weather, lag client.Lag, d time.Duration, trace *client.Trace) client.Stats {
	t.Helper()
	var stats client.Stats
	synctest.Test(t, func(t *testing.T) {
		var cfg Config
		if timeline != nil {
			cfg.Weather = timeline(t)
		}
		srv := NewServer(t, cfg)
		if wind != nil {
			if err := srv.World.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.SetWeather, Weather: *wind}); err != nil {
				t.Fatal(err)
			}
			time.Sleep(3 * time.Second)
			f := srv.World.Bus().Frames.Acquire()
			blows, raised := f.Spells[f.NSpells-1], f.Sea.Now[0]
			f.Release()
			if blows.Steady != 1 || blows.Speed != float64(wind.Speed) || blows.From != float64(wind.Dir) ||
				raised != (physics.SeaInput{Speed: wind.Speed, From: wind.Dir, Fetch: srv.Waves.OpenSea(0, 0).Fetch}) {
				t.Fatalf("after three seconds the wind is %+v and its sea %+v", blows, raised)
			}
		}
		token, _ := srv.Guest("Ann")
		o := DialOptions{Cookie: token}
		if lag != (client.Lag{}) {
			o.Wrap = lag.Wrap
		}
		s := srv.NewSailor(o, recorded(t))
		s.Trace = trace
		if err := s.Connect(t.Context()); err != nil {
			t.Fatal(err)
		}
		if err := s.Sail(t.Context(), d); err != nil {
			t.Fatal(err)
		}
		s.Drop()
		stats = s.Stats
	})
	return stats
}

func report(t *testing.T, name string, s client.Stats, d time.Duration) {
	t.Logf("%s: %d snapshots, %d corrections (%d over the snap thresholds; largest %.3f m, 95th percentile %.3f m), %d resets, %d stale, m up to %d, latest input %d ticks late, %.0f B/s in, %.0f B/s out (payloads)",
		name, s.Snapshots, s.Corrections, s.Over, s.Percentile(100), s.Percentile(95), s.Resets, s.Stale, s.MaxAhead, s.MaxLate,
		float64(s.BytesIn)/d.Seconds(), float64(s.BytesOut)/d.Seconds())
}

func sailLength() time.Duration {
	if testing.Short() {
		return time.Minute
	}
	return 5 * time.Minute
}

// TestSailNoLag: without lag, prediction is the server's to the bit: no
// snapshot ever differs from what the sailor predicted for its tick.
func TestSailNoLag(t *testing.T) {
	d := sailLength()
	s := sail(t, client.Lag{}, d, nil)
	report(t, "no lag", s, d)
	if s.Corrections != 0 || s.Snapshots < int(d.Seconds())*15-30 {
		t.Fatalf("%d corrections in %d snapshots", s.Corrections, s.Snapshots)
	}
}

// TestSailDelay: 100 ms each way and no loss: still not one correction.
func TestSailDelay(t *testing.T) {
	d := sailLength()
	s := sail(t, client.Lag{Delay: 100 * time.Millisecond}, d, nil)
	report(t, "100 ms each way", s, d)
	if s.Corrections != 0 || s.Snapshots < int(d.Seconds())*15-30 {
		t.Fatalf("%d corrections in %d snapshots", s.Corrections, s.Snapshots)
	}
}

// TestSailGale: in a gale's sea, heaving, pitching and surfing, prediction
// is still the server's to the bit, with no lag and with 100 ms each way.
func TestSailGale(t *testing.T) {
	d := sailLength()
	for name, lag := range map[string]client.Lag{"no lag": {}, "100 ms each way": {Delay: 100 * time.Millisecond}} {
		s := sailIn(t, &gale, lag, d, nil)
		report(t, "a gale, "+name, s, d)
		if s.Corrections != 0 || s.Snapshots < int(d.Seconds())*15-30 || s.Seas < 1 {
			t.Fatalf("%s: %d corrections in %d snapshots, %d SeaAreas", name, s.Corrections, s.Snapshots, s.Seas)
		}
	}
}

// TestSailWeatherChange: a developer's weather blows, and raises its sea,
// from the second after next, and the client is told a second before: so a
// change of wind corrects nothing.
func TestSailWeatherChange(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{})
		token, _ := srv.Guest("Ann")
		lag := client.Lag{Delay: 100 * time.Millisecond}
		s := srv.NewSailor(DialOptions{Cookie: token, Wrap: lag.Wrap}, recorded(t))
		s.Trace = &client.Trace{}
		if err := s.Connect(t.Context()); err != nil {
			t.Fatal(err)
		}
		var changes []int64
		for _, wind := range []bus.Weather{gale, weather.Steady(3, 1), weather.Steady(12, 6)} {
			if err := s.Sail(t.Context(), 7*time.Second); err != nil {
				t.Fatal(err)
			}
			reply := make(chan bus.Reply, 1)
			if err := srv.World.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.SetWeather, Weather: wind, Reply: reply}); err != nil {
				t.Fatal(err)
			}
			if err := s.Sail(t.Context(), time.Second); err != nil {
				t.Fatal(err)
			}
			changes = append(changes, (<-reply).Tick)
		}
		if err := s.Sail(t.Context(), 7*time.Second); err != nil {
			t.Fatal(err)
		}
		s.Drop()
		if s.Stats.Seas != 1+len(changes) || s.Stats.Weathers < 1+len(changes) {
			t.Fatalf("%d SeaAreas and %d WeatherSystems for %d changes of wind", s.Stats.Seas, s.Stats.Weathers, len(changes))
		}
		if s.Stats.Corrections != 0 || s.Stats.Resets > 1 {
			t.Errorf("%d corrections and %d resets through %d changes of wind at ticks %v", s.Stats.Corrections, s.Stats.Resets, len(changes), changes)
		}
	})
}

// TestSailSlowFrames: a page drawing 5 frames a second, as CI's software
// renderer does, keeps up, steers, and sees no correction. Between such
// frames the server passes the prediction, whose next snapshot starts it
// again from the server's state: that is counted as a reset.
func TestSailSlowFrames(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{})
		token, _ := srv.Guest("Ann")
		lag := client.Lag{Delay: 100 * time.Millisecond}
		s := srv.NewSailor(DialOptions{Cookie: token, Wrap: lag.Wrap}, recorded(t))
		s.FrameEvery = 200 * time.Millisecond
		if err := s.Connect(t.Context()); err != nil {
			t.Fatal(err)
		}
		if err := s.Sail(t.Context(), time.Minute); err != nil {
			t.Fatal(err)
		}
		s.Drop()
		report(t, "5 frames a second", s.Stats, time.Minute)
		if s.Stats.Corrections != 0 || s.Stats.Steps < 1700 {
			t.Fatalf("%d corrections, %d resets, %d steps", s.Stats.Corrections, s.Stats.Resets, s.Stats.Steps)
		}
	})
}

// TestSailLoss: 100 ms each way and 2% of packets lost each way, over ten
// seeds: corrections come, but none over the snap thresholds. And over
// three more in a trade spell's gusts and shifts: the wind is computed, not
// sent, so loss costs no more there.
func TestSailLoss(t *testing.T) {
	d := sailLength()
	if testing.Short() {
		d = 30 * time.Second
	}
	var all client.Stats
	for seed := range uint64(10) {
		s := sail(t, client.Lag{Delay: 100 * time.Millisecond, Loss: 0.02, Seed: seed + 1}, d, nil)
		report(t, fmt.Sprintf("seed %d", seed+1), s, d)
		if s.Over > 0 {
			t.Errorf("seed %d: %d corrections over the snap thresholds", seed+1, s.Over)
		}
		all.Snapshots += s.Snapshots
		all.Corrections += s.Corrections
		all.Sizes = append(all.Sizes, s.Sizes...)
		all.Resets += s.Resets
		all.Stale += s.Stale
		all.MaxAhead = max(all.MaxAhead, s.MaxAhead)
		all.MaxLate = max(all.MaxLate, s.MaxLate)
		all.BytesIn += s.BytesIn
		all.BytesOut += s.BytesOut
	}
	report(t, "ten seeds", all, 10*d)

	var gusty client.Stats
	for seed := range uint64(3) {
		s := sailWith(t, inTrade, nil, client.Lag{Delay: 100 * time.Millisecond, Loss: 0.02, Seed: seed + 1}, d, nil)
		if s.Over > 0 {
			t.Errorf("in a trade spell, seed %d: %d corrections over the snap thresholds", seed+1, s.Over)
		}
		gusty.Snapshots += s.Snapshots
		gusty.Corrections += s.Corrections
		gusty.Sizes = append(gusty.Sizes, s.Sizes...)
		gusty.Resets += s.Resets
		gusty.Stale += s.Stale
		gusty.MaxAhead = max(gusty.MaxAhead, s.MaxAhead)
		gusty.MaxLate = max(gusty.MaxLate, s.MaxLate)
		gusty.BytesIn += s.BytesIn
		gusty.BytesOut += s.BytesOut
	}
	report(t, "three seeds in a trade spell", gusty, 3*d)
}

// TestTraces records, with -update, the traces the TypeScript tests replay:
// with no lag, and at 200 ms and 2% loss; and replays the committed ones
// through this package's own client, as the TypeScript tests replay them
// through the page's.
func TestTraces(t *testing.T) {
	for _, tc := range []struct {
		name string
		lag  client.Lag
	}{
		{"none", client.Lag{}},
		{"lossy", client.Lag{Delay: 100 * time.Millisecond, Loss: 0.02, Seed: 3}},
	} {
		path := "../../../shared/protocol/testdata/trace-" + tc.name + ".json"
		if *update {
			trace := &client.Trace{Lag: tc.lag.String()}
			sail(t, tc.lag, 20*time.Second, trace)
			if err := trace.Write(path); err != nil {
				t.Fatal(err)
			}
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var trace client.Trace
		if err := json.Unmarshal(data, &trace); err != nil {
			t.Fatal(err)
		}
		corrections := replayTrace(t, &trace)
		if (tc.name == "lossy") != (corrections > 0) {
			t.Errorf("%s: %d corrections", tc.name, corrections)
		}
	}
}

// TestFleetTraces records, with -update, the traces of three sailors
// sailing together among a few other boats, at 200 ms and 2% loss, and
// replays them: every snapshot decodes to the view the sailor decoded.
func TestFleetTraces(t *testing.T) {
	const path = "../../../shared/protocol/testdata/trace-fleet.json"
	lag := client.Lag{Delay: 100 * time.Millisecond, Loss: 0.02, Seed: 5}
	if *update {
		traces := make([]*client.Trace, 3)
		synctest.Test(t, func(t *testing.T) {
			srv := NewServer(t, Config{})
			srv.Crowd(t, 4, func(i int) physics.State {
				return physics.State{X: -640 + float64(i)*90 - 135, Y: 60 + float64(i%2)*400, Heading: math.Pi / 2, Surge: 2, SheetLimit: 0.6}
			})
			var sailors []*client.Sailor
			for i := range traces {
				token, _ := srv.Guest(fmt.Sprint("Crew ", i))
				l := lag
				l.Seed += uint64(i)
				s := srv.NewSailor(DialOptions{Cookie: token, Wrap: l.Wrap}, recorded(t))
				traces[i] = &client.Trace{Lag: l.String()}
				s.Trace = traces[i]
				sailors = append(sailors, s)
			}
			sailAll(t, sailors, 10*time.Second)
		})
		data, err := json.Marshal(traces)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var traces []client.Trace
	if err := json.Unmarshal(data, &traces); err != nil {
		t.Fatal(err)
	}
	if len(traces) != 3 {
		t.Fatalf("%d traces", len(traces))
	}
	for i := range traces {
		views := 0
		for _, e := range traces[i].Events {
			if e.View != "" && e.View != fmt.Sprintf("%08x", client.ViewDigest(&protocol.View{})) {
				views++
			}
		}
		if views < 100 {
			t.Fatalf("sailor %d saw others in %d snapshots", i, views)
		}
		replayTrace(t, &traces[i])
	}
}

// replayTrace gives a trace's events, at their times, to a client.Net and a
// Predictor of its own, and checks they send the same messages and
// reconcile each snapshot alike. It returns the corrections.
func replayTrace(t *testing.T, trace *client.Trace) (corrections int) {
	t.Helper()
	waves, kinds := CatalogKinds(t)
	n := client.Net{FrameMs: 17}
	p := client.NewPredictor(&kinds[0], waves, weather.Fixed(sim.DefaultSpell).Prepared())
	snapshots := map[int64]*protocol.Snapshot{}
	var latest *protocol.Snapshot
	var expect [][]byte
	sent := func(out ...[]byte) { expect = append(expect, out...) }
	for i, e := range trace.Events {
		switch {
		case e.Out != "":
			if i == 0 {
				sent(n.Open(e.T)...)
			}
			if len(expect) == 0 || hex.EncodeToString(expect[0]) != e.Out {
				t.Fatalf("event %d at %v: sent %s, the replay %x", i, e.T, e.Out, expect)
			}
			expect = expect[1:]
		case e.In != "":
			b, _ := hex.DecodeString(e.In)
			out, ev, err := n.Receive(e.T, b)
			if err != nil {
				t.Fatal(err)
			}
			sent(out...)
			if ev.SeaAreas != nil {
				p.Seas.Receive(ev.SeaAreas)
			}
			if ev.WeatherSystems != nil {
				if err := p.ReceiveWeather(ev.WeatherSystems); err != nil {
					t.Fatal(err)
				}
			}
			if ev.Dropped != e.Dropped {
				t.Fatalf("event %d: dropped %v, the trace %v", i, ev.Dropped, e.Dropped)
			}
			if ev.View != nil {
				snapshots[ev.Snapshot.Tick] = ev.Snapshot
				if got := fmt.Sprintf("%08x", client.ViewDigest(ev.View)); got != e.View {
					t.Fatalf("event %d: the view decoded to %s, the trace's to %s", i, got, e.View)
				}
			}
		case e.Timer:
			out, dead := n.Time(e.T)
			if dead {
				t.Fatalf("event %d: dead", i)
			}
			sent(out...)
		case e.Input != nil:
			sent(n.Input(e.T, uint32(e.Input[0]), uint16(e.Input[1]), uint16(e.Input[2])))
		case e.Step != nil:
			p.Step(uint16(e.Step[1]), uint16(e.Step[2]))
			if p.Tick != e.Step[0] {
				t.Fatalf("event %d: stepped tick %d, the trace %d", i, p.Tick, e.Step[0])
			}
		case e.Snap != nil:
			sn := snapshots[e.Snap.Tick]
			o := p.Snapshot(sn)
			// The distance is the test client's own math.Hypot, outside the
			// physics, which Go computes differently on amd64 and arm64: it
			// may differ in its last bit from the machine's that recorded it.
			if o.Stale != e.Snap.Stale || o.Reset != e.Snap.Reset || o.Corrected != e.Snap.Corrected ||
				math.Abs(o.Distance-e.Snap.Distance) > 1e-12 {
				t.Fatalf("event %d: snapshot %d: %+v, the trace %+v", i, e.Snap.Tick, o, e.Snap)
			}
			if o.Corrected {
				corrections++
			}
			latest = sn
		case e.Reset:
			p.Reset(latest)
		}
	}
	return corrections
}

// TestAheadSettlesAndRises: at 100 ms each way, m settles within 5 s and
// holds; after the network stalls for a second, inputs arrive late and m
// rises.
func TestAheadSettlesAndRises(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{})
		token, _ := srv.Guest("Ann")
		lag := client.Lag{Delay: 100 * time.Millisecond}
		// The tiller dragged to and fro: a word every step.
		wiggle := func(n int) (uint16, uint16) { return uint16(256 + n%512), 512 }
		var conn client.Staller
		s := srv.NewSailor(DialOptions{Cookie: token, Wrap: func(c net.Conn) net.Conn {
			w := lag.Wrap(c)
			conn = w.(client.Staller)
			return w
		}}, wiggle)
		if err := s.Connect(t.Context()); err != nil {
			t.Fatal(err)
		}
		if err := s.Sail(t.Context(), 30*time.Second); err != nil {
			t.Fatal(err)
		}
		var settled int
		for _, m := range s.Ms {
			if m.At >= 5*time.Second {
				if settled == 0 {
					settled = m.M
				}
				if m.M != settled {
					t.Fatalf("m was %d at 5 s and %d at %v", settled, m.M, m.At)
				}
			}
		}
		// The network holds everything sent for a second.
		conn.Stall(time.Now().Add(time.Second))
		if err := s.Sail(t.Context(), 5*time.Second); err != nil {
			t.Fatal(err)
		}
		if s.Ahead.M <= settled || s.Stats.MaxLate == 0 {
			t.Fatalf("after a stall m is %d (settled at %d); inputs at most %d ticks late", s.Ahead.M, settled, s.Stats.MaxLate)
		}
		s.Drop()
	})
}

// TestDropout: a sailor gone 20 s finds the same boat; one gone 70 s, past
// the grace, gets a new boat.
func TestDropout(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{})
		token, _ := srv.Guest("Ann")
		s := srv.NewSailor(DialOptions{Cookie: token}, recorded(t))
		sailFor := func(d time.Duration) {
			t.Helper()
			if err := s.Connect(t.Context()); err != nil {
				t.Fatal(err)
			}
			if err := s.Sail(t.Context(), d); err != nil {
				t.Fatal(err)
			}
			s.Drop()
			// What each sail came to, for a failure's message.
			t.Logf("after %v more: %d snapshots, %d corrections (largest %.3f m), %d resets, %d stale, %d SeaAreas, m up to %d, latest input %d ticks late",
				d, s.Stats.Snapshots, s.Stats.Corrections, s.Stats.Percentile(100), s.Stats.Resets, s.Stats.Stale, s.Stats.Seas, s.Stats.MaxAhead, s.Stats.MaxLate)
		}
		sailFor(10 * time.Second)
		time.Sleep(20 * time.Second)
		sailFor(5 * time.Second)
		// Back a moment before a tick, so that the Welcome is there before
		// the sailor's first frame: the snapshot the last connection left
		// waiting for a frame is not taken for the new boat's first.
		time.Sleep(70*time.Second - 5*time.Millisecond)
		sailFor(5 * time.Second)
		w := s.Welcomes
		if len(w) != 3 || w[0].Rejoined || !w[1].Rejoined || w[1].Boat != w[0].Boat || w[2].Rejoined || w[2].Boat == w[0].Boat {
			t.Fatalf("welcomes %+v", w)
		}
		if s.Stats.Corrections != 0 {
			t.Fatalf("%d corrections", s.Stats.Corrections)
		}
	})
}

// sequenceFrom is the catalog's weather with its sequence first beginning
// at a tick.
func sequenceFrom(t *testing.T, tick int64) *weather.Timeline {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	tl, err := weather.FromCatalog(cat)
	if err != nil {
		t.Fatal(err)
	}
	return tl.From(tick)
}

// TestSailGusts: in a trade spell's gusts and shifts, and through a change
// of spell, prediction is still the server's to the bit, with no lag and
// with 100 ms each way: the sailor computes the wind at its boat from the
// spells it is sent, as the server does. The next spell reaches it ten
// seconds before the change begins.
func TestSailGusts(t *testing.T) {
	d := sailLength()
	for name, lag := range map[string]client.Lag{"no lag": {}, "100 ms each way": {Delay: 100 * time.Millisecond}} {
		synctest.Test(t, func(t *testing.T) {
			now := loop.TickAt(time.Now(), Epoch)
			// The sequence's second spell begins 40 s into the sail: its
			// first, a trade spell, has blown for four hours less that.
			change := now + 40*physics.StepsPerSecond
			srv := NewServer(t, Config{Weather: sequenceFrom(t, change-4*3600*physics.StepsPerSecond)})
			token, _ := srv.Guest("Ann")
			o := DialOptions{Cookie: token}
			if lag != (client.Lag{}) {
				o.Wrap = lag.Wrap
			}
			s := srv.NewSailor(o, recorded(t))
			if err := s.Connect(t.Context()); err != nil {
				t.Fatal(err)
			}
			lo, hi := math.Inf(1), math.Inf(-1)
			var heard, spells int
			for sailed := time.Duration(0); sailed < d; sailed += time.Second {
				if err := s.Sail(t.Context(), time.Second); err != nil {
					t.Fatal(err)
				}
				w := s.Predictor.Wind()
				lo, hi = min(lo, w.Speed), max(hi, w.Speed)
				if n := int(s.Predictor.Weather.Count); n != spells {
					if spells == 1 && n == 2 && heard == 0 {
						heard = int((change - s.Predictor.Tick) / physics.StepsPerSecond)
					}
					spells = n
				}
			}
			s.Drop()
			report(t, "gusts, "+name, s.Stats, d)
			t.Logf("%s: the wind at the boat ran from %.1f to %.1f knots; the next spell was heard of %d s before its change", name, lo*3600/1852, hi*3600/1852, heard)
			if s.Stats.Corrections != 0 || s.Stats.Snapshots < int(d.Seconds())*15-30 {
				t.Fatalf("%s: %d corrections in %d snapshots", name, s.Stats.Corrections, s.Stats.Snapshots)
			}
			if hi < 1.08*lo {
				t.Errorf("%s: the wind at the boat ran from %.2f to %.2f m/s: no gusts", name, lo, hi)
			}
			if heard < 8 || heard > 10 || s.Stats.Weathers < 2 {
				t.Errorf("%s: the next spell was heard of %d s before its change, in %d WeatherSystems", name, heard, s.Stats.Weathers)
			}
		})
	}
}
