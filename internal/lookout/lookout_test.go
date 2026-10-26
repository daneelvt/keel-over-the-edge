// SPDX-License-Identifier: AGPL-3.0-only

package lookout

import (
	"encoding/json"
	"flag"
	"os"
	"reflect"
	"sync"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

var update = flag.Bool("update", false, "rewrite testdata's case files from this machine's results")

// caseFile holds the rule to the cases written in path, which the page's
// twin is held to as well: check checks the rule's results on the file's
// inputs against the file's, and the file must hold the cases got, which
// -update writes.
func caseFile[T any](t *testing.T, path string, got T, check func(t *testing.T, want T)) {
	t.Helper()
	if *update {
		data, err := json.MarshalIndent(got, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var want T
	if err := json.Unmarshal(data, &want); err != nil {
		t.Fatal(err)
	}
	check(t, want)
	if !reflect.DeepEqual(want, got) {
		t.Errorf("%s has other cases: rewrite it with go test ./internal/lookout -update", path)
	}
}

// ready is the catalog, its kinds of boat and its encounters, readied
// once.
type ready struct {
	cat   *catalog.Catalog
	kinds []physics.Prepared
	ep    *physics.EncounterPrepared
}

var readied = sync.OnceValue(func() *ready {
	cat, err := catalog.Load()
	if err != nil {
		panic(err)
	}
	_, kinds := cat.Prepare()
	return &ready{cat: cat, kinds: kinds, ep: cat.PrepareEncounters()}
})
