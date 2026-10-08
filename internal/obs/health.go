// SPDX-License-Identifier: AGPL-3.0-only

// Package obs is how the server is observed: its logs, metrics, health
// probes, profiles and execution traces, served on an internal listener the
// public never reaches.
package obs

import (
	"net/http"
	"sync/atomic"
	"time"
)

// StaleAfter is how long the heartbeat may go unbeaten before the process
// counts as stuck.
const StaleAfter = 10 * time.Second

// Health answers the two probes. Liveness asks only whether the process is
// stuck, which a restart cures; readiness asks whether it should be sent
// players, which depends on what it has started.
type Health struct {
	base      time.Time
	beat      atomic.Int64 // when last beaten, nanoseconds after base on the monotonic clock
	ticked    atomic.Bool
	listening atomic.Bool
	stopping  atomic.Bool
	waiting   atomic.Pointer[string] // what starting waits for, if anything
}

// NewHealth returns a health beaten now.
func NewHealth() *Health { return &Health{base: time.Now()} }

// Beat records that the process is making progress: each step of starting,
// then the tick loop after every tick.
func (h *Health) Beat() { h.beat.Store(int64(time.Since(h.base))) }

// Ticked records that the world has ticked.
func (h *Health) Ticked() { h.ticked.Store(true) }

// Listening records whether the public listeners are open.
func (h *Health) Listening(open bool) { h.listening.Store(open) }

// Waiting records what starting is waiting for, such as the database, or
// "" once it waits for nothing: the process is not ready meanwhile.
func (h *Health) Waiting(what string) { h.waiting.Store(&what) }

// Stopping records that the process has begun to stop: it is no longer
// ready, at once.
func (h *Health) Stopping() { h.stopping.Store(true) }

// Live reports whether the heartbeat is fresh, and if not why.
func (h *Health) Live() (bool, string) {
	if age := time.Since(h.base) - time.Duration(h.beat.Load()); age >= StaleAfter {
		return false, "no heartbeat for " + age.Round(time.Millisecond).String()
	}
	return true, "ok"
}

// Ready reports whether the process should be sent traffic, and if not why.
func (h *Health) Ready() (bool, string) {
	switch {
	case h.stopping.Load():
		return false, "stopping"
	case h.waitingFor() != "":
		return false, "waiting for " + h.waitingFor()
	case !h.ticked.Load():
		return false, "the world has not ticked yet"
	case !h.listening.Load():
		return false, "the listeners are not open"
	}
	return true, "ok"
}

func (h *Health) waitingFor() string {
	if w := h.waiting.Load(); w != nil {
		return *w
	}
	return ""
}

// LiveHandler serves the liveness probe.
func (h *Health) LiveHandler() http.Handler { return probe(h.Live) }

// ReadyHandler serves the readiness probe.
func (h *Health) ReadyHandler() http.Handler { return probe(h.Ready) }

func probe(check func() (bool, string)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		ok, why := check()
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		if !ok {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		_, _ = w.Write([]byte(why + "\n"))
	})
}
