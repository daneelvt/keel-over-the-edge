// SPDX-License-Identifier: AGPL-3.0-only

package moderation

import (
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

// chatWordLists are the word lists chat is checked against: anywhere.txt
// and words.txt, but not reserved.txt, whose names (keel, staff, support,
// everyone) are only words in a sentence.
type chatWordLists struct {
	words   map[string]bool
	longest int // the longest word, in bytes
}

var chatLists = sync.OnceValue(func() chatWordLists {
	l := chatWordLists{words: map[string]bool{}}
	for _, w := range readList("words.txt") {
		l.words[w] = true
		l.longest = max(l.longest, len(w))
	}
	return l
})

// asciiKeys are the keys of ASCII characters, as Key makes them.
var asciiKeys = sync.OnceValue(func() *[utf8.RuneSelf]string {
	var keys [utf8.RuneSelf]string
	for c := range rune(utf8.RuneSelf) {
		keys[c] = Key(string(c))
	}
	return &keys
})

// wordKey is Key of a word, quicker for an ASCII one.
func wordKey(w string) string {
	keys := asciiKeys()
	same := true
	for i := 0; i < len(w); i++ {
		if w[i] >= utf8.RuneSelf {
			return Key(w)
		}
		same = same && keys[w[i]] == w[i:i+1]
	}
	if same {
		return w
	}
	var b strings.Builder
	for i := 0; i < len(w); i++ {
		b.WriteString(keys[w[i]])
	}
	return b.String()
}

// words reports whether a line has a word of the lists in any of its
// forms: a word of words.txt as a whole word, a string of anywhere.txt even
// inside one. Words of one or two letters are also read run together ("sh
// it", "f u c k"), but not longer ones: a sentence's words run together
// spell too much ("the pen is", "who re-rigged").
func (f *chatForms) words() bool {
	for _, s := range f.all {
		if wordsIn(s) {
			return true
		}
	}
	// In a, digits end a word too: "shit123".
	return wordsIn(splitDigits(f.a))
}

func wordsIn(s string) bool {
	l := chatLists()
	keys := wordKeys(s)
	for i, k := range keys {
		if listed(k, l) {
			return true
		}
		if utf8.RuneCountInString(k) > 2 {
			continue
		}
		joined := k
		for j := i + 1; j < len(keys) && utf8.RuneCountInString(keys[j]) <= 2 && len(joined) < l.longest+2; j++ {
			joined += keys[j]
			if listed(joined, l) {
				return true
			}
		}
	}
	return false
}

func listed(key string, l chatWordLists) bool {
	if l.words[key] {
		return true
	}
	for _, a := range lists.anywhere {
		if strings.Contains(key, a) {
			return true
		}
	}
	return false
}

// wordKeys are the keys of the words of s: its runs of letters, digits and
// marks, an apostrophe inside one dropped.
func wordKeys(s string) []string {
	var keys []string
	var word strings.Builder
	flush := func() {
		if word.Len() > 0 {
			keys = append(keys, wordKey(word.String()))
			word.Reset()
		}
	}
	for _, r := range s {
		switch {
		case alnum(r):
			word.WriteRune(r)
		case (r == '\'' || r == '’') && word.Len() > 0:
		default:
			flush()
		}
	}
	flush()
	return keys
}

// splitDigits puts a space between a word's letters and its digits.
func splitDigits(s string) string {
	var b strings.Builder
	prev := rune(-1)
	for _, r := range s {
		if prev >= 0 && unicode.IsDigit(prev) != unicode.IsDigit(r) && alnum(prev) && alnum(r) {
			b.WriteByte(' ')
		}
		b.WriteRune(r)
		prev = r
	}
	return b.String()
}
