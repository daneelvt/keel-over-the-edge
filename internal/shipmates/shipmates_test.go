// SPDX-License-Identifier: AGPL-3.0-only

package shipmates_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/chat"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/review"
	"github.com/daneelvt/keel-over-the-edge/internal/shipmates"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// world stands in for the world sailed: where each is, and whom it was
// told their list changed.
type world struct {
	mu       sync.Mutex
	presence map[bus.Account]edge.Presence
	told     []bus.Account
	ashore   [][2]bus.Account
}

func (w *world) Presence(a bus.Account) edge.Presence {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.presence[a]
}

func (w *world) PersonAt(bus.Account, uint32) (bus.Account, bool, bool) {
	return bus.Account{}, false, false
}

func (w *world) PutAshoreBlocked(skipper, other bus.Account) {
	w.mu.Lock()
	w.ashore = append(w.ashore, [2]bus.Account{skipper, other})
	w.mu.Unlock()
}

func (w *world) Shipmates(a bus.Account) {
	w.mu.Lock()
	w.told = append(w.told, a)
	w.mu.Unlock()
}

// toldOf reports whether a was told, and forgets what was told.
func (w *world) toldOf(a store.AccountID) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	in := slices.Contains(w.told, bus.Account(a))
	w.told = nil
	return in
}

func sailor(t *testing.T, s *store.Store, name string, born int32) store.AccountID {
	t.Helper()
	key := ""
	for _, r := range name {
		if r != ' ' {
			key += string(r | 0x20)
		}
	}
	a := storetest.NewAccount(name, key, sha256.Sum256([]byte(name)))
	a.Boat = "jolly-boat"
	id, err := s.CreateAccount(context.Background(), a)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetBorn(context.Background(), id, born); err != nil {
		t.Fatal(err)
	}
	return id
}

// TestShipmates: an offer needs five minutes aboard together in the last
// 30 days; an offer between an adult and a teen is sent as any other and
// never reaches the teen, nor can be accepted, and nothing either is shown
// says why; within a band it is accepted, or made by offering back;
// presence is shown to shipmates alone, and hidden by appearing offline;
// No longer shipmates ends it for both at once, tells the other nothing
// but that their list changed, and a new offer needs sailing together
// again; a block ends it; a declined offer looks waiting to its sender;
// reports from the lists copy the thread or the boat; and nothing of a
// message between shipmates is ever written to the database.
func TestShipmates(t *testing.T) {
	ctx := context.Background()
	s, u := storetest.Store(t, store.Options{})
	pool := storetest.PoolOn(t, u)
	must := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	count := func(sql string, args ...any) int64 {
		t.Helper()
		var n int64
		if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
		return n
	}
	now := time.Now()
	teen := int32((now.Year()-15)*100 + 1)
	ann, bob := sailor(t, s, "Ann Bonny", 199001), sailor(t, s, "Bob Read", 198506)
	tea, ted := sailor(t, s, "Tea Clipper", teen), sailor(t, s, "Ted Brig", teen)
	ties := aboard.NewTies(nil, nil)
	sw := aboard.NewSwitches(aboard.DefaultLifetime)
	w := &world{presence: map[bus.Account]edge.Presence{}}
	var reports []review.In
	var svc *shipmates.Service
	svc = shipmates.New(shipmates.Config{
		Store: s, Ties: ties, Switches: sw, World: func() shipmates.World { return w },
		Tie: func(ctx context.Context, a, b bus.Account, block, on bool) error {
			if err := s.Block(ctx, store.AccountID(a), store.AccountID(b), on); err != nil {
				return err
			}
			ties.SetBlock(a, b, on)
			return svc.Unship(ctx, store.AccountID(a), store.AccountID(b))
		},
		Report: func(_ context.Context, in review.In) error {
			reports = append(reports, in)
			return nil
		},
	})
	offer := func(from, to store.AccountID, want string) {
		t.Helper()
		got, err := svc.Offer(ctx, from, shipmates.Target{ID: to})
		if err != nil || got != want {
			t.Fatalf("an offer: %q %v, want %q", got, err, want)
		}
	}
	list := func(id store.AccountID) shipmates.List {
		t.Helper()
		l, err := svc.List(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		return l
	}
	sail := func(a, b store.AccountID, long bool) {
		t.Helper()
		if err := s.SawTogether(ctx, a, b, time.Now(), 7, long); err != nil {
			t.Fatal(err)
		}
	}

	// No offer without sailing together, nor after only a moment aboard.
	offer(ann, bob, shipmates.NotYet)
	sail(ann, bob, false)
	offer(ann, bob, shipmates.NotYet)
	if r := list(ann).Recent; len(r) != 1 || r[0].Name != "Bob Read" || r[0].Can {
		t.Fatalf("recent crew after a moment: %+v", r)
	}
	// Long ago is too long ago.
	must("UPDATE sailed_with SET sailed_at = now() - interval '31 days'")
	offer(ann, bob, shipmates.NotYet)

	// Five minutes together: an offer, which reaches Bob.
	sail(ann, bob, true)
	if r := list(ann).Recent; len(r) != 1 || !r[0].Can {
		t.Fatalf("recent crew after five minutes: %+v", r)
	}
	offer(ann, bob, shipmates.Offered)
	if !w.toldOf(bob) {
		t.Fatal("Bob was not told of the offer")
	}
	if o := list(bob).Offers; len(o) != 1 || o[0].ID != ann.String() || o[0].Name != "Ann Bonny" {
		t.Fatalf("Bob's offers: %+v", o)
	}
	if r := list(ann).Recent; !r[0].Offered || r[0].Can {
		t.Fatalf("Ann's recent crew with her offer waiting: %+v", r)
	}
	if err := svc.Accept(ctx, bob, ann); err != nil {
		t.Fatal(err)
	}
	if !ties.Shipmates(ann, bob) || !ties.Shipmates(bob, ann) {
		t.Fatal("not shipmates in memory")
	}
	if l := list(bob); len(l.Offers) != 0 || len(l.Shipmates) != 1 || l.Shipmates[0].Presence != "" {
		t.Fatalf("Bob's list: %+v", l)
	}
	offer(ann, bob, shipmates.Already)

	// Presence, to shipmates alone, hidden by appearing offline.
	w.presence[bus.Account(ann)] = edge.Presence{In: true, Sea: true, Skipper: true}
	w.presence[bus.Account(tea)] = edge.Presence{In: true}
	if m := list(bob).Shipmates; m[0].Presence != "sea" || !m[0].Skipper {
		t.Fatalf("Ann at sea, to Bob: %+v", m)
	}
	for _, r := range list(tea).Recent {
		if r.Presence != "" {
			t.Fatalf("presence shown to someone not a shipmate: %+v", r)
		}
	}
	if err := svc.SetOffline(ctx, ann, true); err != nil {
		t.Fatal(err)
	}
	if l := list(ann); !l.Offline {
		t.Fatal("Ann does not appear offline to herself")
	}
	if m := list(bob).Shipmates; m[0].Presence != "" || m[0].Skipper {
		t.Fatalf("Ann offline, to Bob: %+v", m)
	}

	// Across the bands: an offer is sent as any other, and never reaches
	// the teen, who cannot accept it; offering back makes nothing.
	sail(ann, tea, true)
	offer(ann, tea, shipmates.Offered)
	if w.toldOf(tea) {
		t.Fatal("a teen was told of an adult's offer")
	}
	if o := list(tea).Offers; len(o) != 0 {
		t.Fatalf("an adult's offer reached a teen: %+v", o)
	}
	if err := svc.Accept(ctx, tea, ann); !errors.Is(err, shipmates.ErrGone) {
		t.Fatalf("a teen accepting an adult's offer: %v", err)
	}
	offer(tea, ann, shipmates.Offered)
	if ties.Shipmates(ann, tea) || len(list(ann).Offers) != 0 {
		t.Fatal("an adult and a teen made shipmates, or the teen's offer reached the adult")
	}
	for _, r := range list(ann).Recent {
		if r.Name == "Tea Clipper" && (!r.Offered || r.Can) {
			t.Fatalf("Ann's offer to a teen does not look waiting: %+v", r)
		}
	}

	// Two teens: an offer, and offering back makes them shipmates.
	sail(tea, ted, true)
	offer(tea, ted, shipmates.Offered)
	if o := list(ted).Offers; len(o) != 1 {
		t.Fatalf("Ted's offers: %+v", o)
	}
	offer(ted, tea, shipmates.Made)
	if !ties.Shipmates(tea, ted) {
		t.Fatal("two teens offering each other are not shipmates")
	}

	// No longer shipmates: at once for both, the other told only that
	// their list changed; an offer needs sailing together again.
	if err := svc.End(ctx, bob, shipmates.Target{ID: ann}); err != nil {
		t.Fatal(err)
	}
	if !w.toldOf(ann) || ties.Shipmates(ann, bob) || len(list(ann).Shipmates) != 0 || len(list(bob).Shipmates) != 0 {
		t.Fatal("ending it did not end it for both")
	}
	offer(ann, bob, shipmates.NotYet)
	sail(ann, bob, true)

	// A declined offer looks waiting to its sender, as any other.
	offer(ann, bob, shipmates.Offered)
	if err := svc.Decline(ctx, bob, ann); err != nil {
		t.Fatal(err)
	}
	if o := list(bob).Offers; len(o) != 0 {
		t.Fatalf("a declined offer still shown: %+v", o)
	}
	if err := svc.Accept(ctx, bob, ann); !errors.Is(err, shipmates.ErrGone) {
		t.Fatalf("accepting a declined offer: %v", err)
	}
	for _, r := range list(ann).Recent {
		if r.Name == "Bob Read" && !r.Offered {
			t.Fatalf("a declined offer does not look waiting: %+v", r)
		}
	}

	// A block ends shipmates.
	if err := svc.Block(ctx, ted, tea); err != nil {
		t.Fatal(err)
	}
	if ties.Shipmates(tea, ted) || len(list(ted).Shipmates) != 0 || len(w.ashore) != 1 {
		t.Fatal("a block did not end shipmates")
	}

	// Reports from the lists: the boat of recent crew, a shipmate's thread;
	// nobody else.
	if err := svc.Report(ctx, ann, bob, store.ReasonBullying, ""); err != nil {
		t.Fatal(err)
	}
	if err := s.SawTogether(ctx, ann, ted, time.Now(), 9, true); err != nil {
		t.Fatal(err)
	}
	ties.SetShipmates(ann, bob, true)
	if err := svc.Report(ctx, ann, bob, store.ReasonOther, ""); err != nil {
		t.Fatal(err)
	}
	if len(reports) != 2 || reports[0].Boat != 7 || reports[0].Thread || !reports[1].Thread {
		t.Fatalf("the reports: %+v", reports)
	}
	stranger := sailor(t, s, "Sam Stranger", 199001)
	if err := svc.Report(ctx, ann, stranger, store.ReasonOther, ""); !errors.Is(err, shipmates.ErrNoOne) {
		t.Fatalf("a report of a stranger from the lists: %v", err)
	}
	if err := svc.Block(ctx, ann, stranger); err == nil {
		t.Fatal("a block of a stranger from the lists")
	}

	// A message between shipmates is held in memory alone.
	hub := chat.NewHub(nil, aboard.Rules{Switches: sw, Ties: ties}, time.Now)
	hub.Join(aboard.Speaker{Account: ann, Human: ann, Band: aboard.Adult, Rules: true}, "Ann Bonny")
	hub.Join(aboard.Speaker{Account: bob, Human: bob, Band: aboard.Adult, Rules: true}, "Bob Read")
	if said := hub.SayTo(bus.Account(ann), bus.Account(bob), "a zebrafish off the bow"); said.Refused != chat.NotRefused || said.Line.ID == 0 {
		t.Fatalf("a message: %+v", said)
	}
	if said := hub.SayTo(bus.Account(ann), bus.Account(stranger), "a zebrafish for a stranger"); said.Refused != chat.RefusedAway {
		t.Fatalf("a message to a stranger: %+v", said)
	}
	rows, err := pool.Query(ctx, `SELECT table_name, column_name FROM information_schema.columns
		WHERE table_schema = 'public' AND data_type IN ('text', 'jsonb', 'character varying', 'ARRAY')`)
	if err != nil {
		t.Fatal(err)
	}
	var where [][2]string
	for rows.Next() {
		var tbl, col string
		if err := rows.Scan(&tbl, &col); err != nil {
			t.Fatal(err)
		}
		where = append(where, [2]string{tbl, col})
	}
	rows.Close()
	for _, w := range where {
		if n := count(fmt.Sprintf(`SELECT count(*) FROM %q WHERE %q::text LIKE '%%zebrafish%%'`, w[0], w[1])); n != 0 {
			t.Errorf("a message's text in %s.%s", w[0], w[1])
		}
	}

	// Deleting an account takes its rows.
	if _, err := s.DeleteAccount(ctx, bob); err != nil {
		t.Fatal(err)
	}
	if n := count("SELECT count(*) FROM sailed_with WHERE a_id = $1 OR b_id = $1", bob); n != 0 {
		t.Fatalf("%d rows of sailing together kept after a deletion", n)
	}

	// The sweep: a month on, and lapsed offers.
	must("UPDATE sailed_with SET seen_at = now() - interval '31 days'")
	must("UPDATE shipmate_offer SET made_at = now() - interval '8 days'")
	if n, err := s.DeleteSailedAndOffers(ctx, time.Now()); err != nil || n == 0 {
		t.Fatalf("the sweep: %d %v", n, err)
	}
	if n := count("SELECT (SELECT count(*) FROM sailed_with) + (SELECT count(*) FROM shipmate_offer)"); n != 0 {
		t.Fatalf("%d rows left after the sweep", n)
	}
}
