// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"net"
	"os"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
)

var update = flag.Bool("update", false, "record the traces in shared/protocol/testdata again")

// recorded is the controls of the sandbox's recorded sail, a minute long,
// as indices for each step, played again and again.
func recorded(t *testing.T) Controls {
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
func sail(t *testing.T, lag Lag, d time.Duration, trace *Trace) Stats {
	t.Helper()
	var stats Stats
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{})
		token, _ := srv.Guest("Ann")
		o := DialOptions{Cookie: token}
		if lag != (Lag{}) {
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

func report(t *testing.T, name string, s Stats, d time.Duration) {
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
	s := sail(t, Lag{}, d, nil)
	report(t, "no lag", s, d)
	if s.Corrections != 0 || s.Snapshots < int(d.Seconds())*15-30 {
		t.Fatalf("%d corrections in %d snapshots", s.Corrections, s.Snapshots)
	}
}

// TestSailDelay: 100 ms each way and no loss: still not one correction.
func TestSailDelay(t *testing.T) {
	d := sailLength()
	s := sail(t, Lag{Delay: 100 * time.Millisecond}, d, nil)
	report(t, "100 ms each way", s, d)
	if s.Corrections != 0 || s.Snapshots < int(d.Seconds())*15-30 {
		t.Fatalf("%d corrections in %d snapshots", s.Corrections, s.Snapshots)
	}
}

// TestSailLoss: 100 ms each way and 2% of packets lost each way, over ten
// seeds: corrections come, but none over the snap thresholds.
func TestSailLoss(t *testing.T) {
	d := sailLength()
	if testing.Short() {
		d = 30 * time.Second
	}
	var all Stats
	for seed := range uint64(10) {
		s := sail(t, Lag{Delay: 100 * time.Millisecond, Loss: 0.02, Seed: seed + 1}, d, nil)
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
}

// TestTraces records, with -update, the traces the TypeScript tests replay:
// with no lag, and at 200 ms and 2% loss; and replays the committed ones
// through this package's own client, as the TypeScript tests replay them
// through the page's.
func TestTraces(t *testing.T) {
	for _, tc := range []struct {
		name string
		lag  Lag
	}{
		{"none", Lag{}},
		{"lossy", Lag{Delay: 100 * time.Millisecond, Loss: 0.02, Seed: 3}},
	} {
		path := "../../../shared/protocol/testdata/trace-" + tc.name + ".json"
		if *update {
			trace := &Trace{Lag: tc.lag.String()}
			sail(t, tc.lag, 20*time.Second, trace)
			if err := trace.Write(path); err != nil {
				t.Fatal(err)
			}
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var trace Trace
		if err := json.Unmarshal(data, &trace); err != nil {
			t.Fatal(err)
		}
		corrections := replayTrace(t, &trace, CatalogKinds(t))
		if (tc.name == "lossy") != (corrections > 0) {
			t.Errorf("%s: %d corrections", tc.name, corrections)
		}
	}
}

// replayTrace gives a trace's events, at their times, to a Net and a
// Predictor of its own, and checks they send the same messages and
// reconcile each snapshot alike. It returns the corrections.
func replayTrace(t *testing.T, trace *Trace, kinds []physics.Prepared) (corrections int) {
	t.Helper()
	n := Net{FrameMs: 17}
	p := NewPredictor(&kinds[0])
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
			if ev.Snapshot != nil {
				snapshots[ev.Snapshot.Tick] = ev.Snapshot
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
			if o.Stale != e.Snap.Stale || o.Reset != e.Snap.Reset || o.Corrected != e.Snap.Corrected || o.Distance != e.Snap.Distance {
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
		lag := Lag{Delay: 100 * time.Millisecond}
		// The tiller dragged to and fro: a word every step.
		wiggle := func(n int) (uint16, uint16) { return uint16(256 + n%512), 512 }
		var conn Staller
		s := srv.NewSailor(DialOptions{Cookie: token, Wrap: func(c net.Conn) net.Conn {
			w := lag.Wrap(c)
			conn = w.(Staller)
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
		}
		sailFor(10 * time.Second)
		time.Sleep(20 * time.Second)
		sailFor(5 * time.Second)
		time.Sleep(70 * time.Second)
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

func TestParseLag(t *testing.T) {
	l, err := ParseLag("200ms,2%")
	if err != nil || l.Delay != 100*time.Millisecond || l.Loss != 0.02 || l.String() != "200ms,2%" {
		t.Fatalf("%+v, %v", l, err)
	}
	for _, bad := range []string{"", "fast", "200ms,x", "200ms,100%", "-1s"} {
		if _, err := ParseLag(bad); err == nil {
			t.Errorf("%q read", bad)
		}
	}
}

// TestLagLine: chunks keep their order, a lost chunk holds up those behind
// it, a seed repeats a run, and the delays are as the model says.
func TestLagLine(t *testing.T) {
	lag := Lag{Delay: 100 * time.Millisecond, Loss: 0.02, Seed: 9}
	a, b := lag.NewLine(1), lag.NewLine(1)
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	const n = 200_000
	var held, retransmitted, blocked int
	var last time.Time
	for i := range n {
		// A chunk every 10 ms: a lost one holds up those for 400 ms after.
		now := start.Add(time.Duration(i) * 10 * time.Millisecond)
		at := a.Hold(now)
		if at != b.Hold(now) {
			t.Fatal("one seed, two runs")
		}
		if at.Before(last) {
			t.Fatal("a chunk overtook the one before it")
		}
		switch d := at.Sub(now); {
		case d < lag.Delay:
			t.Fatalf("a chunk took %v", d)
		case d >= lag.Delay+4*lag.Delay+Retransmission && at != last:
			retransmitted++
		case d >= lag.Delay+4*lag.Delay && at != last:
			held++
		case at == last:
			blocked++
		}
		last = at
	}
	if p := float64(held+retransmitted) / n; math.Abs(p-0.02) > 0.002 {
		t.Errorf("%.4f of chunks lost, want 0.02", p)
	}
	if p := float64(retransmitted) / n; p < 0.0002 || p > 0.0007 {
		t.Errorf("%.5f of chunks lost twice, want 0.0004", p)
	}
	if blocked == 0 {
		t.Error("no chunk was held up behind a lost one")
	}
}

// TestLagConn: bytes written through the model arrive after its delay, in
// order, and closing sends what was written first.
func TestLagConn(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		client, server := net.Pipe()
		c := Lag{Delay: 50 * time.Millisecond}.Wrap(client)
		go func() {
			for i := range 10 {
				c.Write([]byte{byte(i)})
			}
			c.Close()
		}()
		start := time.Now()
		got, err := io.ReadAll(server)
		if err != nil || string(got) != "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09" {
			t.Fatalf("%v, %v", got, err)
		}
		if d := time.Since(start); d != 50*time.Millisecond {
			t.Fatalf("arrived after %v", d)
		}
	})
}

// TestProxy: bytes through the proxy, on real loopback sockets, arrive in
// order after the delay.
func TestProxy(t *testing.T) {
	back, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer back.Close()
	go func() {
		c, err := back.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		io.Copy(c, c) // an echo
	}()
	front, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go Proxy(t.Context(), front, back.Addr().String(), Lag{Delay: 20 * time.Millisecond, Seed: 1})
	c, err := net.Dial("tcp", front.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	start := time.Now()
	c.Write([]byte("keel"))
	buf := make([]byte, 4)
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "keel" {
		t.Fatalf("%q, %v", buf, err)
	}
	if d := time.Since(start); d < 40*time.Millisecond {
		t.Fatalf("an echo through 20 ms each way took %v", d)
	}
}
