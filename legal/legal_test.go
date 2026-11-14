// SPDX-License-Identifier: AGPL-3.0-only

package legal

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strconv"
	"strings"
	"testing"
)

// TestSums holds every version to the SHA-256 in SUMS: a version someone
// may have signed is never edited. A new version is a new file and a new
// line; a version nobody has signed yet may have its line changed with it.
func TestSums(t *testing.T) {
	raw, err := os.ReadFile("SUMS")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{}
	sc := bufio.NewScanner(bytes.NewReader(raw))
	for sc.Scan() {
		sum, name, ok := strings.Cut(sc.Text(), "  ")
		if !ok {
			t.Fatalf("SUMS: %q is not \"<sha256>  <file>\"", sc.Text())
		}
		want[name] = sum
	}
	for _, v := range Versions() {
		name := "agreement-" + strconv.Itoa(v.Number) + ".md"
		if want[name] != v.SHA256 {
			t.Errorf("%s's SHA-256 is %s, SUMS says %q: a signed version is never edited", name, v.SHA256, want[name])
		}
		delete(want, name)
	}
	for name := range want {
		t.Errorf("SUMS names %s, which is not embedded: a version is never removed", name)
	}
}

func TestVersions(t *testing.T) {
	vs := Versions()
	for i, v := range vs {
		if v.Number != i+1 {
			t.Errorf("version %d is numbered %d", i+1, v.Number)
		}
		sum := sha256.Sum256(v.Text)
		if v.SHA256 != hex.EncodeToString(sum[:]) {
			t.Errorf("version %d's SHA256 is not its text's", v.Number)
		}
		// The text names its own number, so a download read alone says
		// which version it is.
		if !bytes.Contains(v.Text, []byte(v.Name())) {
			t.Errorf("version %d's text does not name itself %q", v.Number, v.Name())
		}
		if !bytes.Contains(v.Text, []byte("This is version "+strconv.Itoa(v.Number)+" of this Agreement.")) {
			t.Errorf("version %d's text does not say which version it is in its section on versions", v.Number)
		}
	}
	if Current().Number != len(vs) {
		t.Errorf("Current is version %d of %d", Current().Number, len(vs))
	}
	if _, ok := Get(0); ok {
		t.Error("Get(0) found a version")
	}
	if _, ok := Get(len(vs) + 1); ok {
		t.Error("Get past the newest found a version")
	}
	if len(Privacy()) == 0 {
		t.Error("no privacy notice")
	}
}

// TestSummary holds CONTRIBUTING.md's plain-words summary to the current
// version's: a contributor reads the same words in both places.
func TestSummary(t *testing.T) {
	contributing, err := os.ReadFile("../CONTRIBUTING.md")
	if err != nil {
		t.Fatal(err)
	}
	text := string(Current().Text)
	start := strings.Index(text, "\n- **You keep your copyright.**")
	end := strings.Index(text, "\n## The agreement")
	if start < 0 || end < start {
		t.Fatal("the agreement's plain-words summary is not where it was")
	}
	summary := strings.TrimSpace(text[start:end])
	if !strings.Contains(string(contributing), summary) {
		t.Errorf("CONTRIBUTING.md's summary is not the agreement's:\n%s", summary)
	}
}
