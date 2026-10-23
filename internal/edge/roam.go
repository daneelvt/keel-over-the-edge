// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"math"
	"sync"
	"sync/atomic"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// The owner's free camera. A connection whose account carries the owner's
// flag may send Roam: while it roams, the connection's eye is the camera's
// point, and the other boats it is sent, its sea's window and the land's
// chunks it is handed are those about the eye, the chunks by a handout made
// for the camera's greatest height. Its boat stays where it is (bus.Stay),
// not stepped, so it can neither drift aground nor over the lip unseen,
// until the camera comes back, the flag is cleared or the connection ends.
// The server cannot see a camera, so the flag, not the message, is the
// gate: from any other account Roam is ignored, and counted.

// RoamReach is how far the free camera roams: the whole disk and Beyond
// metres past its lip, from Low to High metres above the sea.
type RoamReach struct {
	Beyond, Low, High float64
}

// DefaultRoamReach is the starting reach: 500 m past the lip, 2 to 500 m
// up. From 500 m the horizon is 1.6 km off on the dome, high enough to see
// an island whole and the falls from beyond the lip.
var DefaultRoamReach = RoamReach{Beyond: 500, Low: 2, High: 500}

// eye is where a roaming camera is: east, north and up, m.
type eye struct {
	x, y, z float64
}

// clamp is the point (x, y, z) brought within the reach of a disk whose lip
// is lip metres from the centre.
func (r RoamReach) clamp(lip, x, y, z float64) eye {
	if math.IsNaN(x) || math.IsNaN(y) || math.IsInf(x, 0) || math.IsInf(y, 0) {
		x, y = 0, 0
	}
	if d, most := math.Hypot(x, y), lip+r.Beyond; d > most {
		x, y = x*most/d, y*most/d
	}
	if !(z >= r.Low) {
		z = r.Low
	}
	return eye{x, y, min(z, r.High)}
}

// roamTo moves the connection's free camera as the client asks: off the
// boat to a point, or back to it. A connection whose account does not
// carry the owner's flag is refused.
func (c *conn) roamTo(r *pb.Roam) {
	e := c.e
	if !c.tools.Load() {
		e.m.roamRefused.Inc()
		return
	}
	if !c.ready.Load() {
		// Not yet sailing: there is no boat to leave.
		return
	}
	c.rmu.Lock()
	defer c.rmu.Unlock()
	if !r.GetOn() {
		c.landLocked()
		return
	}
	at := e.reach.clamp(e.cfg.Lip, float64(r.GetEast())/100, float64(r.GetNorth())/100, float64(r.GetHeight())/100)
	c.eye.Store(&at)
	if !c.stayed {
		c.stayed = true
		e.owner(bus.Command{Op: bus.Stay, Boat: c.boat, On: true})
	}
}

// landLocked brings the free camera back to the boat: the eye is the
// boat's again, and the boat sails on. rmu must be held.
func (c *conn) landLocked() {
	c.eye.Store(nil)
	if c.stayed {
		c.stayed = false
		c.e.owner(bus.Command{Op: bus.Stay, Boat: c.boat, On: false})
	}
}

// land brings the free camera back, as the connection ends.
func (c *conn) land() {
	c.rmu.Lock()
	c.landLocked()
	c.rmu.Unlock()
}

// Tools tells the open connection of an account, if it has one, that its
// owner's flag is now on or off: the free camera is offered, or withdrawn
// and brought back to the boat. It reports whether the account had a
// connection.
func (e *Edge) Tools(account bus.Account, on bool) bool {
	c := e.registry.get(account)
	if c == nil {
		return false
	}
	c.rmu.Lock()
	defer c.rmu.Unlock()
	c.tools.Store(on)
	if !on {
		c.landLocked()
	}
	if c.welcomed {
		// After the Welcome, which carried the flag as it was: queued
		// under rmu, as the Welcome is, so the two arrive in order.
		c.send(&pb.ServerMessage{Body: &pb.ServerMessage_Tools{Tools: &pb.Tools{On: on}}}, outTools)
	}
	return true
}

// Remove takes an account just deleted out of the game: its connection,
// if it has one, is closed with 4003, and its boat, in the water with a
// connection or in its grace without one, leaves at once.
func (e *Edge) Remove(account bus.Account) {
	if c := e.registry.get(account); c != nil {
		c.stop()
		c.close(CloseRemoved, "this sailor has been deleted")
	}
	f := e.cfg.Bus.Frames.Acquire()
	var boat uint64
	for _, s := range f.Live {
		if f.Owner[s] == account {
			boat = f.Boat[s]
			break
		}
	}
	f.Release()
	if boat != 0 {
		// Sent as a Disconnect is, trying again each tick while the
		// queue is full.
		e.disconnect(bus.Command{Op: bus.Leave, Boat: boat})
	}
}

// Eye is where the free camera of an account's connection is, east and
// north, m; ok is false unless it roams.
func (e *Edge) Eye(account bus.Account) (x, y float64, ok bool) {
	c := e.registry.get(account)
	if c == nil {
		return 0, 0, false
	}
	p := c.eye.Load()
	if p == nil {
		return 0, 0, false
	}
	return p.x, p.y, true
}

// owner sends one of the owner's tools' commands, trying again each tick
// while the queue is full.
func (e *Edge) owner(cmd bus.Command) {
	owner := e.cfg.Bus.Commands.Owner()
	if owner.TrySend(cmd) == nil {
		return
	}
	e.helpers.Add(1)
	go func() {
		defer e.helpers.Done()
		t := time.NewTicker(time.Second / 30)
		defer t.Stop()
		for owner.TrySend(cmd) != nil {
			select {
			case <-t.C:
			case <-e.ctx.Done():
				return
			}
		}
	}()
}

// roaming is the free camera's state on a connection.
type roaming struct {
	// tools: the account carries the owner's flag, as the upgrade read it
	// and Tools has said since.
	tools atomic.Bool
	// eye is where the camera roams, nil while it is on the boat: set by
	// the reader under rmu, read by the encoder.
	eye atomic.Pointer[eye]
	// rmu orders the camera's changes, the Stay sent for them, and the
	// Welcome against Tools; stayed is whether the boat was last told to
	// stay, welcomed whether the Welcome has been queued.
	rmu      sync.Mutex
	stayed   bool
	welcomed bool
}
