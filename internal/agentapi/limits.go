// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"fmt"
	"math"
	"time"

	"golang.org/x/time/rate"
)

// The action limit. Every machine sailor has the same two budgets, so
// reading the sea never costs an order: orders (steer, trim, boat, race),
// and looks (every other tool), each so many a second with a burst, by a
// token bucket. A second, not a minute, so actions cannot be saved up for
// a burst. A call over its budget is refused in its result, with how long
// to wait and the order the boat holds; nothing it asked for is done.

// Limits are the two budgets.
type Limits struct {
	Orders     rate.Limit
	OrderBurst int
	Looks      rate.Limit
	LookBurst  int
}

// DefaultLimits are the budgets every machine sailor has: orders 2 a
// second, burst 5; looks 4 a second, burst 10. Two orders a second trims
// the sheet through a gust (its whole range eases in a second), and no
// hand steering at that rate holds a course better than the autopilot.
var DefaultLimits = Limits{Orders: 2, OrderBurst: 5, Looks: 4, LookBurst: 10}

// String is the budgets in words, as the world page and the handbook give
// them.
func (l Limits) String() string {
	return fmt.Sprintf("orders %s a second, burst %d; looks %s a second, burst %d",
		trimFloat(float64(l.Orders)), l.OrderBurst, trimFloat(float64(l.Looks)), l.LookBurst)
}

func trimFloat(v float64) string {
	if v == math.Trunc(v) {
		return fmt.Sprintf("%d", int(v))
	}
	return fmt.Sprintf("%g", v)
}

// budget is a call's budget: orders or looks.
type budget uint8

const (
	looks budget = iota
	orders
)

// spend takes one from the helm's budget b now, or says how long until
// one is there.
func (h *helm) spend(b budget, now time.Time) (ok bool, wait time.Duration) {
	l := h.looks
	if b == orders {
		l = h.orders
	}
	r := l.ReserveN(now, 1)
	if !r.OK() {
		return false, time.Second
	}
	if d := r.DelayFrom(now); d > 0 {
		r.CancelAt(now)
		return false, d
	}
	return true, 0
}
