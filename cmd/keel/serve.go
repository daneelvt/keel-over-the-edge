// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"flag"
	"io"
	"log/slog"
	"net"
	"net/http"
	"runtime/debug"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/api"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/config"
)

// shutdownTimeout bounds how long a stopping server waits for requests in
// flight.
const shutdownTimeout = 10 * time.Second

func serve(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() {
		io.WriteString(stderr, "usage: keel serve\n\nConfigured from the environment: KEEL_PLAY_ADDR, KEEL_PLAY_ORIGIN.\n")
	}
	if err := fs.Parse(args); err != nil {
		return errUsage
	}
	if fs.NArg() > 0 {
		fs.Usage()
		return errUsage
	}

	log := slog.New(slog.NewJSONHandler(stdout, nil))
	cfg, err := config.Load(getenv)
	if err != nil {
		return err
	}
	cat, err := catalog.Load()
	if err != nil {
		return err
	}
	version := api.Version{Build: buildID(), Catalog: catalog.Version}
	log.Info("starting", "build", version.Build, "catalog", version.Catalog, "boats", len(cat.Boats))

	ln, err := net.Listen("tcp", cfg.PlayAddr)
	if err != nil {
		return err
	}
	return servePlay(ctx, ln, api.Handler(version), log)
}

// servePlay serves the game's routes on ln until ctx ends, then shuts down,
// letting requests in flight finish.
//
// Only ReadHeaderTimeout and IdleTimeout are set: ReadTimeout and
// WriteTimeout would also cut off long-lived connections such as WebSockets.
// Routes that need deadlines set their own.
func servePlay(ctx context.Context, ln net.Listener, h http.Handler, log *slog.Logger) error {
	srv := &http.Server{
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	log.Info("listening", "addr", ln.Addr().String())

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	log.Info("stopping")
	sctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(sctx); err != nil {
		return err
	}
	if err := <-errc; !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	log.Info("stopped")
	return nil
}

// buildID is the VCS revision the binary was built from, with "-dirty" when
// the tree had uncommitted changes, or "dev" when the build has no VCS
// information (go run, go test).
func buildID() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "dev"
	}
	var rev, dirty string
	for _, s := range info.Settings {
		switch s.Key {
		case "vcs.revision":
			rev = s.Value
		case "vcs.modified":
			if s.Value == "true" {
				dirty = "-dirty"
			}
		}
	}
	if rev == "" {
		return "dev"
	}
	if len(rev) > 12 {
		rev = rev[:12]
	}
	return rev + dirty
}
