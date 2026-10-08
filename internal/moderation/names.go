// SPDX-License-Identifier: AGPL-3.0-only

// Package moderation checks what players write for others to read: sailor
// names now, and the word filter that chat, boat names and messages will
// share.
//
// A name has a display form, shown as the player wrote it, and a key, by
// which names are compared: two sailors cannot share a key. The key ignores
// case, width, spacing and separators, and look-alike letters, so a name
// cannot pass for another.
package moderation

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/secure/precis"
	"golang.org/x/text/unicode/norm"
)

// The length of a name, in characters: a letter with its combining marks
// counts once. MaxBytes bounds its UTF-8 form.
const (
	MinLength = 3
	MaxLength = 20
	MaxBytes  = 80
)

// Reason is why a name was refused, as a code the client puts into words.
type Reason string

const (
	Short      Reason = "short"      // fewer than MinLength characters
	Long       Reason = "long"       // more than MaxLength characters, or MaxBytes bytes
	Characters Reason = "characters" // a character a name may not have, or in a place it may not be
	Scripts    Reason = "scripts"    // letters of scripts a name may not mix
	Words      Reason = "words"      // a word that is not allowed (it never says which)
)

// Refusal is a name refused, and why.
type Refusal struct{ Reason Reason }

func (r *Refusal) Error() string { return "moderation: the name is refused: " + string(r.Reason) }

func refuse(r Reason) error { return &Refusal{Reason: r} }

// Name is an accepted name.
type Name struct {
	// Display is the name as shown: RFC 8266's Nickname form, with spaces
	// trimmed and collapsed and the characters normalised (NFKC).
	Display string
	// Key is what names are compared by.
	Key string
}

// CheckName checks a sailor's name and returns its display form and key, or
// a *Refusal.
//
// A name is letters (with their combining marks) and decimal digits, with
// single spaces, hyphens, full stops and apostrophes between them; a full
// stop may be followed by a space, as in "St. Ives". It starts with a
// letter and ends with a letter or digit. Its letters are of one script, or
// of Latin with Japanese, Chinese or Korean (UTS #39's highly restrictive
// level), so a name cannot mix look-alike letters of two alphabets.
func CheckName(s string) (Name, error) {
	if len(s) > 4*MaxBytes {
		return Name{}, refuse(Long)
	}
	display, err := precis.Nickname.String(s)
	if err != nil {
		if strings.TrimFunc(s, unicode.IsSpace) == "" {
			return Name{}, refuse(Short)
		}
		return Name{}, refuse(Characters)
	}
	if !wellFormed(display) {
		return Name{}, refuse(Characters)
	}
	switch n := Length(display); {
	case n < MinLength:
		return Name{}, refuse(Short)
	case n > MaxLength || len(display) > MaxBytes:
		return Name{}, refuse(Long)
	}
	if !highlyRestrictive(display) {
		return Name{}, refuse(Scripts)
	}
	if Blocked(display) {
		return Name{}, refuse(Words)
	}
	return Name{Display: display, Key: Key(display)}, nil
}

// separators may stand between the parts of a name; the key drops them.
const separators = " -.'’"

func isSeparator(r rune) bool { return strings.ContainsRune(separators, r) }

// wellFormed applies the character rules to a name in display form.
func wellFormed(s string) bool {
	if !utf8.ValidString(s) {
		return false
	}
	var prev rune // 0 at the start
	for _, r := range s {
		switch {
		case unicode.IsLetter(r), unicode.Is(unicode.Nd, r) && prev != 0:
		case unicode.Is(unicode.M, r):
			// A mark follows a letter or another mark on one.
			if prev == 0 || !(unicode.IsLetter(prev) || unicode.Is(unicode.M, prev)) {
				return false
			}
		case isSeparator(r):
			if prev == 0 || isSeparator(prev) && !(prev == '.' && r == ' ') {
				return false
			}
		default:
			return false
		}
		prev = r
	}
	return prev != 0 && !isSeparator(prev)
}

// Length counts a name's characters as players see them: every character
// but combining marks, so a letter with its accents counts once. It counts
// the display form; the client counts the same way.
func Length(display string) int {
	n := 0
	for _, r := range display {
		if !unicode.Is(unicode.M, r) {
			n++
		}
	}
	return n
}

// Key is what s is compared by: RFC 8266's Nickname comparison form
// (lowercased, normalised) of its display form, separators removed, then
// UTS #39's skeleton, lowercased again, so case, width, spacing, separators
// and look-alike letters make no difference.
//
// The comparison form is taken of the display form, not of s itself, so a
// name and its display form always share a key: the comparison form
// lowercases before it normalises, and a few characters come out
// differently in the other order (U+03F9, a lunate capital sigma, becomes a
// final sigma one way and a plain one the other).
func Key(s string) string {
	if d, err := precis.Nickname.String(s); err == nil {
		s = d
	}
	k, err := precis.Nickname.CompareKey(s)
	if err != nil {
		// Text that is no name, for the word filter: the same folding,
		// without PRECIS's refusals.
		k = strings.ToLower(norm.NFKC.String(s))
	}
	k = strings.Map(func(r rune) rune {
		if isSeparator(r) || unicode.IsSpace(r) {
			return -1
		}
		return r
	}, k)
	return norm.NFD.String(strings.ToLower(skeleton(k)))
}
