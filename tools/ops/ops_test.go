// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"slices"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/manifests"
)

// TestTunnel: one forward for each fixed address, each on this Mac's
// loopback alone, in a session that runs nothing, as root on production's
// machine, which is named before any of ssh's flags: tailscale refuses a
// flag before it.
func TestTunnel(t *testing.T) {
	argv := tunnelArgs("keel-prod-1", manifests.Forwards)
	want := []string{"ssh", "root@keel-prod-1", "-N",
		"-L", "127.0.0.1:3000:10.43.0.51:80",
		"-L", "127.0.0.1:8428:10.43.0.52:8428",
		"-L", "127.0.0.1:9428:10.43.0.50:9428",
		"-L", "127.0.0.1:15432:10.43.0.53:5432",
		"-L", "127.0.0.1:9090:10.43.0.54:9090"}
	if !slices.Equal(argv, want) {
		t.Fatalf("the tunnel's command:\n%v\nwant\n%v", argv, want)
	}
	local := map[int]bool{}
	for _, f := range manifests.Forwards {
		if local[f.Local] || f.Local < 1024 {
			t.Errorf("%s forwards from port %d, taken or privileged", f.Service, f.Local)
		}
		local[f.Local] = true
	}
	said := links(manifests.Forwards)
	for _, want := range []string{"http://localhost:3000", "Grafana", "http://localhost:8428", "http://localhost:9428", "port=15432", "user=reader", "localhost:9090/debug/pprof"} {
		if !strings.Contains(said, want) {
			t.Errorf("the links lack %q:\n%s", want, said)
		}
	}
}

// TestPrint: -print says the command for production's machine, and runs
// nothing.
func TestPrint(t *testing.T) {
	t.Chdir("../..")
	var out bytes.Buffer
	if err := run(t.Context(), &out, true); err != nil {
		t.Fatal(err)
	}
	if got := out.String(); !strings.HasPrefix(got, "tailscale ssh root@keel-prod-1 -N -L 127.0.0.1:3000:10.43.0.51:80 ") || !strings.HasSuffix(got, " -L 127.0.0.1:9090:10.43.0.54:9090\n") {
		t.Errorf("-print said %q", got)
	}
}
