// SPDX-License-Identifier: AGPL-3.0-only

package oauth

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// TestTokenShape: every kind's token is keelote_, its kind, 43 base62
// characters and 6 of checksum, 60 in all; it parses back to its kind and
// the SHA-256 of the whole string; a token with one character changed, a
// kind the door does not know, or another shape is refused.
func TestTokenShape(t *testing.T) {
	for _, kind := range []string{KindAccess, KindRefresh, KindConnection} {
		seen := map[string]bool{}
		for range 200 {
			tok, hash := NewToken(kind)
			if len(tok) != 60 || TokenLen != 60 || !strings.HasPrefix(tok, "keelote_"+kind+"_") {
				t.Fatalf("%q: %d characters", tok, len(tok))
			}
			for _, c := range tok[len("keelote_xx_"):] {
				if !strings.ContainsRune(base62, c) {
					t.Fatalf("%q has %q", tok, c)
				}
			}
			if hash != sha256.Sum256([]byte(tok)) {
				t.Fatal("the hash is not the whole string's")
			}
			k, h, ok := ParseToken(tok)
			if !ok || k != kind || h != hash {
				t.Fatalf("parsing %q: %v %v", tok, k, ok)
			}
			if seen[tok] {
				t.Fatal("a token drawn twice")
			}
			seen[tok] = true
			// Each character changed, one at a time, in the random part
			// or the checksum.
			for i := len("keelote_xx_"); i < len(tok); i += 7 {
				b := []byte(tok)
				b[i] = base62[(strings.IndexByte(base62, b[i])+1)%62]
				if _, _, ok := ParseToken(string(b)); ok {
					t.Fatalf("%q with character %d changed is accepted", tok, i)
				}
			}
		}
	}
	tok, _ := NewToken(KindAccess)
	for _, bad := range []string{
		"", tok[:59], tok + "0", strings.Replace(tok, "keelote_at_", "keelote_xx_", 1), strings.Replace(tok, "keelote_", "keeloto_", 1),
		strings.Replace(tok, "_at_", "-at_", 1), tok[:20] + "-" + tok[21:], "Bearer " + tok[7:],
	} {
		if _, _, ok := ParseToken(bad); ok {
			t.Errorf("%q accepted", bad)
		}
	}
	id := NewClientID()
	if !Registered(id) || len(id) != 33 || !strings.HasPrefix(id, "keelote_cl_") || Registered("https://claude.ai/oauth/client") || Registered(id+"x") {
		t.Fatalf("a client ID: %q", id)
	}
	if _, _, ok := ParseToken(id); ok {
		t.Fatal("a client ID parsed as a token")
	}
}

// TestIssueRetries: a token whose hash clashes is drawn again, three
// times, each clash logged as an error; a fourth clash fails.
func TestIssueRetries(t *testing.T) {
	var logs bytes.Buffer
	log := slog.New(slog.NewTextHandler(&logs, nil))
	draws, keeps := 0, 0
	draw := func() auth.Drawn { draws++; return auth.DrawToken() }
	_, err := auth.Issue(log, "test", draw, func(auth.Drawn) error { keeps++; return store.ErrTokenTaken })
	if !errors.Is(err, store.ErrTokenTaken) || draws != 4 || keeps != 4 || strings.Count(logs.String(), "level=ERROR") != 4 {
		t.Fatalf("always taken: %v, %d draws, %d keeps\n%s", err, draws, keeps, logs.String())
	}
	logs.Reset()
	draws = 0
	d, err := auth.Issue(log, "test", draw, func(auth.Drawn) error {
		if draws < 3 {
			return store.ErrTokenTaken
		}
		return nil
	})
	if err != nil || d.Token == "" || draws != 3 || strings.Count(logs.String(), "level=ERROR") != 2 {
		t.Fatalf("taken twice: %v, %d draws\n%s", err, draws, logs.String())
	}
	other := errors.New("down")
	if _, err := auth.Issue(log, "test", draw, func(auth.Drawn) error { return other }); !errors.Is(err, other) {
		t.Fatalf("another error: %v", err)
	}
}

// TestCodes: a code is 43 characters of base64url, its hash the SHA-256 of
// the string; anything else is no code.
func TestCodes(t *testing.T) {
	c, h := newCode()
	if got, ok := codeHash(c); !ok || got != h || len(c) != 43 {
		t.Fatalf("%q: %v", c, ok)
	}
	for _, bad := range []string{"", c[:42], c + "A", strings.Replace(c, c[:1], "=", 1)} {
		if _, ok := codeHash(bad); ok {
			t.Errorf("%q accepted", bad)
		}
	}
	if !pkce("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM") {
		t.Fatal("RFC 7636's example verifier refused")
	}
	for _, v := range []string{"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXK", "short", strings.Repeat("a", 129), "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEj+k"} {
		if pkce(v, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM") {
			t.Errorf("verifier %q accepted", v)
		}
	}
}
