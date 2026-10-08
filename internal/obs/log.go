// SPDX-License-Identifier: AGPL-3.0-only

package obs

import (
	"context"
	"crypto/rand"
	"io"
	"log/slog"
	"net/http"
	"time"
)

// NewLogger logs JSON lines to w at level and above, each with the build.
func NewLogger(w io.Writer, level slog.Level, build string) *slog.Logger {
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{Level: level})).With("build", build)
}

type requestIDKey struct{}

// RequestID is the ID the access log gave a request, or "".
func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

// AccessLog logs every request next serves, after it is served: its ID,
// method, the route it matched, status, bytes written and duration. The
// route is the mux's pattern, never the path or the query, so nothing a
// player puts in a URL reaches the logs. Each request gets a random ID,
// returned as X-Request-Id and in its context, for RequestID.
func AccessLog(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		id := rand.Text()
		w.Header().Set("X-Request-Id", id)
		r = r.WithContext(context.WithValue(r.Context(), requestIDKey{}, id))
		rw := &responseWriter{ResponseWriter: w, status: http.StatusOK}
		defer func() {
			// The mux sets the pattern on the request it was given.
			route := r.Pattern
			if route == "" {
				route = "none"
			}
			log.LogAttrs(r.Context(), slog.LevelInfo, "request",
				slog.String("request_id", id),
				slog.String("method", r.Method),
				slog.String("route", route),
				slog.Int("status", rw.status),
				slog.Int64("bytes", rw.bytes),
				slog.Float64("duration_seconds", time.Since(start).Seconds()),
			)
		}()
		next.ServeHTTP(rw, r)
	})
}

// responseWriter notes a response's status and size. Unwrap lets
// http.ResponseController reach the connection underneath, for flushing and
// hijacking.
type responseWriter struct {
	http.ResponseWriter
	status  int
	bytes   int64
	written bool
}

func (w *responseWriter) WriteHeader(status int) {
	if !w.written {
		w.status, w.written = status, true
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *responseWriter) Write(b []byte) (int, error) {
	w.written = true
	n, err := w.ResponseWriter.Write(b)
	w.bytes += int64(n)
	return n, err
}

func (w *responseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
