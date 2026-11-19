// SPDX-License-Identifier: AGPL-3.0-only

package agreement

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// MaxDelivery is the most a webhook's delivery may be, bytes: GitHub caps
// its payloads at 25 MB, but a pull_request event is a few tens of KB.
const MaxDelivery = 1 << 20

// rememberDeliveries is how many deliveries' IDs are kept to refuse a
// second of the same.
const rememberDeliveries = 4096

// Webhook receives GitHub's deliveries. Nothing in one is read before its
// signature is checked against the webhook's secret.
type Webhook struct {
	Secret  []byte
	Checker *Checker
	// Result, if not nil, is told how each delivery ended: ok, ignored,
	// duplicate, bad_signature, too_large, bad_request.
	Result func(string)

	mu   sync.Mutex
	seen map[string]bool
	ring []string
}

// pullActions are the pull_request events that may change who must sign:
// opened, pushed to, reopened, labelled (the owner's label), and closed
// (nothing waits on it any more).
var pullActions = map[string]bool{
	"opened": true, "synchronize": true, "reopened": true, "labeled": true, "unlabeled": true, "closed": true,
	"edited": true, // a pull request's base changed
}

func (h *Webhook) result(w http.ResponseWriter, status int, r string) {
	if h.Result != nil {
		h.Result(r)
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	io.WriteString(w, r+"\n")
}

func (h *Webhook) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		h.result(w, http.StatusMethodNotAllowed, "bad_request")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxDelivery))
	if err != nil {
		if mbe := (*http.MaxBytesError)(nil); errors.As(err, &mbe) {
			h.result(w, http.StatusRequestEntityTooLarge, "too_large")
			return
		}
		h.result(w, http.StatusBadRequest, "bad_request")
		return
	}
	if !Verify(h.Secret, body, r.Header.Get("X-Hub-Signature-256")) {
		h.result(w, http.StatusUnauthorized, "bad_signature")
		return
	}
	if id := r.Header.Get("X-GitHub-Delivery"); id != "" && !h.first(id) {
		h.result(w, http.StatusOK, "duplicate")
		return
	}
	if r.Header.Get("X-GitHub-Event") != "pull_request" {
		h.result(w, http.StatusOK, "ignored")
		return
	}
	var ev struct {
		Action     string `json:"action"`
		Number     int    `json:"number"`
		Repository struct {
			FullName string `json:"full_name"`
		} `json:"repository"`
	}
	if err := json.Unmarshal(body, &ev); err != nil || ev.Number <= 0 || !validRepo(ev.Repository.FullName) {
		h.result(w, http.StatusBadRequest, "bad_request")
		return
	}
	if !pullActions[ev.Action] {
		h.result(w, http.StatusOK, "ignored")
		return
	}
	h.Checker.Enqueue(store.PullRef{Repo: ev.Repository.FullName, Number: ev.Number})
	h.result(w, http.StatusAccepted, "ok")
}

// first reports whether a delivery's ID is new, remembering it.
func (h *Webhook) first(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.seen == nil {
		h.seen = map[string]bool{}
	}
	if h.seen[id] {
		return false
	}
	h.seen[id] = true
	h.ring = append(h.ring, id)
	if len(h.ring) > rememberDeliveries {
		delete(h.seen, h.ring[0])
		h.ring = h.ring[1:]
	}
	return true
}

// Verify checks a delivery's X-Hub-Signature-256, "sha256=" and the
// HMAC-SHA256 of its body under secret in hex, in constant time. An empty
// secret verifies nothing.
func Verify(secret, body []byte, header string) bool {
	if len(secret) == 0 {
		return false
	}
	got, ok := strings.CutPrefix(header, "sha256=")
	if !ok {
		return false
	}
	sig, err := hex.DecodeString(got)
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	return hmac.Equal(sig, mac.Sum(nil))
}

// validRepo reports whether s is owner/name as GitHub names repositories,
// so it is safe in an API path: an owner of letters, digits and hyphens; a
// name of those, underscores and dots, but not "." or "..".
func validRepo(s string) bool {
	owner, name, ok := strings.Cut(s, "/")
	if !ok || owner == "" || name == "" || len(s) > 200 || name == "." || name == ".." {
		return false
	}
	for _, r := range owner {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-') {
			return false
		}
	}
	for _, r := range name {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.') {
			return false
		}
	}
	return true
}
