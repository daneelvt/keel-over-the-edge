// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"context"
	"sync"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The way home. A skipper may lift their own boat home to the start off
// Port Royal from the sea, at most once a minute: the simulation ends its
// voyage, lifted, and starts it again at the start, those aboard still
// aboard (bus.Lift). The connection, and everyone aboard, are told the
// tick it was lifted at, so each covers its screen until the boat is
// drawn there; a second lift inside the minute is told it is too soon.
//
// From the start screen, a player may take their boat out of the water
// instead, with no grace, as watching does (TakeOut): a connection that
// sails it on another screen is closed and sent to its own start screen.

// LiftEvery is how often an account's boat may be lifted home.
const LiftEvery = time.Minute

// liftWait is how long a connection waits for the simulation to lift its
// boat.
const liftWait = 2 * time.Second

// ReasonTakenOut is the reason a connection closed with CloseRemoved
// carries when its boat was taken out of the water from another screen.
const ReasonTakenOut = "Your boat was taken out of the water on another screen."

// lifts are when each account's boat was last lifted home.
type lifts struct {
	mu sync.Mutex
	at map[bus.Account]time.Time
}

// take reports whether account's boat may be lifted at now, and if so
// marks it lifted then. Those lifted more than a minute ago are forgotten.
func (l *lifts) take(a bus.Account, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if t, ok := l.at[a]; ok && now.Sub(t) < LiftEvery {
		return false
	}
	if l.at == nil {
		l.at = map[bus.Account]time.Time{}
	}
	for b, t := range l.at {
		if now.Sub(t) >= LiftEvery {
			delete(l.at, b)
		}
	}
	l.at[a] = now
	return true
}

// forget undoes a take whose lift did not happen.
func (l *lifts) forget(a bus.Account) {
	l.mu.Lock()
	delete(l.at, a)
	l.mu.Unlock()
}

// homeCommand lifts the connection's own boat home, if it sails one and
// was not lifted within the minute, and tells it how that went; lifted,
// everyone aboard is told too.
func (c *conn) homeCommand(now time.Time) {
	e := c.e
	if !c.joined.Load() || c.crew.Load() || c.spectating.Load() {
		c.lifted(&pb.Lifted{})
		return
	}
	if !e.lifts.take(c.account, now) {
		c.lifted(&pb.Lifted{Soon: true})
		return
	}
	c.wmu.Lock()
	boat := c.boat
	c.wmu.Unlock()
	reply := make(chan bus.Reply, 1)
	r := bus.Reply{Result: bus.NoBoat}
	if err := e.cfg.Bus.Commands.Players().TrySend(bus.Command{Op: bus.Lift, Account: c.account, Boat: boat, Reply: reply}); err == nil {
		t := time.NewTimer(liftWait)
		select {
		case r = <-reply:
		case <-t.C:
		case <-e.ctx.Done():
		}
		t.Stop()
	}
	if r.Result != bus.Done {
		e.lifts.forget(c.account)
		c.lifted(&pb.Lifted{})
		return
	}
	told := &pb.Lifted{Tick: r.Tick}
	c.lifted(told)
	// Those aboard come home with it, and cover their screens alike.
	f := e.cfg.Bus.Frames.Acquire()
	var aboard []bus.Account
	if s := r.Slot; s >= 0 && int(s) < f.Capacity() && f.Occupied[s] && f.Boat[s] == boat {
		lo, hi := f.CrewOf(s)
		for i := lo; i < hi; i++ {
			aboard = append(aboard, f.Crew[i].Account)
		}
	}
	f.Release()
	for _, a := range aboard {
		if o := e.registry.get(a); o != nil && o.crew.Load() {
			o.lifted(told)
		}
	}
}

// lifted tells the connection how a lift home went.
func (c *conn) lifted(m *pb.Lifted) {
	c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Lifted{Lifted: m}}, outLifted)
}

// TakeOut takes an account's boat out of the water at once, with no grace,
// at its player's word from the start screen: in its grace, or sailing on
// another screen, whose connection is closed with CloseRemoved and
// ReasonTakenOut, which sends it to its own start screen. Those aboard go
// ashore at the nearest port, as for any boat that leaves. It reports
// whether there was a boat, and returns once the world no longer holds
// it, or ctx is done.
func (e *Edge) TakeOut(ctx context.Context, id store.AccountID) (bool, error) {
	account := bus.Account(id)
	f := e.cfg.Bus.Frames.Acquire()
	var boat uint64
	if s := findBoat(f, account); s >= 0 {
		boat = f.Boat[s]
	}
	f.Release()
	if boat == 0 {
		return false, nil
	}
	if c := e.registry.get(account); c != nil && c.joined.Load() {
		c.wmu.Lock()
		mine := c.boat == boat
		c.wmu.Unlock()
		if mine {
			c.stop()
			c.close(CloseRemoved, ReasonTakenOut)
		}
	}
	e.disconnect(bus.Command{Op: bus.Leave, Boat: boat})
	t := time.NewTicker(time.Second / 30)
	defer t.Stop()
	for {
		f := e.cfg.Bus.Frames.Acquire()
		gone := true
		for _, s := range f.Live {
			gone = gone && f.Boat[s] != boat
		}
		f.Release()
		if gone {
			return true, nil
		}
		select {
		case <-t.C:
		case <-ctx.Done():
			return true, ctx.Err()
		}
	}
}
