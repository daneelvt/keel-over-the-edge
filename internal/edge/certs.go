// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// What a sailor's certificates came to is told to its own connection
// alone, wherever it is in the game, as the frame that carries it is
// published: every frame's events are read here, so none is missed by an
// encoder that skips a frame. A sailor with no connection is told nothing:
// the log keeps what it earned.

// certWays are the ways a task counted, on the wire, by theirs.
var certWays = [...]pb.CertWay{bus.CertLog: pb.CertWay_CERT_WAY_LOG, bus.CertHand: pb.CertWay_CERT_WAY_HAND,
	bus.CertPilot: pb.CertWay_CERT_WAY_PILOT}

// certified tells each sailor f's Certify events are of what they came to.
func (e *Edge) certified(f *bus.Frame) {
	for i := range f.Events {
		ev := &f.Events[i]
		if ev.Op != bus.Certify || ev.Reply.Result != bus.Done {
			continue
		}
		if c := e.registry.get(ev.Account); c != nil {
			c.send(certifiedMessage(&ev.Certified), outCertified)
		}
	}
}

// certifiedMessage is a Certified as its message.
func certifiedMessage(c *bus.Certified) *pb.ServerMessage {
	way := pb.CertWay_CERT_WAY_UNSPECIFIED
	if int(c.Way) < len(certWays) {
		way = certWays[c.Way]
	}
	return &pb.ServerMessage{Body: &pb.ServerMessage_Certified{Certified: &pb.Certified{
		Certificate: uint32(max(c.Certificate, 0)), Task: int32(c.Task), Done: uint32(c.Done), Of: uint32(c.Of), Way: way,
		Runs: uint32(c.Runs), RunsOf: uint32(c.RunsOf), Earned: c.Earned, ByHand: c.ByHand,
	}}}
}
