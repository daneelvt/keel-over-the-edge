// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"os"
	"strings"
	"testing"
)

// TestTableIsCurrent checks the committed table is what the pinned file
// gives.
func TestTableIsCurrent(t *testing.T) {
	data, err := os.ReadFile("confusables-" + version + ".txt")
	if err != nil {
		t.Fatal(err)
	}
	gen, err := generate(data)
	if err != nil {
		t.Fatal(err)
	}
	old, err := os.ReadFile("../../" + out)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gen, old) {
		t.Fatal("the generated table is not current: go run ./tools/confusables")
	}
}

func TestRefusesAnotherFile(t *testing.T) {
	data, err := os.ReadFile("confusables-" + version + ".txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := generate(append(data, '\n')); err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("a changed file: %v", err)
	}
}

func TestParse(t *testing.T) {
	entries, err := parse([]byte("# a comment\n\n006D ;\t0072 006E ;\tMA\t# ( m → rn )\n0030 ;\t004F ;\tMA\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0] != (entry{'0', "O"}) || entries[1] != (entry{'m', "rn"}) {
		t.Fatalf("%+v", entries)
	}
	for _, bad := range []string{"0030 ; 004F\n", "0030 0031 ; 004F ; MA\n", "XYZ ; 004F ; MA\n", "110000 ; 004F ; MA\n", "0030 ; 004F ; MA\n0030 ; 006F ; MA\n"} {
		if _, err := parse([]byte(bad)); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}
