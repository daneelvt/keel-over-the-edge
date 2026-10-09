// SPDX-License-Identifier: AGPL-3.0-only

package obs

import (
	"net/http"
	"net/http/pprof"
)

// InternalPaths are the paths the internal listener serves, for tests that
// check the public listeners serve none of them.
var InternalPaths = []string{
	"/livez", "/readyz", "/metrics",
	"/debug/pprof/", "/debug/pprof/cmdline", "/debug/pprof/profile", "/debug/pprof/symbol",
	"/debug/pprof/trace", "/debug/pprof/goroutine", "/debug/pprof/goroutineleak",
	"/debug/flightrecorder", "/debug/replay", "/debug/wind",
}

// Internal returns the internal listener's routes: the probes, the metrics,
// the profiles, the flight recorder's trace and the input log. pprof's
// handlers are registered here by hand; importing net/http/pprof also
// registers them on http.DefaultServeMux, which the server never serves.
// flight, replay and wind may be nil, and their routes then answer 404;
// wind, a developer's command, is POST /debug/wind.
func Internal(h *Health, m *Metrics, flight, replay, wind http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /livez", h.LiveHandler())
	mux.Handle("GET /readyz", h.ReadyHandler())
	mux.Handle("GET /metrics", m.Handler())
	// Index also serves every named profile: /debug/pprof/heap,
	// /debug/pprof/goroutine and the rest.
	mux.HandleFunc("GET /debug/pprof/", pprof.Index)
	mux.HandleFunc("GET /debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("GET /debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("GET /debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("POST /debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("GET /debug/pprof/trace", pprof.Trace)
	if flight != nil {
		mux.Handle("GET /debug/flightrecorder", flight)
	}
	if replay != nil {
		mux.Handle("GET /debug/replay", replay)
	}
	if wind != nil {
		mux.Handle("POST /debug/wind", wind)
	}
	return mux
}
