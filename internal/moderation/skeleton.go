// SPDX-License-Identifier: AGPL-3.0-only

package moderation

import (
	"sort"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// confusable is one row of the look-alike table: a character and its
// prototype.
type confusable struct {
	from rune
	to   string
}

// prototype is r's prototype, or "" when r is its own.
func prototype(r rune) string {
	i := sort.Search(len(confusables), func(i int) bool { return confusables[i].from >= r })
	if i < len(confusables) && confusables[i].from == r {
		return confusables[i].to
	}
	return ""
}

// skeleton is UTS #39's skeleton of s (section 4): decomposed, each
// character replaced by its prototype, decomposed again. Two strings that
// look alike share a skeleton. It is for comparing, never for showing.
func skeleton(s string) string {
	s = norm.NFD.String(s)
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if p := prototype(r); p != "" {
			b.WriteString(p)
		} else {
			b.WriteRune(r)
		}
	}
	return norm.NFD.String(b.String())
}

// scripts are Unicode's scripts by name, Latin first as the most common,
// then in name order, so finding a character's script is the same each run.
var scripts = func() []string {
	names := make([]string, 0, len(unicode.Scripts))
	for name := range unicode.Scripts {
		if name != "Latin" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return append([]string{"Latin"}, names...)
}()

// scriptOf is the name of r's script, or "" for none.
func scriptOf(r rune) string {
	for _, name := range scripts {
		if unicode.Is(unicode.Scripts[name], r) {
			return name
		}
	}
	return ""
}

// The scripts a highly restrictive string may mix with Latin: the Japanese,
// Chinese and Korean sets of UTS #39, section 5.2.
var allowedMixes = [][]string{
	{"Latin", "Han", "Hiragana", "Katakana"},
	{"Latin", "Han", "Bopomofo"},
	{"Latin", "Han", "Hangul"},
}

// highlyRestrictive reports whether s meets UTS #39's "highly restrictive"
// level (section 5.2): its characters are of one script, or of Latin with
// one of the Japanese, Chinese or Korean sets. Common and Inherited
// characters, such as digits, spaces and combining marks, belong to any
// script.
func highlyRestrictive(s string) bool {
	var used []string
	for _, r := range s {
		sc := scriptOf(r)
		if sc == "" || sc == "Common" || sc == "Inherited" {
			continue
		}
		if !contains(used, sc) {
			used = append(used, sc)
		}
	}
	if len(used) <= 1 {
		return true
	}
	for _, mix := range allowedMixes {
		if every(used, func(sc string) bool { return contains(mix, sc) }) {
			return true
		}
	}
	return false
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func every(list []string, f func(string) bool) bool {
	for _, x := range list {
		if !f(x) {
			return false
		}
	}
	return true
}
