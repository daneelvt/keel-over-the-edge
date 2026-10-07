// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/api"
)

func TestUsage(t *testing.T) {
	cases := map[string]struct {
		args   []string
		status int
	}{
		"no command":      {nil, 2},
		"unknown command": {[]string{"sail"}, 2},
		"help":            {[]string{"help"}, 0},
		"serve extra arg": {[]string{"serve", "now"}, 2},
		"serve bad flag":  {[]string{"serve", "-x"}, 2},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			var out, errOut bytes.Buffer
			got := run(context.Background(), tc.args, func(string) string { return "" }, &out, &errOut)
			if got != tc.status {
				t.Fatalf("status %d, want %d (stderr: %s)", got, tc.status, errOut.String())
			}
		})
	}
}

func TestServeRefusesBadConfig(t *testing.T) {
	var out, errOut bytes.Buffer
	status := run(context.Background(), []string{"serve"}, func(string) string { return "" }, &out, &errOut)
	if status != 1 || !strings.Contains(errOut.String(), "KEEL_PLAY_ORIGIN") {
		t.Fatalf("status %d, stderr %q", status, errOut.String())
	}
}

func TestServeStopsCleanly(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	log := slog.New(slog.NewJSONHandler(io.Discard, nil))
	go func() { done <- servePlay(ctx, ln, api.Handler(api.Version{Build: "b", Catalog: "c"}), log) }()

	res, err := http.Get("http://" + ln.Addr().String() + "/api/version")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not stop")
	}
}
