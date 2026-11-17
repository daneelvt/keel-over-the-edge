// SPDX-License-Identifier: AGPL-3.0-only

package config

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"
)

func loadNew(t *testing.T, vars map[string]string) (Config, error) {
	t.Helper()
	vars["KEEL_PLAY_ORIGIN"] = "https://play.keelovertheedge.com"
	return Load(env(vars))
}

// TestAddressKey: base64 of 32 bytes or more; unset, keel makes its own;
// anything else, keel refuses to start, without repeating the key.
func TestAddressKey(t *testing.T) {
	raw := bytes.Repeat([]byte{0xa5}, 32)
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		c, err := loadNew(t, map[string]string{"KEEL_ADDRESS_KEY": enc.EncodeToString(raw)})
		if err != nil || !bytes.Equal(c.NewSailors.AddressKey, raw) || c.NewSailors.AddressKeyMade {
			t.Errorf("%v: %v %x", enc, err, c.NewSailors.AddressKey)
		}
	}
	// OpenTofu's: 44 letters and digits, 33 bytes.
	c, err := loadNew(t, map[string]string{"KEEL_ADDRESS_KEY": strings.Repeat("aB3", 14) + "xY"})
	if err != nil || len(c.NewSailors.AddressKey) != 33 {
		t.Errorf("44 letters and digits: %v, %d bytes", err, len(c.NewSailors.AddressKey))
	}
	c, err = loadNew(t, map[string]string{})
	if err != nil || !c.NewSailors.AddressKeyMade || c.NewSailors.AddressKey != nil {
		t.Errorf("unset: %v %+v", err, c.NewSailors)
	}
	for _, bad := range []string{base64.StdEncoding.EncodeToString(raw[:31]), "not base64 at all!", "short"} {
		_, err := loadNew(t, map[string]string{"KEEL_ADDRESS_KEY": bad})
		if err == nil || !strings.Contains(err.Error(), "KEEL_ADDRESS_KEY") || strings.Contains(err.Error(), bad) {
			t.Errorf("%q: %v", bad, err)
		}
	}
}

// TestTurnstilePair: both keys, or neither; one without the other refuses
// to start.
func TestTurnstilePair(t *testing.T) {
	c, err := loadNew(t, map[string]string{})
	if err != nil || c.NewSailors.HumanCheck() {
		t.Errorf("neither: %v, check %t", err, c.NewSailors.HumanCheck())
	}
	c, err = loadNew(t, map[string]string{"KEEL_TURNSTILE_SITEKEY": "0x4AAAAAAA", "KEEL_TURNSTILE_SECRET": "0x4AAAAAAA_secret-1"})
	if err != nil || !c.NewSailors.HumanCheck() {
		t.Errorf("both: %v, check %t", err, c.NewSailors.HumanCheck())
	}
	for _, half := range []map[string]string{{"KEEL_TURNSTILE_SITEKEY": "0x4AAAAAAA"}, {"KEEL_TURNSTILE_SECRET": "0x4AAAAAAA"}} {
		if _, err := loadNew(t, half); err == nil || !strings.Contains(err.Error(), "both or neither") {
			t.Errorf("%v: %v", half, err)
		}
	}
	if _, err := loadNew(t, map[string]string{"KEEL_TURNSTILE_SITEKEY": "a key", "KEEL_TURNSTILE_SECRET": "s"}); err == nil {
		t.Error("a site key with a space")
	}
}

func TestTurnstileAddresses(t *testing.T) {
	c, err := loadNew(t, map[string]string{
		"KEEL_TURNSTILE_VERIFY_URL": "http://127.0.0.1:18088/turnstile/siteverify",
		"KEEL_TURNSTILE_SCRIPT":     "/turnstile/api.js?render=explicit",
	})
	if err != nil || c.NewSailors.TurnstileScript != "/turnstile/api.js?render=explicit" {
		t.Fatalf("a stand-in's: %v %+v", err, c.NewSailors)
	}
	for k, bad := range map[string][]string{
		"KEEL_TURNSTILE_VERIFY_URL": {"http://example.com/siteverify", "ftp://x", "https://"},
		"KEEL_TURNSTILE_SCRIPT":     {"http://challenges.cloudflare.com/api.js", "//evil.example/api.js", "api.js", "javascript:alert(1)"},
	} {
		for _, v := range bad {
			if _, err := loadNew(t, map[string]string{k: v}); err == nil || !strings.Contains(err.Error(), k) {
				t.Errorf("%s=%q: %v", k, v, err)
			}
		}
	}
}

// TestNewSailorsNotShown: the key and the secret never reach a log line.
func TestNewSailorsNotShown(t *testing.T) {
	key := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	c, err := loadNew(t, map[string]string{"KEEL_ADDRESS_KEY": key, "KEEL_TURNSTILE_SITEKEY": "sitekey", "KEEL_TURNSTILE_SECRET": "verysecret"})
	if err != nil {
		t.Fatal(err)
	}
	s := c.String()
	if strings.Contains(s, "verysecret") || strings.Contains(s, key) || strings.Contains(s, "[7 7 7") || !strings.Contains(s, "sitekey") {
		t.Errorf("shown: %s", s)
	}
}
