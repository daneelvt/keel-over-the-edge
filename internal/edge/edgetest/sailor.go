// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"os"
	"sort"
	"time"

	"github.com/coder/websocket"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
)

// Controls gives the helm and the sheet, as indices, for the n-th step a
// sailor takes.
type Controls func(n int) (helm, sheet uint16)

// Stats are what a sail saw.
type Stats struct {
	Snapshots   int
	Corrections int
	Resets      int
	Stale       int       // snapshots older than the prediction kept
	Over        int       // corrections drawn at once: over the snap thresholds
	Sizes       []float64 // each correction's distance, m
	Steps       int
	MaxAhead    int
	MaxLate     int // the most ticks an input arrived late
	BytesIn     int
	BytesOut    int
	Reconnects  int
}

// Percentile is the p-th percentile of the corrections' sizes.
func (s *Stats) Percentile(p float64) float64 {
	if len(s.Sizes) == 0 {
		return 0
	}
	v := append([]float64(nil), s.Sizes...)
	sort.Float64s(v)
	return v[min(len(v)-1, int(math.Ceil(p/100*float64(len(v))))-1)]
}

// Sailor is the page's game connection in Go: it connects, keeps the clock,
// steps its boat ahead of the server with physics.Step, reconciles each
// snapshot and sends its controls, frame by frame, as the page and its net
// worker do; and it records a trace of all that.
type Sailor struct {
	srv  *Server
	opts DialOptions
	kind *physics.Prepared

	ws    *websocket.Conn
	inbox *Inbox
	start time.Time

	Net       Net
	Ahead     Ahead
	Predictor *Predictor
	controls  Controls
	stepN     int
	sent      [2]int // the indices last sent: none at first
	fresh     bool   // a Welcome has come, its first snapshot not yet
	latest    *protocol.Snapshot
	queued    []*protocol.Snapshot

	Welcomes []WelcomeSeen
	Stats    Stats
	Trace    *Trace
	// Ms is m after each snapshot, with its time, for the tests.
	Ms []MSeen
}

// WelcomeSeen is a Welcome's boat.
type WelcomeSeen struct {
	Boat     uint64
	Rejoined bool
}

// MSeen is how far ahead the sailor ran, from when.
type MSeen struct {
	At time.Duration
	M  int
}

// NewSailor makes a sailor that connects as o says and steers with
// controls.
func (s *Server) NewSailor(o DialOptions, controls Controls) *Sailor {
	return &Sailor{
		srv: s, opts: o, kind: &s.Kinds[0], controls: controls,
		start: time.Now(), Ahead: NewAhead(), Predictor: NewPredictor(&s.Kinds[0]),
		Net: Net{FrameMs: 17}, sent: [2]int{-1, -1},
	}
}

func (s *Sailor) now() float64 { return float64(time.Since(s.start).Microseconds()) }

// Connect opens the connection and says Hello.
func (s *Sailor) Connect(ctx context.Context) error {
	ws, _, err := s.srv.Dial(ctx, s.opts)
	if err != nil {
		return err
	}
	s.ws = ws
	s.inbox = Read(ws)
	for _, b := range s.Net.Open(s.now()) {
		if err := s.send(ctx, b); err != nil {
			return err
		}
	}
	return nil
}

// Drop closes the connection at once, as a phone losing its network does.
func (s *Sailor) Drop() {
	if s.ws != nil {
		s.ws.CloseNow()
		for range s.inbox.C {
		}
		s.ws = nil
	}
}

func (s *Sailor) send(ctx context.Context, b []byte) error {
	s.Trace.add(s.now(), "out", b)
	s.Stats.BytesOut += len(b)
	return s.ws.Write(ctx, websocket.MessageBinary, b)
}

// Sail runs the client for d, or until the connection ends.
func (s *Sailor) Sail(ctx context.Context, d time.Duration) error {
	end := time.Now().Add(d)
	frame := time.NewTicker(time.Second / 60)
	defer frame.Stop()
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()
	for time.Now().Before(end) {
		s.arm(timer)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case r, ok := <-s.inbox.C:
			if !ok {
				return s.inbox.Err()
			}
			now := s.now()
			s.Trace.add(now, "in", r.Bytes)
			s.Stats.BytesIn += len(r.Bytes)
			_, ev, err := s.Net.Receive(now, r.Bytes)
			if err != nil {
				return err
			}
			if w := ev.Welcome; w != nil {
				s.Welcomes = append(s.Welcomes, WelcomeSeen{Boat: w.GetBoat(), Rejoined: w.GetRejoined()})
				s.fresh = true
			}
			if ev.Snapshot != nil {
				s.queued = append(s.queued, ev.Snapshot)
			}
		case <-timer.C:
			now := s.now()
			s.Trace.mark(now, "timer")
			out, dead := s.Net.Time(now)
			if dead {
				return errors.New("edgetest: no pong for 6 s")
			}
			for _, b := range out {
				if err := s.send(ctx, b); err != nil {
					return err
				}
			}
		case <-frame.C:
			if err := s.frame(ctx); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Sailor) arm(timer *time.Timer) {
	timer.Stop()
	d := s.Net.Deadline()
	if math.IsInf(d, 1) {
		return
	}
	timer.Reset(max(0, s.start.Add(time.Duration(d)*time.Microsecond).Sub(time.Now())))
}

// frame is the page's animation frame: the snapshots that came are
// reconciled, then the boat is stepped to the tick it should be at.
func (s *Sailor) frame(ctx context.Context) error {
	now := s.now()
	for _, sn := range s.queued {
		s.Stats.Snapshots++
		s.Ahead.Margin(int(sn.Margin), now, s.Net.Clock.RTT)
		if sn.Margin != protocol.NoMargin && sn.Margin < 0 {
			s.Stats.MaxLate = max(s.Stats.MaxLate, -int(sn.Margin))
		}
		s.Ms = append(s.Ms, MSeen{At: time.Duration(now) * time.Microsecond, M: s.Ahead.M})
		s.Stats.MaxAhead = max(s.Stats.MaxAhead, s.Ahead.M)
		if s.fresh {
			// On each connection the controls start at the indices in
			// force: the word the server holds.
			s.sent = [2]int{int(sn.Helm), int(sn.Sheet)}
			s.fresh = false
		}
		o := s.Predictor.Snapshot(sn)
		s.Trace.snap(now, sn.Tick, o)
		switch {
		case o.Stale:
			s.Stats.Stale++
		case o.Reset:
			s.Stats.Resets++
		case o.Corrected:
			s.Stats.Corrections++
			s.Stats.Sizes = append(s.Stats.Sizes, o.Distance)
			if o.Over() {
				s.Stats.Over++
			}
		}
		s.latest = sn
	}
	s.queued = s.queued[:0]
	p := s.Predictor
	if !p.Started || !s.Net.Clock.Have {
		return nil
	}
	world := s.Net.Clock.WorldUs(now)
	target := Target(world, s.Net.Clock.RTT, s.Ahead.M)
	if target-p.Tick > Behind && s.latest != nil && s.latest.Tick > p.Tick {
		p.Reset(s.latest)
		s.Stats.Resets++
		s.Trace.mark(now, "reset")
	}
	// A step for a tick an input sent now would reach too late, as when
	// catching up, keeps the controls the server holds; so do all until the
	// clock knows the round trip.
	reach := Target(world, s.Net.Clock.RTT, 0)
	if s.Net.Clock.Rough {
		reach = math.MaxInt64
	}
	for steps := min(MaxSteps, target-p.Tick); steps > 0; steps-- {
		if p.Tick+1 < reach {
			p.Step(uint16(s.sent[0]), uint16(s.sent[1]))
			s.Stats.Steps++
			s.Trace.step(now, p.Tick, uint16(s.sent[0]), uint16(s.sent[1]))
			continue
		}
		helm, sheet := s.controls(s.stepN)
		s.stepN++
		p.Step(helm, sheet)
		s.Stats.Steps++
		s.Trace.step(now, p.Tick, helm, sheet)
		if int(helm) != s.sent[0] || int(sheet) != s.sent[1] {
			s.sent = [2]int{int(helm), int(sheet)}
			s.Trace.input(now, p.Tick, helm, sheet)
			if err := s.send(ctx, s.Net.Input(now, uint32(p.Tick), helm, sheet)); err != nil {
				return err
			}
		}
	}
	return nil
}

// Trace is what a sail did, in order, with its times in microseconds: the
// messages each way, the page's steps and inputs, and each snapshot's
// outcome. The TypeScript tests replay it through the client's own code.
type Trace struct {
	Lag    string       `json:"lag"`
	Events []TraceEvent `json:"events"`
}

// A TraceEvent is one of: a message in or out (hex), the worker's timer, a
// step, an input, a snapshot reconciled, a reset.
type TraceEvent struct {
	T     float64  `json:"t"`
	In    string   `json:"in,omitempty"`
	Out   string   `json:"out,omitempty"`
	Timer bool     `json:"timer,omitempty"`
	Reset bool     `json:"reset,omitempty"`
	Step  []int64  `json:"step,omitempty"`  // tick, helm, sheet
	Input []int64  `json:"input,omitempty"` // seq, helm, sheet
	Snap  *SnapOut `json:"snap,omitempty"`
}

// SnapOut is a snapshot's outcome.
type SnapOut struct {
	Tick      int64   `json:"tick"`
	Stale     bool    `json:"stale,omitempty"`
	Reset     bool    `json:"reset,omitempty"`
	Corrected bool    `json:"corrected,omitempty"`
	Distance  float64 `json:"distance,omitempty"`
}

func (t *Trace) add(now float64, dir string, b []byte) {
	if t == nil {
		return
	}
	e := TraceEvent{T: now}
	if dir == "in" {
		e.In = hex.EncodeToString(b)
	} else {
		e.Out = hex.EncodeToString(b)
	}
	t.Events = append(t.Events, e)
}

func (t *Trace) mark(now float64, what string) {
	if t == nil {
		return
	}
	t.Events = append(t.Events, TraceEvent{T: now, Timer: what == "timer", Reset: what == "reset"})
}

func (t *Trace) step(now float64, tick int64, helm, sheet uint16) {
	if t != nil {
		t.Events = append(t.Events, TraceEvent{T: now, Step: []int64{tick, int64(helm), int64(sheet)}})
	}
}

func (t *Trace) input(now float64, tick int64, helm, sheet uint16) {
	if t != nil {
		t.Events = append(t.Events, TraceEvent{T: now, Input: []int64{tick, int64(helm), int64(sheet)}})
	}
}

func (t *Trace) snap(now float64, tick int64, o Outcome) {
	if t != nil {
		t.Events = append(t.Events, TraceEvent{T: now, Snap: &SnapOut{Tick: tick, Stale: o.Stale, Reset: o.Reset, Corrected: o.Corrected, Distance: o.Distance}})
	}
}

// Write writes the trace as JSON.
func (t *Trace) Write(path string) error {
	data, err := json.Marshal(t)
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}
