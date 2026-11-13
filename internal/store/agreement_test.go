// SPDX-License-Identifier: AGPL-3.0-only

package store_test

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

func agreements(t *testing.T) (*store.Agreements, string) {
	t.Helper()
	u := storetest.URL(t)
	a, err := store.OpenAgreements(context.Background(), u, store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Close)
	return a, u
}

var textSum = strings.Repeat("ab", 32)

func TestAgreementSignatures(t *testing.T) {
	ctx := context.Background()
	a, _ := agreements(t)
	if err := a.Ready(ctx); err != nil {
		t.Fatal(err)
	}
	sig := store.Signature{GitHubID: 7, Login: "ann", Name: "Ann Smith", Version: 1, TextSHA256: textSum, How: store.SignedOnPage}
	if made, err := a.Sign(ctx, sig); err != nil || !made {
		t.Fatalf("first signature: made %v, %v", made, err)
	}
	// Signing the same version again is harmless: nothing new is made.
	if made, err := a.Sign(ctx, sig); err != nil || made {
		t.Fatalf("second signature: made %v, %v", made, err)
	}
	if _, err := a.Sign(ctx, store.Signature{GitHubID: 8, Login: "bob", Name: "Bob", Version: 2, TextSHA256: textSum,
		How: store.SignedByOwner, Guardian: "Carol", GuardianEmail: "carol@example.com", Note: "by e-mail"}); err != nil {
		t.Fatal(err)
	}
	signed, err := a.Signed(ctx, []int64{7, 8, 9}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if !signed[7] || signed[8] || signed[9] {
		t.Errorf("signed version 1: %v, want 7 alone", signed)
	}
	mine, err := a.SignaturesOf(ctx, 7)
	if err != nil || len(mine) != 1 || mine[0].Name != "Ann Smith" || mine[0].SignedAt.IsZero() {
		t.Fatalf("ann's signatures: %+v, %v", mine, err)
	}

	// A void stands down the signature, which is kept; signing again is
	// then a new one.
	if gid, err := a.Void(ctx, mine[0].ID, "signed by mistake"); err != nil || gid != 7 {
		t.Fatalf("void: %d, %v", gid, err)
	}
	if _, err := a.Void(ctx, mine[0].ID, "again"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("voiding a voided signature: %v, want ErrNotFound", err)
	}
	if signed, _ := a.Signed(ctx, []int64{7}, 1); signed[7] {
		t.Error("a voided signature still counts")
	}
	if made, err := a.Sign(ctx, sig); err != nil || !made {
		t.Fatalf("signing after a void: made %v, %v", made, err)
	}
	all, err := a.Signatures(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 3 {
		t.Fatalf("every signature: %d, want 3", len(all))
	}
	if all[0].Voided.IsZero() || all[0].VoidReason != "signed by mistake" {
		t.Errorf("the voided signature: %+v", all[0])
	}
	if all[1].Guardian != "Carol" || all[1].How != store.SignedByOwner {
		t.Errorf("the owner's signature: %+v", all[1])
	}

	// The database refuses what no signature may be.
	for _, bad := range []store.Signature{
		{GitHubID: 9, Login: "x", Name: "", Version: 1, TextSHA256: textSum, How: store.SignedOnPage},
		{GitHubID: 9, Login: "x", Name: "X", Version: 0, TextSHA256: textSum, How: store.SignedOnPage},
		{GitHubID: 9, Login: "x", Name: "X", Version: 1, TextSHA256: "nope", How: store.SignedOnPage},
		{GitHubID: 9, Login: "x", Name: "X", Version: 1, TextSHA256: textSum, How: "post"},
	} {
		if _, err := a.Sign(ctx, bad); err == nil {
			t.Errorf("%+v was signed", bad)
		}
	}
}

func TestAgreementWaiting(t *testing.T) {
	ctx := context.Background()
	a, _ := agreements(t)
	pr := store.PullRef{Repo: "o/r", Number: 3}
	if err := a.SetWaiting(ctx, pr, "abc", []int64{7, 8}); err != nil {
		t.Fatal(err)
	}
	if err := a.SetWaiting(ctx, store.PullRef{Repo: "o/r", Number: 4}, "def", []int64{8}); err != nil {
		t.Fatal(err)
	}
	if got, _ := a.WaitingFor(ctx, 8); !slices.Equal(got, []store.PullRef{{"o/r", 3}, {"o/r", 4}}) {
		t.Errorf("waiting for 8: %v", got)
	}
	// A check replaces a pull request's rows.
	if err := a.SetWaiting(ctx, pr, "abd", []int64{7}); err != nil {
		t.Fatal(err)
	}
	if got, _ := a.WaitingFor(ctx, 8); !slices.Equal(got, []store.PullRef{{"o/r", 4}}) {
		t.Errorf("waiting for 8 after a check: %v", got)
	}
	if err := a.SetWaiting(ctx, pr, "abd", nil); err != nil {
		t.Fatal(err)
	}
	if got, _ := a.Waiting(ctx); !slices.Equal(got, []store.PullRef{{"o/r", 4}}) {
		t.Errorf("every waiting pull request: %v", got)
	}
}

// TestGrantRoles: without the role, granting does nothing and fails
// nothing; with it, the role reaches the agreement's tables and nothing
// else.
func TestGrantRoles(t *testing.T) {
	ctx := context.Background()
	u := storetest.URL(t)
	pool := storetest.PoolOn(t, u)
	var exists bool
	if err := pool.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agreement')").Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if !exists {
		if err := store.GrantRoles(ctx, u); err != nil {
			t.Fatalf("granting without the role: %v", err)
		}
		// Roles belong to the whole server; one made here is left for the
		// next run, and never dropped while another database may use it.
		if _, err := pool.Exec(ctx, "CREATE ROLE agreement NOLOGIN"); err != nil && !strings.Contains(err.Error(), "already exists") {
			t.Skipf("cannot make the role on the test server: %v", err)
		}
	}
	if err := store.GrantRoles(ctx, u); err != nil {
		t.Fatal(err)
	}
	if err := store.GrantRoles(ctx, u); err != nil {
		t.Fatalf("granting twice: %v", err)
	}
	for table, want := range map[string]bool{"agreement_signature": true, "agreement_pull": true, "account": false, "sailor": false} {
		var may bool
		if err := pool.QueryRow(ctx, "SELECT has_table_privilege('agreement', $1, 'SELECT')", table).Scan(&may); err != nil {
			t.Fatal(err)
		}
		if may != want {
			t.Errorf("agreement may read %s: %v, want %v", table, may, want)
		}
	}
	var del bool
	if err := pool.QueryRow(ctx, "SELECT has_table_privilege('agreement', 'agreement_signature', 'DELETE')").Scan(&del); err != nil {
		t.Fatal(err)
	}
	if del {
		t.Error("agreement may delete a signature")
	}
}
