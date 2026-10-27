// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"context"
	"testing"
	"testing/synctest"
	"time"

	"google.golang.org/protobuf/proto"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/forecast"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// Every connection is sent the forecast: after its Welcome the latest
// issue with what has been, then each issue as it is made, the same to
// every connection at the same boundary; and nothing of what has been
// again.
func TestForecastOnline(t *testing.T) {
	if testing.Short() {
		t.Skip("ten minutes of a world's ticks")
	}
	synctest.Test(t, func(t *testing.T) {
		cat, err := catalog.Load()
		if err != nil {
			t.Fatal(err)
		}
		tl, err := weather.FromCatalog(cat)
		if err != nil {
			t.Fatal(err)
		}
		// The sample week from a few hours in, so the forecast has
		// systems and a past.
		tl = tl.From(-6 * 3600 * 30)
		issuer := forecast.New(forecast.Config{Timeline: tl})
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		go issuer.Run(ctx)
		srv := NewServer(t, Config{Weather: tl, Forecast: issuer})
		annToken, _ := srv.Sailor("Ann")
		bobToken, _ := srv.Sailor("Bob")
		ann := srv.NewSailor(DialOptions{Cookie: annToken}, letGo)
		bob := srv.NewSailor(DialOptions{Cookie: bobToken}, letGo)
		for _, s := range []*client.Sailor{ann, bob} {
			if err := s.Connect(t.Context()); err != nil {
				t.Fatal(err)
			}
		}
		sailFor(t, []*client.Sailor{ann, bob}, 10*time.Minute+5*time.Second)
		for _, s := range []*client.Sailor{ann, bob} {
			if len(s.Forecasts) != 2 {
				t.Fatalf("%d forecasts in ten minutes", len(s.Forecasts))
			}
			first, next := s.Forecasts[0], s.Forecasts[1]
			if first.GetPast() == nil || first.GetPast().GetIssue() == nil || len(first.GetPast().GetTruth()) == 0 {
				t.Errorf("the first forecast has no past: %v", first.GetPast())
			}
			// Sent with its past, it is still the whole issue: its reach and
			// its keyframes' spacing with it.
			for _, f := range []interface {
				GetIssue() int64
				GetUntil() int64
				GetEvery() uint32
			}{first, next} {
				if f.GetUntil() <= f.GetIssue() || f.GetEvery() != uint32(tl.Every()) {
					t.Errorf("an issue at %d knows the systems to %d, its keyframes %d apart", f.GetIssue(), f.GetUntil(), f.GetEvery())
				}
			}
			if next.GetPast() != nil || next.GetIssue() != first.GetIssue()+tl.Prepared().ForecastEvery() {
				t.Errorf("the next issue is %d, after %d, with a past %v", next.GetIssue(), first.GetIssue(), next.GetPast() != nil)
			}
		}
		if !proto.Equal(ann.Forecasts[1], bob.Forecasts[1]) {
			t.Error("two connections were sent different issues at one boundary")
		}
	})
}
