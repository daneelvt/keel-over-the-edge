// SPDX-License-Identifier: AGPL-3.0-only

package agreement

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The App's numbers in the tests.
const (
	testAppID    = 4242
	testClientID = "Iv1.test"
	testSecret   = "client-secret"
)

var testKey = func() *rsa.PrivateKey {
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	return k
}()

// fakeGitHub is GitHub's API as far as the keeper uses it, for one
// repository, o/r, owned by theOwner.
type fakeGitHub struct {
	t   *testing.T
	srv *httptest.Server

	mu       sync.Mutex
	pulls    map[int]*fakePull
	statuses []fakeStatus
	comments []fakeComment
	nextID   int64
	revoked  []string
	failing  bool // every repository call answers 502
	users    map[string]User
}

type fakePull struct {
	open    bool
	head    string
	author  User
	labels  []string
	commits []Commit
}

type fakeStatus struct {
	SHA string
	Status
}

type fakeComment struct {
	ID     int64
	Number int
	Body   string
	App    int64
}

func newFakeGitHub(t *testing.T) *fakeGitHub {
	f := &fakeGitHub{t: t, pulls: map[int]*fakePull{}, nextID: 100, users: map[string]User{"ann": ann, "bob": bob}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeGitHub) client() *GitHub {
	return &GitHub{AppID: testAppID, ClientID: testClientID, ClientSecret: testSecret, Key: testKey,
		API: f.srv.URL, Web: f.srv.URL, HTTP: f.srv.Client()}
}

// checkJWT verifies an App's token: RS256 under the test key's public half,
// issued by the client ID, unexpired.
func (f *fakeGitHub) checkJWT(r *http.Request) bool {
	tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok {
		return false
	}
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return false
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if rsa.VerifyPKCS1v15(&testKey.PublicKey, crypto.SHA256, sum[:], sig) != nil {
		return false
	}
	raw, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var c struct {
		Iat, Exp int64
		Iss      string
	}
	if json.Unmarshal(raw, &c) != nil || c.Iss != testClientID || time.Now().Unix() >= c.Exp || c.Exp-c.Iat > 600 {
		return false
	}
	return true
}

func writeJSONT(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func userJSON(u *User) any {
	if u == nil {
		return nil
	}
	return map[string]any{"id": u.ID, "login": u.Login, "type": u.Type}
}

func (f *fakeGitHub) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	path := r.URL.Path
	appCall := strings.HasPrefix(path, "/app/") || strings.HasSuffix(path, "/installation")
	switch {
	case appCall && !f.checkJWT(r):
		writeJSONT(w, 401, map[string]string{"message": "A JSON web token could not be decoded"})
		return
	case path == "/repos/o/r/installation":
		writeJSONT(w, 200, map[string]any{"id": 1})
		return
	case strings.HasSuffix(path, "/installation"):
		writeJSONT(w, 404, map[string]string{"message": "Not Found"})
		return
	case path == "/app/installations":
		writeJSONT(w, 200, []map[string]any{{"id": 1}})
		return
	case path == "/app/installations/1/access_tokens" && r.Method == http.MethodPost:
		writeJSONT(w, 201, map[string]any{"token": "inst-token", "expires_at": time.Now().Add(time.Hour)})
		return
	case path == "/login/oauth/access_token":
		r.ParseForm()
		if r.PostForm.Get("code") != "good" || r.PostForm.Get("client_secret") != testSecret {
			writeJSONT(w, 200, map[string]string{"error": "bad_verification_code"})
			return
		}
		writeJSONT(w, 200, map[string]string{"access_token": "user-token"})
		return
	case path == "/user":
		if r.Header.Get("Authorization") != "Bearer user-token" {
			writeJSONT(w, 401, map[string]string{"message": "Bad credentials"})
			return
		}
		writeJSONT(w, 200, userJSON(&ann))
		return
	case path == "/applications/"+testClientID+"/token" && r.Method == http.MethodDelete:
		var b struct {
			AccessToken string `json:"access_token"`
		}
		json.NewDecoder(r.Body).Decode(&b)
		if u, p, ok := r.BasicAuth(); ok && u == testClientID && p == testSecret {
			f.revoked = append(f.revoked, b.AccessToken)
		}
		w.WriteHeader(204)
		return
	case strings.HasPrefix(path, "/users/"):
		u, ok := f.users[strings.TrimPrefix(path, "/users/")]
		if !ok {
			writeJSONT(w, 404, map[string]string{"message": "Not Found"})
			return
		}
		writeJSONT(w, 200, userJSON(&u))
		return
	}
	// The installation's calls.
	if r.Header.Get("Authorization") != "Bearer inst-token" {
		writeJSONT(w, 401, map[string]string{"message": "Bad credentials"})
		return
	}
	if f.failing {
		writeJSONT(w, 502, map[string]string{"message": "Server Error"})
		return
	}
	if path == "/installation/repositories" {
		writeJSONT(w, 200, map[string]any{"repositories": []map[string]string{{"full_name": "o/r"}}})
		return
	}
	rest, ok := strings.CutPrefix(path, "/repos/o/r/")
	if !ok {
		writeJSONT(w, 404, map[string]string{"message": "Not Found"})
		return
	}
	seg := strings.Split(rest, "/")
	switch {
	case rest == "pulls" && r.Method == http.MethodGet:
		var out []map[string]int
		for n, p := range f.pulls {
			if p.open {
				out = append(out, map[string]int{"number": n})
			}
		}
		writeJSONT(w, 200, out)
	case seg[0] == "pulls" && len(seg) == 2:
		n, _ := strconv.Atoi(seg[1])
		p, ok := f.pulls[n]
		if !ok {
			writeJSONT(w, 404, map[string]string{"message": "Not Found"})
			return
		}
		state := "closed"
		if p.open {
			state = "open"
		}
		var labels []map[string]string
		for _, l := range p.labels {
			labels = append(labels, map[string]string{"name": l})
		}
		writeJSONT(w, 200, map[string]any{
			"state": state, "head": map[string]string{"sha": p.head}, "user": userJSON(&p.author), "labels": labels,
			"base": map[string]any{"repo": map[string]any{"owner": userJSON(&theOwner)}}, "commits": len(p.commits),
		})
	case seg[0] == "pulls" && len(seg) == 3 && seg[2] == "commits":
		n, _ := strconv.Atoi(seg[1])
		p := f.pulls[n]
		var out []map[string]any
		for _, c := range p.commits {
			out = append(out, map[string]any{
				"sha": c.SHA,
				"commit": map[string]any{
					"author":    map[string]string{"name": c.Author.Name, "email": c.Author.Email},
					"committer": map[string]string{"name": c.Committer.Name, "email": c.Committer.Email},
					"message":   c.Message,
				},
				"author": userJSON(c.Author.User), "committer": userJSON(c.Committer.User),
			})
		}
		writeJSONT(w, 200, out)
	case seg[0] == "statuses" && r.Method == http.MethodPost:
		var s Status
		json.NewDecoder(r.Body).Decode(&s)
		f.statuses = append(f.statuses, fakeStatus{SHA: seg[1], Status: s})
		writeJSONT(w, 201, map[string]any{})
	case seg[0] == "issues" && len(seg) == 3 && seg[2] == "comments":
		n, _ := strconv.Atoi(seg[1])
		if r.Method == http.MethodPost {
			var b struct{ Body string }
			json.NewDecoder(r.Body).Decode(&b)
			f.nextID++
			f.comments = append(f.comments, fakeComment{ID: f.nextID, Number: n, Body: b.Body, App: testAppID})
			writeJSONT(w, 201, map[string]any{"id": f.nextID})
			return
		}
		var out []map[string]any
		for _, c := range f.comments {
			if c.Number == n {
				out = append(out, map[string]any{"id": c.ID, "body": c.Body, "performed_via_github_app": map[string]any{"id": c.App}})
			}
		}
		writeJSONT(w, 200, out)
	case seg[0] == "issues" && len(seg) == 3 && seg[1] == "comments" && r.Method == http.MethodPatch:
		id, _ := strconv.ParseInt(seg[2], 10, 64)
		var b struct{ Body string }
		json.NewDecoder(r.Body).Decode(&b)
		for i := range f.comments {
			if f.comments[i].ID == id {
				f.comments[i].Body = b.Body
			}
		}
		writeJSONT(w, 200, map[string]any{})
	default:
		writeJSONT(w, 404, map[string]string{"message": "Not Found: " + r.Method + " " + path})
	}
}

func (f *fakeGitHub) last() fakeStatus {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.statuses) == 0 {
		f.t.Fatal("no status was set")
	}
	return f.statuses[len(f.statuses)-1]
}

func (f *fakeGitHub) commentsOn(n int) []fakeComment {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []fakeComment
	for _, c := range f.comments {
		if c.Number == n {
			out = append(out, c)
		}
	}
	return out
}

// memStore is the keeper's store in memory.
type memStore struct {
	mu      sync.Mutex
	sigs    []store.Signature
	waiting map[store.PullRef]map[int64]bool
	broken  bool
}

func newMemStore() *memStore { return &memStore{waiting: map[store.PullRef]map[int64]bool{}} }

var errBroken = fmt.Errorf("the database is down")

func (m *memStore) Ready(context.Context) error {
	if m.broken {
		return errBroken
	}
	return nil
}

func (m *memStore) Signed(_ context.Context, ids []int64, version int) (map[int64]bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.broken {
		return nil, errBroken
	}
	out := map[int64]bool{}
	for _, s := range m.sigs {
		if s.Version == version && s.Voided.IsZero() && slices.Contains(ids, s.GitHubID) {
			out[s.GitHubID] = true
		}
	}
	return out, nil
}

func (m *memStore) Sign(_ context.Context, s store.Signature) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, o := range m.sigs {
		if o.GitHubID == s.GitHubID && o.Version == s.Version && o.Voided.IsZero() {
			return false, nil
		}
	}
	s.ID = store.AccountID{byte(len(m.sigs) + 1)}
	s.SignedAt = time.Now()
	m.sigs = append(m.sigs, s)
	return true, nil
}

func (m *memStore) SignaturesOf(_ context.Context, id int64) ([]store.Signature, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []store.Signature
	for _, s := range m.sigs {
		if s.GitHubID == id && s.Voided.IsZero() {
			out = append(out, s)
		}
	}
	return out, nil
}

func (m *memStore) Signatures(context.Context) ([]store.Signature, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return slices.Clone(m.sigs), nil
}

func (m *memStore) Void(_ context.Context, id store.AccountID, reason string) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.sigs {
		if m.sigs[i].ID == id && m.sigs[i].Voided.IsZero() {
			m.sigs[i].Voided, m.sigs[i].VoidReason = time.Now(), reason
			return m.sigs[i].GitHubID, nil
		}
	}
	return 0, store.ErrNotFound
}

func (m *memStore) WaitingFor(_ context.Context, id int64) ([]store.PullRef, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []store.PullRef
	for pr, ids := range m.waiting {
		if ids[id] {
			out = append(out, pr)
		}
	}
	return out, nil
}

func (m *memStore) Waiting(context.Context) ([]store.PullRef, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []store.PullRef
	for pr := range m.waiting {
		out = append(out, pr)
	}
	return out, nil
}

func (m *memStore) SetWaiting(_ context.Context, pr store.PullRef, _ string, ids []int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.broken {
		return errBroken
	}
	delete(m.waiting, pr)
	if len(ids) > 0 {
		m.waiting[pr] = map[int64]bool{}
		for _, id := range ids {
			m.waiting[pr][id] = true
		}
	}
	return nil
}

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// drain runs the checker until its queue is empty.
func drain(t *testing.T, c *Checker) {
	t.Helper()
	for range 100 {
		pr, ok, _ := c.next()
		if !ok {
			return
		}
		if err := c.Check(context.Background(), pr); err != nil {
			t.Logf("check %s: %v", String(pr), err)
		}
	}
	t.Fatal("the queue never emptied")
}
