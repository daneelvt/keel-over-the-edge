// SPDX-License-Identifier: AGPL-3.0-only

package client

import (
	"cmp"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/bits"
	"os"
	"sort"
	"time"

	"github.com/coder/websocket"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// Input is a step's controls as the wire carries them: the helm's and the
// sheet's indices, and the autopilot's mode, the way of its latest order,
// its order count and its target.
type Input struct {
	Helm, Sheet      uint16
	Mode, Way, Order uint8
	Target           uint16
}

// Hand is steering by hand: the helm and the sheet, the autopilot off.
func Hand(helm, sheet uint16) Input { return Input{Helm: helm, Sheet: sheet} }

// Pilot is the input's pilot word, stamped seq, for a slot of generation
// gen.
func (in Input) Pilot(seq uint32, gen uint16) bus.PilotWord {
	return bus.PackPilot(seq, in.Mode, in.Way, in.Order, in.Target, gen)
}

// Controls gives the controls for the n-th step a sailor takes.
type Controls func(n int) Input

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
	BytesIn     int // payloads
	BytesOut    int
	FramesIn    int // WebSocket frames' bytes, as the server counts them
	FramesOut   int
	MessagesIn  int
	MessagesOut int
	Reconnects  int
	// The other boats: those in view, summed over the snapshots and at
	// most; the entries that changed views; snapshots dropped for want of
	// their base, and the Resyncs asked for.
	Views     int // snapshots decoded
	Others    int
	MaxOthers int
	Near      int
	Enters    int
	Updates   int
	Leaves    int
	Dropped   int
	Resyncs   int
	Queued    int // Queued messages
	Bells     int // Restart messages: the server about to restart
	Bumps     int // Bump messages
	Seas      int // SeaAreas messages: the sea about the boat
	Weathers  int // WeatherSystems messages: the spells of weather in play and the systems' keyframes
	// WeatherBytes is the WeatherSystems messages' payloads.
	WeatherBytes int
	// SeaBytes is the SeaAreas messages' payloads, and Swells how many of
	// them carried the areas' swell.
	SeaBytes int
	Swells   int
	Chunks       int // chunks' addresses handed
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

// Dialer opens the game connection.
type Dialer func(ctx context.Context) (*websocket.Conn, error)

// Sailor is the page's game connection in Go: it connects, keeps the clock,
// steps its boat ahead of the server with physics.Step, reconciles each
// snapshot, decodes the other boats' views and sends its controls, frame by
// frame, as the page and its net worker do; and it records a trace of all
// that.
type Sailor struct {
	dial Dialer
	kind *physics.Prepared

	ws    *websocket.Conn
	inbox *Inbox
	start time.Time

	Net       Net
	Ahead     Ahead
	Predictor *Predictor
	controls  Controls
	stepN     int
	sent      Input // the controls last sent
	sentAny   bool  // whether any were
	fresh     bool  // a Welcome has come, its first snapshot not yet
	latest    *protocol.Snapshot
	queued    []*protocol.Snapshot

	// FrameEvery is the time between the page's frames: 60 a second
	// unless set.
	FrameEvery time.Duration

	Welcomes []WelcomeSeen
	// Bumps are the Bump messages, in order.
	Bumps []*pb.Bump
	// Places are the places in the queue the server told, in order.
	Places []Place
	// Handed are the addresses of the chunks of land the server handed,
	// in order.
	Handed []string
	Stats  Stats
	Trace  *Trace
	// Ms is m after each snapshot, with its time, for the tests.
	Ms []MSeen
	// OnView, if not nil, is given each snapshot as it is decoded, with the
	// view after it, what its entries did and the slots it samples.
	OnView func(ev *Event)
	// Tools is the account's owner's flag, as the Welcome and Tools last
	// said.
	Tools bool
	// LastSea is the latest SeaAreas the server sent.
	LastSea *pb.SeaAreas
}

// Place is a place in the queue, and how many waited.
type Place struct{ Position, Waiting uint32 }

// WelcomeSeen is a Welcome's boat, and the world's epoch it told: the
// moment world time counts from, in microseconds of UTC since 1970.
type WelcomeSeen struct {
	Boat     uint64
	Rejoined bool
	EpochUs  int64
}

// MSeen is how far ahead the sailor ran, from when.
type MSeen struct {
	At time.Duration
	M  int
}

// NewSailor makes a sailor of a boat of kind that connects through dial
// and steers with controls, in the sea of waves and the wind of weather.
func NewSailor(dial Dialer, kind *physics.Prepared, waves *physics.Waves, weather *physics.WeatherPrepared, controls Controls) *Sailor {
	return &Sailor{
		dial: dial, kind: kind, controls: controls,
		start: time.Now(), Ahead: NewAhead(), Predictor: NewPredictor(kind, waves, weather),
		Net: Net{FrameMs: 17},
	}
}

func (s *Sailor) now() float64 { return float64(time.Since(s.start).Microseconds()) }

// Connect opens the connection and says Hello.
func (s *Sailor) Connect(ctx context.Context) error {
	ws, err := s.dial(ctx)
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

// Roam sends the owner's free camera off the boat to (east, north),
// height up, m, or with on false brings it back.
func (s *Sailor) Roam(ctx context.Context, on bool, east, north, height float64) error {
	return s.send(ctx, s.Net.Roam(s.now(), on, east, north, height))
}

func (s *Sailor) send(ctx context.Context, b []byte) error {
	s.Trace.add(s.now(), "out", b)
	s.Stats.BytesOut += len(b)
	s.Stats.FramesOut += FrameBytes(len(b), true)
	s.Stats.MessagesOut++
	return s.ws.Write(ctx, websocket.MessageBinary, b)
}

// FrameBytes is the size of a WebSocket frame of n bytes of payload
// (RFC 6455, 5.2): its header, the masking key a client's frames carry,
// and the payload.
func FrameBytes(n int, masked bool) int {
	h := 2
	switch {
	case n > 0xffff:
		h += 8
	case n > 125:
		h += 2
	}
	if masked {
		h += 4
	}
	return h + n
}

// Sail runs the client for d, or until the connection ends.
func (s *Sailor) Sail(ctx context.Context, d time.Duration) error {
	end := time.Now().Add(d)
	frame := time.NewTicker(cmp.Or(s.FrameEvery, time.Second/60))
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
			s.Stats.BytesIn += len(r.Bytes)
			s.Stats.FramesIn += FrameBytes(len(r.Bytes), false)
			s.Stats.MessagesIn++
			out, ev, err := s.Net.Receive(now, r.Bytes)
			if err != nil {
				return err
			}
			s.Trace.received(now, r.Bytes, &ev)
			for _, b := range out {
				s.Stats.Resyncs++
				if err := s.send(ctx, b); err != nil {
					return err
				}
			}
			if w := ev.Welcome; w != nil {
				s.Welcomes = append(s.Welcomes, WelcomeSeen{Boat: w.GetBoat(), Rejoined: w.GetRejoined(), EpochUs: w.GetEpochUs()})
				s.Predictor.Circulation = float64(w.GetCirculation())
				s.Tools = w.GetTools()
				s.fresh = true
				// A snapshot still waiting for a frame is the last
				// connection's: its controls are not this boat's.
				s.queued = s.queued[:0]
			}
			if q := ev.Queued; q != nil {
				s.Places = append(s.Places, Place{Position: q.GetPosition(), Waiting: q.GetWaiting()})
				s.Stats.Queued++
			}
			if ev.Dropped {
				s.Stats.Dropped++
			}
			if ev.Restart != nil {
				s.Stats.Bells++
			}
			if ev.Bump != nil {
				s.Stats.Bumps++
				s.Bumps = append(s.Bumps, ev.Bump)
			}
			if ev.SeaAreas != nil {
				s.Stats.Seas++
				s.Stats.SeaBytes += len(r.Bytes)
				if len(ev.SeaAreas.GetSwellHeight()) > 0 {
					s.Stats.Swells++
				}
				s.LastSea = ev.SeaAreas
				s.Predictor.Seas.Receive(ev.SeaAreas, s.Predictor.Circulation)
			}
			if ev.Tools != nil {
				s.Tools = ev.Tools.GetOn()
			}
			if c := ev.Chunks; c != nil {
				s.Stats.Chunks += len(c.GetNumber())
				s.Handed = append(s.Handed, c.GetPath()...)
			}
			if ev.WeatherSystems != nil {
				s.Stats.Weathers++
				s.Stats.WeatherBytes += len(r.Bytes)
				if err := s.Predictor.ReceiveWeather(ev.WeatherSystems); err != nil {
					return err
				}
			}
			if v := ev.View; v != nil {
				s.Predictor.Wakes.Observe(ev.Snapshot.Tick, v, ev.Changes, ev.Sampled)
				s.view(&ev)
				s.queued = append(s.queued, ev.Snapshot)
			}
		case <-timer.C:
			now := s.now()
			s.Trace.mark(now, "timer")
			out, dead := s.Net.Time(now)
			if dead {
				return errors.New("client: no pong for 6 s")
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

// view counts what a snapshot did to the view of the other boats.
func (s *Sailor) view(ev *Event) {
	v := ev.View
	n := v.Len()
	s.Stats.Views++
	s.Stats.Others += n
	s.Stats.MaxOthers = max(s.Stats.MaxOthers, n)
	for slot := range protocol.ViewSlots {
		if v.Has(slot) && !v.Boats[slot].Far() {
			s.Stats.Near++
		}
	}
	s.Stats.Enters += bits.OnesCount64(ev.Changes.Entered)
	s.Stats.Updates += bits.OnesCount64(ev.Changes.Updated)
	s.Stats.Leaves += bits.OnesCount64(ev.Changes.Left)
	if s.OnView != nil {
		s.OnView(ev)
	}
}

func (s *Sailor) arm(timer *time.Timer) {
	timer.Stop()
	d := s.Net.Deadline()
	if math.IsInf(d, 1) {
		return
	}
	timer.Reset(max(0, time.Until(s.start.Add(time.Duration(d)*time.Microsecond))))
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
			s.sent = Input{Helm: sn.Helm, Sheet: sn.Sheet, Mode: sn.Mode, Way: sn.Way, Order: sn.Order, Target: sn.Target}
			s.sentAny = true
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
	// A step for a tick an input sent now would not reach with a tick to
	// spare, as when catching up after a slow frame, keeps the controls the
	// server holds; so do all until the clock knows the round trip.
	reach := Target(world, s.Net.Clock.RTT, 0) + 1
	if s.Net.Clock.Rough {
		reach = math.MaxInt64
	}
	for steps := min(MaxSteps, target-p.Tick); steps > 0; steps-- {
		if p.Tick+1 < reach {
			p.Step(s.sent)
			s.Stats.Steps++
			s.Trace.step(now, p.Tick, s.sent)
			continue
		}
		in := s.controls(s.stepN)
		s.stepN++
		p.Step(in)
		s.Stats.Steps++
		s.Trace.step(now, p.Tick, in)
		if !s.sentAny || in != s.sent {
			s.sent, s.sentAny = in, true
			s.Trace.input(now, p.Tick, in)
			if err := s.send(ctx, s.Net.Input(now, uint32(p.Tick), in)); err != nil {
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
// step, an input, a snapshot reconciled, a reset. A snapshot in carries
// ViewDigest of the view it decoded to, or Dropped.
type TraceEvent struct {
	T       float64  `json:"t"`
	In      string   `json:"in,omitempty"`
	View    string   `json:"view,omitempty"`
	Dropped bool     `json:"dropped,omitempty"`
	Out     string   `json:"out,omitempty"`
	Timer   bool     `json:"timer,omitempty"`
	Reset   bool     `json:"reset,omitempty"`
	Step    []int64  `json:"step,omitempty"`  // tick, helm, sheet; then, with the autopilot used, its mode, way, order and target
	Input   []int64  `json:"input,omitempty"` // seq, helm, sheet; then the same
	Snap    *SnapOut `json:"snap,omitempty"`
}

// SnapOut is a snapshot's outcome.
type SnapOut struct {
	Tick      int64   `json:"tick"`
	Stale     bool    `json:"stale,omitempty"`
	Reset     bool    `json:"reset,omitempty"`
	Corrected bool    `json:"corrected,omitempty"`
	Distance  float64 `json:"distance,omitempty"`
}

// received records a message that came, and the view it decoded to.
func (t *Trace) received(now float64, b []byte, ev *Event) {
	if t == nil {
		return
	}
	e := TraceEvent{T: now, In: hex.EncodeToString(b), Dropped: ev.Dropped}
	if ev.View != nil {
		e.View = fmt.Sprintf("%08x", ViewDigest(ev.View))
	}
	t.Events = append(t.Events, e)
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

func (t *Trace) step(now float64, tick int64, in Input) {
	if t != nil {
		t.Events = append(t.Events, TraceEvent{T: now, Step: traced(tick, in)})
	}
}

func (t *Trace) input(now float64, tick int64, in Input) {
	if t != nil {
		t.Events = append(t.Events, TraceEvent{T: now, Input: traced(tick, in)})
	}
}

// traced is a tick and its controls as a trace holds them: the
// autopilot's only if any of them is not zero.
func traced(tick int64, in Input) []int64 {
	v := []int64{tick, int64(in.Helm), int64(in.Sheet)}
	if in.Mode|in.Way|in.Order != 0 || in.Target != 0 {
		v = append(v, int64(in.Mode), int64(in.Way), int64(in.Order), int64(in.Target))
	}
	return v
}

// Untraced is the controls a trace's step or input holds, after its tick.
func Untraced(v []int64) Input {
	in := Input{Helm: uint16(v[1]), Sheet: uint16(v[2])}
	if len(v) >= 7 {
		in.Mode, in.Way, in.Order, in.Target = uint8(v[3]), uint8(v[4]), uint8(v[5]), uint16(v[6])
	}
	return in
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
