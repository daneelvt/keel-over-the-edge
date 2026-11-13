// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"context"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/logbook"
	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
	"github.com/daneelvt/keel-over-the-edge/internal/news"
	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// fakeNews is the news of a day, as one reader is answered.
type fakeNews struct {
	readers []store.AccountID
}

var newsDay = time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC)

func (f *fakeNews) ParseDay(text string) (time.Time, error) {
	if text == "" || text == "2026-11-12" {
		return newsDay, nil
	}
	return time.Time{}, news.ErrNoEdition
}

func (f *fakeNews) Edition(_ context.Context, reader store.AccountID, day time.Time) (news.Edition, error) {
	f.readers = append(f.readers, reader)
	x, y := 10.0, 20.0
	return news.Edition{World: 3, Day: "2026-11-12", Number: 4, Zone: "America/New_York", FiguresText: "A quiet day on the water.",
		Stories: []news.Story{{ID: "01", Kind: store.StoryGreat, Head: "KEYHOLE ROCK", Text: "An island of the rim, first sighted by {0}.",
			Names: []news.Name{{Kind: news.NameHuman, Name: "Ann Bonny", Logged: true}}, Subject: "island", Number: 7, X: &x, Y: &y}},
		Lead: []news.Story{}, Shipmates: []news.Story{}, Notices: []news.Notice{}, Days: []news.DayRef{{Day: "2026-11-12", Number: 4}}}, nil
}

func (f *fakeNews) About(_ context.Context, reader store.AccountID, name string, limit int) ([]news.Story, error) {
	if name != "Ann Bonny" {
		return []news.Story{}, nil
	}
	return []news.Story{{ID: "01", Kind: store.StoryGreat, Head: "KEYHOLE ROCK", Text: "{0}.", Names: []news.Name{{Kind: news.NameHuman, Name: "Ann Bonny"}}}}, nil
}

func (f *fakeNews) AboutAccount(context.Context, store.AccountID, store.AccountID, int) ([]news.Story, error) {
	return []news.Story{}, nil
}

// TestNewsBehindSession: the news answers only a signed-in sailor, each
// as themselves, kept by no cache but their own browser's 5 s; a day with
// no edition is not found; and the stories naming a sailor are asked by
// name.
func TestNewsBehindSession(t *testing.T) {
	src := &fakeNews{}
	srv := newAboardServer(t, func(c *Config) { c.News = src })
	for _, q := range []string{"", "?day=2026-11-12", "?name=Ann+Bonny"} {
		res, err := http.Get(srv.URL + "/api/news" + q)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("the news%s without a session: %d", q, res.StatusCode)
		}
	}
	if len(src.readers) != 0 {
		t.Fatalf("read without a session: %v", src.readers)
	}
	ann, cookie := makeSailor(t, srv.testServer, "Ann Bonny")
	req, _ := http.NewRequest("GET", srv.URL+"/api/news", nil)
	req.AddCookie(cookie)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var e news.Edition
	err = json.NewDecoder(res.Body).Decode(&e)
	res.Body.Close()
	if err != nil || res.StatusCode != 200 || res.Header.Get("Cache-Control") != "private, max-age=5" {
		t.Fatalf("the news: %d %q %v", res.StatusCode, res.Header.Get("Cache-Control"), err)
	}
	if e.Number != 4 || len(e.Stories) != 1 || e.Stories[0].Names[0].Name != "Ann Bonny" || *e.Stories[0].X != 10 || e.Stories[0].Subject != "island" {
		t.Errorf("the edition %+v", e)
	}
	if len(src.readers) != 1 || src.readers[0] != srv.idOf(t, "Ann Bonny") {
		t.Errorf("read for %v", src.readers)
	}
	if status, body := ann.do("GET", "/api/news?day=2026-11-01", ""); status != 404 || body != `{"error":"not-found"}` {
		t.Errorf("a day with no edition: %d %s", status, body)
	}
	if status, body := ann.do("GET", "/api/news?name=Ann+Bonny", ""); status != 200 || !strings.Contains(body, `"head":"KEYHOLE ROCK"`) {
		t.Errorf("about Ann: %d %s", status, body)
	}
	if status, body := ann.do("GET", "/api/news?name=Nobody", ""); status != 200 || strings.TrimSpace(body) != `{"stories":[]}` {
		t.Errorf("about nobody: %d %s", status, body)
	}
}

// TestOpenRoutes: every route the game serves without a session is in
// openRoutes with its reason, or is the sign-in service's own; a new one
// fails here, so opening a route is always a decision made in review.
// Routes are found in the package's source: each registered with a
// handler not wrapped in auth.Required (required) or auth.Signed
// (signed) answers without a session.
func TestOpenRoutes(t *testing.T) {
	fset := token.NewFileSet()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	var files []*ast.File
	for _, e := range entries {
		n := e.Name()
		if !strings.HasSuffix(n, ".go") || strings.HasSuffix(n, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, n, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		files = append(files, f)
	}
	consts := map[string]string{}
	for _, f := range files {
		for _, d := range f.Decls {
			g, ok := d.(*ast.GenDecl)
			if !ok || g.Tok != token.CONST {
				continue
			}
			for _, sp := range g.Specs {
				vs := sp.(*ast.ValueSpec)
				for i, name := range vs.Names {
					if i < len(vs.Values) {
						if lit, ok := vs.Values[i].(*ast.BasicLit); ok && lit.Kind == token.STRING {
							consts[name.Name], _ = strconv.Unquote(lit.Value)
						}
					}
				}
			}
		}
	}
	open, closed := map[string]bool{}, map[string]bool{}
	for _, f := range files {
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || len(call.Args) != 2 {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != "Handle" && sel.Sel.Name != "HandleFunc" {
				return true
			}
			if x, ok := sel.X.(*ast.Ident); !ok || x.Name != "mux" {
				return true
			}
			var pattern string
			switch a := call.Args[0].(type) {
			case *ast.BasicLit:
				pattern, _ = strconv.Unquote(a.Value)
			case *ast.Ident:
				pattern = consts[a.Name]
			}
			if pattern == "" {
				t.Errorf("%s: a route whose pattern is not a constant", fset.Position(call.Pos()))
				return true
			}
			if c, ok := call.Args[1].(*ast.CallExpr); ok {
				if id, ok := c.Fun.(*ast.Ident); ok && (id.Name == "required" || id.Name == "signed") {
					closed[pattern] = true
					return true
				}
			}
			open[pattern] = true
			return true
		})
	}
	if len(closed) < 40 {
		t.Fatalf("only %d routes behind a session found: the search has lost them", len(closed))
	}
	var found []string
	for p := range open {
		found = append(found, p)
		if openRoutes[p] == "" {
			t.Errorf("%s answers without a session, and openRoutes has no reason for it: close it, or give the reason", p)
		}
	}
	for p, why := range openRoutes {
		if !open[p] {
			t.Errorf("openRoutes has %s (%s), which is not registered open", p, why)
		}
	}
	for p := range sessionless {
		if openRoutes[p] == "" {
			t.Errorf("%s reads no session, and is not an open route", p)
		}
	}
	for p := range pageRoutes {
		if openRoutes[p] == "" {
			t.Errorf("the page's %s is not an open route", p)
		}
	}
	if open[newsRoute] || !closed[newsRoute] {
		t.Error("the news answers without a session")
	}
	if len(oauth.Routes) == 0 {
		t.Error("the sign-in service has no routes")
	}
	slices.Sort(found)
	t.Logf("open routes: %s, and the sign-in service's %d", strings.Join(found, ", "), len(oauth.Routes))
}

// TestLogCarriesItsNews: a log's answer carries this world's stories
// naming its sailor, as the reader may read them.
func TestLogCarriesItsNews(t *testing.T) {
	srv := newAboardServer(t, func(c *Config) {
		c.Logs = logbook.NewService(logbook.ServiceConfig{Store: c.Sailing.(*sailing).Store, Key: moderation.Key})
		c.News = &fakeNews{}
	})
	ann, _ := makeSailor(t, srv.testServer, "Ann Bonny")
	bob, _ := makeSailor(t, srv.testServer, "Bob Read")
	var l struct {
		Name string       `json:"name"`
		News []news.Story `json:"news"`
	}
	status, body := bob.do("GET", "/api/log?name=Ann+Bonny", "")
	if status != 200 || json.Unmarshal([]byte(body), &l) != nil || l.Name != "Ann Bonny" || len(l.News) != 1 || l.News[0].Head != "KEYHOLE ROCK" {
		t.Errorf("Ann's log to Bob: %d %s", status, body)
	}
	if status, body := ann.do("GET", "/api/me/log", ""); status != 200 || !strings.Contains(body, `"news":[]`) {
		t.Errorf("Ann's own log: %d %s", status, body)
	}
}
