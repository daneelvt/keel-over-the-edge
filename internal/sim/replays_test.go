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
)

// The replay tests: a world sailed through the real loop by scripted
// sailors replays, unclocked, to the same world; a log committed once replays
// the same on every machine and with any number of workers; and a sail
// recorded in the client's sandbox, sailed by the tick, ends where the
// browser's did.

var update = flag.Bool("update", false, "record testdata/replays/fixture.log again")

const fixture = "testdata/replays/fixture.log"

var bubbleEpoch = time.Date(2000, time.January, 1, 0, 0, 0, 0, time.UTC)

func catalogKinds(t testing.TB) []physics.Prepared {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	ks := make([]physics.Prepared, len(cat.Boats))
	for i := range cat.Boats {
		p := catalog.PhysicsParams(&cat.Boats[i])
		physics.Prepare(&p, &ks[i])
	}
	return ks
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
func sailLive(t *testing.T, sailors, capacity, limit int, d time.Duration, stall int64) live {
	var out live
	dir := t.TempDir()
	synctest.Test(t, func(t *testing.T) {
		w, err := sim.New(sim.Config{Capacity: capacity, Kinds: catalogKinds(t), Workers: 4, Tick: loop.TickAt(time.Now(), bubbleEpoch), Grace: liveGrace, Limit: limit})
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
			players, dev := w.Bus().Commands.Players(), w.Bus().Commands.Developer()
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
					w.Bus().Controls.Store(p.slot, bus.Pack(seq, uint16(rng.IntN(bus.Steps+1)), 600, p.gen))
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
				switch r := rng.IntN(15); {
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
					dev.TrySend(bus.Command{Op: bus.SetWind, Wind: bus.Wind{Speed: 3 + 6*rng.Float64(), From: 2 * math.Pi * rng.Float64()}})
				case r < 12:
					held = w.Bus().Commands.Server().TrySend(bus.Command{Op: bus.Hold, Held: true}) == nil
				case len(boats) > 0:
					dev.TrySend(bus.Command{Op: bus.Place, Boat: boats[0].boat, State: physics.State{X: 100, Y: 100, Heading: 3}})
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
	res, err := replay.Run(f, replay.Options{Kinds: catalogKinds(t), Workers: workers, At: func(fr *bus.Frame) {
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
	Params    map[string]any `json:"params"`
	Scenarios []struct {
		Name    string             `json:"name"`
		Steps   int                `json:"steps"`
		State   map[string]float64 `json:"state"`
		Control map[string]float64 `json:"control"`
		Env     map[string]float64 `json:"env"`
		Changes []struct {
			At      int                `json:"at"`
			Control map[string]float64 `json:"control"`
			Env     map[string]float64 `json:"env"`
		} `json:"changes"`
		End map[string]string `json:"end"`
	} `json:"scenarios"`
}

// TestSandboxRecordings sails each recorded sandbox sail through the tick:
// a Join, then the recording's start placed and its wind set, and its
// controls given as control words at their steps. The boat sailed in the
// browser is the boat the server's tick sails.
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
		var params physics.Params
		setFields(t, &params, rec.Params)
		var kind physics.Prepared
		physics.Prepare(&params, &kind)
		for _, sc := range rec.Scenarios {
			t.Run(filepath.Base(path)+"/"+sc.Name, func(t *testing.T) {
				w, err := sim.New(sim.Config{Capacity: 4, Kinds: []physics.Prepared{kind}, Workers: 1})
				if err != nil {
					t.Fatal(err)
				}
				defer w.Close()
				w.TickWith(&sim.Input{Commands: []bus.Command{{Op: bus.Join, Account: account(1)}}})
				f := w.Latest()
				slot, boat, gen := f.Live[0], f.Boat[f.Live[0]], f.Gen[f.Live[0]]

				var start physics.State
				setFloats(t, &start, sc.State)
				helm, sheet := sc.Control["helm"], sc.Control["sheet"]
				wind := bus.Wind{Speed: sc.Env["windSpeed"], From: sc.Env["windFrom"]}
				next := 0
				for step := range sc.Steps {
					in := &sim.Input{}
					changed := step == 0
					if step == 0 {
						in.Commands = append(in.Commands,
							bus.Command{Op: bus.Place, Boat: boat, State: start},
							bus.Command{Op: bus.SetWind, Wind: wind})
					}
					for ; next < len(sc.Changes) && sc.Changes[next].At == step; next++ {
						ch := sc.Changes[next]
						if v, ok := ch.Control["helm"]; ok {
							helm, changed = v, true
						}
						if v, ok := ch.Control["sheet"]; ok {
							sheet, changed = v, true
						}
						if ch.Env != nil {
							if v, ok := ch.Env["windSpeed"]; ok {
								wind.Speed = v
							}
							if v, ok := ch.Env["windFrom"]; ok {
								wind.From = v
							}
							in.Commands = append(in.Commands, bus.Command{Op: bus.SetWind, Wind: wind})
						}
					}
					if changed {
						in.Changed = []bus.SlotWord{{Slot: slot, Word: bus.Pack(uint32(step), index(t, helm, -1, 1), index(t, sheet, 0, 1), gen)}}
					}
					w.TickWith(in)
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
