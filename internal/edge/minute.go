// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/daneelvt/keel-over-the-edge/internal/obs"
)

// A connection's data use, a minute at a time: the bytes it carried each
// way, as frames on the wire, and the bytes its page said it fetched over
// HTTP besides (models, land, code). Each whole minute at sea is observed
// once, by the connection's role as the minute ends: a minute queued, or
// idle with no boat and no watch, is not, nor the part of a minute a
// connection ends in. Nothing is kept per player.

// The roles a minute is counted under, and the directions.
const (
	roleSailing = iota
	roleWatching
	roles
)

const (
	dirIn = iota
	dirOut
	dirFetched
	dirAll
	directions
)

var (
	roleNames      = [roles]string{"sailing", "watching"}
	directionNames = [directions]string{"in", "out", "fetched", "all"}
)

// minuteCount is what a connection has carried since its minute began:
// start, in and fetched are the reader's, out the writer's.
type minuteCount struct {
	start   time.Time
	in      int64
	fetched int64
	out     atomic.Int64
}

// minuteObservers are the minute histogram's series, by role and direction.
type minuteObservers [roles][directions]prometheus.Observer

func newMinuteObservers(m *obs.Metrics) minuteObservers {
	var x minuteObservers
	for r, rn := range roleNames {
		for d, dn := range directionNames {
			x[r][d] = m.EdgeMinuteBytes.WithLabelValues(rn, dn)
		}
	}
	return x
}

// minuteRole is the role the connection's minute counts under: watching a
// boat, or sailing one (its own, or aboard another's); false for neither.
func (c *conn) minuteRole() (int, bool) {
	switch {
	case c.spectating.Load():
		return roleWatching, true
	case c.joined.Load() || c.crew.Load():
		return roleSailing, true
	}
	return 0, false
}

// countMinute adds what the page fetched, as a ping tells it, and, once a
// minute has passed since the count began, observes it scaled to the
// minute and begins the next. The first ping begins the count: what came
// before it, the page's start among it, is not a minute at sea. The
// reader's: pings come every 2 s, so a minute is observed within 2 s of
// its end.
func (c *conn) countMinute(now time.Time, fetched uint32) {
	m := &c.minute
	if m.start.IsZero() {
		m.start, m.in = now, 0
		m.out.Store(0)
		return
	}
	m.fetched += int64(fetched)
	took := now.Sub(m.start)
	if took < time.Minute {
		return
	}
	in, out, f := m.in, m.out.Swap(0), m.fetched
	m.start, m.in, m.fetched = now, 0, 0
	r, ok := c.minuteRole()
	if !ok {
		return
	}
	per := float64(time.Minute) / float64(took)
	o := &c.e.m.minute[r]
	o[dirIn].Observe(float64(in) * per)
	o[dirOut].Observe(float64(out) * per)
	o[dirFetched].Observe(float64(f) * per)
	o[dirAll].Observe(float64(in+out+f) * per)
}
