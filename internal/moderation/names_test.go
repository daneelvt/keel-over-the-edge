// SPDX-License-Identifier: AGPL-3.0-only

package moderation

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"strings"
	"testing"

	"golang.org/x/text/unicode/norm"
)

var update = flag.Bool("update", false, "write testdata/lengths.json again")

func reason(err error) Reason {
	var r *Refusal
	if errors.As(err, &r) {
		return r.Reason
	}
	return ""
}

func TestCheckName(t *testing.T) {
	cases := []struct {
		in      string
		display string // "" when refused
		reason  Reason
	}{
		{"Ann Bonny", "Ann Bonny", ""},
		{"  Sea    Wolf  ", "Sea Wolf", ""},
		{"Sea\u00a0Wolf", "Sea Wolf", ""}, // a no-break space is a space
		{"Ｓｅａ Ｗｏｌｆ", "Sea Wolf", ""},      // fullwidth letters, folded by NFKC
		{"O'Brien", "O'Brien", ""},
		{"O’Brien", "O’Brien", ""},
		{"St. Ives", "St. Ives", ""},
		{"Jean-Luc", "Jean-Luc", ""},
		{"Sailor 42", "Sailor 42", ""},
		{"Zoë", "Zoë", ""},
		{"Mary Read", "Mary Read", ""},
		{"Ελένη", "Ελένη", ""},
		{"Владимир", "Владимир", ""},
		{"山田花子", "山田花子", ""},
		{"やまだ はなこ", "やまだ はなこ", ""},
		{"Ken 山田", "Ken 山田", ""},         // Latin with Han
		{"Sakura さくら", "Sakura さくら", ""}, // Latin with Hiragana
		{"Min-jun 민준", "Min-jun 민준", ""}, // Latin with Hangul
		{"محمد", "محمد", ""},
		{"Ab", "", Short},
		{"", "", Short},
		{"   ", "", Short},
		{"Á̂", "", Short}, // one letter and its marks count once
		{"Abcdefghijklmnopqrst", "Abcdefghijklmnopqrst", ""},
		{"Abcdefghijklmnopqrstu", "", Long},
		{"Abcdefghij klmnopqrs", "Abcdefghij klmnopqrs", ""},
		{"Àbcdefghijklmnopqrst", "Àbcdefghijklmnopqrst", ""},
		{strings.Repeat("ẽ", 20), strings.Repeat("ẽ", 20), ""},
		{strings.Repeat("A", 400), "", Long},
		{"Paypal", "Paypal", ""},
		{"Pаypal", "", Scripts},    // a Cyrillic а among Latin letters
		{"Αλεξ Влад", "", Scripts}, // Greek and Cyrillic
		{"Abc\u202eabc", "", Characters},
		{"Ab\u200dcd", "", Characters}, // a zero-width joiner
		{"Ab\u200bcd", "", Characters}, // a zero-width space
		{"Ship ⚓", "", Characters},     // a symbol
		{"Sailor 😀", "", Characters},   // an emoji
		{"Sea_Wolf", "", Characters},
		{"Sea  -Wolf", "", Characters},
		{"Sea--Wolf", "", Characters},
		{"-Sea Wolf", "", Characters},
		{"Sea Wolf.", "", Characters},
		{"42 Sailors", "", Characters}, // starts with a digit
		{"́Abc", "", Characters},       // a mark with no letter
		{"Ab1́", "", Characters},       // a mark on a digit
		{"Sea\tWolf", "", Characters},
		{"Sea\x00Wolf", "", Characters},
		{"Abc", "", Characters}, // private use
		{"Harbourmaster", "", Words},
		{"Fuckface", "", Words},
		{"Sh1t Happens", "", Words},
		{"S H I T", "", Words},
	}
	for _, c := range cases {
		n, err := CheckName(c.in)
		if got := reason(err); got != c.reason || n.Display != c.display {
			t.Errorf("CheckName(%q) = %q, %q; want %q, %q", c.in, n.Display, got, c.display, c.reason)
		}
		if c.reason == "" && !norm.NFC.IsNormalString(n.Display) {
			t.Errorf("%q's display form is not normalised", c.in)
		}
	}
}

func TestKeysAlike(t *testing.T) {
	groups := [][]string{
		{"Sea Wolf", "seawolf", "SEA-WOLF", "Sea.Wolf", "Ｓｅａ Ｗｏｌｆ", "SeaWolf", "sea wolf", "Sea'Wolf"},
		{"Paypal", "Pаypal"},             // Latin, and with a Cyrillic а
		{"Captain Bob", "Captain B0b"},   // a zero for an o
		{"Will", "Wi1l"},                 // a one for an l
		{"Fern", "Fem"},                  // rn for m: look-alikes refuse more than look-alikes
		{"O'Brien", "O’Brien", "OBrien"}, // apostrophes are separators
		{"Zoë", "Zoë", "ZOË", "ZOË"},   // composed or not
		{"\u03f900", "\u03a300"},         // a lunate capital sigma folds as a capital sigma
	}
	for _, g := range groups {
		want := Key(g[0])
		for _, s := range g[1:] {
			if got := Key(s); got != want {
				t.Errorf("Key(%q) = %q, Key(%q) = %q", g[0], want, s, got)
			}
		}
	}
	for _, pair := range [][2]string{{"Sea Wolf", "Sea Wolves"}, {"Ann", "Anne"}, {"Zoë", "Zoe"}} {
		if Key(pair[0]) == Key(pair[1]) {
			t.Errorf("%q and %q share a key", pair[0], pair[1])
		}
	}
}

func readLines(t *testing.T, name string) []string {
	t.Helper()
	data, err := listFiles.ReadFile("lists/" + name)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "#") || strings.TrimSpace(line) == "" {
			continue
		}
		out = append(out, line)
	}
	return out
}

func TestListsInKeyForm(t *testing.T) {
	for _, name := range []string{"anywhere.txt", "words.txt", "reserved.txt"} {
		entries := readLines(t, name)
		if len(entries) == 0 {
			t.Errorf("%s is empty", name)
		}
		for _, e := range entries {
			if k := Key(e); k != e || strings.ContainsAny(e, "#") {
				t.Errorf("%s: %q is not in key form; write %q", name, e, k)
			}
		}
	}
}

func TestInnocentNamesPass(t *testing.T) {
	for _, name := range readLines(t, "innocent.txt") {
		if _, err := CheckName(name); err != nil {
			t.Errorf("%q refused: %v", name, err)
		}
	}
}

// TestReservedRefused checks every reserved name, and its look-alikes, is
// refused.
func TestReservedRefused(t *testing.T) {
	for _, name := range []string{
		"Harbourmaster", "Harbour Master", "harbour-master", "HARBOURMASTER", "H4rbourmaster", "Harb0urmaster",
		"The Harbourmaster", "Harbourmaster Bob", "Port Royal", "PortRoyal", "Port R0yal", "Keel", "K E E L",
		"Keel Over the Edge", "Moderator", "Mod Ann", "Admin", "Adm1n", "Ａｄｍｉｎ", "Adrnin", "System",
		"Наrbourmaster", // Cyrillic Н and а, which no name may mix with Latin
		"Адmin",         // Cyrillic А and д
	} {
		if _, err := CheckName(name); err == nil {
			t.Errorf("%q accepted", name)
		}
	}
	for _, e := range readLines(t, "reserved.txt") {
		if !Blocked(e) {
			t.Errorf("reserved %q passes", e)
		}
	}
}

func TestWordsMatchWholeWords(t *testing.T) {
	for text, want := range map[string]bool{
		"shit":           true,
		"Big Shit":       true,
		"BigShit":        false, // inside a word: only anywhere.txt reaches there
		"Shitake":        false,
		"s.h.i.t":        true,
		"5h1t":           true,
		"Motherfuckers":  true, // anywhere
		"Scunthorpe":     false,
		"Cunt":           true,
		"Ann Bonny":      false,
		"Arse Wipe":      true,
		"Assisi":         false,
		"Mississippi":    false,
		"Sea Wolf":       false,
		"Shi Tsu":        false,
		"Shi T":          true, // run together, the letters spell it
		"Pass Ass Words": true,
	} {
		if got := Blocked(text); got != want {
			t.Errorf("Blocked(%q) = %v", text, got)
		}
	}
}

// lengthCase is a row of testdata/lengths.json, which the client's tests
// read to count names as the server does.
type lengthCase struct {
	Name   string `json:"name"`
	Length int    `json:"length"`
	Reason Reason `json:"reason,omitempty"` // short or long, or "" when the length is right
}

var lengthInputs = []string{
	"Ann", "Ab", "A", "  Sea    Wolf  ", "Ｓｅａ Ｗｏｌｆ", "Zoë", "Zoë", "Á̂", "é̂̃áb",
	"Abcdefghijklmnopqrst", "Abcdefghijklmnopqrstu", "Àbcdefghijklmnopqrst", "山田花子", "やまだ はなこ", "민준",
	"Владимир", "محمد", "Ken 山田", "O’Brien", "St. Ives", "Sea\u00a0Wolf", "Sea\u2003Wolf",
	strings.Repeat("ẽ", 20), strings.Repeat("ẽ", 21), "ﬀ Ship", "Ⅻ Sailor",
}

func lengthTable(t *testing.T) []lengthCase {
	t.Helper()
	var out []lengthCase
	for _, in := range lengthInputs {
		n, err := CheckName(in)
		r := reason(err)
		if r != "" && r != Short && r != Long {
			t.Fatalf("%q is refused as %s: the table is for lengths", in, r)
		}
		display := n.Display
		if r != "" {
			display = in
		}
		out = append(out, lengthCase{Name: in, Length: Length(normalise(display)), Reason: r})
	}
	return out
}

// normalise is the display form without the refusals, for counting names
// too short or long to have one.
func normalise(s string) string {
	return strings.Join(strings.Fields(norm.NFKC.String(s)), " ")
}

// TestLengthTable checks testdata/lengths.json is current: the client's
// name check counts these names and must agree.
func TestLengthTable(t *testing.T) {
	table := lengthTable(t)
	data, err := json.MarshalIndent(table, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	data = append(data, '\n')
	const path = "testdata/lengths.json"
	if *update {
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	old, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(old, data) {
		t.Fatalf("%s is not current: go test ./internal/moderation -run LengthTable -args -update", path)
	}
}

func TestSkeleton(t *testing.T) {
	if confusablesVersion != "17.0.0" {
		t.Fatalf("the table is Unicode %s", confusablesVersion)
	}
	for in, want := range map[string]string{"m": "rn", "0": "O", "1": "l", "а": "a", "abc": "abc", "’": "'"} {
		if got := skeleton(in); got != want {
			t.Errorf("skeleton(%q) = %q, want %q", in, got, want)
		}
	}
}

// FuzzCheckName runs any string through the whole check: it never panics,
// an accepted name's display form is accepted again as itself, and the key
// of the input is the key of its display form.
func FuzzCheckName(f *testing.F) {
	for _, s := range append(lengthInputs, "Sea Wolf", "Pаypal", "Ab\u200dcd", "Sh1t", "Ｓｅａ", "\xff\xfe", "\u03f900", "Á̂b c") {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		n, err := CheckName(s)
		if err != nil {
			if reason(err) == "" {
				t.Fatalf("%q: an error without a reason: %v", s, err)
			}
			return
		}
		again, err := CheckName(n.Display)
		if err != nil || again != n {
			t.Fatalf("%q → %q, then %q, %v", s, n.Display, again.Display, err)
		}
		if k := Key(s); k != n.Key {
			t.Fatalf("Key(%q) = %q, the display form's %q", s, k, n.Key)
		}
		if Length(n.Display) < MinLength || Length(n.Display) > MaxLength || len(n.Display) > MaxBytes {
			t.Fatalf("%q accepted at length %d", n.Display, Length(n.Display))
		}
	})
}
