// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/time/rate"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// conn is one game connection. Its reader is the request's goroutine (run);
// its writer has one of its own; the encoder fills its mailbox.
type conn struct {
	e       *Edge
	ws      *websocket.Conn
	raw     net.Conn // the socket under ws
	id      uint64
	account bus.Account
	reqID   string

	// The boat, set by the reader once the Join is answered and before the
	// encoder is given the connection; read by the encoder after.
	slot     int32
	gen      uint16
	boat     uint64
	rejoined bool
	joinTick int64
	joined   atomic.Bool // the simulation gave the connection a boat
	ready    atomic.Bool // Welcome is queued: inputs steer the boat from now on
	// queued: the connection waits in the simulation's queue for a boat,
	// at position when it joined it. The encoder alone reads the rest.
	queued                    atomic.Bool
	position                  int32
	toldPosition, toldWaiting int32
	seen                      int64 // the tick the encoder last found it in the queue
	enc                       *encoder

	// The control slot's writer, stopped once another connection has
	// taken the boat over: a word is stored only under wmu while not
	// stopped, so once stop has returned none ever is. Words stamped for a
	// tick still to come wait in held, oldest first, until the tick before
	// theirs is published: the slot holds one word, and one stored at once
	// would be replaced by the next before its tick came whenever the
	// client sends a word a tick, as it does while the tiller is dragged.
	wmu     sync.Mutex
	stopped bool
	held    [heldWords]bus.Word
	first   int // held's oldest
	nheld   int
	waiting atomic.Int32 // nheld, for the encoder to skip connections with none

	margin margin
	ack    atomic.Int64 // the newest snapshot's tick the client has decoded
	// resync: the client lacks a base and asked for a full snapshot.
	resync     atomic.Bool
	lastResync time.Time

	// The writer's side.
	queue      chan outgoing
	box        mailbox
	writeTimer *time.Timer
	done       chan struct{} // closed once the reader has finished: the writer stops

	// gone: the encoder lets the connection go.
	gone atomic.Bool

	closeOnce sync.Once
	closed    chan struct{} // the close, with its handshake or without, has finished
	sent      websocket.StatusCode
	readErr   error

	limiter    *rate.Limiter
	drops      int
	dropsSince time.Time
	buf        []byte
	msg        pb.ClientMessage
}

// heldWords is how many words a connection may have waiting for their
// tick: at most one a tick is sent, and none is held more than
// bus.MaxAhead ticks.
const heldWords = 64

// outgoing is a message for the writer, and its kind for the metrics.
type outgoing struct {
	b    []byte
	kind int
}

func newConn(e *Edge, ws *websocket.Conn, raw net.Conn, account bus.Account, reqID string) *conn {
	c := &conn{
		e:       e,
		ws:      ws,
		raw:     raw,
		id:      e.nextConn.Add(1),
		account: account,
		reqID:   reqID,
		queue:   make(chan outgoing, e.lim.Queue),
		done:    make(chan struct{}),
		closed:  make(chan struct{}),
		limiter: rate.NewLimiter(e.lim.Rate, e.lim.Burst),
		buf:     make([]byte, e.lim.ReadLimit+1),
	}
	c.margin.init()
	c.box.init()
	c.writeTimer = time.AfterFunc(time.Hour, c.drop)
	c.writeTimer.Stop()
	return c
}

// run is the connection's whole life: the Hello, the Join, then inputs and
// pings until the connection ends.
func (c *conn) run() {
	e := c.e
	c.ws.SetReadLimit(e.lim.ReadLimit)
	e.running.Add(1)
	go c.writer()
	defer c.finish()

	hello := time.AfterFunc(e.lim.Hello, func() {
		e.m.hello[helloTimeout].Inc()
		c.close(websocket.StatusPolicyViolation, "no hello")
	})
	data, ok := c.next()
	if !hello.Stop() || !ok || !c.hello(data) || !c.join() {
		return
	}
	// A connection silent for this long has gone: it is dropped without a
	// close frame, as there is nobody to read one.
	idle := time.AfterFunc(e.lim.Idle, c.drop)
	defer idle.Stop()
	for {
		data, ok := c.next()
		if !ok {
			return
		}
		idle.Reset(e.lim.Idle)
		if data != nil && !c.handle(data) {
			return
		}
	}
}

// next reads the next message. It is nil, with ok, when the message was
// over the client's rate and dropped; ok is false once the connection has
// ended or been closed.
func (c *conn) next() (data []byte, ok bool) {
	typ, r, err := c.ws.Reader(context.Background())
	if err != nil {
		c.readErr = err
		return nil, false
	}
	n := 0
	for {
		if n == len(c.buf) {
			// The library refuses a message over the limit itself; this
			// only guards the buffer.
			c.close(websocket.StatusMessageTooBig, "message too big")
			return nil, false
		}
		k, err := r.Read(c.buf[n:])
		n += k
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			c.readErr = err
			return nil, false
		}
	}
	c.e.m.bytesIn.Add(frameBytes(n, true))
	if typ != websocket.MessageBinary {
		c.close(websocket.StatusUnsupportedData, "binary messages only")
		return nil, false
	}
	if !c.limiter.Allow() {
		c.e.m.droppedRate.Inc()
		now := time.Now()
		if now.Sub(c.dropsSince) > c.e.lim.DropWindow {
			c.drops, c.dropsSince = 0, now
		}
		c.drops++
		if c.drops > c.e.lim.Drops {
			c.close(websocket.StatusPolicyViolation, "too many messages")
			return nil, false
		}
		return nil, true
	}
	return c.buf[:n], true
}

// decode decodes a client's message into c.msg, closing the connection on
// one it cannot.
func (c *conn) decode(data []byte) bool {
	if err := protocol.DecodeClient(data, &c.msg); err != nil {
		c.close(websocket.StatusUnsupportedData, "not a message of this game")
		return false
	}
	return true
}

// hello checks the client speaks this server's protocol, catalog and
// physics.
func (c *conn) hello(data []byte) bool {
	e := c.e
	if data == nil || !c.decode(data) {
		if data == nil {
			c.close(websocket.StatusPolicyViolation, "hello first")
		}
		return false
	}
	h := c.msg.GetHello()
	if h == nil {
		c.close(websocket.StatusPolicyViolation, "hello first")
		return false
	}
	e.m.in[inHello].Inc()
	var differs int
	switch {
	case h.GetProtocol() != e.cfg.Protocol:
		differs = helloProtocol
	case h.GetCatalog() != e.cfg.Catalog:
		differs = helloCatalog
	case h.GetPhysicsLayout() != e.cfg.Layout:
		differs = helloLayout
	default:
		e.m.hello[helloOK].Inc()
		e.cfg.Log.Debug("game connection", "request_id", c.reqID, "conn", c.id, "client_build", h.GetBuild())
		return true
	}
	e.m.hello[differs].Inc()
	e.cfg.Log.Info("game connection refused: versions differ", "request_id", c.reqID, "differs", helloNames[differs],
		"protocol", h.GetProtocol(), "catalog", h.GetCatalog(), "layout", h.GetPhysicsLayout(), "client_build", h.GetBuild())
	c.close(CloseVersion, "versions differ: reload")
	return false
}

// join takes the account's boat over from any older connection, then asks
// the simulation for it and hands the connection to the encoder, which
// welcomes it.
func (c *conn) join() bool {
	e := c.e
	if old := e.registry.claim(c); old != nil {
		old.stop()
		old.close(CloseReplaced, "playing on another device")
	}
	reply := make(chan bus.Reply, 1)
	c.wmu.Lock()
	if c.stopped {
		// A newer connection took the account over before this one asked.
		c.wmu.Unlock()
		return false
	}
	err := e.cfg.Bus.Commands.Players().TrySend(bus.Command{Op: bus.Join, Account: c.account, Conn: c.id, Reply: reply})
	c.wmu.Unlock()
	if err != nil {
		e.m.join[joinBusy].Inc()
		c.close(websocket.StatusTryAgainLater, "busy")
		return false
	}
	timer := time.NewTimer(e.lim.Join)
	defer timer.Stop()
	var r bus.Reply
	select {
	case r = <-reply:
	case <-timer.C:
		e.m.join[joinTimeout].Inc()
		c.close(websocket.StatusTryAgainLater, "busy")
		c.lateJoin(reply)
		return false
	case <-c.closed:
		c.lateJoin(reply)
		return false
	}
	switch r.Result {
	case bus.Joined, bus.Rejoined:
	case bus.Queued:
		// The sea is full: the connection waits, and its encoder tells it
		// its place, and welcomes it once the queue gives it a boat.
		e.m.join[joinQueued].Inc()
		c.position, c.joinTick = r.Position, r.Tick
		c.queued.Store(true)
		c.enc = e.encoderFor()
		c.enc.add(c)
		return true
	case bus.Full:
		e.m.join[joinFull].Inc()
		c.close(websocket.StatusTryAgainLater, "the sea and its queue are full")
		return false
	default:
		c.close(websocket.StatusInternalError, "no boat")
		return false
	}
	if r.Result == bus.Rejoined {
		e.m.join[joinRejoined].Inc()
	} else {
		e.m.join[joinJoined].Inc()
	}
	c.slot, c.gen, c.boat, c.rejoined, c.joinTick = r.Slot, r.Gen, r.Boat, r.Result == bus.Rejoined, r.Tick
	c.joined.Store(true)
	c.enc = e.encoderFor()
	c.enc.add(c)
	return true
}

// lateJoin waits, apart, for the answer to a Join the connection gave up
// on: if the simulation gave it a boat after all, the boat's grace begins;
// if it put it in the queue, it leaves it.
func (c *conn) lateJoin(reply <-chan bus.Reply) {
	e := c.e
	e.helpers.Add(1)
	go func() {
		defer e.helpers.Done()
		select {
		case r := <-reply:
			switch r.Result {
			case bus.Joined, bus.Rejoined:
				e.disconnect(bus.Command{Op: bus.Disconnect, Boat: r.Boat, Conn: c.id})
			case bus.Queued:
				e.disconnect(bus.Command{Op: bus.Disconnect, Account: c.account, Conn: c.id})
			}
		case <-e.ctx.Done():
		}
	}()
}

// handle acts on a message after the Hello; false ends the connection.
func (c *conn) handle(data []byte) bool {
	if !c.decode(data) {
		return false
	}
	switch b := c.msg.Body.(type) {
	case *pb.ClientMessage_Input:
		c.e.m.in[inInput].Inc()
		c.input(b.Input)
	case *pb.ClientMessage_Ping:
		c.e.m.in[inPing].Inc()
		return c.ping(b.Ping)
	case *pb.ClientMessage_Hello:
		c.e.m.in[inHello].Inc()
	case *pb.ClientMessage_Command:
		c.e.m.in[inCommand].Inc()
		if b.Command.GetResync() != nil {
			c.askResync(time.Now())
		}
	}
	return true
}

// resyncEvery is how often a client's request for a full snapshot is
// honoured, at most.
const resyncEvery = time.Second

// askResync has the next snapshot written in full, unless the client asked
// within the last second.
func (c *conn) askResync(now time.Time) {
	if !c.lastResync.IsZero() && now.Sub(c.lastResync) < resyncEvery {
		c.e.m.resyncIgnored.Inc()
		return
	}
	c.lastResync = now
	c.resync.Store(true)
	c.e.m.resyncHonoured.Inc()
}

// input takes the controls the client stepped its boat with, stamped for
// the tick it predicted them for: the word goes into the boat's slot once
// the tick before that has been published, and the tick applies it then
// (bus.Due).
func (c *conn) input(in *pb.Input) {
	e := c.e
	c.ack.Store(in.GetAckTick())
	if in.GetAckOnly() || !c.ready.Load() {
		return
	}
	latest := e.latest.Load()
	d := marginOf(in.GetSeq(), latest)
	c.margin.record(d)
	e.m.margin.Observe(float64(d))
	w := bus.Pack(in.GetSeq(), uint16(min(in.GetHelm(), bus.Steps)), uint16(min(in.GetSheet(), bus.Steps)), c.gen)
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if c.stopped {
		return
	}
	if c.nheld == heldWords {
		c.first = (c.first + 1) % heldWords
		c.nheld--
	}
	c.held[(c.first+c.nheld)%heldWords] = w
	c.nheld++
	c.releaseLocked(latest + 1)
}

// release stores the newest held word due by tick next, and forgets it and
// those before it.
func (c *conn) release(next int64) {
	c.wmu.Lock()
	c.releaseLocked(next)
	c.wmu.Unlock()
}

func (c *conn) releaseLocked(next int64) {
	if c.stopped {
		c.nheld = 0
		c.waiting.Store(0)
		return
	}
	due := -1
	for i := range c.nheld {
		if bus.Due(c.held[(c.first+i)%heldWords].Seq(), next) {
			due = i
		}
	}
	if due >= 0 {
		c.e.cfg.Bus.Controls.Store(c.slot, c.held[(c.first+due)%heldWords])
		c.first = (c.first + due + 1) % heldWords
		c.nheld -= due + 1
	}
	c.waiting.Store(int32(c.nheld))
}

// ping answers with world time.
func (c *conn) ping(p *pb.Ping) bool {
	e := c.e
	c.ack.Store(p.GetAckTick())
	if ms := p.GetRttMs(); ms > 0 {
		e.m.rtt.Observe(float64(ms) / 1000)
	}
	if ms := p.GetFrameMs(); ms > 0 {
		e.m.frame.Observe(float64(ms) / 1000)
	}
	wt, _ := e.cfg.Clock.WorldTime()
	return c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Pong{Pong: &pb.Pong{
		ClientTimeUs: p.GetClientTimeUs(), WorldTimeUs: wt.Microseconds(),
	}}}, outPong)
}

// send queues a message for the writer; a full queue closes the
// connection.
func (c *conn) send(m *pb.ServerMessage, kind int) bool {
	b, err := protocol.AppendServer(nil, m)
	if err != nil {
		c.close(websocket.StatusInternalError, "encoding")
		return false
	}
	select {
	case c.queue <- outgoing{b, kind}:
		return true
	default:
		c.close(websocket.StatusPolicyViolation, "too many messages waiting")
		return false
	}
}

// writer writes what is queued, then the newest snapshot, until the
// connection ends.
func (c *conn) writer() {
	defer c.e.running.Done()
	for {
		select {
		case <-c.done:
			return
		case o := <-c.queue:
			if !c.write(o.b, o.kind) {
				return
			}
		case <-c.box.signal:
		}
		// Queued messages go before the snapshot: a Welcome before the
		// connection's first.
		for queued := true; queued; {
			select {
			case o := <-c.queue:
				if !c.write(o.b, o.kind) {
					return
				}
			default:
				queued = false
			}
		}
		if b, tick := c.box.take(); b != nil {
			if !c.write(b, outSnapshot) {
				return
			}
			if ack := c.ack.Load(); ack > 0 {
				c.e.m.lag.Observe(float64(tick - ack))
			}
		}
	}
}

// write writes one message; one that takes longer than the limit drops the
// connection, whose peer is not reading.
func (c *conn) write(b []byte, kind int) bool {
	e := c.e
	start := time.Now()
	c.writeTimer.Reset(e.lim.Write)
	err := c.ws.Write(context.Background(), websocket.MessageBinary, b)
	c.writeTimer.Stop()
	if err != nil {
		return false
	}
	e.m.write.Observe(time.Since(start).Seconds())
	e.m.out[kind].Inc()
	e.m.bytesOut.Add(frameBytes(len(b), false))
	return true
}

// stop stops the connection writing its boat's control slot, for good.
func (c *conn) stop() {
	c.wmu.Lock()
	c.stopped = true
	c.wmu.Unlock()
}

// close closes the connection with a code, its handshake running apart;
// only the first close or drop counts.
func (c *conn) close(code websocket.StatusCode, reason string) {
	c.closeOnce.Do(func() {
		c.sent = code
		c.e.running.Add(1)
		go func() {
			defer c.e.running.Done()
			defer close(c.closed)
			_ = c.ws.Close(code, reason)
		}()
	})
}

// force closes the connection's socket at once, whatever close is under
// way: a close's handshake waiting on a peer that does not answer ends.
// (The library's CloseNow, after a Close, waits for that Close.)
func (c *conn) force() {
	c.drop()
	if c.raw != nil {
		_ = c.raw.Close()
	}
}

// drop closes the connection without a close frame.
func (c *conn) drop() {
	c.closeOnce.Do(func() {
		_ = c.ws.CloseNow()
		close(c.closed)
	})
}

// finish ends the connection once its reader has: the encoder lets it go,
// the registry forgets it, the close finishes, the writer stops, and if the
// connection had a boat, the boat's grace begins; if it was waiting for
// one, it leaves the queue, or, if the queue gave it one the edge had not
// yet seen, that boat's grace begins.
func (c *conn) finish() {
	e := c.e
	c.gone.Store(true)
	e.registry.release(c)
	c.drop()
	<-c.closed
	c.writeTimer.Stop()
	close(c.done)
	switch {
	case c.joined.Load():
		e.disconnect(bus.Command{Op: bus.Disconnect, Boat: c.boat, Conn: c.id})
	case c.queued.Load():
		e.disconnect(bus.Command{Op: bus.Disconnect, Account: c.account, Conn: c.id})
	}
	code := websocket.StatusCode(-1)
	switch {
	case c.sent != 0:
		code = c.sent
	case errors.Is(c.readErr, websocket.ErrMessageTooBig):
		code = websocket.StatusMessageTooBig
	default:
		code = websocket.CloseStatus(c.readErr)
	}
	e.m.closed(code)
	e.cfg.Log.Debug("game connection closed", "request_id", c.reqID, "conn", c.id, "code", int(code))
}

// disconnect tells the simulation a connection has ended, with cmd, a
// Disconnect, trying again each tick while its queue is full.
func (e *Edge) disconnect(cmd bus.Command) {
	players := e.cfg.Bus.Commands.Players()
	if players.TrySend(cmd) == nil {
		return
	}
	e.helpers.Add(1)
	go func() {
		defer e.helpers.Done()
		t := time.NewTicker(time.Second / 30)
		defer t.Stop()
		for players.TrySend(cmd) != nil {
			select {
			case <-t.C:
			case <-e.ctx.Done():
				return
			}
		}
	}()
}
