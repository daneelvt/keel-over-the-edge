// SPDX-License-Identifier: AGPL-3.0-only

package obs

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

func get(t *testing.T, client *http.Client, url string) (int, string) {
	t.Helper()
	res, err := client.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, string(body)
}

func TestLiveness(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := NewHealth()
		srv := httptest.NewTestServer(t, Internal(h, NewMetrics("b", "c"), nil, nil, nil))
		if code, _ := get(t, srv.Client(), srv.URL+"/livez"); code != 200 {
			t.Fatalf("a fresh heartbeat: %d", code)
		}
		time.Sleep(StaleAfter - time.Millisecond)
		if code, _ := get(t, srv.Client(), srv.URL+"/livez"); code != 200 {
			t.Fatalf("just before going stale: %d", code)
		}
		time.Sleep(time.Millisecond)
		if code, body := get(t, srv.Client(), srv.URL+"/livez"); code != 503 || !strings.Contains(body, "no heartbeat for 10s") {
			t.Fatalf("a stale heartbeat: %d %q", code, body)
		}
		h.Beat()
		if code, _ := get(t, srv.Client(), srv.URL+"/livez"); code != 200 {
			t.Fatalf("beaten again: %d", code)
		}
		// Liveness never looks at readiness.
		h.Stopping()
		if code, _ := get(t, srv.Client(), srv.URL+"/livez"); code != 200 {
			t.Fatalf("stopping: %d", code)
		}
	})
}

func TestReadiness(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := NewHealth()
		srv := httptest.NewTestServer(t, Internal(h, NewMetrics("b", "c"), nil, nil, nil))
		ready := func(want int, why string) {
			t.Helper()
			code, body := get(t, srv.Client(), srv.URL+"/readyz")
			if code != want || !strings.Contains(body, why) {
				t.Fatalf("readyz %d %q, want %d %q", code, body, want, why)
			}
		}
		ready(503, "not ticked")
		h.Ticked()
		ready(503, "listeners")
		h.Listening(true)
		ready(200, "ok")
		h.Stopping()
		ready(503, "stopping")
	})
}

func TestAccessLog(t *testing.T) {
	var logs bytes.Buffer
	log := NewLogger(&logs, slog.LevelInfo, "build-1")
	mux := http.NewServeMux()
	var seen string
	mux.HandleFunc("GET /api/boats/{id}", func(w http.ResponseWriter, r *http.Request) {
		seen = RequestID(r.Context())
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte("hello"))
	})
	srv := httptest.NewTestServer(t, AccessLog(log, mux))
	res, err := srv.Client().Get(srv.URL + "/api/boats/secret-name?token=hunter2")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	id := res.Header.Get("X-Request-Id")
	if id == "" || id != seen {
		t.Fatalf("X-Request-Id %q, in the context %q", id, seen)
	}
	srv.Close()
	line := logs.String()
	if strings.Contains(line, "secret-name") || strings.Contains(line, "hunter2") {
		t.Fatalf("the path or query reached the log: %s", line)
	}
	var entry map[string]any
	if err := json.Unmarshal([]byte(line), &entry); err != nil {
		t.Fatalf("%v: %s", err, line)
	}
	for k, want := range map[string]any{
		"build": "build-1", "request_id": id, "method": "GET", "route": "GET /api/boats/{id}",
		"status": float64(418), "bytes": float64(5),
	} {
		if entry[k] != want {
			t.Errorf("%s = %v, want %v", k, entry[k], want)
		}
	}
	if _, ok := entry["duration_seconds"].(float64); !ok {
		t.Error("no duration")
	}
}

func TestAccessLogUnmatched(t *testing.T) {
	var logs bytes.Buffer
	srv := httptest.NewTestServer(t, AccessLog(NewLogger(&logs, slog.LevelInfo, "b"), http.NewServeMux()))
	if code, _ := get(t, srv.Client(), srv.URL+"/nothing/here"); code != 404 {
		t.Fatalf("status %d", code)
	}
	srv.Close()
	if !strings.Contains(logs.String(), `"route":"none"`) || strings.Contains(logs.String(), "nothing") {
		t.Fatalf("log: %s", logs.String())
	}
}

// everyMetric is every metric the server defines, by name.
var everyMetric = []string{
	"keel_build_info", "keel_sim_tick", "keel_sim_tick_duration_seconds", "keel_sim_phase_duration_seconds",
	"keel_sim_ticks_total", "keel_sim_ticks_late_total", "keel_sim_ticks_skipped_total",
	"keel_sim_clock_drift_seconds", "keel_sim_boats", "keel_sim_physics_workers",
	"keel_sim_commands_total", "keel_flightrecorder_snapshots_total",
	"go_goroutines", "go_gc_duration_seconds",
}

func TestMetricsListed(t *testing.T) {
	m := NewMetrics("b1", "c1")
	m.PhaseDuration.WithLabelValues("physics")
	m.Commands.WithLabelValues("join", "joined")
	m.Snapshots.WithLabelValues("overrun")
	m.CounterFunc("keel_test_total", "A test's count.", func() uint64 { return 7 })
	srv := httptest.NewTestServer(t, m.Handler())
	_, body := get(t, srv.Client(), srv.URL)
	for _, name := range append(everyMetric, "keel_test_total 7") {
		if !strings.Contains(body, name) {
			t.Errorf("/metrics lacks %s", name)
		}
	}
	if !strings.Contains(body, `keel_build_info{build="b1",catalog="c1"} 1`) {
		t.Error("no build info")
	}
	if !strings.Contains(body, `le="0.025"`) || !strings.Contains(body, `le="0.01"`) {
		t.Error("the tick's buckets lack 10 ms or 25 ms")
	}
}

func TestMetricsAllocateNothing(t *testing.T) {
	m := NewMetrics("b", "c")
	phase := m.PhaseDuration.WithLabelValues("physics")
	cmd := m.Commands.WithLabelValues("join", "joined")
	n := testing.AllocsPerRun(1000, func() {
		m.Tick.Set(5)
		m.TickDuration.Observe(0.004)
		phase.Observe(0.002)
		m.Ticks.Inc()
		m.TicksLate.Inc()
		m.TicksSkipped.Add(3)
		m.ClockDrift.Set(-0.001)
		m.Boats.Set(1000)
		m.Workers.Set(4)
		cmd.Inc()
	})
	if n != 0 {
		t.Fatalf("updating the metrics allocates %v times", n)
	}
}

// fakeTrace stands in for the runtime's flight recorder, which a synctest
// bubble cannot hold.
func fakeFlight(t *testing.T, dir string) (*Flight, *bytes.Buffer) {
	var logs bytes.Buffer
	f := NewFlight(dir, NewLogger(&logs, slog.LevelInfo, "b"), NewMetrics("b", "c"))
	f.writeTo = func(w io.Writer) error {
		_, err := w.Write([]byte("trace"))
		return err
	}
	return f, &logs
}

func TestOverrunsAtMostOnceAMinute(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		dir := t.TempDir()
		f, _ := fakeFlight(t, dir)
		ctx, cancel := context.WithCancel(t.Context())
		done := make(chan struct{})
		go func() { f.Run(ctx); close(done) }()
		for _, at := range []struct {
			wait time.Duration
			tick int64
		}{{0, 10}, {10 * time.Second, 20}, {40 * time.Second, 30}, {11 * time.Second, 40}, {time.Second, 50}} {
			time.Sleep(at.wait)
			f.Overrun(at.tick)
			synctest.Wait()
		}
		cancel()
		<-done
		names, err := filepath.Glob(filepath.Join(dir, "trace-*.out"))
		if err != nil {
			t.Fatal(err)
		}
		// 0 s and 61 s; not 10 s, 50 s or 62 s.
		if len(names) != 2 || !strings.HasSuffix(names[0], "-tick10.out") || !strings.HasSuffix(names[1], "-tick40.out") {
			t.Fatalf("wrote %v", names)
		}
		if !strings.Contains(names[0], "trace-20000101T000000Z-") {
			t.Fatalf("%s is not named for its UTC time", names[0])
		}
		data, err := os.ReadFile(names[0])
		if err != nil || string(data) != "trace" {
			t.Fatalf("%q, %v", data, err)
		}
	})
}

func TestOverrunNeverBlocks(t *testing.T) {
	f, _ := fakeFlight(t, "")
	for i := range 100 {
		f.Overrun(int64(i)) // nobody runs f
	}
}

func TestFlightSnapshotConflict(t *testing.T) {
	f, _ := fakeFlight(t, "")
	release := make(chan struct{})
	started := make(chan struct{})
	f.writeTo = func(w io.Writer) error {
		close(started)
		<-release
		_, err := w.Write([]byte("trace"))
		return err
	}
	srv := httptest.NewTestServer(t, Internal(NewHealth(), NewMetrics("b", "c"), f, nil, nil))
	var wg sync.WaitGroup
	var firstCode int
	var firstBody string
	wg.Go(func() { firstCode, firstBody = get(t, srv.Client(), srv.URL+"/debug/flightrecorder") })
	<-started
	if code, _ := get(t, srv.Client(), srv.URL+"/debug/flightrecorder"); code != http.StatusConflict {
		t.Fatalf("a second snapshot while one is written: %d", code)
	}
	close(release)
	wg.Wait()
	if firstCode != 200 || firstBody != "trace" {
		t.Fatalf("the first snapshot: %d %q", firstCode, firstBody)
	}
}

// TestFlightRecorder takes a real snapshot from the runtime's recorder.
func TestFlightRecorder(t *testing.T) {
	var logs bytes.Buffer
	f := NewFlight("", NewLogger(&logs, slog.LevelInfo, "b"), NewMetrics("b", "c"))
	if err := f.Start(); err != nil {
		t.Fatal(err)
	}
	defer f.Stop()
	srv := httptest.NewTestServer(t, Internal(NewHealth(), NewMetrics("b", "c"), f, nil, nil))
	code, body := get(t, srv.Client(), srv.URL+"/debug/flightrecorder")
	if code != 200 || !strings.HasPrefix(body, "go 1.") {
		t.Fatalf("%d, %d bytes starting %q", code, len(body), body[:min(len(body), 16)])
	}
}

func TestInternalRoutes(t *testing.T) {
	srv := httptest.NewTestServer(t, Internal(NewHealth(), NewMetrics("b", "c"), nil, nil, nil))
	for _, path := range []string{"/debug/pprof/", "/debug/pprof/goroutine", "/debug/pprof/cmdline", "/metrics", "/livez"} {
		if code, _ := get(t, srv.Client(), srv.URL+path); code != 200 {
			t.Errorf("%s: %d", path, code)
		}
	}
	for _, path := range []string{"/debug/flightrecorder", "/debug/replay", "/api/version"} {
		if code, _ := get(t, srv.Client(), srv.URL+path); code != 404 {
			t.Errorf("%s: %d, want 404 when not given", path, code)
		}
	}
}
