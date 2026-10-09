// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/daneelvt/keel-over-the-edge/internal/store/db"
)

// LeaseKey is the advisory lock that is the simulation's lease: the CRC-32
// of "keel sim lease", as goose's own lock is the CRC-32 of "goose"
// (4097083626), so the two never meet.
const LeaseKey int64 = 1866618722

// The lease's timing.
const (
	// LeasePoll is how often a process waiting for the lease asks for it.
	LeasePoll = 500 * time.Millisecond
	// LeasePing is how often the holder checks its connection, and
	// LeasePingLimit how long a check may take before the connection
	// counts as lost.
	LeasePing      = time.Second
	LeasePingLimit = 3 * time.Second
	// LeaseRetake is how long a holder whose connection was lost tries to
	// take the lease back before it gives up.
	LeaseRetake = 10 * time.Second
)

// The lease's connection's TCP keepalives: a database that vanishes
// without closing the socket is noticed within about 20 s even between
// checks, rather than Go's default of about 150 s.
var leaseKeepAlive = net.KeepAliveConfig{Enable: true, Idle: 5 * time.Second, Interval: 5 * time.Second, Count: 3}

// ErrLeaseLost is a lease that could not be taken back: another process
// may be running the world.
var ErrLeaseLost = errors.New("store: the simulation lease was lost")

// LeaseOptions are how a lease is taken and kept.
type LeaseOptions struct {
	// Holder names this process in the lease's row: its host and build.
	Holder string
	// Log, if not nil, is told about waiting (at most once a minute) and
	// about a lost connection.
	Log *slog.Logger
	// Beat, if not nil, is called while waiting, at least every second.
	Beat func()
	// Waiting, if not nil, is told who holds the lease while this process
	// waits for it.
	Waiting func(holder string)
	// Lost, if not nil, is told what came of each lost connection:
	// "retaken" or "lost".
	Lost func(outcome string)
	// Zero durations are the defaults above; tests shorten them.
	Poll, Ping, PingLimit, Retake time.Duration
}

// Lease is the simulation's lease: a session-level advisory lock held on
// a connection of its own, never one of a pool, for the process's life
// (PostgreSQL: "Once acquired at session level, an advisory lock is held
// until explicitly released or the session ends"), and the epoch its
// holder raised on taking it. If the process dies, the session ends with
// its socket and the lock is free.
type Lease struct {
	cfg *pgx.ConnConfig
	opt LeaseOptions

	mu    sync.Mutex
	conn  *pgx.Conn
	epoch int64
}

// NewLease reads the database's URL for a lease; it connects nothing.
func NewLease(url string, opt LeaseOptions) (*Lease, error) {
	cfg, err := pgx.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrConfig, err)
	}
	cfg.RuntimeParams["application_name"] = "keel sim lease"
	// pgx dials with a zero net.Dialer, which leaves keepalives to Go's
	// defaults (15 s idle, 15 s apart, 9 probes).
	d := &net.Dialer{KeepAliveConfig: leaseKeepAlive}
	cfg.DialFunc = d.DialContext
	opt.Poll = orDefault(opt.Poll, LeasePoll)
	opt.Ping = orDefault(opt.Ping, LeasePing)
	opt.PingLimit = orDefault(opt.PingLimit, LeasePingLimit)
	opt.Retake = orDefault(opt.Retake, LeaseRetake)
	return &Lease{cfg: cfg, opt: opt}, nil
}

// Epoch is the epoch this process took the lease at.
func (l *Lease) Epoch() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.epoch
}

// LeaseState is the lease's row: who took it last, when, and at what epoch.
type LeaseState struct {
	Epoch  int64
	Holder string
	Since  time.Time
}

// Take waits until the lease is free, asking every Poll, and takes it: the
// epoch is raised by one and this process named its holder. The raise waits
// for any fenced transaction of the last holder still open, so nothing it
// writes can land after. Take returns the new epoch, or ctx's error.
func (l *Lease) Take(ctx context.Context) (int64, error) {
	var logged time.Time
	for {
		l.beat()
		held, state, err := l.try(ctx)
		if err == nil && held {
			epoch, err := l.raise(ctx)
			if err == nil {
				return epoch, nil
			}
			l.closeConn()
			if ctx.Err() != nil {
				return 0, ctx.Err()
			}
		}
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		if err == nil && l.opt.Waiting != nil {
			l.opt.Waiting(state.Holder)
		}
		if l.opt.Log != nil && time.Since(logged) >= time.Minute {
			if err != nil {
				l.opt.Log.Warn("waiting for the simulation lease", "err", err)
			} else {
				l.opt.Log.Info("waiting for the simulation lease", "holder", state.Holder, "epoch", state.Epoch, "since", state.Since)
			}
			logged = time.Now()
		}
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-time.After(l.opt.Poll):
		}
	}
}

// try asks for the lock once, connecting first if need be; when another
// holds it, it says who.
func (l *Lease) try(ctx context.Context) (bool, LeaseState, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.conn == nil {
		cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		conn, err := pgx.ConnectConfig(cctx, l.cfg.Copy())
		cancel()
		if err != nil {
			return false, LeaseState{}, err
		}
		l.conn = conn
	}
	qctx, cancel := context.WithTimeout(ctx, l.opt.PingLimit)
	defer cancel()
	q := db.New(l.conn)
	held, err := q.TryLease(qctx, LeaseKey)
	if err != nil {
		l.closeLocked()
		return false, LeaseState{}, err
	}
	if held {
		return true, LeaseState{}, nil
	}
	row, err := q.LeaseHolder(qctx)
	if err != nil {
		l.closeLocked()
		return false, LeaseState{}, err
	}
	return false, LeaseState{Epoch: row.Epoch, Holder: row.Holder, Since: row.Since.Time}, nil
}

// raise raises the epoch, holding the lock.
func (l *Lease) raise(ctx context.Context) (int64, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	epoch, err := db.New(l.conn).RaiseLeaseEpoch(ctx, l.opt.Holder)
	if err != nil {
		return 0, err
	}
	l.epoch = epoch
	return epoch, nil
}

// Watch checks the lease's connection every Ping until ctx ends, when it
// returns nil. A check that fails, or takes longer than PingLimit, is a lost
// connection: the simulation carries on (it never waits on the database)
// while Watch tries for up to Retake to take the lock back. Taken back with
// the epoch unchanged, nobody else held the lease long enough to write, and
// anyone who takes it later is fenced from this process's writes: Watch
// carries on. If the epoch moved, or Retake passed, it returns
// ErrLeaseLost, and the process must stop.
func (l *Lease) Watch(ctx context.Context) error {
	t := time.NewTicker(l.opt.Ping)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
		if err := l.ping(ctx); err == nil || ctx.Err() != nil {
			continue
		} else if l.opt.Log != nil {
			l.opt.Log.Warn("the simulation lease's connection was lost; taking the lease back", "err", err)
		}
		err := l.retake(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			l.lost("lost")
			return err
		}
		l.lost("retaken")
		if l.opt.Log != nil {
			l.opt.Log.Info("the simulation lease was taken back", "epoch", l.Epoch())
		}
	}
}

func (l *Lease) ping(ctx context.Context) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.conn == nil {
		return errors.New("no connection")
	}
	pctx, cancel := context.WithTimeout(ctx, l.opt.PingLimit)
	defer cancel()
	return l.conn.Ping(pctx)
}

// retake opens a new connection and takes the lock again, if it is free
// within Retake and the epoch has not moved.
func (l *Lease) retake(ctx context.Context) error {
	l.closeConn()
	deadline := time.Now().Add(l.opt.Retake)
	for {
		held, _, err := l.try(ctx)
		if err == nil && held {
			row, err := l.state(ctx)
			if err == nil {
				if row.Epoch != l.Epoch() {
					l.closeConn()
					return fmt.Errorf("%w: its epoch is %d, this process's %d", ErrLeaseLost, row.Epoch, l.Epoch())
				}
				return nil
			}
			l.closeConn()
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			return fmt.Errorf("%w: not taken back within %v", ErrLeaseLost, l.opt.Retake)
		}
		select {
		case <-ctx.Done():
		case <-time.After(l.opt.Poll):
		}
	}
}

func (l *Lease) state(ctx context.Context) (LeaseState, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	qctx, cancel := context.WithTimeout(ctx, l.opt.PingLimit)
	defer cancel()
	row, err := db.New(l.conn).LeaseHolder(qctx)
	return LeaseState{Epoch: row.Epoch, Holder: row.Holder, Since: row.Since.Time}, err
}

// Release gives the lease up: the lock released, then its connection
// closed, which would end the session and free the lock even had the
// release not been sent.
func (l *Lease) Release(ctx context.Context) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.conn == nil {
		return
	}
	rctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_, _ = db.New(l.conn).ReleaseLease(rctx, LeaseKey)
	l.closeLocked()
}

func (l *Lease) closeConn() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.closeLocked()
}

func (l *Lease) closeLocked() {
	if l.conn == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = l.conn.Close(ctx)
	l.conn = nil
}

func (l *Lease) beat() {
	if l.opt.Beat != nil {
		l.opt.Beat()
	}
}

func (l *Lease) lost(outcome string) {
	if l.opt.Lost != nil {
		l.opt.Lost(outcome)
	}
}
