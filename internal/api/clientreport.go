// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"net/http"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
)

// The page's own reports, POST /api/client-report: an error it met, how
// long its start took, or what its policy refused (policy.go). Only a page with a session sends them; it holds
// them until it has one. Each is counted, and an error logged at warn with
// its build, its message and its stack; nothing names the account, not
// even the access log's line. The page sends no player's words: a message
// is cut before anything quoted, and a stack is asset names and line
// numbers only. The server cuts again, and holds every field to its
// length.

// clientReportRoute is the route the page sends its reports to.
const clientReportRoute = "POST /api/client-report"

// The limits on a report.
const (
	// ReportBodyLimit is the largest report.
	ReportBodyLimit = 8 << 10
	// ReportLimit is how many reports a session may send in ReportWindow.
	ReportLimit  = 10
	ReportWindow = time.Minute
	// reportMessage and reportStack are the longest message, in
	// characters, and stack, in bytes.
	reportMessage = 300
	reportStack   = 2 << 10
	// reportBuilds is how many builds the errors are counted under by
	// name; any after is "other". A process serves one build, and pages of
	// the one before it for a while.
	reportBuilds = 8
	// reportLongest is the longest a stage may be, in ms, and
	// reportMostBytes the most bytes a start may have fetched.
	reportLongest   = 10 * 60 * 1000
	reportMostBytes = 1 << 30
)

// stageNames are the start-up's stages, in their order.
var stageNames = []string{"shell", "cover", "start", "tap", "reveal"}

// visitNames are the kinds of visit: the page's files not in this
// browser before; in it, from the browser's cache; or served by the
// service worker.
var visitNames = []string{"first", "return", "worker"}

// clientReport is a report as the page sends it.
type clientReport struct {
	Build string `json:"build"`
	Kind  string `json:"kind"`
	// An error's.
	Message string `json:"message,omitzero"`
	Stack   string `json:"stack,omitzero"`
	// A start's: each stage's ms from the navigation's start, 0 for one
	// the page did not pass through; the bytes fetched to the reveal; the
	// visit; the tier it draws at.
	Stages map[string]int64 `json:"stages,omitzero"`
	Bytes  int64            `json:"bytes,omitzero"`
	Visit  string           `json:"visit,omitzero"`
	Tier   int              `json:"tier,omitzero"`
	// A policy's: the directive that refused, or would have refused as a
	// report; what it refused, an address's origin and path or a word
	// for what has none (inline, eval, trusted-types-sink); and the
	// asset and line that asked. Never a sample of what was refused.
	Directive string `json:"directive,omitzero"`
	Blocked   string `json:"blocked,omitzero"`
	Source    string `json:"source,omitzero"`
	Line      int    `json:"line,omitzero"`
}

// buildPattern is what a build may be: the image's BUILD, or "dev"; and
// stackPattern what a stack may hold: asset names and line numbers.
var (
	buildPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
	stackPattern = regexp.MustCompile(`^[A-Za-z0-9._:\n-]*$`)
	// A policy report's directive, what it refused (an address with no
	// query or fragment, or a word), and the asset that asked.
	directivePattern = regexp.MustCompile(`^[a-z-]{1,40}$`)
	blockedPattern   = regexp.MustCompile(`^[A-Za-z0-9._~:/%@+!$&()*,;=-]{0,300}$`)
	sourcePattern    = regexp.MustCompile(`^[A-Za-z0-9._-]{0,128}$`)
)

// policyDirectives are the directives counted by name; any other is
// "other". The pages' policies name these, and a browser reports the one
// that refused, which may be more particular than the policy's own
// (script-src-elem where the policy says script-src).
var policyDirectives = []string{
	"default-src", "script-src", "script-src-elem", "script-src-attr", "worker-src", "connect-src",
	"img-src", "style-src", "style-src-elem", "style-src-attr", "font-src", "manifest-src", "media-src",
	"frame-src", "child-src", "object-src", "frame-ancestors", "base-uri", "form-action",
	"require-trusted-types-for", "trusted-types",
}

// reportLongestLine is the latest line a policy report may name.
const reportLongestLine = 10_000_000

// clientReports are the route's limits and counts, in memory.
type clientReports struct {
	mu     sync.Mutex
	times  map[[32]byte][]time.Time
	swept  time.Time
	builds map[string]prometheus.Counter
}

// allow reports whether the session may send a report at now, and counts
// it if it may.
func (c *clientReports) allow(session [32]byte, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.times == nil {
		c.times = map[[32]byte][]time.Time{}
	}
	since := now.Add(-ReportWindow)
	if now.Sub(c.swept) > ReportWindow {
		for k, ts := range c.times {
			if !ts[len(ts)-1].After(since) {
				delete(c.times, k)
			}
		}
		c.swept = now
	}
	ts := c.times[session]
	i := 0
	for i < len(ts) && !ts[i].After(since) {
		i++
	}
	ts = ts[i:]
	if len(ts) >= ReportLimit {
		c.times[session] = ts
		return false
	}
	c.times[session] = append(ts, now)
	return true
}

// errors is the errors' counter for a build: by its name for the first
// reportBuilds, "other" after.
func (c *clientReports) errors(m *obs.Metrics, build string) prometheus.Counter {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.builds == nil {
		c.builds = map[string]prometheus.Counter{}
	}
	if e, ok := c.builds[build]; ok {
		return e
	}
	if len(c.builds) >= reportBuilds {
		return m.ClientErrors.WithLabelValues("other")
	}
	e := m.ClientErrors.WithLabelValues(build)
	c.builds[build] = e
	return e
}

// clientReport takes a report from the page.
func (a *api) clientReport(w http.ResponseWriter, r *http.Request) {
	// The access log names no account for a report.
	obs.SetAccount(r.Context(), "")
	s, _ := auth.SessionFromContext(r.Context())
	r.Body = http.MaxBytesReader(w, r.Body, ReportBodyLimit)
	var in clientReport
	if !readJSON(w, r, &in) {
		return
	}
	if !in.valid() {
		writeError(w, http.StatusBadRequest, "malformed")
		return
	}
	if !a.reports.allow(s.Hash, time.Now()) {
		writeError(w, http.StatusTooManyRequests, "often")
		return
	}
	m := a.cfg.Metrics
	switch in.Kind {
	case "error":
		a.reports.errors(m, in.Build).Inc()
		a.cfg.Log.Warn("a page's error", "page_build", in.Build, "message", cutQuoted(in.Message), "stack", in.Stack)
	case "startup":
		for _, st := range stageNames {
			if ms := in.Stages[st]; ms > 0 {
				m.ClientStartup.WithLabelValues(st, in.Visit).Observe(float64(ms) / 1000)
			}
		}
		if in.Bytes > 0 {
			m.ClientStartupBytes.WithLabelValues(in.Visit).Observe(float64(in.Bytes))
		}
	case "policy":
		d := in.Directive
		if !slices.Contains(policyDirectives, d) {
			d = "other"
		}
		m.ClientPolicyViolations.WithLabelValues(d).Inc()
		a.cfg.Log.Info("a page's policy", "page_build", in.Build, "directive", in.Directive, "blocked", in.Blocked,
			"source", in.Source, "line", in.Line)
	}
	w.WriteHeader(http.StatusNoContent)
}

// valid reports whether a report is one the page sends: a build, a kind,
// and each field of its kind within its bounds.
func (in *clientReport) valid() bool {
	if !buildPattern.MatchString(in.Build) {
		return false
	}
	switch in.Kind {
	case "error":
		return in.Message != "" && utf8.RuneCountInString(in.Message) <= reportMessage &&
			len(in.Stack) <= reportStack && stackPattern.MatchString(in.Stack) && in.Stages == nil && in.Bytes == 0 && in.Visit == "" && in.Tier == 0
	case "startup":
		if in.Message != "" || in.Stack != "" || !slices.Contains(visitNames, in.Visit) ||
			in.Bytes < 0 || in.Bytes > reportMostBytes || in.Tier < 0 || in.Tier > 3 {
			return false
		}
		for st, ms := range in.Stages {
			if !slices.Contains(stageNames, st) || ms < 0 || ms > reportLongest {
				return false
			}
		}
		return true
	case "policy":
		return in.Message == "" && in.Stack == "" && in.Stages == nil && in.Bytes == 0 && in.Visit == "" && in.Tier == 0 &&
			directivePattern.MatchString(in.Directive) && blockedPattern.MatchString(in.Blocked) &&
			sourcePattern.MatchString(in.Source) && in.Line >= 0 && in.Line <= reportLongestLine
	}
	return false
}

// cutQuoted cuts a message before the first thing quoted in it: what a
// page's error quotes may be a player's words.
func cutQuoted(s string) string {
	if i := strings.IndexAny(s, "\"'`“”‘’«»"); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}

// registerClientReports registers the report route and makes its series,
// each stage's and visit's.
func (a *api) registerClientReports(mux *http.ServeMux, required func(http.HandlerFunc) http.Handler) {
	m := a.cfg.Metrics
	for _, v := range visitNames {
		for _, st := range stageNames {
			m.ClientStartup.WithLabelValues(st, v)
		}
		m.ClientStartupBytes.WithLabelValues(v)
	}
	for _, d := range policyDirectives {
		m.ClientPolicyViolations.WithLabelValues(d)
	}
	m.ClientPolicyViolations.WithLabelValues("other")
	mux.Handle(clientReportRoute, required(a.clientReport))
}
