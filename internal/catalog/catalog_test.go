// SPDX-License-Identifier: AGPL-3.0-only

package catalog

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func TestLoadEmbedded(t *testing.T) {
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Boats) == 0 {
		t.Fatal("no boats")
	}
	for _, b := range c.Boats {
		if b.ID == "" || b.Name == "" || b.Capacity < 1 || b.LengthOverall <= 0 {
			t.Errorf("incomplete boat: %+v", b)
		}
	}
}

func TestVersionMatchesEmbeddedData(t *testing.T) {
	sum := sha256.Sum256(embedded)
	if got := hex.EncodeToString(sum[:])[:16]; got != Version {
		t.Fatalf("Version = %s, embedded data hashes to %s: run go run ./tools/catalog", Version, got)
	}
}

func TestParseRejects(t *testing.T) {
	cases := map[string]string{
		"unknown field": `{"boats":[{"id":"a","name":"A","description":"d","capacity":1,"lengthOverall":1,"colour":"red"}]}`,
		"trailing data": `{"boats":[{"id":"a","name":"A","description":"d","capacity":1,"lengthOverall":1}]} {}`,
		"no boats":      `{"boats":[]}`,
		"not json":      `boats: []`,
		"wrong type":    `{"boats":[{"id":"a","name":"A","description":"d","capacity":"one","lengthOverall":1}]}`,
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse([]byte(data)); err == nil {
				t.Fatal("accepted")
			}
		})
	}
}

// FuzzParse checks that no input makes the decoder panic, and that whatever
// it accepts has at least one boat.
func FuzzParse(f *testing.F) {
	f.Add(embedded)
	f.Add([]byte(`{"boats":[]}`))
	f.Add([]byte(`{"boats":[{"id":"a"}]}`))
	f.Fuzz(func(t *testing.T, data []byte) {
		c, err := Parse(data)
		if err == nil && len(c.Boats) == 0 {
			t.Fatal("accepted a catalog with no boats")
		}
	})
}
