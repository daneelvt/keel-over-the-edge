// SPDX-License-Identifier: AGPL-3.0-only

package store_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// A world's week is stored fenced by the lease, read back as it was, made
// again in place of the one it had, and refused if its bytes no longer
// match its digest.
func TestWeatherRoundTrip(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	w, err := s.ActiveOrFirstWorld(ctx, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.LoadWeather(ctx, w.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a world with no week: %v", err)
	}
	l := newLease(t, u, "test", store.LeaseOptions{})
	epoch := take(t, l)
	records := []byte(`{"version":1,"spells":[[0]]}`)
	sum := sha256.Sum256(records)
	week := &store.Weather{
		Version: 1, Epoch: time.Date(2026, 10, 18, 22, 0, 0, 0, time.UTC), Ends: time.Date(2026, 10, 25, 22, 0, 0, 0, time.UTC),
		Records: records, Digest: sum[:], GenerationMs: 3,
	}
	if err := s.StoreWeather(ctx, w.ID, epoch+1, week); !errors.Is(err, store.ErrFenced) {
		t.Fatalf("a week stored by another epoch: %v", err)
	}
	if err := s.StoreWeather(ctx, w.ID, epoch, week); err != nil {
		t.Fatal(err)
	}
	got, err := s.LoadWeather(ctx, w.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Version != 1 || !got.Epoch.Equal(week.Epoch) || !got.Ends.Equal(week.Ends) || !bytes.Equal(got.Records, records) || got.GenerationMs != 3 {
		t.Fatalf("the week reads back as %+v", got)
	}
	// Made again for another epoch: the row is replaced.
	again := *week
	again.Epoch = week.Epoch.Add(time.Hour)
	if err := s.StoreWeather(ctx, w.ID, epoch, &again); err != nil {
		t.Fatal(err)
	}
	if got, err := s.LoadWeather(ctx, w.ID); err != nil || !got.Epoch.Equal(again.Epoch) {
		t.Fatalf("the week made again reads back as %+v, %v", got, err)
	}
	bad := *week
	bad.Digest = bytes.Repeat([]byte{1}, 32)
	if err := s.StoreWeather(ctx, w.ID, epoch, &bad); err == nil {
		t.Fatal("a week not matching its digest was stored")
	}
	pool := storetest.PoolOn(t, u)
	must(t, pool, "UPDATE world_weather SET records = '\\x00'")
	if _, err := s.LoadWeather(ctx, w.ID); err == nil {
		t.Fatal("a week not matching its digest was read")
	}
}
