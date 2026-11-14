// SPDX-License-Identifier: AGPL-3.0-only

package agreement

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// GitHub is a GitHub App's client: the App's own calls, signed by its
// private key, and its installations', with a token per installation; and
// the web flow by which a person signs in through it to say who they are.
// It uses the standard library alone.
type GitHub struct {
	// AppID and ClientID are the App's; ClientSecret is for the sign-in.
	AppID        int64
	ClientID     string
	ClientSecret string
	// Key is the App's private key.
	Key *rsa.PrivateKey
	// API is GitHub's REST API, https://api.github.com; Web is GitHub
	// itself, https://github.com, where people sign in.
	API, Web string
	// HTTP, if not nil, makes the calls.
	HTTP *http.Client
	// Now, if not nil, is the time.
	Now func() time.Time
	// Errors, if not nil, is called for each call GitHub refused or that
	// failed.
	Errors func()

	mu     sync.Mutex
	tokens map[string]installToken // by repository
}

type installToken struct {
	token   string
	expires time.Time
}

// ErrNotInstalled is a repository the App is not installed on.
var ErrNotInstalled = errors.New("the App is not installed on the repository")

// ParseKey reads a GitHub App's private key, PEM: PKCS #1, as GitHub
// gives it, or PKCS #8.
func ParseKey(pemText string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(pemText))
	if block == nil {
		return nil, errors.New("the private key is not PEM")
	}
	if k, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return k, nil
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("the private key: %w", err)
	}
	rk, ok := k.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("the private key is not RSA")
	}
	return rk, nil
}

func (g *GitHub) now() time.Time {
	if g.Now != nil {
		return g.Now()
	}
	return time.Now()
}

func (g *GitHub) client() *http.Client {
	if g.HTTP != nil {
		return g.HTTP
	}
	return http.DefaultClient
}

// JWT is the App's own token, RS256, valid nine minutes from a minute ago
// (GitHub allows ten, and the clocks may differ).
func (g *GitHub) JWT() (string, error) {
	now := g.now()
	enc := base64.RawURLEncoding
	header := enc.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	iss := g.ClientID
	if iss == "" {
		iss = strconv.FormatInt(g.AppID, 10)
	}
	claims, err := json.Marshal(map[string]any{"iat": now.Add(-time.Minute).Unix(), "exp": now.Add(9 * time.Minute).Unix(), "iss": iss})
	if err != nil {
		return "", err
	}
	signing := header + "." + enc.EncodeToString(claims)
	sum := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(nil, g.Key, crypto.SHA256, sum[:])
	if err != nil {
		return "", err
	}
	return signing + "." + enc.EncodeToString(sig), nil
}

// apiError is an answer GitHub refused a call with.
type apiError struct {
	Status  int
	Method  string
	Path    string
	Message string
}

func (e *apiError) Error() string {
	return fmt.Sprintf("GitHub answered %s %s with %d: %s", e.Method, e.Path, e.Status, e.Message)
}

// call makes one REST call with an Authorization header (none if auth is
// ""), the body as JSON, and decodes the answer into out. It answers the
// next page's URL from the Link header, if any.
func (g *GitHub) call(ctx context.Context, method, rawURL, auth string, body, out any) (next string, err error) {
	defer func() {
		if err != nil && g.Errors != nil {
			g.Errors()
		}
	}()
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return "", err
		}
		rd = bytes.NewReader(b)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, rawURL, rd)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "keel-agreement")
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := g.client().Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	if err != nil {
		return "", err
	}
	if res.StatusCode/100 != 2 {
		var e struct{ Message string }
		_ = json.Unmarshal(raw, &e)
		if e.Message == "" {
			e.Message = http.StatusText(res.StatusCode)
		}
		return "", &apiError{Status: res.StatusCode, Method: method, Path: req.URL.Path, Message: e.Message}
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return "", fmt.Errorf("GitHub's answer to %s %s: %w", method, req.URL.Path, err)
		}
	}
	return nextLink(res.Header.Get("Link")), nil
}

// nextLink is the rel="next" URL of a Link header, or "".
func nextLink(h string) string {
	for part := range strings.SplitSeq(h, ",") {
		u, params, ok := strings.Cut(strings.TrimSpace(part), ";")
		if !ok || !strings.Contains(params, `rel="next"`) {
			continue
		}
		return strings.Trim(strings.TrimSpace(u), "<>")
	}
	return ""
}

// token is an installation's token for a repository, made when there is
// none or it ends within five minutes.
func (g *GitHub) token(ctx context.Context, repo string) (string, error) {
	g.mu.Lock()
	t, ok := g.tokens[repo]
	g.mu.Unlock()
	if ok && g.now().Add(5*time.Minute).Before(t.expires) {
		return t.token, nil
	}
	jwt, err := g.JWT()
	if err != nil {
		return "", err
	}
	var inst struct{ ID int64 }
	if _, err := g.call(ctx, http.MethodGet, g.API+"/repos/"+repo+"/installation", "Bearer "+jwt, nil, &inst); err != nil {
		if e := (*apiError)(nil); errors.As(err, &e) && e.Status == http.StatusNotFound {
			return "", fmt.Errorf("%s: %w", repo, ErrNotInstalled)
		}
		return "", err
	}
	var got struct {
		Token     string
		ExpiresAt time.Time `json:"expires_at"`
	}
	path := g.API + "/app/installations/" + strconv.FormatInt(inst.ID, 10) + "/access_tokens"
	if _, err := g.call(ctx, http.MethodPost, path, "Bearer "+jwt, nil, &got); err != nil {
		return "", err
	}
	g.mu.Lock()
	if g.tokens == nil {
		g.tokens = map[string]installToken{}
	}
	g.tokens[repo] = installToken{token: got.Token, expires: got.ExpiresAt}
	g.mu.Unlock()
	return got.Token, nil
}

// repoCall is a call on a repository, with its installation's token. A
// call refused as unauthorized drops the token, so the next is made with
// a new one.
func (g *GitHub) repoCall(ctx context.Context, method, repo, path string, body, out any) (string, error) {
	tok, err := g.token(ctx, repo)
	if err != nil {
		return "", err
	}
	u := path
	if !strings.HasPrefix(path, "https://") && !strings.HasPrefix(path, "http://") {
		u = g.API + "/repos/" + repo + path
	}
	next, err := g.call(ctx, method, u, "Bearer "+tok, body, out)
	if e := (*apiError)(nil); errors.As(err, &e) && e.Status == http.StatusUnauthorized {
		g.mu.Lock()
		delete(g.tokens, repo)
		g.mu.Unlock()
	}
	return next, err
}

// ghUser is an account as GitHub's REST API gives it.
type ghUser struct {
	ID    int64  `json:"id"`
	Login string `json:"login"`
	Type  string `json:"type"`
}

func (u *ghUser) user() *User {
	if u == nil || u.ID == 0 {
		return nil
	}
	return &User{ID: u.ID, Login: u.Login, Type: u.Type}
}

// maxCommits is the most commits GitHub lists of a pull request.
const maxCommits = 250

// Pull reads a pull request, its commits, and its repository's owner.
func (g *GitHub) Pull(ctx context.Context, repo string, number int) (Pull, error) {
	var pr struct {
		State string `json:"state"`
		Head  struct {
			SHA string `json:"sha"`
		} `json:"head"`
		User   ghUser `json:"user"`
		Labels []struct {
			Name string `json:"name"`
		} `json:"labels"`
		Base struct {
			Repo struct {
				Owner ghUser `json:"owner"`
			} `json:"repo"`
		} `json:"base"`
		Commits int `json:"commits"`
	}
	n := strconv.Itoa(number)
	if _, err := g.repoCall(ctx, http.MethodGet, repo, "/pulls/"+n, nil, &pr); err != nil {
		return Pull{}, err
	}
	p := Pull{
		Repo: repo, Number: number, HeadSHA: pr.Head.SHA, Open: pr.State == "open",
		Owner: User{ID: pr.Base.Repo.Owner.ID, Login: pr.Base.Repo.Owner.Login, Type: pr.Base.Repo.Owner.Type},
	}
	// A deleted account opened it: its commits still name who wrote them.
	if u := pr.User.user(); u != nil {
		p.Author = *u
	}
	for _, l := range pr.Labels {
		p.Labels = append(p.Labels, l.Name)
	}
	if !p.Open {
		return p, nil
	}
	path := "/pulls/" + n + "/commits?per_page=100"
	for page := 0; path != "" && page < maxCommits/100+1; page++ {
		var cs []struct {
			SHA    string `json:"sha"`
			Commit struct {
				Author    struct{ Name, Email string } `json:"author"`
				Committer struct{ Name, Email string } `json:"committer"`
				Message   string                       `json:"message"`
			} `json:"commit"`
			Author    *ghUser `json:"author"`
			Committer *ghUser `json:"committer"`
		}
		next, err := g.repoCall(ctx, http.MethodGet, repo, path, nil, &cs)
		if err != nil {
			return Pull{}, err
		}
		for _, c := range cs {
			p.Commits = append(p.Commits, Commit{
				SHA:       c.SHA,
				Author:    Ident{Name: c.Commit.Author.Name, Email: c.Commit.Author.Email, User: c.Author.user()},
				Committer: Ident{Name: c.Commit.Committer.Name, Email: c.Commit.Committer.Email, User: c.Committer.user()},
				Message:   c.Commit.Message,
			})
		}
		path = next
	}
	if pr.Commits > len(p.Commits) {
		return Pull{}, fmt.Errorf("%s#%d has %d commits, more than GitHub lists (%d)", repo, number, pr.Commits, len(p.Commits))
	}
	return p, nil
}

// OpenPulls lists a repository's open pull requests' numbers.
func (g *GitHub) OpenPulls(ctx context.Context, repo string) ([]int, error) {
	var out []int
	path := "/pulls?state=open&per_page=100"
	for page := 0; path != "" && page < 20; page++ {
		var prs []struct {
			Number int `json:"number"`
		}
		next, err := g.repoCall(ctx, http.MethodGet, repo, path, nil, &prs)
		if err != nil {
			return nil, err
		}
		for _, p := range prs {
			out = append(out, p.Number)
		}
		path = next
	}
	return out, nil
}

// Repos lists the repositories the App is installed on, owner/name.
func (g *GitHub) Repos(ctx context.Context) ([]string, error) {
	jwt, err := g.JWT()
	if err != nil {
		return nil, err
	}
	var insts []struct {
		ID int64 `json:"id"`
	}
	if _, err := g.call(ctx, http.MethodGet, g.API+"/app/installations?per_page=100", "Bearer "+jwt, nil, &insts); err != nil {
		return nil, err
	}
	var repos []string
	for _, inst := range insts {
		var tok struct{ Token string }
		path := g.API + "/app/installations/" + strconv.FormatInt(inst.ID, 10) + "/access_tokens"
		if _, err := g.call(ctx, http.MethodPost, path, "Bearer "+jwt, nil, &tok); err != nil {
			return nil, err
		}
		next := g.API + "/installation/repositories?per_page=100"
		for page := 0; next != "" && page < 10; page++ {
			var got struct {
				Repositories []struct {
					FullName string `json:"full_name"`
				} `json:"repositories"`
			}
			n, err := g.call(ctx, http.MethodGet, next, "Bearer "+tok.Token, nil, &got)
			if err != nil {
				return nil, err
			}
			for _, r := range got.Repositories {
				repos = append(repos, r.FullName)
			}
			next = n
		}
	}
	return repos, nil
}

// Status sets a commit's status of a context.
func (g *GitHub) Status(ctx context.Context, repo, sha string, s Status) error {
	_, err := g.repoCall(ctx, http.MethodPost, repo, "/statuses/"+sha, s, nil)
	return err
}

// Comment is one of the App's comments on a pull request.
type Comment struct {
	ID   int64
	Body string
}

// FindComment finds the App's comment on a pull request carrying marker.
func (g *GitHub) FindComment(ctx context.Context, repo string, number int, marker string) (Comment, bool, error) {
	path := "/issues/" + strconv.Itoa(number) + "/comments?per_page=100"
	for page := 0; path != "" && page < 30; page++ {
		var cs []struct {
			ID   int64  `json:"id"`
			Body string `json:"body"`
			App  *struct {
				ID int64 `json:"id"`
			} `json:"performed_via_github_app"`
		}
		next, err := g.repoCall(ctx, http.MethodGet, repo, path, nil, &cs)
		if err != nil {
			return Comment{}, false, err
		}
		for _, c := range cs {
			if c.App != nil && c.App.ID == g.AppID && strings.Contains(c.Body, marker) {
				return Comment{ID: c.ID, Body: c.Body}, true, nil
			}
		}
		path = next
	}
	return Comment{}, false, nil
}

// AddComment comments on a pull request.
func (g *GitHub) AddComment(ctx context.Context, repo string, number int, body string) error {
	_, err := g.repoCall(ctx, http.MethodPost, repo, "/issues/"+strconv.Itoa(number)+"/comments", map[string]string{"body": body}, nil)
	return err
}

// EditComment changes a comment.
func (g *GitHub) EditComment(ctx context.Context, repo string, id int64, body string) error {
	_, err := g.repoCall(ctx, http.MethodPatch, repo, "/issues/comments/"+strconv.FormatInt(id, 10), map[string]string{"body": body}, nil)
	return err
}

// UserByLogin finds an account by its name, for the owner entering a
// signature by hand.
func (g *GitHub) UserByLogin(ctx context.Context, login string) (User, error) {
	var u ghUser
	if _, err := g.call(ctx, http.MethodGet, g.API+"/users/"+url.PathEscape(login), "", nil, &u); err != nil {
		return User{}, err
	}
	return User(u), nil
}

// AuthorizeURL is where a person is sent to sign in through the App.
func (g *GitHub) AuthorizeURL(state, redirect string) string {
	q := url.Values{"client_id": {g.ClientID}, "redirect_uri": {redirect}, "state": {state}, "allow_signup": {"false"}}
	return g.Web + "/login/oauth/authorize?" + q.Encode()
}

// SignedIn exchanges a sign-in's code for the person's account. The token
// it is given is used once, to ask who they are, and revoked at once: the
// App keeps no access to anyone's account.
func (g *GitHub) SignedIn(ctx context.Context, code, redirect string) (User, error) {
	form := url.Values{"client_id": {g.ClientID}, "client_secret": {g.ClientSecret}, "code": {code}, "redirect_uri": {redirect}}
	ctx2, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx2, http.MethodPost, g.Web+"/login/oauth/access_token", strings.NewReader(form.Encode()))
	if err != nil {
		return User{}, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", "keel-agreement")
	res, err := g.client().Do(req)
	if err != nil {
		g.failed()
		return User{}, err
	}
	defer res.Body.Close()
	var tok struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
		Description string `json:"error_description"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&tok); err != nil || res.StatusCode != http.StatusOK {
		g.failed()
		return User{}, fmt.Errorf("GitHub's sign-in answered %d: %v", res.StatusCode, err)
	}
	if tok.AccessToken == "" {
		return User{}, fmt.Errorf("GitHub's sign-in: %s %s", tok.Error, tok.Description)
	}
	defer g.revoke(context.WithoutCancel(ctx), tok.AccessToken)
	var u ghUser
	if _, err := g.call(ctx, http.MethodGet, g.API+"/user", "Bearer "+tok.AccessToken, nil, &u); err != nil {
		return User{}, err
	}
	if u.ID == 0 {
		return User{}, errors.New("GitHub's sign-in named no account")
	}
	return User(u), nil
}

func (g *GitHub) failed() {
	if g.Errors != nil {
		g.Errors()
	}
}

// revoke revokes a person's token, best effort.
func (g *GitHub) revoke(ctx context.Context, token string) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	b, _ := json.Marshal(map[string]string{"access_token": token})
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, g.API+"/applications/"+url.PathEscape(g.ClientID)+"/token", bytes.NewReader(b))
	if err != nil {
		return
	}
	req.SetBasicAuth(g.ClientID, g.ClientSecret)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "keel-agreement")
	req.Header.Set("Content-Type", "application/json")
	if res, err := g.client().Do(req); err == nil {
		res.Body.Close()
	}
}
