// SPDX-License-Identifier: AGPL-3.0-only

package client

import (
	"errors"
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// The connection's schedule, as the net worker keeps it, in microseconds.
const (
	BurstPings  = 8         // pings after a Welcome, to set the clock at once
	BurstEvery  = 100_000   // between them
	PingEvery   = 2_000_000 // then
	AckAfter    = 100_000   // an empty Input after this long without sending
	PongTimeout = 6_000_000 // without a Pong, the connection is taken for dead
)

// Net is a connection's state as the client's net worker keeps it,
// client/src/workers/net/session.ts's twin: what to send, and when, given
// what arrived and when, and the other boats' views. It does no I/O and
// reads no clock: the caller gives it each event with its time, and calls
// Time at Deadline.
type Net struct {
	Clock   Clock
	FrameMs uint32 // the frame time Pings report
	Views   Views

	welcomed  bool
	waiting   bool // queued for a boat: pings keep the connection alive
	ackTick   int64
	lastSent  float64
	lastHeard float64
	pingsLeft int
	nextPing  float64
}

// Event is what a message was, for the page.
type Event struct {
	Welcome *pb.Welcome
	Queued  *pb.Queued
	// Restart: the server is about to restart.
	Restart *pb.Restart
	// Snapshot is a snapshot's header; View the other boats after it,
	// valid until ViewsKept more snapshots are decoded; Changes what its
	// entries did, and Sampled the view slots it samples.
	Snapshot *protocol.Snapshot
	View     *protocol.View
	Changes  protocol.Changes
	Sampled  uint64
	// Dropped: a snapshot whose base the client lacks, let go; a Resync
	// is sent.
	Dropped bool
}

// Open starts a connection: the Hello to send.
func (n *Net) Open(now float64) [][]byte {
	n.welcomed, n.waiting, n.ackTick, n.pingsLeft, n.nextPing = false, false, 0, 0, -1
	n.Views.Reset()
	return [][]byte{n.encode(now, Hello())}
}

// Receive takes a server's message: what to send, and what it was.
func (n *Net) Receive(now float64, b []byte) ([][]byte, Event, error) {
	if len(b) > 0 && b[0] == protocol.KindSnapshot {
		var sn protocol.Snapshot
		if err := protocol.ReadSnapshot(b, &sn); err != nil {
			return nil, Event{}, err
		}
		v, ch, err := n.Views.Decode(b, &sn)
		if errors.Is(err, ErrMissingBase) {
			return [][]byte{n.encode(now, &pb.ClientMessage{Body: &pb.ClientMessage_Command{Command: &pb.Command{
				Body: &pb.Command_Resync{Resync: &pb.Resync{}},
			}}})}, Event{Snapshot: &sn, Dropped: true}, nil
		}
		if err != nil {
			return nil, Event{}, err
		}
		n.ackTick = max(n.ackTick, sn.Tick)
		return nil, Event{Snapshot: &sn, View: v, Changes: ch, Sampled: v.Sampled(sn.Flags, &ch)}, nil
	}
	var m pb.ServerMessage
	if err := protocol.DecodeServer(b, &m); err != nil {
		return nil, Event{}, err
	}
	switch b := m.Body.(type) {
	case *pb.ServerMessage_Welcome:
		n.Clock.Welcome(float64(b.Welcome.GetWorldTimeUs()), now)
		n.welcomed, n.waiting, n.lastHeard = true, false, now
		n.pingsLeft, n.nextPing = BurstPings, now
		return nil, Event{Welcome: b.Welcome}, nil
	case *pb.ServerMessage_Pong:
		n.Clock.Sample(float64(b.Pong.GetClientTimeUs()), float64(b.Pong.GetWorldTimeUs()), now)
		n.lastHeard = now
	case *pb.ServerMessage_Queued:
		n.lastHeard = now
		if !n.waiting && !n.welcomed {
			// Waiting, it pings every PingEvery, so that the server, which
			// drops a connection silent for a minute, keeps it.
			n.waiting, n.nextPing = true, now+PingEvery
		}
		return nil, Event{Queued: b.Queued}, nil
	case *pb.ServerMessage_Restart:
		n.lastHeard = now
		return nil, Event{Restart: b.Restart}, nil
	}
	return nil, Event{}, nil
}

// Input is the page's controls for tick seq.
func (n *Net) Input(now float64, seq uint32, helm, sheet uint16) []byte {
	return n.encode(now, &pb.ClientMessage{Body: &pb.ClientMessage_Input{Input: &pb.Input{
		Seq: seq, Helm: uint32(helm), Sheet: uint32(sheet), AckTick: n.ackTick,
	}}})
}

// Deadline is when Time must next be called.
func (n *Net) Deadline() float64 {
	switch {
	case n.waiting:
		return min(n.nextPing, n.lastHeard+PongTimeout)
	case !n.welcomed:
		return math.Inf(1)
	}
	d := min(n.lastSent+AckAfter, n.lastHeard+PongTimeout)
	if n.nextPing >= 0 {
		d = min(d, n.nextPing)
	}
	return d
}

// Time sends what is due at now; dead says the connection has gone quiet
// and must be closed.
func (n *Net) Time(now float64) (out [][]byte, dead bool) {
	if !n.welcomed && !n.waiting {
		return nil, false
	}
	if now-n.lastHeard >= PongTimeout {
		return nil, true
	}
	if n.waiting {
		if now >= n.nextPing {
			n.nextPing = now + PingEvery
			out = append(out, n.encode(now, &pb.ClientMessage{Body: &pb.ClientMessage_Ping{Ping: &pb.Ping{
				ClientTimeUs: int64(now), RttMs: uint32(math.Round(n.Clock.RTT / 1000)), FrameMs: n.FrameMs,
			}}}))
		}
		return out, false
	}
	if n.nextPing >= 0 && now >= n.nextPing {
		if n.pingsLeft > 0 {
			n.pingsLeft--
		}
		if n.pingsLeft > 0 {
			n.nextPing = now + BurstEvery
		} else {
			n.nextPing = now + PingEvery
		}
		out = append(out, n.encode(now, &pb.ClientMessage{Body: &pb.ClientMessage_Ping{Ping: &pb.Ping{
			ClientTimeUs: int64(now), AckTick: n.ackTick,
			RttMs: uint32(math.Round(n.Clock.RTT / 1000)), FrameMs: n.FrameMs,
		}}}))
	}
	if now-n.lastSent >= AckAfter {
		out = append(out, n.encode(now, &pb.ClientMessage{Body: &pb.ClientMessage_Input{Input: &pb.Input{
			AckTick: n.ackTick, AckOnly: true,
		}}}))
	}
	return out, false
}

func (n *Net) encode(now float64, m *pb.ClientMessage) []byte {
	n.lastSent = now
	b, err := protocol.AppendClient(nil, m)
	if err != nil {
		panic(err) // the client's messages always encode
	}
	return b
}
