// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"io"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	dto "github.com/prometheus/client_model/go"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// report sends a page's report with the cookie, none for none: the
// answer's status and body.
func report(t *testing.T, srv *testServer, cookie *http.Cookie, body string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", srv.URL+"/api/client-report", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, strings.TrimSpace(string(b))
}

// startups is how many start-ups were observed at a stage, for a visit.
func startups(t *testing.T, srv *testServer, stage, visit string) uint64 {
	t.Helper()
	var m dto.Metric
	if err := srv.metrics.ClientStartup.WithLabelValues(stage, visit).(prometheus.Metric).Write(&m); err != nil {
		t.Fatal(err)
	}
	return m.GetHistogram().GetSampleCount()
}

var accountInLog = regexp.MustCompile(`"account":"([^"]+)"`)

// TestClientReports: the page's reports need a session; an error is
// counted by its build and logged with its message cut before anything
// quoted, and a start-up's stages and bytes are observed by visit; a body
// over 8 KB, malformed or out of bounds is refused; a session sends ten a
// minute at most; and nothing the route logs names the account.
func TestClientReports(t *testing.T) {
	st, _ := storetest.Store(t, store.Options{})
	srv := newTestServer(t, st, nil)
	_, cookie := makeSailor(t, srv, "Ann Bonny")
	// The account's id, as the access log names it for another route.
	if status, _ := get(t, http.DefaultClient, srv.URL+"/api/me", cookie); status != 200 {
		t.Fatalf("me: %d", status)
	}
	found := accountInLog.FindAllStringSubmatch(srv.logs.String(), -1)
	if len(found) == 0 {
		t.Fatal("no account in the access log")
	}
	account := found[len(found)-1][1]
	before := len(srv.logs.String())

	errorReport := `{"build":"abc123","kind":"error","message":"Cannot read properties of undefined (reading 'Ann Bonny')","stack":"index-Bx1.js:12:345\nchart-9a.js:4:5"}`
	if status, _ := report(t, srv, nil, errorReport); status != 401 {
		t.Errorf("without a session: %d", status)
	}
	if status, body := report(t, srv, cookie, errorReport); status != 204 {
		t.Fatalf("an error: %d %s", status, body)
	}
	if n := testutil.ToFloat64(srv.metrics.ClientErrors.WithLabelValues("abc123")); n != 1 {
		t.Errorf("errors of build abc123: %v", n)
	}
	startup := `{"build":"abc123","kind":"startup","stages":{"shell":180,"cover":240,"start":1900,"tap":5200,"reveal":7400},"bytes":2400000,"visit":"first","tier":2}`
	if status, body := report(t, srv, cookie, startup); status != 204 {
		t.Fatalf("a start-up: %d %s", status, body)
	}
	for _, stage := range stageNames {
		if n := startups(t, srv, stage, "first"); n != 1 {
			t.Errorf("stage %s: %d observed", stage, n)
		}
	}
	// A return the worker served, straight to sea: no start screen to tap.
	if status, _ := report(t, srv, cookie, `{"build":"abc123","kind":"startup","stages":{"shell":20,"cover":60,"reveal":1500},"bytes":40000,"visit":"worker","tier":3}`); status != 204 {
		t.Fatalf("a return: %d", status)
	}
	if startups(t, srv, "reveal", "worker") != 1 || startups(t, srv, "tap", "worker") != 0 {
		t.Error("a return's stages")
	}
	if n := testutil.CollectAndCount(srv.metrics.ClientStartupBytes); n != len(visitNames) {
		t.Errorf("the bytes' series: %d", n)
	}

	for name, body := range map[string]string{
		"not JSON":          `{"build":"abc123","kind":"error",`,
		"an unknown member": `{"build":"abc123","kind":"error","message":"x","name":"Ann Bonny"}`,
		"an unknown kind":   `{"build":"abc123","kind":"chat","message":"x"}`,
		"no build":          `{"kind":"error","message":"x"}`,
		"a build of spaces": `{"build":"a b","kind":"error","message":"x"}`,
		"a long message":    `{"build":"abc123","kind":"error","message":"` + strings.Repeat("x", 301) + `"}`,
		"a stack with text": `{"build":"abc123","kind":"error","message":"x","stack":"at Ann (index.js:1:2)"}`,
		"an unknown stage":  `{"build":"abc123","kind":"startup","stages":{"lunch":1},"visit":"first"}`,
		"an unknown visit":  `{"build":"abc123","kind":"startup","stages":{"shell":1},"visit":"third"}`,
		"a stage too long":  `{"build":"abc123","kind":"startup","stages":{"shell":600001},"visit":"first"}`,
	} {
		if status, _ := report(t, srv, cookie, body); status != 400 {
			t.Errorf("%s: %d", name, status)
		}
	}
	big := `{"build":"abc123","kind":"error","message":"x","stack":"` + strings.Repeat("a", 8<<10) + `"}`
	if status, _ := report(t, srv, cookie, big); status != 413 {
		t.Errorf("over 8 KB: %d", status)
	}

	// Three sent so far in the minute: seven more, then refused.
	for i := range 7 {
		if status, _ := report(t, srv, cookie, `{"build":"abc123","kind":"error","message":"again"}`); status != 204 {
			t.Fatalf("report %d of the minute: %d", i+4, status)
		}
	}
	if status, body := report(t, srv, cookie, `{"build":"abc123","kind":"error","message":"again"}`); status != 429 || !strings.Contains(body, "often") {
		t.Errorf("the eleventh in a minute: %d %s", status, body)
	}
	if n := testutil.ToFloat64(srv.metrics.ClientErrors.WithLabelValues("abc123")); n != 8 {
		t.Errorf("errors counted: %v", n)
	}

	logs := srv.logs.String()[before:]
	if strings.Contains(logs, account) {
		t.Errorf("the account in the log:\n%s", logs)
	}
	if strings.Contains(logs, "Ann Bonny") {
		t.Errorf("quoted words in the log:\n%s", logs)
	}
	if !strings.Contains(logs, `"message":"Cannot read properties of undefined (reading"`) ||
		!strings.Contains(logs, `"stack":"index-Bx1.js:12:345\nchart-9a.js:4:5"`) ||
		!strings.Contains(logs, `"page_build":"abc123"`) || !strings.Contains(logs, `"level":"WARN"`) {
		t.Errorf("the error's line:\n%s", logs)
	}
}

// TestClientReportBuilds: errors are counted under the first eight builds
// named, and under "other" after, so a page cannot make series without end.
func TestClientReportBuilds(t *testing.T) {
	var c clientReports
	m := newTestServer(t, noDatabase{}, nil).metrics
	for i := range reportBuilds + 3 {
		c.errors(m, strings.Repeat("b", i+1)).Inc()
	}
	if n := testutil.CollectAndCount(m.ClientErrors); n != reportBuilds+1 {
		t.Errorf("%d series", n)
	}
	if n := testutil.ToFloat64(m.ClientErrors.WithLabelValues("other")); n != 3 {
		t.Errorf("other: %v", n)
	}
}

// TestCutQuoted: a message is cut before the first quote of any kind.
func TestCutQuoted(t *testing.T) {
	for in, want := range map[string]string{
		"x is not a function":                  "x is not a function",
		`Unexpected token 'A', "Ann" is not`:   "Unexpected token",
		"Failed to fetch “a name”":             "Failed to fetch",
		"`name` missing":                       "",
		"Cannot read properties (reading «x»)": "Cannot read properties (reading",
	} {
		if got := cutQuoted(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}

// TestClientPolicyReports: what a page's policy refused is counted by its
// directive, an unknown one as "other", and logged at info with what was
// refused and the asset that asked; a report with a sample, a query or a
// stack is refused.
func TestClientPolicyReports(t *testing.T) {
	st, _ := storetest.Store(t, store.Options{})
	srv := newTestServer(t, st, nil)
	_, cookie := makeSailor(t, srv, "Mary Read")
	before := len(srv.logs.String())

	worker := `{"build":"abc123","kind":"policy","directive":"worker-src","blocked":"data","source":"index-Bx1.js","line":102}`
	if status, _ := report(t, srv, nil, worker); status != 401 {
		t.Errorf("without a session: %d", status)
	}
	for _, body := range []string{
		worker,
		`{"build":"abc123","kind":"policy","directive":"require-trusted-types-for","blocked":"trusted-types-sink","source":"api.js","line":1}`,
		`{"build":"abc123","kind":"policy","directive":"connect-src","blocked":"https://example.com/a/b.wasm"}`,
		`{"build":"abc123","kind":"policy","directive":"navigate-to","blocked":"https://example.com/"}`,
		`{"build":"abc123","kind":"policy","directive":"style-src-elem","blocked":"inline","line":30}`,
	} {
		if status, msg := report(t, srv, cookie, body); status != 204 {
			t.Fatalf("%s: %d %s", body, status, msg)
		}
	}
	for d, want := range map[string]float64{
		"worker-src": 1, "require-trusted-types-for": 1, "connect-src": 1, "other": 1, "style-src-elem": 1, "img-src": 0,
	} {
		if n := testutil.ToFloat64(srv.metrics.ClientPolicyViolations.WithLabelValues(d)); n != want {
			t.Errorf("%s: %v, want %v", d, n, want)
		}
	}
	if n := testutil.CollectAndCount(srv.metrics.ClientPolicyViolations); n != len(policyDirectives)+1 {
		t.Errorf("%d series", n)
	}
	logs := srv.logs.String()[before:]
	if !strings.Contains(logs, `"msg":"a page's policy"`) || !strings.Contains(logs, `"directive":"worker-src"`) ||
		!strings.Contains(logs, `"blocked":"data"`) || !strings.Contains(logs, `"source":"index-Bx1.js"`) ||
		!strings.Contains(logs, `"line":102`) || !strings.Contains(logs, `"level":"INFO"`) {
		t.Errorf("the policy's line:\n%s", logs)
	}

	for name, body := range map[string]string{
		"a sample":           `{"build":"abc123","kind":"policy","directive":"worker-src","blocked":"data","sample":"data:,"}`,
		"a query":            `{"build":"abc123","kind":"policy","directive":"connect-src","blocked":"https://example.com/a?token=Mary"}`,
		"a fragment":         `{"build":"abc123","kind":"policy","directive":"connect-src","blocked":"https://example.com/a#Mary"}`,
		"words":              `{"build":"abc123","kind":"policy","directive":"connect-src","blocked":"Mary Read"}`,
		"no directive":       `{"build":"abc123","kind":"policy","blocked":"inline"}`,
		"a directive's case": `{"build":"abc123","kind":"policy","directive":"Worker-Src","blocked":"inline"}`,
		"a path as source":   `{"build":"abc123","kind":"policy","directive":"img-src","source":"assets/index.js"}`,
		"a negative line":    `{"build":"abc123","kind":"policy","directive":"img-src","line":-1}`,
		"a message":          `{"build":"abc123","kind":"policy","directive":"img-src","message":"x"}`,
		"a long address":     `{"build":"abc123","kind":"policy","directive":"img-src","blocked":"https://example.com/` + strings.Repeat("a", 300) + `"}`,
	} {
		if status, _ := report(t, srv, cookie, body); status != 400 {
			t.Errorf("%s: %d", name, status)
		}
	}
}
