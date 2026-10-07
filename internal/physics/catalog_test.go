// SPDX-License-Identifier: AGPL-3.0-only

package physics_test

import (
	"encoding/json"
	"math"
	"os"
	"reflect"
	"testing"
	"unicode"
	"unicode/utf8"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The golden scenarios carry the Jolly boat's Params as data, so that the
// client can run them without the catalog's Go types. They must be the
// catalog's values exactly, bit for bit.
func TestScenarioParamsAreTheCatalogs(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	var boat *catalog.Boat
	for i := range cat.Boats {
		if cat.Boats[i].ID == "jolly-boat" {
			boat = &cat.Boats[i]
		}
	}
	if boat == nil {
		t.Fatal("the catalog has no jolly-boat")
	}
	p := catalog.PhysicsParams(boat)

	data, err := os.ReadFile("testdata/scenarios.json")
	if err != nil {
		t.Fatal(err)
	}
	var sf struct {
		Params map[string]json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(data, &sf); err != nil {
		t.Fatal(err)
	}
	v := reflect.ValueOf(p)
	if len(sf.Params) != v.NumField() {
		t.Errorf("scenarios.json has %d params, Params %d fields", len(sf.Params), v.NumField())
	}
	for i := range v.NumField() {
		name := v.Type().Field(i).Name
		r, n := utf8.DecodeRuneInString(name)
		raw, ok := sf.Params[string(unicode.ToLower(r))+name[n:]]
		if !ok {
			t.Errorf("scenarios.json has no %s", name)
			continue
		}
		var want []float64
		if v.Field(i).Kind() == reflect.Array {
			if err := json.Unmarshal(raw, &want); err != nil {
				t.Fatalf("%s: %v", name, err)
			}
		} else {
			var x float64
			if err := json.Unmarshal(raw, &x); err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			want = []float64{x}
		}
		got := []float64{}
		if f := v.Field(i); f.Kind() == reflect.Array {
			for j := range f.Len() {
				got = append(got, f.Index(j).Float())
			}
		} else {
			got = append(got, f.Float())
		}
		if len(got) != len(want) {
			t.Errorf("%s: %d values in the catalog, %d in scenarios.json", name, len(got), len(want))
			continue
		}
		for j := range got {
			if math.Float64bits(got[j]) != math.Float64bits(want[j]) {
				t.Errorf("%s: the catalog has %v, scenarios.json %v: copy the catalog's value", name, got, want)
				break
			}
		}
	}

	// Prepare must accept them: every derived constant finite.
	var b physics.Prepared
	physics.Prepare(&p, &b)
	pv := reflect.ValueOf(b)
	var check func(v reflect.Value, path string)
	check = func(v reflect.Value, path string) {
		switch v.Kind() {
		case reflect.Float64:
			if f := v.Float(); math.IsNaN(f) || math.IsInf(f, 0) {
				t.Errorf("Prepare gives %s = %v", path, f)
			}
		case reflect.Array:
			for j := range v.Len() {
				check(v.Index(j), path)
			}
		case reflect.Struct:
			for j := range v.NumField() {
				check(v.Field(j), path+"."+v.Type().Field(j).Name)
			}
		}
	}
	check(pv, "Prepared")
}
