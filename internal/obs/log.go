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

// requestInfo is what the access log learns about a request from the
// handlers it wraps, which see copies of the request with contexts of their
// own.
type requestInfo struct {
	id      string
	route   string
	account string
}

type requestInfoKey struct{}

func info(ctx context.Context) *requestInfo {
	i, _ := ctx.Value(requestInfoKey{}).(*requestInfo)
	return i
}

// RequestID is the ID the access log gave a request, or "".
func RequestID(ctx context.Context) string {
	if i := info(ctx); i != nil {
		return i.id
	}
	return ""
}

// SetRoute tells the access log which route a request matched: a mux's
// pattern, so it is known even for a request refused before reaching the
// mux.
func SetRoute(ctx context.Context, pattern string) {
	if i := info(ctx); i != nil {
		i.route = pattern
	}
}

// SetAccount tells the access log which account made a request.
func SetAccount(ctx context.Context, id string) {
	if i := info(ctx); i != nil {
		i.account = id
	}
}

// AccessLog logs every request next serves, after it is served: its ID,
// method, the route it matched, the account that made it if any, status,
// bytes written and duration. The route is the mux's pattern, never the
// path or the query, and nothing of the body or the cookies is logged, so
// nothing a player writes reaches the logs. Each request gets a random ID,
// returned as X-Request-Id and in its context, for RequestID.
func AccessLog(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ri := &requestInfo{id: rand.Text()}
		w.Header().Set("X-Request-Id", ri.id)
		r = r.WithContext(context.WithValue(r.Context(), requestInfoKey{}, ri))
		rw := &responseWriter{ResponseWriter: w, status: http.StatusOK}
		defer func() {
			// A mux sets the pattern on the request it was given, when no
			// handler between said which route it was.
			route := ri.route
			if route == "" {
				route = r.Pattern
			}
			if route == "" {
				route = "none"
			}
			attrs := []slog.Attr{
				slog.String("request_id", ri.id),
				slog.String("method", r.Method),
				slog.String("route", route),
				slog.Int("status", rw.status),
				slog.Int64("bytes", rw.bytes),
				slog.Float64("duration_seconds", time.Since(start).Seconds()),
			}
			if ri.account != "" {
				attrs = append(attrs, slog.String("account", ri.account))
			}
			log.LogAttrs(r.Context(), slog.LevelInfo, "request", attrs...)
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
