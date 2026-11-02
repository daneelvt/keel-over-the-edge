// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A keel that makes its world for a while as it starts, answering 503 with
// why meanwhile, then 200.
func slowKeel(t *testing.T, readyAfter time.Duration) *httptest.Server {
	t.Helper()
	start := time.Now()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if time.Since(start) < readyAfter {
			w.WriteHeader(http.StatusServiceUnavailable)
			fmt.Fprintln(w, "the world: making the next one")
			return
		}
		fmt.Fprintln(w, "ok")
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestWaitReadyWaitsForASlowKeel(t *testing.T) {
	srv := slowKeel(t, 400*time.Millisecond)
	if err := waitReady(srv.URL, 2*time.Second, nil); err != nil {
		t.Fatalf("a keel ready in 0.4 s within a wait of 2 s: %v", err)
	}
}

func TestWaitReadySaysWhatReadyzLastAnswered(t *testing.T) {
	srv := slowKeel(t, time.Hour)
	err := waitReady(srv.URL, 300*time.Millisecond, nil)
	if err == nil {
		t.Fatal("a keel never ready was taken as ready")
	}
	for _, want := range []string{"within 300ms", `503 "the world: making the next one"`} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the error %q does not say %q", err, want)
		}
	}
}

func TestWaitReadyStopsWhenKeelExits(t *testing.T) {
	srv := slowKeel(t, time.Hour)
	exited := make(chan struct{})
	time.AfterFunc(200*time.Millisecond, func() { close(exited) })
	start := time.Now()
	err := waitReady(srv.URL, time.Minute, exited)
	if err == nil || !strings.Contains(err.Error(), errExited.Error()) {
		t.Fatalf("an exit was not reported: %v", err)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Errorf("waited %s after keel exited", d)
	}
}

func TestWaitReadyWithNothingListening(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	err := waitReady(url, 200*time.Millisecond, nil)
	if err == nil || !strings.Contains(err.Error(), "connection refused") {
		t.Fatalf("the error does not say nothing listened: %v", err)
	}
}

func TestTailKeepsTheLastLines(t *testing.T) {
	var tl tail
	for i := range tailLines + 5 {
		fmt.Fprintf(&tl, "line %d\n", i+1)
	}
	fmt.Fprint(&tl, "half a ")
	fmt.Fprint(&tl, "line")
	got := tl.lines()
	if len(got) != tailLines+1 {
		t.Fatalf("kept %d lines, want %d: %q", len(got), tailLines+1, got)
	}
	if got[0] != "line 6" || got[tailLines-1] != fmt.Sprintf("line %d", tailLines+5) {
		t.Errorf("kept %q … %q", got[0], got[tailLines-1])
	}
	if got[tailLines] != "half a line" {
		t.Errorf("the unended line is %q", got[tailLines])
	}
	tl.reset()
	if len(tl.lines()) != 0 {
		t.Error("reset kept lines")
	}
}
