// SPDX-License-Identifier: AGPL-3.0-only

package edge_test

import (
	"math"
	"math/rand/v2"
	"net"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/coder/websocket"

	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/edge/edgetest"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// ring puts n boats in a ring of radius r about the start grid's first
// place, where the first player's boat appears, sailing in circles.
func ring(n int, r float64) func(i int) physics.State {
	return func(i int) physics.State {
		a := 2 * math.Pi * float64(i) / float64(n)
		return physics.State{X: -640 + r*math.Sin(a), Y: -20 + r*math.Cos(a), Heading: a, Surge: 2, Rudder: 0.3, SheetLimit: 0.5}
	}
}

// pausable is a connection whose reads can be held up, as a client that
// stops reading does.
type pausable struct {
	net.Conn
	mu   sync.Mutex
	open chan struct{}
}

func (p *pausable) pause() {
	p.mu.Lock()
	p.open = make(chan struct{})
	p.mu.Unlock()
}

func (p *pausable) resume() {
	p.mu.Lock()
	close(p.open)
	p.mu.Unlock()
}

func (p *pausable) Read(b []byte) (int, error) {
	p.mu.Lock()
	open := p.open
	p.mu.Unlock()
	<-open
	return p.Conn.Read(b)
}

// reader decodes every snapshot a connection receives, as the client does.
type reader struct {
	t        *testing.T
	views    client.Views
	inbox    *client.Inbox
	headers  []protocol.Snapshot
	missing  int
	lastView *protocol.View
}

func newReader(t *testing.T, ws *websocket.Conn) *reader {
	return &reader{t: t, inbox: client.Read(ws)}
}

// read takes what has come: every snapshot must decode against its base.
func (r *reader) read() {
	r.t.Helper()
	for {
		select {
		case m, ok := <-r.inbox.C:
			if !ok {
				return
			}
			if m.Snapshot == nil {
				continue
			}
			v, _, err := r.views.Decode(m.Bytes, m.Snapshot)
			if err == client.ErrMissingBase {
				r.missing++
				continue
			}
			if err != nil {
				r.t.Fatalf("snapshot of tick %d: %v", m.Snapshot.Tick, err)
			}
			r.headers = append(r.headers, *m.Snapshot)
			r.lastView = v
		default:
			return
		}
	}
}

// TestBases: the first snapshot is full, each after it is a delta against
// one the writer took before it; with the writer held up so snapshots are
// replaced in the mailbox, every snapshot that arrives still decodes.
func TestBases(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := edgetest.NewServer(t, edgetest.Config{Capacity: 64})
		token, _ := s.Guest("Ann")
		var gate *pausable
		small := edgetest.SmallReadBuffer(2048)
		ws, _, err := s.Connect(t.Context(), edgetest.DialOptions{Cookie: token, Wrap: func(c net.Conn) net.Conn {
			gate = &pausable{Conn: small(c), open: make(chan struct{})}
			close(gate.open)
			return gate
		}})
		if err != nil {
			t.Fatal(err)
		}
		defer ws.CloseNow()
		s.Crowd(t, 40, ring(40, 200))
		r := newReader(t, ws)
		for range 30 {
			time.Sleep(100 * time.Millisecond)
			r.read()
		}
		// The client stops reading for 2 s: the server's writes wait on
		// the full buffer, and snapshots are replaced while they do.
		replacedBefore := count(t, s, "dropped", "snapshot_replaced")
		gate.pause()
		time.Sleep(2 * time.Second)
		gate.resume()
		for range 30 {
			time.Sleep(100 * time.Millisecond)
			r.read()
		}
		if count(t, s, "dropped", "snapshot_replaced") == replacedBefore {
			t.Fatal("no snapshot was replaced while the client was not reading")
		}
		if r.missing != 0 || len(r.headers) < 30 {
			t.Fatalf("%d snapshots lacked their base, of %d", r.missing, len(r.headers))
		}
		if r.headers[0].Base != 0 {
			t.Fatalf("the first snapshot is a delta of %d ticks", r.headers[0].Base)
		}
		deltas := 0
		for _, h := range r.headers[1:] {
			if h.Base != 0 {
				deltas++
			}
		}
		if deltas < len(r.headers)-2 {
			t.Fatalf("%d deltas in %d snapshots", deltas, len(r.headers))
		}
		if n := r.lastView.Len(); n != 40 {
			t.Fatalf("%d boats in view of 40", n)
		}
	})
}

// TestResync: a client that asks for a full snapshot gets one next; a
// second request within the second is ignored.
func TestResync(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := edgetest.NewServer(t, edgetest.Config{})
		token, _ := s.Guest("Ann")
		ws, _, err := s.Connect(t.Context(), edgetest.DialOptions{Cookie: token})
		if err != nil {
			t.Fatal(err)
		}
		defer ws.CloseNow()
		s.Crowd(t, 5, ring(5, 100))
		r := newReader(t, ws)
		time.Sleep(time.Second)
		r.read()
		resync := &pb.ClientMessage{Body: &pb.ClientMessage_Command{Command: &pb.Command{Body: &pb.Command_Resync{Resync: &pb.Resync{}}}}}
		client.Send(t.Context(), ws, resync)
		client.Send(t.Context(), ws, resync)
		time.Sleep(time.Second / 3)
		n := len(r.headers)
		r.read()
		full := 0
		for _, h := range r.headers[n:] {
			if h.Base == 0 {
				full++
			}
		}
		if full != 1 {
			t.Fatalf("%d full snapshots after two requests", full)
		}
		if h, i := count(t, s, "resyncs", "honoured"), count(t, s, "resyncs", "ignored"); h != 1 || i != 1 {
			t.Fatalf("resyncs honoured %v, ignored %v", h, i)
		}
		time.Sleep(time.Second)
		client.Send(t.Context(), ws, resync)
		time.Sleep(time.Second / 3)
		if h := count(t, s, "resyncs", "honoured"); h != 2 {
			t.Fatalf("a request a second later: %v honoured", h)
		}
	})
}

// TestModifiedClient: whatever a client sends, it receives no boat beyond
// its area of interest.
func TestModifiedClient(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		s := edgetest.NewServer(t, edgetest.Config{Capacity: 256})
		token, _ := s.Guest("Mallory")
		ws, _, err := s.Connect(t.Context(), edgetest.DialOptions{Cookie: token})
		if err != nil {
			t.Fatal(err)
		}
		defer ws.CloseNow()
		rng := rand.New(rand.NewPCG(9, 9))
		s.Crowd(t, 200, func(int) physics.State {
			return physics.State{X: -640 + (rng.Float64()-0.5)*4000, Y: -20 + (rng.Float64()-0.5)*4000, Heading: rng.Float64() * 6}
		})
		r := newReader(t, ws)
		seen := 0
		for range 100 {
			// Anything: inputs of any value, resyncs, pings that claim
			// anything, a Hello again.
			var m *pb.ClientMessage
			switch rng.IntN(4) {
			case 0:
				m = &pb.ClientMessage{Body: &pb.ClientMessage_Input{Input: &pb.Input{
					Seq: rng.Uint32(), Helm: rng.Uint32(), Sheet: rng.Uint32(), AckTick: rng.Int64(), AckOnly: rng.IntN(2) == 0}}}
			case 1:
				m = &pb.ClientMessage{Body: &pb.ClientMessage_Command{Command: &pb.Command{Body: &pb.Command_Resync{Resync: &pb.Resync{}}}}}
			case 2:
				m = &pb.ClientMessage{Body: &pb.ClientMessage_Ping{Ping: &pb.Ping{ClientTimeUs: rng.Int64(), AckTick: -rng.Int64()}}}
			default:
				m = client.Hello()
			}
			client.Send(t.Context(), ws, m)
			time.Sleep(100 * time.Millisecond)
			n := len(r.headers)
			r.read()
			if v := r.lastView; v != nil && len(r.headers) > n {
				h := r.headers[len(r.headers)-1]
				for slot := range protocol.ViewSlots {
					if !v.Has(slot) {
						continue
					}
					q := v.Boats[slot]
					d := math.Hypot(float64(q.X)*protocol.PositionStep-h.State.X, float64(q.Y)*protocol.PositionStep-h.State.Y)
					// A far boat not sampled may have moved since: a little
					// slack for that.
					if d > edge.ViewKeep+5 {
						t.Fatalf("a boat %.0f m away in view", d)
					}
					seen++
				}
			}
		}
		if seen == 0 {
			t.Fatal("no boat was ever in view")
		}
	})
}
