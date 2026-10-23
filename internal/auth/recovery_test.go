// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"regexp"
	"strings"
	"testing"
)

// TestRecoveryCode: a code drawn is 26 characters of Crockford's base 32 in
// groups of four; it reads back to its hash in any case, with or without
// its hyphens or spaces, with I and L for 1 and O for 0; nothing else
// does.
func TestRecoveryCode(t *testing.T) {
	form := regexp.MustCompile(`^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{2}$`)
	seen := map[string]bool{}
	for range 200 {
		code, hash := NewRecoveryCode()
		if !form.MatchString(code) || seen[code] {
			t.Fatalf("%q", code)
		}
		seen[code] = true
		plain := strings.ReplaceAll(code, "-", "")
		typed := []string{
			code, plain, strings.ToLower(code), " " + strings.ReplaceAll(code, "-", " ") + "\n",
			strings.NewReplacer("1", "l", "0", "o").Replace(strings.ToLower(plain)),
			strings.NewReplacer("1", "I", "0", "O").Replace(plain),
		}
		for _, s := range typed {
			if got, ok := HashRecoveryCode(s); !ok || got != hash {
				t.Fatalf("%q read as %v for %q", s, ok, code)
			}
		}
	}
	for _, bad := range []string{"", "7KQ2", strings.Repeat("Z", 25), strings.Repeat("Z", 27), strings.Repeat("U", 26),
		// The last character carries two bits past the code's 128: only
		// those zero are a code.
		strings.Repeat("0", 25) + "1", "7KQ2-M9XD-0F3H-RB6C-Z1WN-5TPE-4!"} {
		if _, ok := HashRecoveryCode(bad); ok {
			t.Errorf("%q read as a code", bad)
		}
	}
}
