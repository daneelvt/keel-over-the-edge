// SPDX-License-Identifier: AGPL-3.0-only

// Command loadbot sails many headless players against a server: each a
// guest, connected over the game connection with the Go client
// (internal/client), which keeps the clock, predicts its boat, decodes the
// other boats' views and sends its controls as the page does, steering and
// trimming at random as the scripted sailors do. It reports what each
// received and sent, and what the server's metrics say of the tick and the
// encoders.
//
//	go run ./tools/loadbot -n 200 -url https://127.0.0.1:5173 [-lag 200ms,2%] [-for 5m] [-ramp 30s]
//
// Its guests are made by POST /guest and named "Loadbot 1" and on; their
// session cookies are kept in .dev/loadbot/sessions.json and used again, so
// that repeated runs make no new guests. Against go run ./tools/dev it
// trusts mkcert's local root, and reads keel's metrics from its internal
// listener. It runs from the repository root.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/client"
)

func main() {
	n := flag.Int("n", 20, "how many players")
	base := flag.String("url", "https://127.0.0.1:5173", "the game's origin: the page's, which serves /guest and /ws")
	lagFlag := flag.String("lag", "", "a round trip and loss such as 200ms,2%: each connection through the lag model")
	sail := flag.Duration("for", time.Minute, "how long to sail, once all have joined")
	ramp := flag.Duration("ramp", 0, "spread the players' joining over this long")
	fps := flag.Int("fps", 30, "each player's frames a second")
	metrics := flag.String("metrics", "http://127.0.0.1:9090/metrics", "keel's metrics; none if empty")
	sessions := flag.String("sessions", ".dev/loadbot/sessions.json", "where the guests' sessions are kept")
	ca := flag.String("ca", "", "a root certificate to trust (PEM); mkcert's local root if empty")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, *n, *base, *lagFlag, *sail, *ramp, *fps, *metrics, *sessions, *ca); err != nil {
		fmt.Fprintln(os.Stderr, "loadbot:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, n int, base, lagFlag string, sail, ramp time.Duration, fps int, metrics, sessions, ca string) error {
	if n < 1 || fps < 1 {
		return errors.New("-n and -fps must be at least 1")
	}
	hc, err := httpClient(ctx, base, ca)
	if err != nil {
		return err
	}
	cfg := Config{
		N:          n,
		Sail:       sail,
		Ramp:       ramp,
		FrameEvery: time.Second / time.Duration(fps),
		Guests:     &httpGuests{base: strings.TrimSuffix(base, "/"), client: hc},
		Sessions:   sessions,
		Dial:       wsDialer(hc, base),
		Out:        os.Stdout,
	}
	if lagFlag != "" {
		l, err := client.ParseLag(lagFlag)
		if err != nil {
			return err
		}
		cfg.Lag = &l
	}
	if metrics != "" {
		cfg.Metrics = func(ctx context.Context) (string, error) { return scrape(ctx, metrics) }
	}
	_, err = Run(ctx, cfg)
	return err
}

// httpClient trusts the system's roots and, for an https origin, ca or
// mkcert's local root, which go run ./tools/dev serves with.
func httpClient(ctx context.Context, base, ca string) (*http.Client, error) {
	if !strings.HasPrefix(base, "https://") {
		return &http.Client{Timeout: 10 * time.Second}, nil
	}
	if ca == "" {
		out, err := exec.CommandContext(ctx, "go", "tool", "mkcert", "-CAROOT").Output()
		if err == nil {
			ca = filepath.Join(strings.TrimSpace(string(out)), "rootCA.pem")
		}
	}
	pool, err := x509.SystemCertPool()
	if err != nil {
		pool = x509.NewCertPool()
	}
	if pem, err := os.ReadFile(ca); err == nil {
		pool.AppendCertsFromPEM(pem)
	}
	return &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig:     &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
			MaxIdleConnsPerHost: 64,
		},
	}, nil
}
