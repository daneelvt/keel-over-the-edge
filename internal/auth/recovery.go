// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"strings"
)

// A recovery code signs an account in without a passkey, once. It is 128
// random bits, more than NIST SP 800-63B-4 asks of a saved recovery code
// (4.2.1.1: at least 64) and above the 112 bits under which a look-up
// secret must be salted and slowly hashed (3.1.2): it is kept as its
// SHA-256, as a session token is, so the code alone finds its account.
//
// It is written in Douglas Crockford's base 32, which has no letters that
// pass for digits, in 26 characters grouped by four for reading aloud:
// 7KQ2-M9XD-0F3H-RB6C-Z1WN-5TPE-4G. It is read without regard to case,
// spaces or hyphens, with I and L read as 1 and O as 0.

// recoveryBytes is a recovery code's length before encoding.
const recoveryBytes = 16

// crockford is Crockford's base 32 alphabet.
var crockford = base32.NewEncoding("0123456789ABCDEFGHJKMNPQRSTVWXYZ").WithPadding(base32.NoPadding)

// recoveryLen is a recovery code's length, its hyphens aside.
var recoveryLen = crockford.EncodedLen(recoveryBytes)

// NewRecoveryCode draws a recovery code and returns it, as the player is
// shown it, and its hash, as the database keeps it.
func NewRecoveryCode() (string, [32]byte) {
	raw := make([]byte, recoveryBytes)
	_, _ = rand.Read(raw) // never fails (crypto/rand)
	plain := crockford.EncodeToString(raw)
	var b strings.Builder
	for i := 0; i < len(plain); i += 4 {
		if i > 0 {
			b.WriteByte('-')
		}
		b.WriteString(plain[i:min(i+4, len(plain))])
	}
	return b.String(), sha256.Sum256(raw)
}

// HashRecoveryCode reads a recovery code as a player types it and returns
// its hash, or false when it cannot be one.
func HashRecoveryCode(typed string) ([32]byte, bool) {
	var b strings.Builder
	for _, r := range strings.ToUpper(typed) {
		switch r {
		case ' ', '-', '\t', '\n', '\r':
			continue
		case 'I', 'L':
			r = '1'
		case 'O':
			r = '0'
		}
		b.WriteRune(r)
	}
	plain := b.String()
	if len(plain) != recoveryLen {
		return [32]byte{}, false
	}
	raw, err := crockford.DecodeString(plain)
	// Encoding again catches what the decoder lets by: bits past the
	// code's 128 in its last character.
	if err != nil || len(raw) != recoveryBytes || crockford.EncodeToString(raw) != plain {
		return [32]byte{}, false
	}
	return sha256.Sum256(raw), true
}
