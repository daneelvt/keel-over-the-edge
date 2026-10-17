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
	"/debug/flightrecorder", "/debug/replay", "/debug/wind", "/debug/weather", "/debug/place",
	// The owner's tools' (internal/owner's Paths).
	"/owner/", "/owner/index.html", "/owner/assets/x.js",
	"/owner/api/world.json", "/owner/api/gusts.bin", "/owner/api/islands.json", "/owner/api/current.json",
	"/owner/api/land.png", "/owner/api/coasts.svg", "/owner/api/island/0.svg", "/owner/api/point",
	"/owner/api/flag", "/owner/api/place", "/owner/api/unseen",
}

// Internal returns the internal listener's routes: the probes, the metrics,
// the profiles, the flight recorder's trace, the input log and the owner's
// tools. pprof's handlers are registered here by hand; importing
// net/http/pprof also registers them on http.DefaultServeMux, which the
// server never serves. flight, replay, weather and owner may be nil, and
// their routes then answer 404; weather, the developer's commands, is POST
// /debug/wind, /debug/weather, /debug/encounter and /debug/place; owner is
// everything under /owner/, which guards itself.
func Internal(h *Health, m *Metrics, flight, replay, weather, owner http.Handler) http.Handler {
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
	if weather != nil {
		mux.Handle("POST /debug/wind", weather)
		mux.Handle("POST /debug/weather", weather)
		mux.Handle("POST /debug/encounter", weather)
		mux.Handle("POST /debug/place", weather)
	}
	if owner != nil {
		mux.Handle("/owner/", owner)
	}
	return mux
}

// MetricsOnly returns the metrics listener's routes: GET /metrics, and
// nothing else. A scraper let in to it reaches no profile, trace or input
// log, which a NetworkPolicy, filtering ports and not paths, could not
// keep from it on the internal listener.
func MetricsOnly(m *Metrics) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", m.Handler())
	return mux
}
