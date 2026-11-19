// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"encoding/csv"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

func TestAgreementConfig(t *testing.T) {
	base := map[string]string{
		"KEEL_PLAY_ORIGIN":  "https://play.example",
		"KEEL_DATABASE_URL": "postgres://agreement@db/keel",
	}
	app := map[string]string{
		"KEEL_AGREEMENT_APP_ID": "42", "KEEL_AGREEMENT_CLIENT_ID": "Iv1.x", "KEEL_AGREEMENT_PRIVATE_KEY": "k",
		"KEEL_AGREEMENT_WEBHOOK_SECRET": "w", "KEEL_AGREEMENT_CLIENT_SECRET": "c", "KEEL_AGREEMENT_CONTACT": "o@example.com",
	}
	with := func(extra map[string]string, drop ...string) func(string) string {
		m := map[string]string{}
		for k, v := range base {
			m[k] = v
		}
		for k, v := range extra {
			m[k] = v
		}
		for _, k := range drop {
			delete(m, k)
		}
		return func(k string) string { return m[k] }
	}
	c, err := loadAgreementConfig(with(nil))
	if err != nil {
		t.Fatal(err)
	}
	if up, _ := c.setUp(); up || c.addr != "127.0.0.1:8082" || c.api != "https://api.github.com" {
		t.Errorf("not set up: %+v", c)
	}
	c, err = loadAgreementConfig(with(app))
	if err != nil {
		t.Fatal(err)
	}
	if up, _ := c.setUp(); !up || c.appID != 42 {
		t.Errorf("set up: %+v", c)
	}
	for name, getenv := range map[string]func(string) string{
		"in part":         with(map[string]string{"KEEL_AGREEMENT_APP_ID": "42"}),
		"no origin":       with(nil, "KEEL_PLAY_ORIGIN"),
		"an http origin":  with(map[string]string{"KEEL_PLAY_ORIGIN": "http://play.example"}),
		"an origin path":  with(map[string]string{"KEEL_PLAY_ORIGIN": "https://play.example/x"}),
		"no database":     with(nil, "KEEL_DATABASE_URL"),
		"a bad App ID":    with(map[string]string{"KEEL_AGREEMENT_APP_ID": "x"}),
		"a bad log level": with(map[string]string{"KEEL_LOG_LEVEL": "loud"}),
	} {
		if _, err := loadAgreementConfig(getenv); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
	if _, err := loadAgreementConfig(with(map[string]string{"KEEL_PLAY_ORIGIN": "http://localhost:5173"})); err != nil {
		t.Errorf("a local origin: %v", err)
	}
}

// TestAgreementKeeper runs keel agreement, not set up, on the test
// database: its probes, its page, its webhook's 503, and keel admin
// agreements through its internal listener.
func TestAgreementKeeper(t *testing.T) {
	cfg := agreementConfig{origin: "https://play.example", databaseURL: storetest.URL(t), internalAddr: "127.0.0.1:0", addr: "127.0.0.1:0"}
	var mu sync.Mutex
	var addrs []string
	listen := func(network, addr string) (net.Listener, error) {
		ln, err := net.Listen(network, addr)
		if err == nil {
			mu.Lock()
			addrs = append(addrs, ln.Addr().String())
			mu.Unlock()
		}
		return ln, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runAgreement(ctx, cfg, io.Discard, listen) }()
	defer func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("keel agreement stopped with %v", err)
		}
	}()
	get := func(url string) (int, string) {
		res, err := http.Get(url)
		if err != nil {
			return 0, err.Error()
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	var internal, public string
	deadline := time.Now().Add(20 * time.Second)
	for {
		mu.Lock()
		if len(addrs) == 2 {
			internal, public = addrs[0], addrs[1]
		}
		mu.Unlock()
		if public != "" {
			if status, _ := get("http://" + internal + "/readyz"); status == 200 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("keel agreement never became ready")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status, body := get("http://" + public + "/agreement"); status != 200 || !strings.Contains(body, "Signing is not open yet") {
		t.Errorf("the page: %d", status)
	}
	res, err := http.Post("http://"+public+"/agreement/webhook", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("the webhook not set up: %d", res.StatusCode)
	}
	if status, _ := get("http://" + public + "/agreements/api/signatures.json"); status != 404 {
		t.Errorf("the owner's routes on the public listener: %d", status)
	}
	if status, body := get("http://" + internal + "/metrics"); status != 200 || !strings.Contains(body, `keel_agreement_webhooks_total{result="not_set_up"} 1`) {
		t.Errorf("the metrics: %d", status)
	}

	admin := func(args ...string) (string, string, error) {
		var out, errs bytes.Buffer
		err := adminWith(context.Background(), append([]string{"-addr", internal}, args...), env(nil), strings.NewReader(""), &out, &errs, http.DefaultClient)
		return out.String(), errs.String(), err
	}
	if out, _, err := admin("agreements", "list"); err != nil || !strings.Contains(out, "Nobody has signed yet") {
		t.Errorf("list, empty: %q %v", out, err)
	}
	out, _, err := admin("agreements", "add", "ann", "-id", "7", "-name", "Ann Smith", "-guardian", "Carol Smith",
		"-guardian-email", "carol@example.com", "-note", "by e-mail")
	if err != nil || !strings.Contains(out, "Would record") || !strings.Contains(out, "run it again with -yes") {
		t.Fatalf("add without -yes: %q %v", out, err)
	}
	out, _, err = admin("agreements", "add", "ann", "-id", "7", "-name", "=Ann Smith", "-note", "on paper", "-yes")
	if err != nil || !strings.Contains(out, "Recorded") {
		t.Fatalf("add: %q %v", out, err)
	}
	out, _, err = admin("agreements", "export")
	if err != nil {
		t.Fatal(err)
	}
	rows, err := csv.NewReader(strings.NewReader(out)).ReadAll()
	if err != nil || len(rows) != 2 || rows[1][2] != "ann" || rows[1][3] != "'=Ann Smith" || rows[1][7] != "owner" {
		t.Fatalf("export: %q %v", out, err)
	}
	id := rows[1][0]
	if _, errs, err := admin("agreements", "void", id); err == nil {
		t.Errorf("void without a reason: %q", errs)
	}
	if out, _, err := admin("agreements", "void", id, "-reason", "a test", "-yes"); err != nil || !strings.Contains(out, "Voided") {
		t.Errorf("void: %q %v", out, err)
	}
	if out, _, _ := admin("agreements", "list"); !strings.Contains(out, "VOID") {
		t.Errorf("list after the void: %q", out)
	}
	if _, _, err := admin("agreements", "sign"); err == nil {
		t.Error("an unknown agreements command was taken")
	}
}
