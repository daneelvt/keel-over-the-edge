// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"sync"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/devcert"
)

// servePhoneSetup serves the page that walks a phone through trusting the
// local root, on caPort.
func servePhoneSetup(rootPath, gameURL string) (*http.Server, error) {
	return devcert.ServePhoneSetup(rootPath, caPort, devcert.Phone{Game: gameURL, Command: "go run ./tools/dev"})
}

// printAddresses prints, with a QR code each, the phone setup page and the
// game.
func printAddresses(mu *sync.Mutex, out io.Writer, origin string, lan []net.IP) {
	mu.Lock()
	defer mu.Unlock()
	setup := ""
	if len(lan) > 0 {
		setup = fmt.Sprintf("http://%s/", net.JoinHostPort(lan[0].String(), strconv.Itoa(caPort)))
	}
	devcert.PrintAddresses(out, setup, origin)
}
