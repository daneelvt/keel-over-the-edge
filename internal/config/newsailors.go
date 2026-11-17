// SPDX-License-Identifier: AGPL-3.0-only

package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

// AddressKeyBytes is the least an address key may hold.
const AddressKeyBytes = 32

// The human check's defaults: Cloudflare Turnstile's script and
// siteverify.
const (
	DefaultTurnstileScript    = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
	DefaultTurnstileVerifyURL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
)

// NewSailors is how new sailors are let in: the key their addresses are
// kept under, and the human check.
type NewSailors struct {
	// AddressKey is the key an address is kept under, as an HMAC, while
	// it counts toward the new sailors from it: KEEL_ADDRESS_KEY, base64
	// of 32 bytes or more. Unset (AddressKeyMade), keel makes one as it
	// starts, and every count starts again with each start.
	AddressKey     []byte
	AddressKeyMade bool
	// TurnstileSiteKey and TurnstileSecret are the Turnstile widget's
	// keys: the site key, public, which the page renders the widget with,
	// and the secret keel checks its tokens with. Both or neither: with
	// neither, no human check is made.
	TurnstileSiteKey string
	TurnstileSecret  string
	// TurnstileVerifyURL is siteverify's address, and TurnstileScript the
	// widget's script's, which the page loads: Cloudflare's, unless a test
	// points them at a stand-in. The script may be a path on the page's
	// own origin.
	TurnstileVerifyURL string
	TurnstileScript    string
}

// HumanCheck reports whether the human check is set up: both its keys.
func (n NewSailors) HumanCheck() bool { return n.TurnstileSiteKey != "" && n.TurnstileSecret != "" }

// String leaves the key and the secret out, so the configuration can be
// logged.
func (n NewSailors) String() string {
	return fmt.Sprintf("{AddressKeyMade:%t TurnstileSiteKey:%s HumanCheck:%t TurnstileVerifyURL:%s TurnstileScript:%s}",
		n.AddressKeyMade, n.TurnstileSiteKey, n.HumanCheck(), n.TurnstileVerifyURL, n.TurnstileScript)
}

// loadNewSailors reads the address key and the human check's settings.
func loadNewSailors(getenv func(string) string) (NewSailors, []error) {
	var errs []error
	n := NewSailors{
		TurnstileSiteKey:   getenv("KEEL_TURNSTILE_SITEKEY"),
		TurnstileSecret:    getenv("KEEL_TURNSTILE_SECRET"),
		TurnstileVerifyURL: or(getenv("KEEL_TURNSTILE_VERIFY_URL"), DefaultTurnstileVerifyURL),
		TurnstileScript:    or(getenv("KEEL_TURNSTILE_SCRIPT"), DefaultTurnstileScript),
	}
	if v := getenv("KEEL_ADDRESS_KEY"); v == "" {
		n.AddressKeyMade = true
	} else if key, err := ParseAddressKey(v); err != nil {
		errs = append(errs, fmt.Errorf("KEEL_ADDRESS_KEY: %w", err))
	} else {
		n.AddressKey = key
	}
	switch {
	case (n.TurnstileSiteKey == "") != (n.TurnstileSecret == ""):
		errs = append(errs, errors.New("KEEL_TURNSTILE_SITEKEY and KEEL_TURNSTILE_SECRET: both or neither (neither: no human check)"))
	case n.TurnstileSiteKey != "":
		if !turnstileKey(n.TurnstileSiteKey) {
			errs = append(errs, errors.New("KEEL_TURNSTILE_SITEKEY: not a site key: letters, digits, - and _"))
		}
		if !turnstileKey(n.TurnstileSecret) {
			errs = append(errs, errors.New("KEEL_TURNSTILE_SECRET: not a secret key: letters, digits, - and _"))
		}
	}
	if err := checkVerifyURL(n.TurnstileVerifyURL); err != nil {
		errs = append(errs, fmt.Errorf("KEEL_TURNSTILE_VERIFY_URL: %w", err))
	}
	if err := checkScript(n.TurnstileScript); err != nil {
		errs = append(errs, fmt.Errorf("KEEL_TURNSTILE_SCRIPT: %w", err))
	}
	return n, errs
}

// ParseAddressKey reads an address key: base64, standard or URL-safe,
// padded or not, of AddressKeyBytes bytes or more. Its errors never
// repeat it.
func ParseAddressKey(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if b, err := enc.DecodeString(s); err == nil {
			if len(b) < AddressKeyBytes {
				return nil, fmt.Errorf("%d bytes: it must hold %d or more", len(b), AddressKeyBytes)
			}
			return b, nil
		}
	}
	return nil, errors.New("not base64")
}

// turnstileKey reports whether s may be a Turnstile key: Cloudflare's are
// letters, digits, - and _.
func turnstileKey(s string) bool {
	if len(s) > 256 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

// checkVerifyURL accepts siteverify's address: https, or http on a
// loopback address, for a test's stand-in.
func checkVerifyURL(s string) error {
	u, err := url.Parse(s)
	switch {
	case err != nil:
		return err
	case u.Scheme == "http" && loopback(u.Hostname()):
	case u.Scheme != "https":
		return fmt.Errorf("%q is not https (http is allowed on localhost, 127.0.0.1 or [::1] alone)", s)
	}
	if u.Host == "" || u.User != nil {
		return fmt.Errorf("%q has no host, or has user information", s)
	}
	return nil
}

// checkScript accepts the widget's script's address: https, or a path on
// the page's own origin, as a test's stand-in has.
func checkScript(s string) error {
	u, err := url.Parse(s)
	switch {
	case err != nil:
		return err
	case u.Scheme == "" && u.Host == "" && strings.HasPrefix(u.Path, "/") && !strings.HasPrefix(s, "//"):
		return nil
	case u.Scheme != "https" || u.Host == "" || u.User != nil:
		return fmt.Errorf("%q is neither https nor a path on the page's origin", s)
	}
	return nil
}
