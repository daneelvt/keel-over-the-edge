// SPDX-License-Identifier: AGPL-3.0-only

package moderation

import (
	"bufio"
	"embed"
	"strings"
)

// The word lists, one entry a line in key form (see Key), # for comments:
//
//	anywhere.txt   refused wherever they occur, even inside a word: only
//	               strings no innocent word contains
//	words.txt      refused as whole words
//	reserved.txt   names that would pass for the game speaking
//
// Whole words are matched against every run of a name's words joined, so
// "s h i t" and "Port Royal" are found as one. innocent.txt lists names
// that must pass, which the tests check.
//
//go:embed lists/*.txt
var listFiles embed.FS

type wordLists struct {
	anywhere []string
	words    map[string]bool // words.txt and reserved.txt
	longest  int             // the longest whole word, in bytes
}

var lists = loadLists()

func loadLists() wordLists {
	l := wordLists{anywhere: readList("anywhere.txt"), words: map[string]bool{}}
	for _, name := range []string{"words.txt", "reserved.txt"} {
		for _, w := range readList(name) {
			l.words[w] = true
			l.longest = max(l.longest, len(w))
		}
	}
	return l
}

func readList(name string) []string {
	f, err := listFiles.Open("lists/" + name)
	if err != nil {
		panic(err) // embedded
	}
	defer f.Close()
	var out []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = line[:i]
		}
		if line = strings.TrimSpace(line); line != "" {
			out = append(out, line)
		}
	}
	return out
}

// substitutions are the digits and symbols written for letters, folded
// before matching: "sh1t" is matched as "shit".
var substitutions = strings.NewReplacer("0", "o", "1", "i", "3", "e", "4", "a", "5", "s", "7", "t", "@", "a", "$", "s")

// Blocked reports whether text has a word the lists refuse, as written or
// with digits and symbols read as the letters they stand for. It never says
// which word.
func Blocked(text string) bool {
	lower := strings.ToLower(text)
	for _, form := range []string{lower, substitutions.Replace(lower)} {
		if blockedForm(form) {
			return true
		}
	}
	return false
}

func blockedForm(text string) bool {
	key := Key(text)
	for _, a := range lists.anywhere {
		if strings.Contains(key, a) {
			return true
		}
	}
	words := strings.FieldsFunc(text, isSeparator)
	keys := make([]string, len(words))
	for i, w := range words {
		keys[i] = Key(w)
	}
	// Every run of whole words, joined.
	for i := range keys {
		joined := ""
		for j := i; j < len(keys) && len(joined) < lists.longest; j++ {
			joined += keys[j]
			if lists.words[joined] {
				return true
			}
		}
	}
	return false
}
