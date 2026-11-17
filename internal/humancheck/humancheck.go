// SPDX-License-Identifier: AGPL-3.0-only

// Package humancheck asks Cloudflare whether a token a page's Turnstile
// widget gave is a person's: its siteverify, called once for each new
// sailor before their passkey is made.
//
// A token passes only if Cloudflare says it succeeded, for the play host,
// for the action new-sailor. Each check is sent with an idempotency key of
// its own, and sent once more with the same key after a network error or
// a 5xx, so that a retry is never taken for a token used twice. A check
// that cannot be answered in Timeout is unavailable: the caller refuses
// the new sailor (failing closed), never lets them through.
package humancheck

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
)

// Cloudflare's addresses: the script a page loads the widget from, which
// must not be proxied or cached, and the siteverify keel asks.
const (
	DefaultScript    = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
	DefaultVerifyURL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
)

// Action is the widget's action on the start screen, which siteverify
// gives back: a token made for anything else does not make a sailor.
const Action = "new-sailor"

// TestToken is the token Cloudflare's test site keys give, which its test
// secrets pass and real secrets refuse.
const TestToken = "XXXX.DUMMY.TOKEN.XXXX"

// MaxToken is the longest token Cloudflare makes, in characters.
const MaxToken = 2048

// Timeout bounds a check, its retry included.
const Timeout = 5 * time.Second

// Cloudflare's test secrets answer every token with the hostname
// example.com and no action: a check made with one expects that answer,
// so that the local cluster can load the real script with the test keys.
// A real secret is never held to so little.
const testHostname = "example.com"

// testSecret reports whether secret is one of Cloudflare's test secrets:
// 1x… always passes, 2x… always fails, 3x… answers a token spent.
func testSecret(secret string) bool {
	return len(secret) == 35 && (strings.HasPrefix(secret, "1x") || strings.HasPrefix(secret, "2x") || strings.HasPrefix(secret, "3x")) &&
		strings.TrimLeft(secret[2:], "0") == "AA"
}

// Result is what a check found, as keel_human_checks_total labels it.
type Result string

const (
	// Passed: a person's token, for this host and action, used once.
	Passed Result = "passed"
	// Refused: no token, one Cloudflare refused, or one for another host
	// or action.
	Refused Result = "refused"
	// Spent: a token used before, or older than its 300 seconds.
	Spent Result = "spent"
	// Unavailable: Cloudflare could not be asked, or did not answer in
	// time, or refused keel's own part of the question.
	Unavailable Result = "unavailable"
	// Off: no check was made, the owner having switched it off, or none
	// being set up.
	Off Result = "off"
)

// Results are every Result, as the counter labels them.
var Results = []Result{Passed, Refused, Spent, Unavailable, Off}

// Config sets up a Checker.
type Config struct {
	// Secret is the widget's secret key.
	Secret string
	// VerifyURL is siteverify's address: DefaultVerifyURL unless set.
	VerifyURL string
	// Hostname is the play host, the only one a token may be for.
	Hostname string
	// Client is the HTTP client: one with no timeout of its own unless set.
	Client *http.Client
	// Timeout, if not zero, replaces the package's: for tests.
	Timeout time.Duration
	Log     *slog.Logger
}

// Checker checks tokens with Cloudflare.
type Checker struct {
	cfg Config
}

// New makes a Checker.
func New(cfg Config) *Checker {
	if cfg.VerifyURL == "" {
		cfg.VerifyURL = DefaultVerifyURL
	}
	if cfg.Client == nil {
		cfg.Client = &http.Client{}
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = Timeout
	}
	if cfg.Log == nil {
		cfg.Log = slog.New(slog.DiscardHandler)
	}
	return &Checker{cfg: cfg}
}

// answer is siteverify's answer, as far as keel reads it.
type answer struct {
	Success    bool     `json:"success"`
	Hostname   string   `json:"hostname"`
	Action     string   `json:"action"`
	ErrorCodes []string `json:"error-codes"`
}

// errAnswer is an answer that is not siteverify's.
var errAnswer = errors.New("humancheck: not siteverify's answer")

// decode reads siteverify's answer: a JSON object with success a boolean.
func decode(body []byte) (answer, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return answer{}, errAnswer
	}
	if s, ok := raw["success"]; !ok || (string(s) != "true" && string(s) != "false") {
		return answer{}, errAnswer
	}
	var a answer
	if err := json.Unmarshal(body, &a); err != nil {
		return answer{}, errAnswer
	}
	return a, nil
}

// judge is what an answer means for a token checked for host, with a
// test secret or a real one.
func judge(a answer, host string, test bool) Result {
	if !a.Success {
		switch {
		case slices.Contains(a.ErrorCodes, "timeout-or-duplicate"):
			return Spent
		case slices.Contains(a.ErrorCodes, "invalid-input-response"), slices.Contains(a.ErrorCodes, "missing-input-response"):
			return Refused
		}
		// keel's own part refused (its secret, its request), or Cloudflare's
		// own fault: nothing the player did.
		return Unavailable
	}
	if test {
		if a.Hostname != testHostname || a.Action != "" {
			return Refused
		}
		return Passed
	}
	if a.Hostname != host || a.Action != Action {
		return Refused
	}
	return Passed
}

// Check asks Cloudflare about token, from the player at remoteip ("" when
// unknown). A missing token, or one longer than any Cloudflare makes, is
// refused without asking.
func (c *Checker) Check(ctx context.Context, token, remoteip string) Result {
	if token == "" || len(token) > MaxToken {
		return Refused
	}
	ctx, cancel := context.WithTimeout(ctx, c.cfg.Timeout)
	defer cancel()
	form := url.Values{"secret": {c.cfg.Secret}, "response": {token}, "idempotency_key": {idempotencyKey()}}
	if remoteip != "" {
		form.Set("remoteip", remoteip)
	}
	body := form.Encode()
	var last error
	for try := range 2 {
		a, retry, err := c.ask(ctx, body)
		if err == nil {
			r := judge(a, c.cfg.Hostname, testSecret(c.cfg.Secret))
			if r == Unavailable {
				c.cfg.Log.Warn("the human check: Cloudflare refused keel's question", "errors", strings.Join(a.ErrorCodes, ","))
			}
			return r
		}
		last = err
		if !retry || ctx.Err() != nil || try == 1 {
			break
		}
	}
	c.cfg.Log.Warn("the human check: Cloudflare did not answer", "err", last)
	return Unavailable
}

// ask posts one check: retry is whether a failure is worth one more try
// (a network error, or a 5xx).
func (c *Checker) ask(ctx context.Context, body string) (a answer, retry bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.VerifyURL, strings.NewReader(body))
	if err != nil {
		return answer{}, false, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := c.cfg.Client.Do(req)
	if err != nil {
		return answer{}, true, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if err != nil {
		return answer{}, true, err
	}
	if res.StatusCode >= 500 {
		return answer{}, true, fmt.Errorf("siteverify answered %s", res.Status)
	}
	a, err = decode(raw)
	if err != nil {
		return answer{}, false, fmt.Errorf("siteverify answered %s: %w", res.Status, err)
	}
	return a, false, nil
}

// idempotencyKey is a random UUID (version 4), which siteverify takes to
// tell a retry from a token used again.
func idempotencyKey() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
