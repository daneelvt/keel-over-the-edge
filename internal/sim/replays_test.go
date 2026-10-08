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

// sailLive runs sailors through the clocked loop for d in a synctest
// bubble, with players joining and leaving besides, developer commands now
// and then, and a tick stalled at stall (if not zero) to force a skip.
func sailLive(t *testing.T, sailors, capacity int, d time.Duration, stall int64) live {
	var out live
	dir := t.TempDir()
	synctest.Test(t, func(t *testing.T) {
		w, err := sim.New(sim.Config{Capacity: capacity, Kinds: catalogKinds(t), Workers: 4, Tick: loop.TickAt(time.Now(), bubbleEpoch)})
		if err != nil {
			t.Fatal(err)
		}
		discard := slog.New(slog.DiscardHandler)
		log := replay.New(replay.Config{
			Frames: w.Bus().Frames,
			Header: replay.Header{Build: "test", Catalog: catalog.Version, Layout: physics.LayoutVersion, Capacity: capacity, Epoch: bubbleEpoch},
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
		// Players come and go; a developer changes the wind and moves a boat.
		go func() {
			defer func() { done <- struct{}{} }()
			rng := rand.New(rand.NewPCG(2, 2))
			players, dev := w.Bus().Commands.Players(), w.Bus().Commands.Developer()
			var boats []uint64
			reply := make(chan bus.Reply, 1)
			for account := uint64(1); ; account++ {
				select {
				case <-ctx.Done():
					return
				case <-time.After(time.Duration(200+rng.IntN(800)) * time.Millisecond):
				}
				switch r := rng.IntN(10); {
				case r < 5:
					players.TrySend(bus.Command{Op: bus.Join, Account: account, Reply: reply})
					select {
					case rep := <-reply:
						if rep.Result == bus.Joined {
							boats = append(boats, rep.Boat)
						}
					case <-ctx.Done():
						return
					}
				case r < 8 && len(boats) > 0:
					i := rng.IntN(len(boats))
					players.TrySend(bus.Command{Op: bus.Leave, Boat: boats[i]})
					boats = append(boats[:i], boats[i+1:]...)
				case r < 9:
					dev.TrySend(bus.Command{Op: bus.SetWind, Wind: bus.Wind{Speed: 3 + 6*rng.Float64(), From: 2 * math.Pi * rng.Float64()}})
				case len(boats) > 0:
					dev.TrySend(bus.Command{Op: bus.Place, Boat: boats[0], State: physics.State{X: 100, Y: 100, Heading: 3}})
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
	session := sailLive(t, 200, 512, d, 0)
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
		session := sailLive(t, 16, 64, 70*time.Second, 600)
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
	var skipped bool
	ops := map[bus.Op]bool{}
	for _, seg := range f.Segments {
		for _, r := range seg.Records {
			skipped = skipped || r.Skipped > 0
			for _, e := range r.Events {
				ops[e.Op] = true
			}
		}
	}
	if !skipped || len(ops) != len(bus.Ops) || len(f.Segments) < 3 {
		t.Fatalf("the fixture lacks a skip (%v), an op (%v) or segments (%d)", skipped, ops, len(f.Segments))
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
				w.TickWith(&sim.Input{Commands: []bus.Command{{Op: bus.Join, Account: 1}}})
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
