// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"crypto/rand"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"golang.org/x/sync/errgroup"

	"github.com/daneelvt/keel-over-the-edge/internal/agreement"
	"github.com/daneelvt/keel-over-the-edge/internal/config"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/legal"
)

const agreementUsage = `usage: keel agreement

The keeper of the contributor agreement: the server of the GitHub App that
checks every pull request's authors have signed it (the status
pr-agreement, and one comment), and of the page where they sign, at
/agreement on the players' host. A process of its own, with its own
database role, which reaches the agreement's two tables alone.

Without the App's settings it runs "not set up": its page shows the
agreement to read, and nothing to sign; its webhook answers 503.

Configured from the environment:
  KEEL_PLAY_ORIGIN       the players' HTTPS origin, whose /agreement this
                         serves (required)
  KEEL_DATABASE_URL      the database, a postgres:// URL, as the role
                         agreement (required)
  KEEL_AGREEMENT_ADDR    the page's and the webhook's listener (default
                         127.0.0.1:8082)
  KEEL_INTERNAL_ADDR     probes, and the owner's routes for keel admin
                         agreements (default 127.0.0.1:9090)
  KEEL_METRICS_ADDR      the metrics alone, GET /metrics (default none)
  KEEL_LOG_LEVEL         debug, info, warn or error (default info)
  KEEL_AGREEMENT_APP_ID         the GitHub App's ID
  KEEL_AGREEMENT_CLIENT_ID      its client ID
  KEEL_AGREEMENT_PRIVATE_KEY    its private key, PEM
  KEEL_AGREEMENT_WEBHOOK_SECRET its webhook's secret
  KEEL_AGREEMENT_CLIENT_SECRET  its client secret, for signing in
  KEEL_AGREEMENT_CONTACT        the owner's address for a parent or
                                guardian and for privacy requests
  KEEL_AGREEMENT_GITHUB_API     GitHub's API (default https://api.github.com)
  KEEL_AGREEMENT_GITHUB_WEB     GitHub (default https://github.com)
`

// sweepEvery is how often every open pull request is checked again, so a
// webhook GitHub failed to deliver mends itself.
const sweepEvery = time.Hour

// agreementConfig is keel agreement's configuration.
type agreementConfig struct {
	origin, databaseURL              string
	addr, internalAddr, metricsAddr  string
	logLevel                         slog.Level
	appID                            int64
	clientID, clientSecret, keyPEM   string
	webhookSecret, contact, api, web string
}

// setUp reports whether every one of the App's settings is given; some but
// not all is an error.
func (c agreementConfig) setUp() (bool, error) {
	given := map[string]bool{
		"KEEL_AGREEMENT_APP_ID": c.appID != 0, "KEEL_AGREEMENT_CLIENT_ID": c.clientID != "",
		"KEEL_AGREEMENT_PRIVATE_KEY": c.keyPEM != "", "KEEL_AGREEMENT_WEBHOOK_SECRET": c.webhookSecret != "",
		"KEEL_AGREEMENT_CLIENT_SECRET": c.clientSecret != "", "KEEL_AGREEMENT_CONTACT": c.contact != "",
	}
	var missing []string
	for name, ok := range given {
		if !ok {
			missing = append(missing, name)
		}
	}
	slices.Sort(missing)
	switch len(missing) {
	case 0:
		return true, nil
	case len(given):
		return false, nil
	}
	return false, fmt.Errorf("the GitHub App is set up in part: %s missing", strings.Join(missing, ", "))
}

func loadAgreementConfig(getenv func(string) string) (agreementConfig, error) {
	or := func(name, def string) string {
		if v := getenv(name); v != "" {
			return v
		}
		return def
	}
	c := agreementConfig{
		origin:        strings.TrimSuffix(getenv("KEEL_PLAY_ORIGIN"), "/"),
		databaseURL:   getenv("KEEL_DATABASE_URL"),
		addr:          or("KEEL_AGREEMENT_ADDR", "127.0.0.1:8082"),
		internalAddr:  or("KEEL_INTERNAL_ADDR", config.DefaultInternalAddr),
		metricsAddr:   getenv("KEEL_METRICS_ADDR"),
		clientID:      strings.TrimSpace(getenv("KEEL_AGREEMENT_CLIENT_ID")),
		clientSecret:  strings.TrimSpace(getenv("KEEL_AGREEMENT_CLIENT_SECRET")),
		keyPEM:        strings.TrimSpace(getenv("KEEL_AGREEMENT_PRIVATE_KEY")),
		webhookSecret: strings.TrimSpace(getenv("KEEL_AGREEMENT_WEBHOOK_SECRET")),
		contact:       strings.TrimSpace(getenv("KEEL_AGREEMENT_CONTACT")),
		api:           strings.TrimSuffix(or("KEEL_AGREEMENT_GITHUB_API", "https://api.github.com"), "/"),
		web:           strings.TrimSuffix(or("KEEL_AGREEMENT_GITHUB_WEB", "https://github.com"), "/"),
	}
	u, err := url.Parse(c.origin)
	if err != nil || u.Host == "" || u.Path != "" || (u.Scheme != "https" && !(u.Scheme == "http" && isLoopbackHost(u.Hostname()))) {
		return c, fmt.Errorf("KEEL_PLAY_ORIGIN: %q is not an https origin", c.origin)
	}
	if err := config.CheckDatabaseURL(c.databaseURL); err != nil {
		return c, fmt.Errorf("KEEL_DATABASE_URL: %w", err)
	}
	level, err := config.ParseLevel(or("KEEL_LOG_LEVEL", "info"))
	if err != nil {
		return c, fmt.Errorf("KEEL_LOG_LEVEL: %w", err)
	}
	c.logLevel = level
	if s := strings.TrimSpace(getenv("KEEL_AGREEMENT_APP_ID")); s != "" {
		if c.appID, err = strconv.ParseInt(s, 10, 64); err != nil || c.appID <= 0 {
			return c, fmt.Errorf("KEEL_AGREEMENT_APP_ID: %q is not an App's ID", s)
		}
	}
	if _, err := c.setUp(); err != nil {
		return c, err
	}
	return c, nil
}

func isLoopbackHost(h string) bool {
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// agreementMetrics are the keeper's own, on a registry of its own.
type agreementMetrics struct {
	reg        *prometheus.Registry
	webhooks   *prometheus.CounterVec
	checks     *prometheus.CounterVec
	signatures *prometheus.CounterVec
	github     prometheus.Counter
}

func newAgreementMetrics() *agreementMetrics {
	m := &agreementMetrics{
		reg: prometheus.NewRegistry(),
		webhooks: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "keel_agreement_webhooks_total", Help: "GitHub's webhook deliveries, by how each ended.",
		}, []string{"result"}),
		checks: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "keel_agreement_checks_total", Help: "Pull requests checked, by the status set: success, pending or error.",
		}, []string{"result"}),
		signatures: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "keel_agreement_signatures_total", Help: "New signatures, by how: page or owner.",
		}, []string{"how"}),
		github: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "keel_agreement_github_errors_total", Help: "Calls to GitHub refused or failed.",
		}),
	}
	m.reg.MustRegister(m.webhooks, m.checks, m.signatures, m.github,
		collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	// Every result shown from the start, at 0, so a rate is never absent.
	for _, r := range []string{"ok", "ignored", "duplicate", "bad_signature", "too_large", "bad_request", "not_set_up"} {
		m.webhooks.WithLabelValues(r)
	}
	for _, r := range []string{"success", "pending", "error"} {
		m.checks.WithLabelValues(r)
	}
	for _, h := range []string{store.SignedOnPage, store.SignedByOwner} {
		m.signatures.WithLabelValues(h)
	}
	return m
}

func (m *agreementMetrics) handler() http.Handler {
	return promhttp.HandlerFor(m.reg, promhttp.HandlerOpts{})
}

func agreementCmd(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("agreement", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { io.WriteString(stderr, agreementUsage) }
	if err := fs.Parse(args); err != nil || fs.NArg() > 0 {
		fs.Usage()
		return errUsage
	}
	cfg, err := loadAgreementConfig(getenv)
	if err != nil {
		return err
	}
	return runAgreement(ctx, cfg, stdout, net.Listen)
}

// runAgreement runs the keeper until ctx ends.
func runAgreement(ctx context.Context, cfg agreementConfig, stdout io.Writer, listen func(network, addr string) (net.Listener, error)) error {
	log := obs.NewLogger(stdout, cfg.logLevel, buildID())
	m := newAgreementMetrics()
	setUp, _ := cfg.setUp()

	var ready atomic.Bool
	var db *store.Agreements
	internal := http.NewServeMux()
	internal.HandleFunc("GET /livez", func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "ok\n") })
	internal.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if !ready.Load() {
			http.Error(w, "starting", http.StatusServiceUnavailable)
			return
		}
		rctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := db.Ready(rctx); err != nil {
			http.Error(w, "the agreement's tables cannot be read: "+err.Error(), http.StatusServiceUnavailable)
			return
		}
		io.WriteString(w, "ok\n")
	})
	internal.Handle("GET /metrics", m.handler())
	var late lateHandler
	internal.Handle("/agreements/api/", &late)

	internalLn, err := listen("tcp", cfg.internalAddr)
	if err != nil {
		return err
	}
	side := &sideServers{}
	side.serve(newServer(internal, log), internalLn)
	// Until the public listener serves, a failure closes the side servers
	// at once; after, they are shut down with it.
	fail := func(err error) error {
		side.close()
		return err
	}
	if cfg.metricsAddr != "" {
		ln, err := listen("tcp", cfg.metricsAddr)
		if err != nil {
			return fail(err)
		}
		side.serve(newServer(obsMetricsOnly(m.handler()), log), ln)
	}

	log.Info("keel agreement starting", "set_up", setUp, "version", legal.Current().Number, "sha256", legal.Current().SHA256)
	db, err = store.OpenAgreements(ctx, cfg.databaseURL, store.Options{Log: log})
	if err != nil {
		return fail(err)
	}
	defer db.Close()

	var gh *agreement.GitHub
	if setUp {
		key, err := agreement.ParseKey(cfg.keyPEM)
		if err != nil {
			return fail(fmt.Errorf("KEEL_AGREEMENT_PRIVATE_KEY: %w", err))
		}
		gh = &agreement.GitHub{
			AppID: cfg.appID, ClientID: cfg.clientID, ClientSecret: cfg.clientSecret, Key: key,
			API: cfg.api, Web: cfg.web, HTTP: &http.Client{Timeout: 30 * time.Second}, Errors: m.github.Inc,
		}
	} else {
		log.Warn("the GitHub App is not set up: the page shows the agreement to read, and the webhook answers 503")
	}
	checker := &agreement.Checker{GitHub: gh, Store: db, Page: cfg.origin + "/agreement", Log: log,
		Result: func(r string) { m.checks.WithLabelValues(r).Inc() }}
	key := make([]byte, 32)
	rand.Read(key)
	signed := func(how string) { m.signatures.WithLabelValues(how).Inc() }
	page := &agreement.Page{GitHub: gh, Store: db, Checker: checker, Origin: cfg.origin, Contact: cfg.contact, Key: key, Log: log, Signed: signed}
	admin := &agreement.Admin{GitHub: gh, Store: db, Checker: checker, Signed: signed}
	late.set(admin.Handler())

	public := http.NewServeMux()
	public.Handle("/agreement", page.Handler())
	public.Handle("/agreement/", page.Handler())
	if setUp {
		public.Handle("/agreement/webhook", &agreement.Webhook{Secret: []byte(cfg.webhookSecret), Checker: checker,
			Result: func(r string) { m.webhooks.WithLabelValues(r).Inc() }})
	} else {
		public.HandleFunc("/agreement/webhook", func(w http.ResponseWriter, _ *http.Request) {
			m.webhooks.WithLabelValues("not_set_up").Inc()
			http.Error(w, "not set up", http.StatusServiceUnavailable)
		})
	}
	publicLn, err := listen("tcp", cfg.addr)
	if err != nil {
		return fail(err)
	}
	srv := newServer(obs.AccessLog(log, public), log)
	ready.Store(true)
	log.Info("keel agreement listening", "addr", cfg.addr, "internal", cfg.internalAddr)

	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error { return serveUntilClosed(srv, publicLn) })
	if setUp {
		g.Go(func() error { checker.Run(gctx); return nil })
		g.Go(func() error { checker.SweepEvery(gctx, sweepEvery); return nil })
	}
	g.Go(func() error {
		<-gctx.Done()
		ready.Store(false)
		sctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		return errors.Join(srv.Shutdown(sctx), side.shutdown(sctx))
	})
	err = g.Wait()
	log.Info("keel agreement stopped")
	return err
}

// obsMetricsOnly serves GET /metrics alone, as keel's metrics listener
// does.
func obsMetricsOnly(h http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", h)
	return mux
}
