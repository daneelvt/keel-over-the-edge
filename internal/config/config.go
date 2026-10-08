// SPDX-License-Identifier: AGPL-3.0-only

// Package config reads the server's configuration from the environment. It is
// read once at start and validated as a whole: the server refuses to start if
// any variable is missing or malformed.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"strconv"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/sim"
)

// Config is the server's configuration.
type Config struct {
	// PlayAddr is the address the game's HTTP server listens on.
	PlayAddr string
	// PlayOrigin is the HTTPS origin players use, such as
	// https://play.keelovertheedge.com.
	PlayOrigin string
	// AgentsAddr is the address the AI agents' HTTP server listens on.
	AgentsAddr string
	// InternalAddr is the address of the internal HTTP server: probes,
	// metrics, profiles. It must not be reachable from outside.
	InternalAddr string
	// LogLevel is the least level logged.
	LogLevel slog.Level
	// TraceDir, if not "", is where the flight recorder writes the traces
	// of ticks that overran.
	TraceDir string
	// ReplayDir, if not "", is where the input log is written as well as
	// kept in memory.
	ReplayDir string
	// DevSailors is how many scripted sailors sail in the world.
	DevSailors int
}

// The defaults: loopback addresses, so a developer's ports stay private.
const (
	DefaultPlayAddr     = "127.0.0.1:8080"
	DefaultAgentsAddr   = "127.0.0.1:8081"
	DefaultInternalAddr = "127.0.0.1:9090"
)

// Load reads the configuration through getenv (os.Getenv in the server).
// Every problem is reported, not only the first.
func Load(getenv func(string) string) (Config, error) {
	var errs []error
	c := Config{
		PlayAddr:     or(getenv("KEEL_PLAY_ADDR"), DefaultPlayAddr),
		PlayOrigin:   getenv("KEEL_PLAY_ORIGIN"),
		AgentsAddr:   or(getenv("KEEL_AGENTS_ADDR"), DefaultAgentsAddr),
		InternalAddr: or(getenv("KEEL_INTERNAL_ADDR"), DefaultInternalAddr),
		TraceDir:     getenv("KEEL_TRACE_DIR"),
		ReplayDir:    getenv("KEEL_REPLAY_DIR"),
	}
	addrs := []struct{ name, addr string }{
		{"KEEL_PLAY_ADDR", c.PlayAddr},
		{"KEEL_AGENTS_ADDR", c.AgentsAddr},
		{"KEEL_INTERNAL_ADDR", c.InternalAddr},
	}
	for i, a := range addrs {
		if err := checkAddr(a.addr); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", a.name, err))
			continue
		}
		for _, b := range addrs[:i] {
			if checkAddr(b.addr) == nil && overlap(a.addr, b.addr) {
				errs = append(errs, fmt.Errorf("%s: %q is %s's address too", a.name, a.addr, b.name))
			}
		}
	}
	if err := checkOrigin(c.PlayOrigin); err != nil {
		errs = append(errs, fmt.Errorf("KEEL_PLAY_ORIGIN: %w", err))
	}
	if v := getenv("KEEL_LOG_LEVEL"); v != "" {
		level, err := ParseLevel(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("KEEL_LOG_LEVEL: %w", err))
		}
		c.LogLevel = level
	}
	if v := getenv("KEEL_DEV_SAILORS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 || n > sim.Capacity {
			errs = append(errs, fmt.Errorf("KEEL_DEV_SAILORS: %q is not a number from 0 to %d", v, sim.Capacity))
		}
		c.DevSailors = n
	}
	return c, errors.Join(errs...)
}

func or(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

// ParseLevel reads a log level: debug, info, warn or error.
func ParseLevel(s string) (slog.Level, error) {
	switch strings.ToLower(s) {
	case "debug":
		return slog.LevelDebug, nil
	case "info":
		return slog.LevelInfo, nil
	case "warn":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	}
	return 0, fmt.Errorf("%q is not debug, info, warn or error", s)
}

// overlap reports whether two listeners could not both have their
// addresses: the same port on the same host, or on any host.
func overlap(a, b string) bool {
	ha, pa, _ := net.SplitHostPort(a)
	hb, pb, _ := net.SplitHostPort(b)
	if pa != pb {
		return false
	}
	wild := func(h string) bool { return h == "" || h == "0.0.0.0" || h == "::" }
	return ha == hb || wild(ha) || wild(hb)
}

func checkAddr(addr string) error {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return fmt.Errorf("port %q is not a number from 1 to 65535", port)
	}
	return nil
}

// checkOrigin accepts an origin as browsers send it: https, a host, an
// optional port, and nothing else.
func checkOrigin(origin string) error {
	if origin == "" {
		return errors.New("required")
	}
	u, err := url.Parse(origin)
	if err != nil {
		return err
	}
	switch {
	case u.Scheme != "https":
		return fmt.Errorf("%q is not https", origin)
	case u.Host == "" || u.User != nil:
		return fmt.Errorf("%q has no host, or has user information", origin)
	case u.Path != "" || u.RawQuery != "" || u.Fragment != "" || strings.HasSuffix(origin, "/"):
		return fmt.Errorf("%q is not an origin: no path, query or trailing slash", origin)
	}
	return nil
}
