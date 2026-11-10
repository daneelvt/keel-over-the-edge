// SPDX-License-Identifier: AGPL-3.0-only

package watch

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// TestLink: a sailor's link finds the sailor and says whether the viewer
// may watch it now, as a watch is refused: a human alike whether not at
// sea, sailing unwatched or blocking the viewer; a machine sailor not at
// sea; the viewer's own boat; a code no account has.
func TestLink(t *testing.T) {
	w := newWorld(t)
	blocked := map[[2]bus.Account]bool{}
	w.s.cfg.Blocks = func(a, b bus.Account) bool { return blocked[[2]bus.Account{a, b}] }
	ctx := context.Background()
	viewer := w.account(1, "Viewer", store.AccountID{})
	ann := w.account(2, "Ann Bonny", store.AccountID{})
	mary := w.account(3, "Iron Mary", ann)
	w.sail()

	check := func(code, name string, want error) {
		t.Helper()
		got, err := w.s.Link(ctx, viewer, code)
		if !errors.Is(err, want) || err == nil && want != nil || got.Name != name {
			t.Fatalf("%s: %q %v, want %q %v", code, got.Name, err, name, want)
		}
	}
	check("w2", "Ann Bonny", ErrCannot)
	check("w3", "Iron Mary", ErrNotAtSea)
	check("w1", "Viewer", ErrOwn)
	check("nobody", "", ErrNoLink)
	check("f2", "", ErrNoLink)

	w.sail(ann, mary)
	check("w2", "Ann Bonny", ErrCannot)
	check("w3", "Iron Mary", nil)
	w.edge.voyage[bus.Account(ann)] = true
	w.sail(ann, mary)
	check("w2", "Ann Bonny", nil)
	blocked[[2]bus.Account{bus.Account(ann), bus.Account(viewer)}] = true
	w.sail(ann, mary)
	check("w2", "Ann Bonny", ErrCannot)
	// A machine sailor is watched whoever blocks whom.
	check("w3", "Iron Mary", nil)
}

// TestFleet: a fleet's link finds the fleet's machine sailors the viewer
// may watch now, liveliest first, and never its human's own boat; nothing
// in the rows names the human; the list's fleet filter keeps them alone.
func TestFleet(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	viewer := w.account(1, "Viewer", store.AccountID{})
	ann := w.account(2, "Ann Bonny", store.AccountID{})
	bob := w.account(3, "Bob", store.AccountID{})
	calm := w.account(10, "Calm Kate", ann)
	storm := w.account(11, "Storm Sal", ann)
	ashore := w.account(12, "Ashore Al", ann)
	other := w.account(13, "Other Oz", bob)
	w.facts(calm, Facts{Sky: "calm", Edge: 20, State: StateSailing})
	w.facts(storm, Facts{Sky: "storm", Force: 8, Edge: 12, State: StateCapsized})
	w.edge.voyage[bus.Account(ann)] = true
	w.sail(ann, calm, storm, other)
	_ = ashore

	rows, err := w.s.Fleet(ctx, viewer, "f2")
	if err != nil {
		t.Fatal(err)
	}
	if got := names(Page{Sailors: rows}); got != "Storm Sal,Calm Kate" {
		t.Fatalf("Ann's fleet: %s", got)
	}
	b, _ := json.Marshal(rows)
	if strings.Contains(string(b), "Ann") || strings.Contains(string(b), "owner") {
		t.Fatalf("the rows name their owner: %s", b)
	}
	if rows, err := w.s.Fleet(ctx, viewer, "f3"); err != nil || names(Page{Sailors: rows}) != "Other Oz" {
		t.Fatalf("Bob's fleet: %v %v", rows, err)
	}
	if rows, err := w.s.Fleet(ctx, viewer, "f1"); err != nil || len(rows) != 0 {
		t.Fatalf("a fleet with none at sea: %v %v", rows, err)
	}
	if _, err := w.s.Fleet(ctx, viewer, "w2"); !errors.Is(err, ErrNoLink) {
		t.Fatalf("a sailor's code as a fleet's: %v", err)
	}
	if got := names(w.list(viewer, Query{Sort: SortName, Fleet: "f2", Q: "sal"})); got != "Storm Sal" {
		t.Fatalf("the list's fleet filter: %s", got)
	}
	// The human's own machine sailors, in their own fleet, are theirs.
	if rows, _ := w.s.Fleet(ctx, ann, "f2"); len(rows) != 2 || !rows[0].Mine {
		t.Fatalf("Ann's own fleet: %+v", rows)
	}
}

// TestFollowLink: following by a link is taken whatever the sailor's
// state, with the same answer; within the cap; never one's own; a code no
// account has; and stopped.
func TestFollowLink(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	viewer := w.account(1, "Viewer", store.AccountID{})
	ann := w.account(2, "Ann Bonny", store.AccountID{})
	w.account(3, "Iron Mary", ann)
	w.sail()
	// Ann not at sea, Iron Mary not at sea, Ann again.
	for i, code := range []string{"w2", "w3", "w2"} {
		if n, err := w.s.FollowLink(ctx, viewer, code, true); err != nil || n != []int{1, 2, 2}[i] {
			t.Fatalf("following %s: %d %v", code, n, err)
		}
	}
	// Ann at sea unwatched, and allowing: the same answer.
	w.sail(ann)
	if n, err := w.s.FollowLink(ctx, viewer, "w2", true); err != nil || n != 2 {
		t.Fatalf("following Ann at sea: %d %v", n, err)
	}
	// On the Following filter, she cannot be watched until she allows it.
	if p := w.list(viewer, Query{Who: WhoFollowing, Sort: SortName}); len(p.Sailors) != 2 || p.Sailors[0].Name != "Ann Bonny" || p.Sailors[0].Gone != GoneCannot {
		t.Fatalf("followed unwatched: %+v", p.Sailors)
	}
	w.edge.voyage[bus.Account(ann)] = true
	w.sail(ann)
	if p := w.list(viewer, Query{Who: WhoFollowing, Sort: SortName}); p.Sailors[0].Name != "Ann Bonny" || p.Sailors[0].Gone != "" {
		t.Fatalf("followed and allowing: %+v", p.Sailors)
	}
	if _, err := w.s.FollowLink(ctx, viewer, "w1", true); !errors.Is(err, ErrOwn) {
		t.Fatalf("one's own: %v", err)
	}
	if _, err := w.s.FollowLink(ctx, viewer, "nobody", true); !errors.Is(err, ErrNoLink) {
		t.Fatalf("no link: %v", err)
	}
	if n, err := w.s.FollowLink(ctx, viewer, "w3", false); err != nil || n != 1 {
		t.Fatalf("stopped: %d %v", n, err)
	}
	// The cap.
	for i := range MaxFollows {
		id := w.account(byte(100+i%150), "", store.AccountID{})
		w.db.follows[viewer] = append(w.db.follows[viewer], id)
	}
	w.s.Forget(viewer)
	if _, err := w.s.FollowLink(ctx, viewer, "w3", true); !errors.Is(err, ErrTooMany) {
		t.Fatalf("past the cap: %v", err)
	}
}

// TestCardCode: a machine sailor's card carries its link's code; a
// human's never does.
func TestCardCode(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	viewer := w.account(1, "Viewer", store.AccountID{})
	ann := w.account(2, "Ann Bonny", store.AccountID{})
	mary := w.account(3, "Iron Mary", ann)
	w.edge.voyage[bus.Account(ann)] = true
	w.sail(ann, mary)
	if c, err := w.s.Card(ctx, viewer, "Iron Mary"); err != nil || c.Code != "w3" {
		t.Fatalf("Iron Mary's card: %+v %v", c, err)
	}
	if c, err := w.s.Card(ctx, viewer, "Ann Bonny"); err != nil || c.Code != "" {
		t.Fatalf("Ann's card: %+v %v", c, err)
	}
}

// TestNewCode: each of a human's links made anew, the old one finding
// nothing; never another's machine sailor, nor a link that is none of
// them.
func TestNewCode(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	ann := w.account(2, "Ann Bonny", store.AccountID{})
	bob := w.account(3, "Bob", store.AccountID{})
	mary := w.account(4, "Iron Mary", ann)
	if c, err := w.s.Codes(ctx, ann); err != nil || c.Sailor != "w2" || c.Fleet != "f2" {
		t.Fatalf("Ann's codes %+v %v", c, err)
	}
	for _, which := range []string{LinkMe, LinkFleet, LinkMachine} {
		code, err := w.s.NewCode(ctx, ann, which, mary)
		if err != nil || !strings.HasPrefix(code, "new") {
			t.Fatalf("%s: %q %v", which, code, err)
		}
	}
	if _, err := w.s.Link(ctx, bob, "w2"); !errors.Is(err, ErrNoLink) {
		t.Fatalf("Ann's old link: %v", err)
	}
	if _, err := w.s.Link(ctx, bob, "w4"); !errors.Is(err, ErrNoLink) {
		t.Fatalf("Iron Mary's old link: %v", err)
	}
	if _, err := w.s.Fleet(ctx, bob, "f2"); !errors.Is(err, ErrNoLink) {
		t.Fatalf("Ann's old fleet link: %v", err)
	}
	if _, err := w.s.NewCode(ctx, bob, LinkMachine, mary); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("another's machine sailor: %v", err)
	}
	if _, err := w.s.NewCode(ctx, ann, LinkMachine, ann); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a machine sailor that is the human: %v", err)
	}
	if _, err := w.s.NewCode(ctx, ann, "everything", mary); !errors.Is(err, ErrWhich) {
		t.Fatalf("none of the links: %v", err)
	}
}

// TestLinkJustSailed: a sailor whose boat has just come into the water,
// newer than the boats the list keeps a moment, is found by their link
// and their fleet's.
func TestLinkJustSailed(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	viewer := w.account(1, "Viewer", store.AccountID{})
	ann := w.account(2, "Ann Bonny", store.AccountID{})
	mary := w.account(3, "Iron Mary", ann)
	w.edge.voyage[bus.Account(ann)] = true
	w.sail()
	w.list(viewer, Query{})
	// Into the water, the boats kept not yet made again.
	f := bus.NewFrame(256)
	for i, id := range []store.AccountID{ann, mary} {
		f.Live = append(f.Live, int32(i))
		f.Owner[i] = bus.Account(id)
		f.Boat[i] = uint64(100 + i)
	}
	w.frames.Publish(f)
	if got, err := w.s.Link(ctx, viewer, "w2"); err != nil || got.Name != "Ann Bonny" {
		t.Fatalf("Ann just sailed: %v %v", got, err)
	}
	w.frames.Publish(bus.NewFrame(256))
	w.list(viewer, Query{})
	w.frames.Publish(f)
	if rows, err := w.s.Fleet(ctx, viewer, "f2"); err != nil || len(rows) != 1 {
		t.Fatalf("Iron Mary just sailed: %v %v", rows, err)
	}
}
