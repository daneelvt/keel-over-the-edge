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
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/sim"
)

// Config is the server's configuration.
type Config struct {
	// PlayAddr is the address the game's HTTP server listens on.
	PlayAddr string
	// PlayOrigin is the HTTPS origin players use, such as
	// https://play.keelovertheedge.com, or an http:// origin on a loopback
	// address, which browsers treat as secure, for tests.
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
	// ClientDir, if not "", is the game's built page, which the game's
	// listener then serves; it must hold index.html. Unset, another server
	// serves the page, as Vite does in development.
	ClientDir string
	// BoatLimit is the most boats the world holds at once; beyond it,
	// players wait in a queue.
	BoatLimit int
	// DevSailors is how many scripted sailors sail in the world.
	DevSailors int
	// DevCommands turns on the developer's commands on the internal
	// listener: POST /debug/wind. Only tools/dev and tools/e2e set it.
	DevCommands bool
	// Bell is how long the world sails on once players have been told the
	// server is about to restart, before it stops.
	Bell time.Duration
	// DatabaseURL is the database's: a postgres:// URL or key=value pairs,
	// as pgx reads them. It holds a password: it is never logged.
	DatabaseURL string
}

// String leaves the database's URL out, so a Config can be logged.
func (c Config) String() string {
	c.DatabaseURL = "(not shown)"
	type plain Config
	return fmt.Sprintf("%+v", plain(c))
}

// The defaults: loopback addresses, so a developer's ports stay private.
const (
	DefaultPlayAddr     = "127.0.0.1:8080"
	DefaultAgentsAddr   = "127.0.0.1:8081"
	DefaultInternalAddr = "127.0.0.1:9090"
)

// DefaultBoatLimit is the boat limit unless KEEL_BOAT_LIMIT sets one: a
// starting value, until load tests on the server's machine set it.
const DefaultBoatLimit = 1000

// DefaultBell is the bell unless KEEL_BELL sets one, and MaxBell the
// longest it may be: the stop's other steps and its bell must fit in the
// time Kubernetes gives a pod to stop.
const (
	DefaultBell = 3 * time.Second
	MaxBell     = 10 * time.Second
)

// The bounds of a stop's steps after the bell: the world's final checkpoint
// and every event left written, then the game connections closed, a peer
// that has not answered by then dropped. With a Recreate deployment every
// second the old process lingers is a second of pause.
const (
	FinalCheckpointTimeout = 5 * time.Second
	CloseTimeout           = 3 * time.Second
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
		ClientDir:    getenv("KEEL_CLIENT_DIR"),
		DatabaseURL:  getenv("KEEL_DATABASE_URL"),
		BoatLimit:    DefaultBoatLimit,
		Bell:         DefaultBell,
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
	if err := CheckDatabaseURL(c.DatabaseURL); err != nil {
		errs = append(errs, fmt.Errorf("KEEL_DATABASE_URL: %w", err))
	}
	if v := getenv("KEEL_LOG_LEVEL"); v != "" {
		level, err := ParseLevel(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("KEEL_LOG_LEVEL: %w", err))
		}
		c.LogLevel = level
	}
	if v := getenv("KEEL_BOAT_LIMIT"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > sim.Capacity {
			errs = append(errs, fmt.Errorf("KEEL_BOAT_LIMIT: %q is not a number from 1 to %d", v, sim.Capacity))
		}
		c.BoatLimit = n
	}
	if v := getenv("KEEL_DEV_SAILORS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 || n > sim.Capacity {
			errs = append(errs, fmt.Errorf("KEEL_DEV_SAILORS: %q is not a number from 0 to %d", v, sim.Capacity))
		}
		c.DevSailors = n
	}
	if v := getenv("KEEL_BELL"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d < 0 || d > MaxBell {
			errs = append(errs, fmt.Errorf("KEEL_BELL: %q is not a duration from 0s to %v", v, MaxBell))
		}
		c.Bell = d
	}
	switch v := getenv("KEEL_DEV_COMMANDS"); v {
	case "", "0":
	case "1":
		c.DevCommands = true
	default:
		errs = append(errs, fmt.Errorf("KEEL_DEV_COMMANDS: %q is not 0 or 1", v))
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

func loopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// CheckDatabaseURL checks a database URL is there and, when it is a URL
// rather than key=value pairs, that it is a postgres one. Its errors never
// repeat it: it holds a password.
func CheckDatabaseURL(s string) error {
	switch {
	case s == "":
		return errors.New("required")
	case strings.Contains(s, "://"):
		u, err := url.Parse(s)
		if err != nil {
			return errors.New("not a URL that can be read")
		}
		if u.Scheme != "postgres" && u.Scheme != "postgresql" {
			return fmt.Errorf("a %s:// URL, not postgres://", u.Scheme)
		}
		if u.Host == "" && !strings.Contains(u.RawQuery, "host=") {
			return errors.New("the URL has no host")
		}
	case !strings.Contains(s, "="):
		return errors.New("neither a postgres:// URL nor key=value pairs")
	}
	return nil
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
// optional port, and nothing else. http is accepted on a loopback address
// alone, which browsers treat as a secure context, so tests can run without
// a certificate; nothing a real deployment serves is reached that way.
func checkOrigin(origin string) error {
	if origin == "" {
		return errors.New("required")
	}
	u, err := url.Parse(origin)
	if err != nil {
		return err
	}
	switch {
	case u.Scheme == "http" && loopback(u.Hostname()):
	case u.Scheme != "https":
		return fmt.Errorf("%q is not https (http is allowed on localhost, 127.0.0.1 or [::1] alone)", origin)
	case u.Host == "" || u.User != nil:
		return fmt.Errorf("%q has no host, or has user information", origin)
	case u.Path != "" || u.RawQuery != "" || u.Fragment != "" || strings.HasSuffix(origin, "/"):
		return fmt.Errorf("%q is not an origin: no path, query or trailing slash", origin)
	}
	return nil
}
