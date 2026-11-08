// SPDX-License-Identifier: AGPL-3.0-only

package moderation

import (
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// chatForms are the folded forms of a clean line the chat filter reads.
type chatForms struct {
	// a is the line lowercased, each look-alike of a Latin letter read as
	// it, accents dropped, and every decimal digit an ASCII one.
	a string
	// b is a with digits and symbols written for letters read as the
	// letters, in words that have a letter ("sh1t", "c0m", "@ss"), never
	// in numbers ("10.30").
	b string
	// ja is a with its single letters joined, and jb that read as b is.
	ja, jb string
	// links are a, b, ja, jb and the line lowercase (for domains of other
	// scripts, "пример.рф"): the forms links are looked for in.
	links []string
	// all are b and jb, and each with its repeated letters read once and
	// twice: the forms words and apps' names are looked for in. No word of
	// the lists nor app's name has a digit, so b has every word a has.
	all []string
}

func foldChat(clean string) *chatForms {
	f := &chatForms{a: fold(clean)}
	f.b, f.ja = substitute(f.a), joinSingles(f.a)
	f.jb = substitute(f.ja)
	for _, s := range []string{f.a, f.b, f.ja, f.jb, strings.ToLower(clean)} {
		f.links = appendNew(f.links, s)
	}
	for _, s := range []string{f.b, f.jb} {
		f.all = appendNew(f.all, s)
		f.all = appendNew(f.all, collapseRepeats(s, 1))
		f.all = appendNew(f.all, collapseRepeats(s, 2))
	}
	return f
}

func appendNew(list []string, s string) []string {
	for _, x := range list {
		if x == s {
			return list
		}
	}
	return append(list, s)
}

// fold is the line lowercased, look-alikes of Latin letters, digits and
// full stops read as them, and accents dropped.
func fold(s string) string {
	ascii := true
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			ascii = false
			break
		}
	}
	if ascii {
		return strings.ToLower(s)
	}
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range strings.ToLower(s) {
		foldRune(&b, r)
	}
	return b.String()
}

func foldRune(b *strings.Builder, r rune) {
	switch {
	case unicode.In(r, unicode.M, unicode.Cf):
		// Dropped: marks on letters (a strike through, a keycap's), and the
		// joiners and selectors left in emoji.
	case r < utf8.RuneSelf:
		b.WriteRune(unicode.ToLower(r))
	case unicode.Is(unicode.Nd, r):
		b.WriteByte('0' + digitValue(r))
	case r >= 0x1f1e6 && r <= 0x1f1ff: // regional indicators, which spell flags
		b.WriteByte(byte('a' + r - 0x1f1e6))
	case r >= 0x1f150 && r <= 0x1f169: // negative circled capitals
		b.WriteByte(byte('a' + r - 0x1f150))
	case r >= 0x1f170 && r <= 0x1f189: // negative squared capitals
		b.WriteByte(byte('a' + r - 0x1f170))
	default:
		if f, ok := latinFolds()[r]; ok {
			b.WriteString(f)
			return
		}
		// A letter with accents: its letter, folded.
		d := norm.NFD.String(string(r))
		if d == string(r) {
			b.WriteRune(r)
			return
		}
		for _, p := range d {
			if !unicode.Is(unicode.Mn, p) {
				if f, ok := latinFolds()[p]; ok {
					b.WriteString(f)
				} else {
					b.WriteRune(p)
				}
			}
		}
	}
}

// digitValue is the value of a decimal digit: Unicode's digits come in runs
// of ten from zero.
func digitValue(r rune) byte {
	n := 0
	for unicode.Is(unicode.Nd, r-rune(n)-1) {
		n++
	}
	return byte(n % 10)
}

// dotLike are characters that pass for a full stop between a domain's
// parts.
const dotLike = "。˳｡·‧∙⋅・･•⸱․܁܂۔ꓸㆍᆞ"

// smallCapitals read as the letters they are, which the look-alike table
// leaves as themselves.
var smallCapitals = map[rune]string{
	'ᴀ': "a", 'ʙ': "b", 'ᴄ': "c", 'ᴅ': "d", 'ᴇ': "e", 'ꜰ': "f", 'ɢ': "g", 'ʜ': "h", 'ɪ': "i", 'ᴊ': "j",
	'ᴋ': "k", 'ʟ': "l", 'ᴍ': "m", 'ɴ': "n", 'ᴏ': "o", 'ᴘ': "p", 'ǫ': "q", 'ʀ': "r", 'ꜱ': "s", 'ᴛ': "t",
	'ᴜ': "u", 'ᴠ': "v", 'ᴡ': "w", 'ʏ': "y", 'ᴢ': "z", 'ʍ': "m", 'ĸ': "k",
}

// latinFolds maps each non-ASCII character that looks like ASCII to what
// it looks like, lowercase: the look-alike table's prototypes, small
// capitals read as letters, a prototype of "rn" (an m's) as m, and
// full stops' look-alikes as one.
var latinFolds = sync.OnceValue(func() map[rune]string {
	m := map[rune]string{'♯': "#"}
	for _, r := range dotLike {
		m[r] = "."
	}
	for r, s := range smallCapitals {
		m[r] = s
	}
	for _, c := range confusables {
		if _, ok := m[c.from]; ok || c.from < utf8.RuneSelf {
			continue
		}
		if to, ok := asciiPrototype(c.to); ok {
			m[c.from] = to
		}
	}
	return m
})

// asciiPrototype is a look-alike's prototype as ASCII, lowercase, if it has
// one.
func asciiPrototype(proto string) (string, bool) {
	var b strings.Builder
	for _, p := range strings.ToLower(norm.NFD.String(proto)) {
		switch {
		case unicode.Is(unicode.Mn, p):
		case p < utf8.RuneSelf:
			b.WriteRune(p)
		case smallCapitals[p] != "":
			b.WriteString(smallCapitals[p])
		case strings.ContainsRune(dotLike, p):
			b.WriteByte('.')
		default:
			return "", false
		}
	}
	switch to := b.String(); to {
	case "":
		return "", false
	case "rn": // an m's prototype
		return "m", true
	default:
		return to, true
	}
}

// substitute reads digits and symbols as letters in each word of s that
// has a letter.
func substitute(s string) string {
	if !strings.ContainsAny(s, "013457@$") {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for len(s) > 0 {
		i := strings.IndexByte(s, ' ')
		word := s
		if i >= 0 {
			word = s[:i+1]
		}
		s = s[len(word):]
		if strings.IndexFunc(word, unicode.IsLetter) >= 0 {
			word = substitutions.Replace(word)
		}
		b.WriteString(word)
	}
	return b.String()
}

// alnum reports whether r is part of a word: a letter, a digit or a mark.
func alnum(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.Is(unicode.M, r)
}

// joinSingles joins runs of three or more single letters or digits with
// little between them ("s h i t", "c-o-m"), dropping what is between, but
// for full stops: those stay unless every gap of the run has one, so
// "e x a m p l e . c o m" is example.com and "s.h.i.t" is shit.
func joinSingles(s string) string {
	parts := splitWords(s)
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(parts); {
		// parts alternate: a gap (perhaps empty) then a word, from the
		// first gap.
		if i%2 == 0 || !single(parts[i]) {
			b.WriteString(parts[i])
			i++
			continue
		}
		j := i // the run is parts[i], parts[i+2] ... parts[j]
		for j+2 < len(parts) && single(parts[j+2]) && light(parts[j+1]) {
			j += 2
		}
		if j-i < 4 {
			b.WriteString(parts[i])
			i++
			continue
		}
		dotted := true
		for k := i + 1; k < j; k += 2 {
			dotted = dotted && strings.Contains(parts[k], ".")
		}
		for k := i; k <= j; k++ {
			switch {
			case k%2 == 1:
				b.WriteString(parts[k])
			case !dotted && strings.Contains(parts[k], "."):
				b.WriteByte('.')
			}
		}
		i = j + 1
	}
	return b.String()
}

// splitWords splits s into gaps and words, alternately, from a gap (empty
// when s starts with a word).
func splitWords(s string) []string {
	var parts []string
	start, inWord := 0, false
	for i, r := range s {
		if alnum(r) != inWord {
			parts = append(parts, s[start:i])
			start, inWord = i, !inWord
		}
	}
	return append(parts, s[start:])
}

func single(word string) bool {
	_, n := utf8.DecodeRuneInString(word)
	return n == len(word) && word != ""
}

// light reports whether a gap is short enough to join single letters over.
func light(gap string) bool { return utf8.RuneCountInString(gap) <= 3 }

// collapseRepeats reads each letter repeated three times or more as keep
// of it.
func collapseRepeats(s string, keep int) string {
	if !hasRepeat(s) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		j, n := i+size, 1
		for j < len(s) && unicode.IsLetter(r) {
			next, size := utf8.DecodeRuneInString(s[j:])
			if next != r {
				break
			}
			j, n = j+size, n+1
		}
		if n >= 3 {
			n = keep
		}
		for range n {
			b.WriteRune(r)
		}
		i = j
	}
	return b.String()
}

// hasRepeat reports whether s has a letter three times in a row.
func hasRepeat(s string) bool {
	prev, n := rune(-1), 0
	for _, r := range s {
		if r != prev {
			prev, n = r, 0
		}
		if n++; n == 3 && unicode.IsLetter(r) {
			return true
		}
	}
	return false
}
