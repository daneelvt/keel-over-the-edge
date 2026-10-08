// SPDX-License-Identifier: AGPL-3.0-only

package obs

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime/trace"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// The flight recorder's settings: the trace it keeps covers at least the
// last MinAge, in at most MaxBytes.
const (
	FlightMinAge   = 10 * time.Second
	FlightMaxBytes = 32 << 20
)

// OverrunEvery is the least time between two traces written for overruns.
const OverrunEvery = time.Minute

// Flight keeps the last seconds of the process's execution trace in memory
// (runtime/trace's flight recorder) and writes them out on demand: when a
// tick overruns, to a file, and when asked, over HTTP. Only one snapshot is
// written at a time.
type Flight struct {
	fr      *trace.FlightRecorder
	writeTo func(io.Writer) error // fr's, but tests give their own
	dir     string
	log     *slog.Logger
	overrun chan int64
	busy    atomic.Bool
	now     func() time.Time

	overruns, requests prometheus.Counter
}

// NewFlight makes a flight recorder whose overrun traces go to dir, or
// nowhere if dir is "". Start starts it recording.
func NewFlight(dir string, log *slog.Logger, m *Metrics) *Flight {
	fr := trace.NewFlightRecorder(trace.FlightRecorderConfig{MinAge: FlightMinAge, MaxBytes: FlightMaxBytes})
	f := &Flight{
		fr:       fr,
		dir:      dir,
		log:      log,
		overrun:  make(chan int64, 1),
		now:      time.Now,
		overruns: m.Snapshots.WithLabelValues("overrun"),
		requests: m.Snapshots.WithLabelValues("request"),
	}
	f.writeTo = func(w io.Writer) error {
		_, err := fr.WriteTo(w)
		return err
	}
	return f
}

// Start starts recording. Only one flight recorder may run in a process.
func (f *Flight) Start() error { return f.fr.Start() }

// Stop stops recording.
func (f *Flight) Stop() { f.fr.Stop() }

// Overrun asks for the trace around an overrunning tick to be written. It
// never blocks: if a request is already waiting, this one is dropped.
func (f *Flight) Overrun(tick int64) {
	select {
	case f.overrun <- tick:
	default:
	}
}

// Run writes overrun traces until ctx ends, at most one every OverrunEvery.
func (f *Flight) Run(ctx context.Context) {
	var last time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case tick := <-f.overrun:
			now := f.now()
			if f.dir == "" || !last.IsZero() && now.Sub(last) < OverrunEvery {
				continue
			}
			last = now
			if err := f.writeFile(now, tick); err != nil {
				f.log.Warn("flight recorder: could not write an overrun's trace", "tick", tick, "err", err)
			}
		}
	}
}

func (f *Flight) writeFile(now time.Time, tick int64) error {
	if err := os.MkdirAll(f.dir, 0o755); err != nil {
		return err
	}
	name := filepath.Join(f.dir, fmt.Sprintf("trace-%s-tick%d.out", now.UTC().Format("20060102T150405Z"), tick))
	file, err := os.Create(name)
	if err != nil {
		return err
	}
	err = f.snapshot(file, f.overruns)
	if cerr := file.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(name)
		return err
	}
	f.log.Warn("flight recorder: a tick overran; trace written", "tick", tick, "file", name)
	return nil
}

var errBusy = errors.New("a snapshot is already being written")

// snapshot writes the trace to w, unless another snapshot is being written.
func (f *Flight) snapshot(w io.Writer, count prometheus.Counter) error {
	if !f.busy.CompareAndSwap(false, true) {
		return errBusy
	}
	defer f.busy.Store(false)
	if err := f.writeTo(w); err != nil {
		return err
	}
	count.Inc()
	return nil
}

// ServeHTTP streams a snapshot of the trace, or answers 409 while another is
// being written.
func (f *Flight) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	if !f.busy.CompareAndSwap(false, true) {
		http.Error(w, errBusy.Error(), http.StatusConflict)
		return
	}
	defer f.busy.Store(false)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="flightrecorder.trace"`)
	if err := f.writeTo(w); err != nil {
		f.log.Warn("flight recorder: snapshot failed", "err", err)
		return
	}
	f.requests.Inc()
}
