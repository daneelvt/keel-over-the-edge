// SPDX-License-Identifier: AGPL-3.0-only

package sim_test

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"math"
	"math/rand/v2"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"sync"
	"testing"
	"testing/synctest"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/replay"
	"github.com/daneelvt/keel-over-the-edge/internal/scripted"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/sim/loop"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// The replay tests: a world sailed through the real loop by scripted
// sailors replays, unclocked, to the same world; a log committed once replays
// the same on every machine and with any number of workers; and a sail
// recorded in the client's sandbox, sailed by the tick, ends where the
// browser's did.

var update = flag.Bool("update", false, "record testdata/replays/fixture.log again")

const fixture = "testdata/replays/fixture.log"

var bubbleEpoch = time.Date(2000, time.January, 1, 0, 0, 0, 0, time.UTC)

// physicsOnce prepares the catalog's sea and boats once for the package's
// tests.
var physicsOnce = sync.OnceValues(func() (*physics.Waves, []physics.Prepared) {
	cat, err := catalog.Load()
	if err != nil {
		panic(err)
	}
	return cat.Prepare()
})

// catalogKinds is the catalog's boats, prepared for its sea.
func catalogKinds(t testing.TB) []physics.Prepared {
	_, ks := physicsOnce()
	return ks
}

// catalogEncounters is the catalog's encounters, prepared.
func catalogEncounters(t testing.TB) *physics.EncounterPrepared {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	return cat.PrepareEncounters()
}

// catalogWaves is the catalog's sea.
// catalogWeather is the world's own weather: the catalog's sequence. Each
// world gets a timeline of its own: a timeline remembers the direction it
// last walked to, which is not for two goroutines at once.
func catalogWeather(t testing.TB) *weather.Timeline {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	tl, err := weather.FromCatalog(cat)
	if err != nil {
		t.Fatal(err)
	}
	return tl
}

func catalogWaves(t testing.TB) *physics.Waves {
	w, _ := physicsOnce()
	return w
}

// live is a recorded session: the log's bytes and the world it ended in.
type live struct {
	log []byte
	end []byte // the last frame's snapshot
}

// liveGrace is the live sessions' grace, short so that graces end in them.
const liveGrace = 300

// account is a test's account n.
func account(n uint64) bus.Account {
	var a bus.Account
	for k := range 8 {
		a[15-k] = byte(n >> (8 * k))
	}
	return a
}

// sailLive runs sailors through the clocked loop for d in a synctest
// bubble, in a world of at most limit boats, with players joining, waiting
// in the queue, leaving, losing their connections and coming back besides,
// developer commands and holds of admission now and then, and a tick
// stalled at stall (if not zero) to force a skip.
// liveEdge is the edge the live sessions' worlds have: five seconds'
// fall, and approaches survived 20 m back out of the mist band.
var liveEdge = &sim.Edge{Fall: 150, Clear: 20}

func sailLive(t *testing.T, sailors, capacity, limit int, d time.Duration, stall int64) live {
	var out live
	dir := t.TempDir()
	synctest.Test(t, func(t *testing.T) {
		w, err := sim.New(sim.Config{Capacity: capacity, Kinds: catalogKinds(t), Waves: catalogWaves(t), Weather: catalogWeather(t), Encounters: catalogEncounters(t), Workers: 4, Tick: loop.TickAt(time.Now(), bubbleEpoch), Grace: liveGrace, Limit: limit, Edge: liveEdge})
		if err != nil {
			t.Fatal(err)
		}
		discard := slog.New(slog.DiscardHandler)
		log := replay.New(replay.Config{
			Frames: w.Bus().Frames,
			Header: replay.Header{Build: "test", Catalog: catalog.Version, Layout: physics.LayoutVersion, Capacity: capacity, Epoch: bubbleEpoch, Grace: liveGrace, Limit: limit},
			Dir:    dir,
			Log:    discard,
		})
		w.Record(log)
		lp := loop.New(loop.Config{World: w, Epoch: bubbleEpoch, Log: discard, AfterTick: func(tick int64) {
			if tick == stall {
				time.Sleep(2 * time.Second)
			}
		}})
		ctx, cancel := context.WithCancel(t.Context())
		done := make(chan struct{}, 4)
		go func() { log.Run(); done <- struct{}{} }()
		go func() { lp.Run(ctx); done <- struct{}{} }()
		go func() {
			scripted.Run(ctx, scripted.Config{N: sailors, Bus: w.Bus(), Seed: 1, Log: discard})
			done <- struct{}{}
		}()
		// Players come and go, and lose their connections, some coming back
		// within their grace; some wait for a boat, and of those some come
		// back from another connection and some give up; a developer changes
		// the wind and moves a boat; and admission is held for a moment now
		// and then.
		go func() {
			defer func() { done <- struct{}{} }()
			rng := rand.New(rand.NewPCG(2, 2))
			players, dev, owner := w.Bus().Commands.Players(), w.Bus().Commands.Developer(), w.Bus().Commands.Owner()
			type player struct {
				account    bus.Account
				boat, conn uint64
				slot       int32
				gen        uint16
			}
			var boats, waiting []player
			reply := make(chan bus.Reply, 1)
			conn := uint64(1)
			held := false
			join := func(a bus.Account) (bus.Reply, bool) {
				conn++
				players.TrySend(bus.Command{Op: bus.Join, Account: a, Conn: conn, Reply: reply})
				select {
				case rep := <-reply:
					return rep, true
				case <-ctx.Done():
					return bus.Reply{}, false
				}
			}
			for n := uint64(1); ; n++ {
				select {
				case <-ctx.Done():
					return
				case <-time.After(time.Duration(200+rng.IntN(800)) * time.Millisecond):
				}
				// A player's helm, stamped for a tick a little ahead; and
				// those the queue has given boats to find them.
				f := w.Bus().Frames.Acquire()
				if len(boats) > 0 {
					p := boats[rng.IntN(len(boats))]
					seq := uint32(f.Tick + 1 + int64(rng.IntN(4)))
					w.Bus().Controls.StoreHand(p.slot, bus.Pack(seq, uint16(rng.IntN(bus.Steps+1)), 600, p.gen))
				}
				for i := 0; i < len(waiting); {
					p := waiting[i]
					admitted := false
					for _, s := range f.Live {
						if f.Owner[s] == p.account && f.Conn[s] == p.conn {
							boats = append(boats, player{p.account, f.Boat[s], p.conn, s, f.Gen[s]})
							admitted = true
						}
					}
					if admitted {
						waiting = append(waiting[:i], waiting[i+1:]...)
					} else {
						i++
					}
				}
				f.Release()
				if held {
					// Admission held a moment, as while the database is behind.
					dev.TrySend(bus.Command{Op: bus.Hold})
					held = false
				}
				switch r := rng.IntN(18); {
				case r < 5:
					rep, ok := join(account(n))
					if !ok {
						return
					}
					switch rep.Result {
					case bus.Joined:
						boats = append(boats, player{account(n), rep.Boat, conn, rep.Slot, rep.Gen})
					case bus.Queued:
						waiting = append(waiting, player{account: account(n), conn: conn})
					}
				case r < 7 && len(boats) > 0:
					i := rng.IntN(len(boats))
					players.TrySend(bus.Command{Op: bus.Leave, Boat: boats[i].boat})
					boats = append(boats[:i], boats[i+1:]...)
				case r < 8 && len(boats) > 0:
					// A connection lost: the boat sails on, and leaves when
					// its grace ends, unless its sailor comes back first.
					i := rng.IntN(len(boats))
					players.TrySend(bus.Command{Op: bus.Disconnect, Boat: boats[i].boat, Conn: boats[i].conn})
					if rng.IntN(2) == 0 {
						boats = append(boats[:i], boats[i+1:]...)
					}
				case r < 9 && len(boats) > 0:
					i := rng.IntN(len(boats))
					rep, ok := join(boats[i].account)
					if !ok {
						return
					}
					boats[i].conn = conn
					if rep.Result == bus.Joined {
						boats[i].boat, boats[i].slot, boats[i].gen = rep.Boat, rep.Slot, rep.Gen
					}
				case r < 10 && len(waiting) > 0:
					i := rng.IntN(len(waiting))
					if rng.IntN(2) == 0 {
						// Gives up waiting.
						players.TrySend(bus.Command{Op: bus.Disconnect, Account: waiting[i].account, Conn: waiting[i].conn})
						waiting = append(waiting[:i], waiting[i+1:]...)
						break
					}
					// Comes back from another connection, keeping the place.
					if _, ok := join(waiting[i].account); !ok {
						return
					}
					waiting[i].conn = conn
				case r < 11:
					dev.TrySend(bus.Command{Op: bus.SetWeather, Weather: randomWeather(rng)})
				case r < 12:
					held = w.Bus().Commands.Server().TrySend(bus.Command{Op: bus.Hold, Held: true}) == nil
				case r < 13 && len(boats) > 0:
					// The owner's tools move a boat: to the start, or to
					// just inside the lip, to go over placed.
					p := boats[rng.IntN(len(boats))]
					st := physics.State{X: 8333, Heading: math.Pi / 2}
					owner.TrySend(bus.Command{Op: bus.Teleport, Boat: p.boat, State: st, Start: n%2 == 0})
				case r < 14 && len(boats) > 0:
					// A boat stays, as while its owner's free camera roams,
					// and sails on again.
					owner.TrySend(bus.Command{Op: bus.Stay, Boat: boats[rng.IntN(len(boats))].boat, On: rng.IntN(2) == 0})
				case r < 15 && len(boats) > 0:
					owner.TrySend(bus.Command{Op: bus.Unseen, Boat: boats[rng.IntN(len(boats))].boat, On: rng.IntN(2) == 0})
				case len(boats) > 0:
					// Moved to open water, to the lip to go over, or into
					// the mist band.
					st := physics.State{X: 100, Y: 100, Heading: 3}
					switch n % 3 {
					case 1:
						st = physics.State{X: 8331, Heading: math.Pi / 2, Surge: 3, SheetLimit: 0.6}
					case 2:
						st = physics.State{X: 8000, Heading: -math.Pi / 2, Surge: 3, SheetLimit: 0.6}
					}
					dev.TrySend(bus.Command{Op: bus.Place, Boat: boats[0].boat, State: st})
				}
			}
		}()
		time.Sleep(d)
		cancel()
		<-done
		<-done
		<-done
		log.Close()
		<-done
		out.end = sim.AppendSnapshot(nil, w.Latest())
		w.Close()
	})
	names, err := filepath.Glob(filepath.Join(dir, "*.log"))
	if err != nil || len(names) != 1 {
		t.Fatalf("logs %v, %v", names, err)
	}
	if out.log, err = os.ReadFile(names[0]); err != nil {
		t.Fatal(err)
	}
	return out
}

// replayLog replays a log and returns the result and the last frame's
// snapshot.
func replayLog(t *testing.T, data []byte, workers int) (replay.Result, []byte) {
	t.Helper()
	f, err := replay.Read(data)
	if err != nil {
		t.Fatal(err)
	}
	var end []byte
	res, err := replay.Run(f, replay.Options{Kinds: catalogKinds(t), Waves: catalogWaves(t), Weather: catalogWeather(t), Encounters: catalogEncounters(t), Workers: workers, Edge: liveEdge, At: func(fr *bus.Frame) {
		end = sim.AppendSnapshot(end[:0], fr)
	}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Diverged != nil {
		t.Fatalf("with %d workers: %v", workers, res.Diverged)
	}
	return res, end
}

func TestLiveToReplay(t *testing.T) {
	d := 5 * time.Minute
	if testing.Short() {
		d = time.Minute
	}
	session := sailLive(t, 200, 512, 220, d, 0)
	res, end := replayLog(t, session.log, 4)
	if want := int64(d / (time.Second / 30)); res.To != want {
		t.Errorf("replayed to tick %d, the session ran to %d", res.To, want)
	}
	if res.Digests < int(d/time.Second)-1 {
		t.Errorf("%d digests compared", res.Digests)
	}
	if !bytes.Equal(end, session.end) {
		t.Fatal("the replay's last frame differs from the session's")
	}
	// The same log replayed again gives the same bytes.
	if _, again := replayLog(t, session.log, 1); !bytes.Equal(again, end) {
		t.Fatal("two replays of one log differ")
	}
}

// TestFixture replays the committed log, which CI does on amd64 and arm64,
// with one worker and with eight. After a deliberate change to the physics
// or the tick, record it again and commit it:
//
//	go test ./internal/sim -run Fixture -update
func TestFixture(t *testing.T) {
	if *update {
		session := sailLive(t, 16, 64, 24, 70*time.Second, 600)
		if err := os.MkdirAll(filepath.Dir(fixture), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fixture, session.log, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s, %d bytes", fixture, len(session.log))
	}
	data, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	f, err := replay.Read(data)
	if err != nil {
		t.Fatal(err)
	}
	var skipped, held bool
	ops := map[bus.Op]bool{}
	results := map[bus.Result]bool{}
	for _, seg := range f.Segments {
		for _, r := range seg.Records {
			skipped = skipped || r.Skipped > 0
			for _, e := range r.Events {
				ops[e.Op] = true
				results[e.Reply.Result] = true
			}
			for _, c := range r.Changed {
				// A word applied after the tick its writer read: held for its tick.
				held = held || int32(c.Word.Seq()-uint32(r.Tick)) == 0 && c.Word.Seq() != 0
			}
		}
	}
	if !skipped || len(ops) != len(bus.Ops) || len(f.Segments) < 3 || !results[bus.Expired] || !results[bus.Rejoined] || !held ||
		!results[bus.Queued] || !results[bus.Admitted] || !results[bus.Dequeued] || f.Header.Limit != 24 {
		t.Fatalf("the fixture lacks a skip (%v), an op (%v), a grace that ended or was cut short, a wait, an admission or one who gave up waiting (%v), a held word (%v), segments (%d) or its limit",
			skipped, ops, results, held, len(f.Segments))
	}
	_, one := replayLog(t, data, 1)
	_, eight := replayLog(t, data, 8)
	if !bytes.Equal(one, eight) {
		t.Fatal("one worker and eight end in different worlds")
	}
}

// A recording of the client's sandbox, as internal/physics's tests read it.
type recording struct {
	Sea       map[string]float64 `json:"sea"`
	Params    map[string]any     `json:"params"`
	Wind      map[string]any     `json:"wind"`
	Scenarios []struct {
		Name    string             `json:"name"`
		Steps   int                `json:"steps"`
		State   map[string]float64 `json:"state"`
		Control map[string]float64 `json:"control"`
		// Sea is the sea of step 0: its tick, and its areas' inputs;
		// Weather the spells in play then.
		Sea struct {
			Tick  int64       `json:"tick"`
			Areas [][3]uint32 `json:"areas"`
		} `json:"sea"`
		Weather struct {
			Tick   int64            `json:"tick"`
			Spells []map[string]any `json:"spells"`
		} `json:"weather"`
		Changes []struct {
			At      int                `json:"at"`
			Control map[string]float64 `json:"control"`
			// Set is a developer's weather the sandbox set at this step,
			// and Spells the spells in play from it on.
			Set *struct {
				Mode   uint8  `json:"mode"`
				Regime uint16 `json:"regime"`
				Speed  uint32 `json:"speed"`
				Dir    uint32 `json:"dir"`
			} `json:"set"`
			Spells []map[string]any `json:"spells"`
		} `json:"changes"`
		End map[string]string `json:"end"`
	} `json:"scenarios"`
}

// TestSandboxRecordings sails each recorded sandbox sail through the tick:
// a world whose own weather is the recording's first spell, the Join, then
// the recording's start placed, its controls given as control words at
// their steps, and the developer's weathers the sandbox set given at the
// ticks it set them, each step at the tick the sandbox sailed it. The boat
// sailed in the browser, in the wind and the sea the sandbox computed by
// the server's rules, is the boat the server's tick sails.
func TestSandboxRecordings(t *testing.T) {
	paths, err := filepath.Glob("../physics/testdata/recordings/*.json")
	if err != nil || len(paths) == 0 {
		t.Fatalf("no recordings: %v", err)
	}
	for _, path := range paths {
		var rec recording
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, &rec); err != nil {
			t.Fatal(err)
		}
		var seaParams physics.SeaParams
		setFloats(t, &seaParams, rec.Sea)
		waves := new(physics.Waves)
		physics.PrepareSea(&seaParams, waves)
		var params physics.Params
		setFields(t, &params, rec.Params)
		var kind physics.Prepared
		physics.Prepare(&params, waves, &kind)
		// The sandbox sailed in the catalog's wind.
		var windParams physics.WeatherParams
		setFields(t, &windParams, rec.Wind)
		cat, err := catalog.Load()
		if err != nil {
			t.Fatal(err)
		}
		if windParams != catalog.WeatherParams(cat) {
			t.Fatalf("%s: its wind values are not the catalog's", path)
		}
		for _, sc := range rec.Scenarios {
			t.Run(filepath.Base(path)+"/"+sc.Name, func(t *testing.T) {
				if len(sc.Weather.Spells) != 1 || sc.Weather.Tick != sc.Sea.Tick {
					t.Fatalf("the sail starts in %d spells at tick %d, its sea at %d", len(sc.Weather.Spells), sc.Weather.Tick, sc.Sea.Tick)
				}
				var first physics.Spell
				setFields(t, &first, sc.Weather.Spells[0])
				// The Join, in the tick before step 0's.
				w, err := sim.New(sim.Config{Capacity: 4, Kinds: []physics.Prepared{kind}, Waves: waves, Workers: 1,
					Tick: sc.Sea.Tick - 2, Weather: catalogWeather(t).Fixed(first)})
				if err != nil {
					t.Fatal(err)
				}
				defer w.Close()
				w.TickWith(&sim.Input{Commands: []bus.Command{{Op: bus.Join, Account: account(1)}}})
				f := w.Latest()
				slot, boat, gen := f.Live[0], f.Boat[f.Live[0]], f.Gen[f.Live[0]]
				if f.Tick != sc.Sea.Tick-1 {
					t.Fatalf("before step 0 the world is at tick %d", f.Tick)
				}

				var start physics.State
				setFloats(t, &start, sc.State)
				helm, sheet := sc.Control["helm"], sc.Control["sheet"]
				// The autopilot's control, as whole numbers.
				pilot := [4]float64{sc.Control["pilot"], sc.Control["target"], sc.Control["order"], sc.Control["way"]}
				next := 0
				for step := range sc.Steps {
					in := &sim.Input{}
					changed := step == 0
					if step == 0 {
						in.Commands = append(in.Commands, bus.Command{Op: bus.Place, Boat: boat, State: start})
					}
					var spells []map[string]any
					for ; next < len(sc.Changes) && sc.Changes[next].At == step; next++ {
						ch := sc.Changes[next]
						if v, ok := ch.Control["helm"]; ok {
							helm, changed = v, true
						}
						if v, ok := ch.Control["sheet"]; ok {
							sheet, changed = v, true
						}
						for i, name := range []string{"pilot", "target", "order", "way"} {
							if v, ok := ch.Control[name]; ok {
								pilot[i], changed = v, true
							}
						}
						if s := ch.Set; s != nil {
							in.Commands = append(in.Commands, bus.Command{Op: bus.SetWeather, Weather: bus.Weather{
								Mode: bus.WeatherMode(s.Mode), Regime: s.Regime, Speed: s.Speed, Dir: s.Dir}})
						}
						if ch.Spells != nil {
							spells = ch.Spells
						}
					}
					if changed {
						in.Changed = []bus.SlotWord{{Slot: slot, Word: bus.Pack(uint32(step), index(t, helm, -1, 1), index(t, sheet, 0, 1), gen),
							Pilot: bus.PackPilot(uint32(step), uint8(pilot[0]), uint8(pilot[3]), uint8(pilot[2]), uint16(pilot[1]), gen)}}
					}
					w.TickWith(in)
					// The spell the sandbox set is the one the server set.
					if len(spells) > 0 {
						var want physics.Spell
						setFields(t, &want, spells[len(spells)-1])
						f := w.Latest()
						if got := f.Spells[f.NSpells-1]; got != want {
							t.Fatalf("step %d: the server's spell is %+v, the sandbox's %+v", step, got, want)
						}
					}
				}
				got := w.Latest().State[slot]
				names := stateNames()
				for i, v := range sim.StateFields(&got) {
					if want := sc.End[names[i]]; fmt.Sprintf("%#016x", math.Float64bits(*v)) != want {
						t.Errorf("after %d steps %s is %v (%#016x), the sandbox reached %s", sc.Steps, names[i], *v, math.Float64bits(*v), want)
					}
				}
			})
		}
	}
}

// randomWeather is a developer's weather drawn at random: a steady wind,
// one of the catalog's regimes held, or the world's own.
func randomWeather(rng *rand.Rand) bus.Weather {
	switch rng.IntN(3) {
	case 0:
		return weather.Steady(3+6*rng.Float64(), 2*math.Pi*rng.Float64())
	case 1:
		return bus.Weather{Mode: bus.WeatherHeld, Regime: uint16(rng.IntN(4))}
	}
	return bus.Weather{Mode: bus.WeatherAuto}
}

// index is a control's value as a step of its range; it must be one exactly.
func index(t *testing.T, v, lo, hi float64) uint16 {
	t.Helper()
	k := (v - lo) / (hi - lo) * bus.Steps
	if k != math.Trunc(k) || k < 0 || k > bus.Steps {
		t.Fatalf("%v is not on a step of [%v, %v]", v, lo, hi)
	}
	return uint16(k)
}

func stateNames() []string {
	t := reflect.TypeFor[physics.State]()
	names := make([]string, t.NumField())
	for i := range names {
		names[i] = lowerFirst(t.Field(i).Name)
	}
	return names
}

func lowerFirst(s string) string {
	r, n := utf8.DecodeRuneInString(s)
	return string(unicode.ToLower(r)) + s[n:]
}

func setFloats(t *testing.T, record any, values map[string]float64) {
	t.Helper()
	m := map[string]any{}
	for k, v := range values {
		m[k] = v
	}
	setFields(t, record, m)
}

// setFields sets a record's fields from values named as the client names
// them: numbers, or arrays of numbers.
func setFields(t *testing.T, record any, values map[string]any) {
	t.Helper()
	v := reflect.ValueOf(record).Elem()
	for name, x := range values {
		f := v.FieldByNameFunc(func(n string) bool { return lowerFirst(n) == name })
		if !f.IsValid() {
			t.Fatalf("%s has no field %s", v.Type().Name(), name)
		}
		switch x := x.(type) {
		case float64:
			f.SetFloat(x)
		case []any:
			for i, e := range x {
				f.Index(i).SetFloat(e.(float64))
			}
		default:
			t.Fatalf("%s: %v", name, strconv.Quote(fmt.Sprint(x)))
		}
	}
}

// TestPilotReplaysMidTurn: sailors on the autopilot, tacking and gybing
// every ten to twenty seconds, are replayed tick for tick from the log's
// start and from each of its later checkpoints, at least one of which was
// taken with a boat in the middle of a turn: what the autopilot remembers
// is in the state the checkpoint holds.
func TestPilotReplaysMidTurn(t *testing.T) {
	const capacity = 16
	dir := t.TempDir()
	synctest.Test(t, func(t *testing.T) {
		w, err := sim.New(sim.Config{Capacity: capacity, Kinds: catalogKinds(t), Waves: catalogWaves(t), Weather: catalogWeather(t), Encounters: catalogEncounters(t), Workers: 2, Tick: loop.TickAt(time.Now(), bubbleEpoch)})
		if err != nil {
			t.Fatal(err)
		}
		discard := slog.New(slog.DiscardHandler)
		log := replay.New(replay.Config{
			Frames: w.Bus().Frames,
			Header: replay.Header{Build: "test", Catalog: catalog.Version, Layout: physics.LayoutVersion, Capacity: capacity, Epoch: bubbleEpoch, Grace: sim.GraceTicks},
			Dir:    dir,
			Log:    discard,
		})
		w.Record(log)
		lp := loop.New(loop.Config{World: w, Epoch: bubbleEpoch, Log: discard})
		ctx, cancel := context.WithCancel(t.Context())
		done := make(chan struct{}, 3)
		go func() { log.Run(); done <- struct{}{} }()
		go func() { lp.Run(ctx); done <- struct{}{} }()
		go func() {
			scripted.Run(ctx, scripted.Config{N: 12, Bus: w.Bus(), Seed: 3, Log: discard, MinTurn: 10 * time.Second, MaxTurn: 20 * time.Second})
			done <- struct{}{}
		}()
		time.Sleep(4 * replay.SegmentTicks * time.Second / physics.StepsPerSecond)
		cancel()
		<-done
		<-done
		log.Close()
		<-done
		w.Close()
	})
	names, err := filepath.Glob(filepath.Join(dir, "*.log"))
	if err != nil || len(names) != 1 {
		t.Fatalf("logs %v, %v", names, err)
	}
	data, err := os.ReadFile(names[0])
	if err != nil {
		t.Fatal(err)
	}
	f, err := replay.Read(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.Segments) < 3 {
		t.Fatalf("%d segments", len(f.Segments))
	}
	midTurn := 0
	for k := range f.Segments {
		frame := bus.NewFrame(capacity)
		if err := sim.ReadSnapshot(f.Segments[k].Snapshot, frame); err != nil {
			t.Fatal(err)
		}
		turning := false
		for _, s := range frame.Live {
			turning = turning || frame.State[s].PilotWay != physics.WayHold
		}
		if k > 0 && turning {
			midTurn++
		}
		from := *f
		from.Segments = f.Segments[k:]
		res, err := replay.Run(&from, replay.Options{Kinds: catalogKinds(t), Waves: catalogWaves(t), Weather: catalogWeather(t), Encounters: catalogEncounters(t), Workers: 2})
		if err != nil {
			t.Fatal(err)
		}
		if res.Diverged != nil || res.Digests == 0 {
			t.Fatalf("from checkpoint %d (a boat turning: %v): %d digests, %v", k, turning, res.Digests, res.Diverged)
		}
	}
	if midTurn == 0 {
		t.Fatal("no checkpoint after the first was taken with a boat in the middle of a turn")
	}
}
