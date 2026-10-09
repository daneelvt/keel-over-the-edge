// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"context"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Lag is a model of a slow, lossy network under TCP, for the game
// connection, which is TCP: each chunk written arrives after a one-way
// delay; a chunk "lost" is not lost, as TCP sends it again, but held for a
// further probe timeout of twice the round trip (RFC 8985, 7.2, the tail
// loss probe), and, if the probe is lost too, for a retransmission timeout
// of a second more (RFC 6298); and nothing behind a held chunk overtakes
// it, since TCP delivers in order. Each chunk stands for a segment, and
// every loss is treated as a tail loss, which suits small, sparse game
// messages.
type Lag struct {
	// Delay is the one-way delay; the round trip is twice it.
	Delay time.Duration
	// Loss is the chance that a chunk is lost, in each direction.
	Loss float64
	// Seed makes a run repeat.
	Seed uint64
}

// ParseLag reads "200ms,2%": the round trip and the loss in each
// direction.
func ParseLag(s string) (Lag, error) {
	rtt, loss, ok := strings.Cut(s, ",")
	d, err := time.ParseDuration(strings.TrimSpace(rtt))
	if err != nil || d < 0 {
		return Lag{}, fmt.Errorf("lag %q: a round trip such as 200ms, then a loss such as 2%%", s)
	}
	l := Lag{Delay: d / 2}
	if ok {
		p, err := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(loss), "%"), 64)
		if err != nil || p < 0 || p >= 100 {
			return Lag{}, fmt.Errorf("lag %q: a loss from 0%% to under 100%%", s)
		}
		l.Loss = p / 100
	}
	return l, nil
}

// String writes l as ParseLag reads it.
func (l Lag) String() string {
	return fmt.Sprintf("%v,%g%%", 2*l.Delay, l.Loss*100)
}

// Retransmission is the timeout after a lost probe.
const Retransmission = time.Second

// A Line delays one direction of a connection as the model says: Hold
// gives each chunk, in the order written, the time it may be delivered.
type Line struct {
	lag  Lag
	rng  *rand.Rand
	last time.Time
}

// NewLine makes one direction's line; stream tells the two directions'
// random numbers apart.
func (l Lag) NewLine(stream uint64) *Line {
	return &Line{lag: l, rng: rand.New(rand.NewPCG(l.Seed, stream))}
}

// Hold is when a chunk written at now arrives.
func (ln *Line) Hold(now time.Time) time.Time {
	at := now.Add(ln.lag.Delay)
	if ln.lag.Loss > 0 && ln.rng.Float64() < ln.lag.Loss {
		at = at.Add(4 * ln.lag.Delay)
		if ln.rng.Float64() < ln.lag.Loss {
			at = at.Add(Retransmission)
		}
	}
	if at.Before(ln.last) {
		at = ln.last
	}
	ln.last = at
	return at
}

// Wrap puts the model on a connection, both ways: what is written to the
// result reaches c after the model's delay, and what c receives is read
// from the result after it.
func (l Lag) Wrap(c net.Conn) net.Conn {
	lc := &lagConn{Conn: c}
	// Closing sends what was written first, as TCP does before its FIN.
	lc.out = newPipe(l.NewLine(1), func(b []byte) error {
		_, err := c.Write(b)
		return err
	}, func() { c.Close() })
	lc.in = newPipe(l.NewLine(2), nil, nil)
	go func() {
		buf := make([]byte, 64<<10)
		for {
			n, err := c.Read(buf)
			if n > 0 {
				lc.in.put(buf[:n])
			}
			if err != nil {
				lc.in.fail(err)
				return
			}
		}
	}()
	return lc
}

type lagConn struct {
	net.Conn
	out, in   *pipe
	closeOnce sync.Once
}

// A Staller is a connection whose sending can be held up, as a network
// that drops everything for a while and then delivers it.
type Staller interface {
	// Stall holds everything written until then.
	Stall(until time.Time)
}

func (c *lagConn) Stall(until time.Time) {
	c.out.mu.Lock()
	c.out.line.last = until
	c.out.mu.Unlock()
}

func (c *lagConn) Write(b []byte) (int, error) {
	if err := c.out.put(b); err != nil {
		return 0, err
	}
	return len(b), nil
}

func (c *lagConn) Read(b []byte) (int, error) { return c.in.read(b) }

func (c *lagConn) Close() error {
	c.closeOnce.Do(func() {
		c.in.abort()
		c.out.fail(net.ErrClosed)
	})
	return nil
}

// pipe holds chunks until their time. With deliver, a goroutine hands each
// to it at its time; without, read returns them once due.
type pipe struct {
	line    *Line
	deliver func([]byte) error
	done    func() // after the last chunk is delivered, if not nil

	mu     sync.Mutex
	chunks []chunk
	err    error
	wake   chan struct{}
}

type chunk struct {
	at time.Time
	b  []byte
}

func newPipe(line *Line, deliver func([]byte) error, done func()) *pipe {
	p := &pipe{line: line, deliver: deliver, done: done, wake: make(chan struct{}, 1)}
	if deliver != nil {
		go p.run()
	}
	return p
}

func (p *pipe) put(b []byte) error {
	p.mu.Lock()
	if p.err != nil {
		p.mu.Unlock()
		return p.err
	}
	p.chunks = append(p.chunks, chunk{at: p.line.Hold(time.Now()), b: append([]byte(nil), b...)})
	p.mu.Unlock()
	p.signal()
	return nil
}

func (p *pipe) signal() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

// fail ends the pipe once the chunks it holds have gone: nothing more is
// put, and next returns err after them.
func (p *pipe) fail(err error) {
	p.mu.Lock()
	if p.err == nil {
		p.err = err
	}
	p.mu.Unlock()
	p.signal()
}

// abort ends the pipe at once, dropping what it holds.
func (p *pipe) abort() {
	p.mu.Lock()
	p.chunks = nil
	if p.err == nil {
		p.err = net.ErrClosed
	}
	p.mu.Unlock()
	p.signal()
}

// next waits for the first chunk's time and takes it.
func (p *pipe) next() ([]byte, error) {
	for {
		p.mu.Lock()
		if len(p.chunks) == 0 {
			err := p.err
			p.mu.Unlock()
			if err != nil {
				return nil, err
			}
			<-p.wake
			continue
		}
		c := p.chunks[0]
		if wait := time.Until(c.at); wait > 0 {
			p.mu.Unlock()
			t := time.NewTimer(wait)
			select {
			case <-t.C:
			case <-p.wake:
				t.Stop()
			}
			continue
		}
		p.chunks = p.chunks[1:]
		p.mu.Unlock()
		return c.b, nil
	}
}

func (p *pipe) run() {
	for {
		b, err := p.next()
		if err != nil {
			if p.done != nil {
				p.done()
			}
			return
		}
		if p.deliver(b) != nil {
			p.fail(io.ErrClosedPipe)
			return
		}
	}
}

// read returns what is due, waiting for the first chunk's time.
func (p *pipe) read(b []byte) (int, error) {
	p.mu.Lock()
	if len(p.chunks) > 0 && !p.chunks[0].at.After(time.Now()) {
		c := &p.chunks[0]
		n := copy(b, c.b)
		c.b = c.b[n:]
		if len(c.b) == 0 {
			p.chunks = p.chunks[1:]
		}
		p.mu.Unlock()
		return n, nil
	}
	p.mu.Unlock()
	c, err := p.next()
	if err != nil {
		return 0, err
	}
	n := copy(b, c)
	if n < len(c) {
		// Put the rest back at the front, due at once.
		p.mu.Lock()
		p.chunks = append([]chunk{{at: time.Now(), b: c[n:]}}, p.chunks...)
		p.mu.Unlock()
	}
	return n, nil
}

// Proxy forwards each connection ln accepts to target through the model,
// until ctx ends: the browser's traffic slowed and lost as the model says,
// the same on every machine and phone. Each connection's lines are seeded
// from the model's seed and the connection's number, so a run repeats.
func Proxy(ctx context.Context, ln net.Listener, target string, l Lag) error {
	go func() {
		<-ctx.Done()
		ln.Close()
	}()
	var d net.Dialer
	for n := uint64(0); ; n++ {
		c, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		go func() {
			defer c.Close()
			up, err := d.DialContext(ctx, "tcp", target)
			if err != nil {
				return
			}
			conn := l
			conn.Seed = l.Seed*1_000_003 + n
			w := conn.Wrap(up)
			defer w.Close()
			done := make(chan struct{}, 2)
			go func() { io.Copy(w, c); done <- struct{}{} }()
			go func() { io.Copy(c, w); done <- struct{}{} }()
			select {
			case <-done:
			case <-ctx.Done():
			}
		}()
	}
}
