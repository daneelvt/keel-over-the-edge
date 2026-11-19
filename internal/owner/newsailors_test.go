// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// fakeNewSailors is the database's settings for new sailors: each write.
type fakeNewSailors struct {
	mu      sync.Mutex
	writes  []string
	actions []store.Action
}

func (f *fakeNewSailors) SetNewSailorsPerAddress(_ context.Context, n int, a store.Action) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes, f.actions = append(f.writes, fmt.Sprint("per address ", n)), append(f.actions, a)
	return nil
}

func (f *fakeNewSailors) SetHumanCheck(_ context.Context, on bool, a store.Action) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes, f.actions = append(f.writes, "check "+onOff(on)), append(f.actions, a)
	return nil
}

func number(n int) *int { return &n }

// TestNewSailorSettings: the number a day and the human check's switch,
// checked first, then written to the database and memory, each recorded;
// the number kept within 1 to 1000.
func TestNewSailorSettings(t *testing.T) {
	r, _ := sailRig(t)
	sw := r.o.cfg.Switches
	if code, _, _ := settingsCall(t, r, SettingsRequest{NewSailorsPerAddress: number(5)}); code != 503 {
		t.Fatalf("without the database's settings: %d", code)
	}
	f := &fakeNewSailors{}
	r.o.cfg.NewSailors = f
	for _, bad := range []int{0, 1001, -1} {
		if code, _, body := settingsCall(t, r, SettingsRequest{NewSailorsPerAddress: number(bad)}); code != 400 || !strings.HasPrefix(body, "newSailorsPerAddress:") {
			t.Errorf("%d: %d %s", bad, code, body)
		}
	}
	code, a, _ := settingsCall(t, r, SettingsRequest{NewSailorsPerAddress: number(2), HumanCheck: yes(false), Check: true})
	if code != 200 || a.Settings.NewSailorsPerAddress != 2 || a.Settings.HumanCheck ||
		a.Words != "Would set: 2 new sailors an address a day; the human check on new sailors off." {
		t.Fatalf("checked: %d %+v", code, a)
	}
	if len(f.writes) != 0 || sw.NewSailorsPerAddress() != 20 || !sw.HumanCheck() {
		t.Fatalf("a check changed something: %v", f.writes)
	}
	code, a, _ = settingsCall(t, r, SettingsRequest{NewSailorsPerAddress: number(1), HumanCheck: yes(false)})
	if code != 200 || a.Settings.NewSailorsPerAddress != 1 || a.Settings.HumanCheck ||
		a.Words != "Done: 1 new sailor an address a day; the human check on new sailors off." {
		t.Fatalf("set: %d %+v", code, a)
	}
	if strings.Join(f.writes, ",") != "per address 1,check off" || f.actions[0].Detail != "1" || f.actions[1].Detail != "off" ||
		f.actions[0].Source != store.SourcePage {
		t.Fatalf("the writes: %v %+v", f.writes, f.actions)
	}
	if sw.NewSailorsPerAddress() != 1 || sw.HumanCheck() {
		t.Fatal("memory after the set")
	}
	if code, a, _ = settingsCall(t, r, SettingsRequest{HumanCheck: yes(true)}); code != 200 || !sw.HumanCheck() || !a.Settings.HumanCheck {
		t.Fatalf("on again: %d %+v", code, a)
	}
	for action, n := range map[string]float64{store.ActionNewSailors: 1, store.ActionHumanCheck: 2} {
		if got := testutil.ToFloat64(r.metrics.OwnerActions.WithLabelValues(action)); got != n {
			t.Errorf("%s counted %v", action, got)
		}
	}
}
