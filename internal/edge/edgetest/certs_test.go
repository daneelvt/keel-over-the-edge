// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// TestCertifiedToTheSailor: what a sailor's certificates came to reaches
// its own connection, a task done, a venture a run nearer and the
// certificate earned in turn, and no other sailor's.
func TestCertifiedToTheSailor(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := NewServer(t, Config{Capacity: 4})
		annToken, ann := srv.Sailor("Ann")
		bobToken, _ := srv.Sailor("Bob")
		sailor := dial(t, srv, annToken, client.Hello())
		sailor.welcomed()
		other := dial(t, srv, bobToken, client.Hello())
		other.welcomed()
		for _, c := range []bus.Certified{
			{Certificate: 1, Task: 3, Done: 2, Of: 4, Way: bus.CertLog},
			{Certificate: 1, Task: 0, Done: 2, Of: 4, Way: bus.CertPilot, Runs: 1, RunsOf: 2},
			{Certificate: 1, Task: 1, Done: 4, Of: 4, Way: bus.CertHand, Earned: true, ByHand: true},
		} {
			if err := srv.World.Bus().Commands.Server().TrySend(bus.Command{Op: bus.Certify, Account: bus.Account(ann), Certified: c}); err != nil {
				t.Fatal(err)
			}
		}
		if !sailor.read(2*time.Second, func() bool { return len(sailor.certified) == 3 }) {
			t.Fatalf("Ann told %v", sailor.certified)
		}
		want := []*pb.Certified{
			{Certificate: 1, Task: 3, Done: 2, Of: 4, Way: pb.CertWay_CERT_WAY_LOG},
			{Certificate: 1, Task: 0, Done: 2, Of: 4, Way: pb.CertWay_CERT_WAY_PILOT, Runs: 1, RunsOf: 2},
			{Certificate: 1, Task: 1, Done: 4, Of: 4, Way: pb.CertWay_CERT_WAY_HAND, Earned: true, ByHand: true},
		}
		for i, w := range want {
			g := sailor.certified[i]
			if g.GetCertificate() != w.Certificate || g.GetTask() != w.Task || g.GetDone() != w.Done || g.GetOf() != w.Of ||
				g.GetWay() != w.Way || g.GetRuns() != w.Runs || g.GetRunsOf() != w.RunsOf || g.GetEarned() != w.Earned ||
				g.GetByHand() != w.ByHand {
				t.Errorf("told %d: %v, want %v", i, g, w)
			}
		}
		other.read(500*time.Millisecond, nil)
		if len(other.certified) != 0 {
			t.Errorf("Bob told Ann's: %v", other.certified)
		}
	})
}
