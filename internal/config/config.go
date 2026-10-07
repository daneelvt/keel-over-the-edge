// SPDX-License-Identifier: AGPL-3.0-only

// Package config reads the server's configuration from the environment. It is
// read once at start and validated as a whole: the server refuses to start if
// any variable is missing or malformed.
package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
)

// Config is the server's configuration.
type Config struct {
	// PlayAddr is the address the game's HTTP server listens on.
	PlayAddr string
	// PlayOrigin is the HTTPS origin players use, such as
	// https://play.keelovertheedge.com.
	PlayOrigin string
}

// Load reads the configuration through getenv (os.Getenv in the server).
// Every problem is reported, not only the first.
func Load(getenv func(string) string) (Config, error) {
	var errs []error
	c := Config{
		PlayAddr:   getenv("KEEL_PLAY_ADDR"),
		PlayOrigin: getenv("KEEL_PLAY_ORIGIN"),
	}
	if c.PlayAddr == "" {
		c.PlayAddr = "127.0.0.1:8080"
	}
	if err := checkAddr(c.PlayAddr); err != nil {
		errs = append(errs, fmt.Errorf("KEEL_PLAY_ADDR: %w", err))
	}
	if err := checkOrigin(c.PlayOrigin); err != nil {
		errs = append(errs, fmt.Errorf("KEEL_PLAY_ORIGIN: %w", err))
	}
	return c, errors.Join(errs...)
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
