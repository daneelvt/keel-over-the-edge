// SPDX-License-Identifier: AGPL-3.0-only

package moderation

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// MaxChat is a line's longest, in Unicode code points.
const MaxChat = 200

// maxChatBytes is the most of a line read at all: a longer one is refused as
// long unread.
const maxChatBytes = 4096

// maxMarks is the most combining marks one character keeps: more only pile
// up over the lines around it.
const maxMarks = 4

// ChatReason is why a line was refused.
type ChatReason string

const (
	ChatEmpty   ChatReason = "empty"   // nothing left after cleaning
	ChatLong    ChatReason = "long"    // more than MaxChat code points after cleaning
	ChatContact ChatReason = "contact" // a link, bare domain, email, phone number, handle, or another app's name with a contact
	ChatWords   ChatReason = "words"   // a word of the lists (never says which)
)

// CheckChat cleans a line and checks it. It returns the line as it is to be
// shown (one line, cleaned) and "" when it passes, or the reason it is
// refused (the cleaned text is still returned). It never logs and keeps
// nothing.
//
// Cleaning normalises the line (NFKC), removes control, format, invisible
// and direction characters (a zero-width joiner and an emoji's variation
// selector stay inside emoji), keeps at most maxMarks combining marks on a
// character, turns newlines and tabs into spaces, collapses spaces and trims
// them. Cleaning a clean line changes nothing. A line over 4 KB is refused as
// long unread, and its clean form is "".
//
// The checks read folded forms of the line, never what is shown: lowercase,
// look-alike letters read as the Latin ones (UTS #39's skeleton), digits and
// symbols written for letters read as letters, letters repeated three times
// or more read once and twice ("shiiit"), and single letters between
// separators joined ("s h i t", "e x a m p l e . c o m").
func CheckChat(text string) (clean string, refused ChatReason) {
	if len(text) > maxChatBytes {
		return "", ChatLong
	}
	clean = cleanChat(text)
	switch {
	case clean == "":
		return "", ChatEmpty
	case utf8.RuneCountInString(clean) > MaxChat:
		return clean, ChatLong
	}
	f := foldChat(clean)
	if f.contact() {
		return clean, ChatContact
	}
	if f.words() {
		return clean, ChatWords
	}
	return clean, ""
}

// cleanChat is a line as shown.
func cleanChat(s string) string {
	s = dropInvisible(strings.ToValidUTF8(s, ""))
	for {
		// Normalising can turn a character into a space, or an emoji into a
		// letter a joiner may not follow; dropping a character can leave
		// two to normalise into one. Each round drops something, or ends.
		next := dropInvisible(norm.NFKC.String(s))
		if next == s {
			break
		}
		s = next
	}
	s = tidy(s)
	if !norm.NFKC.IsNormalString(s) {
		return cleanChat(s)
	}
	return s
}

// dropInvisible removes what a line may not show and makes every space a
// plain one.
func dropInvisible(s string) string {
	if printableASCII(s) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	prev := rune(-1) // the last rune kept
	for i, r := range s {
		next, _ := utf8.DecodeRuneInString(s[i+utf8.RuneLen(r):])
		switch {
		case unicode.IsSpace(r) || r == '\u2800': // a braille blank shows as a space
			r = ' '
		case r == '\u200d': // a zero-width joiner, only between emoji ("👩\u200d🚀")
			if !pictograph(prev) || !pictograph(next) {
				continue
			}
		case r == '\ufe0e' || r == '\ufe0f': // text or emoji presentation, only on an emoji or a keycap
			if !pictograph(prev) && next != '\u20e3' {
				continue
			}
		case invisible(r):
			continue
		}
		b.WriteRune(r)
		prev = r
	}
	return b.String()
}

// invisible reports whether r is a character a line drops: controls,
// format characters (zero-width spaces and joiners, the direction marks,
// embeddings, overrides and isolates), private use, unassigned code points
// and the other default-ignorable ones (variation selectors, Hangul fillers).
func invisible(r rune) bool {
	switch {
	case unicode.In(r, unicode.Cc, unicode.Cf, unicode.Co):
		return true
	case unicode.In(r, unicode.Other_Default_Ignorable_Code_Point, unicode.Variation_Selector):
		return true
	case r == '\ufffc' || r == '\ufffd': // object and replacement characters
		return true
	case !unicode.IsGraphic(r):
		// Unassigned in this Unicode version, but for emoji newer than it.
		return r < 0x1f000 || r > 0x1faff
	}
	return false
}

// pictograph reports whether r is an emoji, or part of one a joiner may
// follow.
func pictograph(r rune) bool {
	return unicode.Is(unicode.So, r) || r >= 0x1f000 && r <= 0x1faff || r == '\ufe0f' || r == '\u20e3'
}

// tidy keeps at most maxMarks combining marks on a character and none on a
// space or at the start, collapses spaces and trims them.
func tidy(s string) string {
	if printableASCII(s) && !strings.Contains(s, "  ") && strings.TrimSpace(s) == s {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	marks, base, space := 0, false, false
	for _, r := range s {
		switch {
		case r == ' ':
			space, base = b.Len() > 0, false
		case unicode.Is(unicode.M, r):
			if base && marks < maxMarks {
				b.WriteRune(r)
				marks++
			}
		default:
			if space {
				b.WriteByte(' ')
				space = false
			}
			b.WriteRune(r)
			marks, base = 0, true
		}
	}
	return b.String()
}

// printableASCII reports whether s is all printable ASCII, which cleaning
// leaves as it is but for its spaces.
func printableASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < ' ' || s[i] > '~' {
			return false
		}
	}
	return true
}
