// SPDX-License-Identifier: AGPL-3.0-only

package client

import (
	"context"
	"errors"
	"math/bits"
	"time"

	"github.com/coder/websocket"

	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// Spectator watches a sailor's boat over the game connection, as the page
// does while watching: its Hello names the sailor; it decodes each snapshot
// against its views, asking for a full one when it lacks a base; and it
// sends only acknowledgements of the newest snapshot it decoded and pings,
// never controls.
type Spectator struct {
	dial   Dialer
	Sailor string
	Stats  Stats
	// Welcomed is how many watches began; Ended, the WatchEnded told, the
	// latest's why; Waiting, whether the latest Queued put it in the
	// spectators' queue.
	Welcomed int
	Ended    int
	Why      pb.WatchEnd
	Waiting  bool
}

// NewSpectator makes a spectator of the sailor named, which connects with
// dial.
func NewSpectator(dial Dialer, sailor string) *Spectator {
	return &Spectator{dial: dial, Sailor: sailor}
}

// spectatorEvery is how often a spectator acknowledges and pings.
const spectatorEvery = time.Second

// Watch connects, watches until ctx ends or d has passed, and closes; an
// error is the connection's, ended by the server.
func (s *Spectator) Watch(ctx context.Context, d time.Duration) error {
	ws, err := s.dial(ctx)
	if err != nil {
		return err
	}
	defer ws.CloseNow()
	send := func(m *pb.ClientMessage) error {
		b, err := protocol.AppendClient(nil, m)
		if err != nil {
			return err
		}
		s.Stats.BytesOut += len(b)
		s.Stats.FramesOut += FrameBytes(len(b), true)
		s.Stats.MessagesOut++
		return ws.Write(ctx, websocket.MessageBinary, b)
	}
	if err := send(HelloWatch(s.Sailor)); err != nil {
		return err
	}
	in := Read(ws)
	var views Views
	var ack int64
	tick := time.NewTicker(spectatorEvery)
	defer tick.Stop()
	end := time.After(d)
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-end:
			ws.Close(websocket.StatusNormalClosure, "")
			return nil
		case <-tick.C:
			if err := send(&pb.ClientMessage{Body: &pb.ClientMessage_Input{Input: &pb.Input{AckTick: ack, AckOnly: true}}}); err != nil {
				return err
			}
			if err := send(&pb.ClientMessage{Body: &pb.ClientMessage_Ping{Ping: &pb.Ping{ClientTimeUs: time.Now().UnixMicro(), AckTick: ack}}}); err != nil {
				return err
			}
		case r, ok := <-in.C:
			if !ok {
				if errors.Is(in.Err(), context.Canceled) {
					return nil
				}
				return in.Err()
			}
			s.Stats.BytesIn += len(r.Bytes)
			s.Stats.FramesIn += FrameBytes(len(r.Bytes), false)
			s.Stats.MessagesIn++
			if r.Snapshot != nil {
				s.Stats.Snapshots++
				v, _, err := views.Decode(r.Bytes, r.Snapshot)
				if errors.Is(err, ErrMissingBase) {
					s.Stats.Dropped++
					s.Stats.Resyncs++
					if err := send(&pb.ClientMessage{Body: &pb.ClientMessage_Command{Command: &pb.Command{Body: &pb.Command_Resync{Resync: &pb.Resync{}}}}}); err != nil {
						return err
					}
					continue
				}
				if err != nil {
					return err
				}
				ack = r.Snapshot.Tick
				n := bits.OnesCount64(v.Used)
				s.Stats.Views++
				s.Stats.Others += n
				s.Stats.MaxOthers = max(s.Stats.MaxOthers, n)
				continue
			}
			switch m := r.Message.Body.(type) {
			case *pb.ServerMessage_Welcome:
				if m.Welcome.GetWatching() != nil {
					s.Welcomed++
				}
				views.Reset()
			case *pb.ServerMessage_WatchEnded:
				s.Ended++
				s.Why = m.WatchEnded.GetWhy()
			case *pb.ServerMessage_Queued:
				s.Stats.Queued++
				s.Waiting = m.Queued.GetSpectators()
			case *pb.ServerMessage_Restart:
				s.Stats.Bells++
			case *pb.ServerMessage_Bump:
				s.Stats.Bumps++
			}
		}
	}
}
