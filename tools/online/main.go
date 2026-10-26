// SPDX-License-Identifier: AGPL-3.0-only

// Command online checks the game from outside, as a player reaches it:
// through Cloudflare and the tunnel, at https://play.keelovertheedge.com.
// It changes nothing lasting: the one sailor it makes for itself, with a
// passkey of its own, named "Zz Online …", it deletes at the end.
//
//	go run ./tools/online [-url https://play.keelovertheedge.com] [-page client/dist/index.html] [-hold 10m] [-mcp https://agents.keelovertheedge.com/mcp]
//
// It checks that the page and an asset answer, with HSTS; that Cloudflare
// caches the asset and not the page; that nothing was injected into the
// page (and, with -page, that its bytes are the build's); that
// /api/version names the build production follows; that HEAD works and a
// PUT is blocked at the edge; that /ws refuses a request without a session
// or from another origin; that one address is limited by Traefik, even
// when it forges CF-Connecting-IP on every request (so Cloudflare writes
// the header); that another host is not served; and that a game
// connection stays open for -hold (0 skips it), and is closed with 4003
// when its sailor is deleted; and that a machine sailor of a second sailor
// of its own, with a connection token, is answered by handbook at the MCP
// address, until it is deleted. It exits 1 if any check fails.
package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/registry"
)

func main() {
	base := flag.String("url", "https://play.keelovertheedge.com", "the game's origin")
	page := flag.String("page", "", "the build's index.html, to compare the page's bytes with")
	hold := flag.Duration("hold", 10*time.Minute, "how long a game connection must stay open; 0 skips it")
	mcp := flag.String("mcp", "https://agents.keelovertheedge.com/mcp", "the MCP address; empty skips its check")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	hc := &http.Client{Timeout: 30 * time.Second}
	c := &checker{
		base: *base, page: *page, hold: *hold, mcp: *mcp, hc: hc, out: os.Stdout,
		reg:   &registry.Registry{Base: "https://ghcr.io", HC: hc},
		pause: time.Sleep,
	}
	if failed := c.run(ctx); failed > 0 {
		fmt.Fprintf(os.Stderr, "online: %d checks failed\n", failed)
		os.Exit(1)
	}
}
