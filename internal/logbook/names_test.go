// SPDX-License-Identifier: AGPL-3.0-only

package logbook

import (
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Who may read a log, for every age band, a machine sailor, one's own and
// the owner's; and a block either way.
func TestMayRead(t *testing.T) {
	me := store.AccountID{1}
	other := store.AccountID{2}
	adult, teen := Reader{ID: me, Band: aboard.Adult}, Reader{ID: me, Band: aboard.Teen}
	for _, c := range []struct {
		name    string
		r       Reader
		s       Sailor
		blocked bool
		want    bool
	}{
		{"an adult's, by default", adult, Sailor{ID: other, Band: aboard.Adult}, false, true},
		{"an adult's, to a teen", teen, Sailor{ID: other, Band: aboard.Adult}, false, true},
		{"an adult's, kept to them", adult, Sailor{ID: other, Band: aboard.Adult, Shown: store.LogShownMe}, false, false},
		{"a teen's, by default", adult, Sailor{ID: other, Band: aboard.Teen}, false, false},
		{"a teen's, by default, to a teen", teen, Sailor{ID: other, Band: aboard.Teen}, false, false},
		{"a teen's, opened by them", teen, Sailor{ID: other, Band: aboard.Teen, Shown: store.LogShownSailors}, false, true},
		{"an unknown band's, by default", adult, Sailor{ID: other, Band: aboard.Unknown}, false, false},
		{"an unknown band's, opened", adult, Sailor{ID: other, Band: aboard.Unknown, Shown: store.LogShownSailors}, false, true},
		{"a machine sailor's", teen, Sailor{ID: other, Machine: true, Owner: store.AccountID{3}}, false, true},
		{"a machine sailor's, its setting ignored", adult, Sailor{ID: other, Machine: true, Owner: store.AccountID{3}, Shown: store.LogShownMe}, false, true},
		{"one's own, kept to one", teen, Sailor{ID: me, Band: aboard.Teen, Shown: store.LogShownMe}, false, true},
		{"one's own machine sailor's", adult, Sailor{ID: other, Machine: true, Owner: me}, false, true},
		{"one's own machine sailor's, blocked", adult, Sailor{ID: other, Machine: true, Owner: me}, true, true},
		{"an adult's, blocked", adult, Sailor{ID: other, Band: aboard.Adult}, true, false},
		{"a machine sailor's, blocked", adult, Sailor{ID: other, Machine: true, Owner: store.AccountID{3}}, true, false},
		{"a teen's, to the owner", Reader{All: true}, Sailor{ID: other, Band: aboard.Teen}, false, true},
		{"a former sailor's", adult, Sailor{ID: other, Gone: true}, false, false},
	} {
		if got := MayRead(c.r, c.s, c.blocked); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}

// How a sailor is named: by name when the reader may read their log and
// they are in the reader's band, a machine sailor always, one's self;
// counted otherwise; "a sailor" for a block; a former sailor once
// deleted; every name to the owner.
func TestNameOf(t *testing.T) {
	me := store.AccountID{1}
	other := store.AccountID{2}
	adult, teen, unknown := Reader{ID: me, Band: aboard.Adult}, Reader{ID: me, Band: aboard.Teen}, Reader{ID: me}
	for _, c := range []struct {
		name    string
		r       Reader
		s       Sailor
		blocked bool
		want    Naming
	}{
		{"an adult to an adult", adult, Sailor{ID: other, Band: aboard.Adult}, false, Named},
		{"an adult to a teen", teen, Sailor{ID: other, Band: aboard.Adult}, false, Counted},
		{"a teen to an adult", adult, Sailor{ID: other, Band: aboard.Teen, Shown: store.LogShownSailors}, false, Counted},
		{"a teen to a teen, their log kept", teen, Sailor{ID: other, Band: aboard.Teen}, false, Counted},
		{"a teen to a teen, their log opened", teen, Sailor{ID: other, Band: aboard.Teen, Shown: store.LogShownSailors}, false, Named},
		{"an adult whose log is kept", adult, Sailor{ID: other, Band: aboard.Adult, Shown: store.LogShownMe}, false, Counted},
		{"an unknown band to an unknown band", unknown, Sailor{ID: other, Shown: store.LogShownSailors}, false, Counted},
		{"a machine sailor, to a teen", teen, Sailor{ID: other, Machine: true}, false, Named},
		{"one's self", teen, Sailor{ID: me, Band: aboard.Teen}, false, Named},
		{"an adult, blocked", adult, Sailor{ID: other, Band: aboard.Adult}, true, Hidden},
		{"a machine sailor, blocked", adult, Sailor{ID: other, Machine: true}, true, Hidden},
		{"a former sailor", adult, Sailor{Gone: true}, false, Former},
		{"a former sailor, to the owner", Reader{All: true}, Sailor{Gone: true}, false, Former},
		{"a teen, to the owner", Reader{All: true}, Sailor{ID: other, Band: aboard.Teen}, false, Named},
	} {
		if got := NameOf(c.r, c.s, c.blocked); got != c.want {
			t.Errorf("%s: %d, want %d", c.name, got, c.want)
		}
	}
}
