// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
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
// what arrived and when. It does no I/O and reads no clock: the caller
// gives it each event with its time, and calls Time at Deadline.
type Net struct {
	Clock   Clock
	FrameMs uint32 // the frame time Pings report

	welcomed  bool
	ackTick   int64
	lastSent  float64
	lastHeard float64
	pingsLeft int
	nextPing  float64
}

// Received is what a message was, for the page.
type Event struct {
	Welcome  *pb.Welcome
	Snapshot *protocol.Snapshot
}

// Open starts a connection: the Hello to send.
func (n *Net) Open(now float64) [][]byte {
	n.welcomed, n.ackTick, n.pingsLeft, n.nextPing = false, 0, 0, -1
	return [][]byte{n.encode(now, Hello())}
}

// Receive takes a server's message: what to send, and what it was.
func (n *Net) Receive(now float64, b []byte) ([][]byte, Event, error) {
	if len(b) > 0 && b[0] == protocol.KindSnapshot {
		var sn protocol.Snapshot
		if err := protocol.ReadSnapshot(b, &sn); err != nil {
			return nil, Event{}, err
		}
		n.ackTick = max(n.ackTick, sn.Tick)
		return nil, Event{Snapshot: &sn}, nil
	}
	var m pb.ServerMessage
	if err := protocol.DecodeServer(b, &m); err != nil {
		return nil, Event{}, err
	}
	switch b := m.Body.(type) {
	case *pb.ServerMessage_Welcome:
		n.Clock.Welcome(float64(b.Welcome.GetWorldTimeUs()), now)
		n.welcomed, n.lastHeard = true, now
		n.pingsLeft, n.nextPing = BurstPings, now
		return nil, Event{Welcome: b.Welcome}, nil
	case *pb.ServerMessage_Pong:
		n.Clock.Sample(float64(b.Pong.GetClientTimeUs()), float64(b.Pong.GetWorldTimeUs()), now)
		n.lastHeard = now
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
	if !n.welcomed {
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
	if !n.welcomed {
		return nil, false
	}
	if now-n.lastHeard >= PongTimeout {
		return nil, true
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
