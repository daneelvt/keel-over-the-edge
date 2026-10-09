// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/devcert"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/smoke"
)

// forwardPort is where -smoke reaches keel's internal listener on the Mac,
// through kubectl port-forward.
const forwardPort = 19090

// smoke checks the game running in the cluster as a phone reaches it: over
// HTTPS at the Mac's name, trusting the local root alone.
func (c *cluster) smoke(ctx context.Context) error {
	if err := c.checkTools(); err != nil {
		return err
	}
	host, err := c.localHost(ctx)
	if err != nil {
		return err
	}
	build, err := c.runningBuild(ctx)
	if err != nil {
		return err
	}
	root, err := devcert.Root(ctx)
	if err != nil {
		return err
	}
	hc, err := devcert.ClientTrusting(root)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	base := "https://" + host

	if err := checkPage(ctx, hc, base); err != nil {
		return err
	}
	if err := checkVersion(ctx, hc, base, build); err != nil {
		return err
	}
	name, jar, err := smoke.Guest(ctx, hc, base)
	if err != nil {
		return err
	}
	_, jar2, err := smoke.Guest(ctx, hc, base)
	if err != nil {
		return err
	}
	if err := smoke.Game(ctx, hc, jar, jar2, base); err != nil {
		return err
	}
	if err := c.withForward(ctx, func(internal string) error { return checkInternal(ctx, internal) }); err != nil {
		return err
	}
	if err := c.plainRefused(ctx, build); err != nil {
		return err
	}
	c.logf("smoke: ok: at %s, the page and its assets with their caching, the physics module, /api/version naming build %s, a guest made and read back (%s), the game connection, a second player seeing the first's boat, keel's probes and metrics, and the database refusing a connection without TLS", base, build, name)
	return nil
}

// runningBuild is the build the game's Deployment runs: its image's tag.
func (c *cluster) runningBuild(ctx context.Context) (string, error) {
	out, err := c.kubectl(ctx, nil, "-n", namespace, "get", "deployment", deployment, "-o", `jsonpath={.spec.template.spec.containers[?(@.name=="keel")].image}`)
	if err != nil {
		return "", err
	}
	image := strings.TrimSpace(string(out))
	_, tag, ok := strings.Cut(image, ":")
	if !ok {
		return "", fmt.Errorf("the game runs %q, not a build of keel", image)
	}
	return tag, nil
}

func fetch(ctx context.Context, hc *http.Client, url string) (*http.Response, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, "", err
	}
	res, err := hc.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("smoke: %w", err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, "", fmt.Errorf("smoke: %s: %w", url, err)
	}
	if res.StatusCode != http.StatusOK {
		return res, string(body), fmt.Errorf("smoke: %s answered %s", url, res.Status)
	}
	return res, string(body), nil
}

var (
	scriptRef = regexp.MustCompile(`"(/assets/[A-Za-z0-9._-]+\.js)"`)
	moduleRef = regexp.MustCompile(`physics-[A-Za-z0-9_-]+\.wasm`)
)

// checkPage fetches the page as a browser does: the HTML, never cached;
// its scripts, cached for a year; and the physics module one of them
// loads, as WebAssembly.
func checkPage(ctx context.Context, hc *http.Client, base string) error {
	res, page, err := fetch(ctx, hc, base+"/")
	if err != nil {
		return err
	}
	if !strings.Contains(page, "<title>Keel Over the Edge</title>") {
		return errors.New("smoke: the page has no game title")
	}
	if cc := res.Header.Get("Cache-Control"); cc != "no-cache" {
		return fmt.Errorf("smoke: the page's Cache-Control is %q, want no-cache", cc)
	}
	if res.Header.Get("X-Content-Type-Options") != "nosniff" {
		return errors.New("smoke: the page has no X-Content-Type-Options: nosniff")
	}
	scripts := scriptRef.FindAllStringSubmatch(page, -1)
	if len(scripts) == 0 {
		return errors.New("smoke: the page names no script under /assets/")
	}
	module := ""
	for _, s := range scripts {
		res, body, err := fetch(ctx, hc, base+s[1])
		if err != nil {
			return err
		}
		if cc := res.Header.Get("Cache-Control"); !strings.Contains(cc, "immutable") || !strings.Contains(cc, "max-age=31536000") {
			return fmt.Errorf("smoke: %s's Cache-Control is %q, want a year, immutable", s[1], cc)
		}
		if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
			return fmt.Errorf("smoke: %s is served as %q", s[1], ct)
		}
		if m := moduleRef.FindString(body); m != "" {
			module = m
		}
	}
	if module == "" {
		return errors.New("smoke: no script the page loads names the physics module")
	}
	return smoke.ModuleServed(ctx, hc, base+"/assets/"+module)
}

// checkVersion checks the server runs the build deployed, with this tree's
// catalog.
func checkVersion(ctx context.Context, hc *http.Client, base, build string) error {
	_, body, err := fetch(ctx, hc, base+"/api/version")
	if err != nil {
		return err
	}
	var v struct{ Build, Catalog string }
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		return fmt.Errorf("smoke: /api/version: %w", err)
	}
	if v.Build != build {
		return fmt.Errorf("smoke: the server runs build %q, not %q", v.Build, build)
	}
	if v.Catalog != catalog.Version {
		return fmt.Errorf("smoke: server catalog %s, want %s", v.Catalog, catalog.Version)
	}
	return nil
}

// checkInternal checks keel's internal listener, at base: ready, and its
// metrics.
func checkInternal(ctx context.Context, base string) error {
	plain := &http.Client{Timeout: 5 * time.Second}
	if _, _, err := fetch(ctx, plain, base+"/readyz"); err != nil {
		return err
	}
	_, metrics, err := fetch(ctx, plain, base+"/metrics")
	if err != nil {
		return err
	}
	return smoke.Metrics(metrics)
}

// withForward runs f with keel's internal listener forwarded to the Mac's
// loopback by kubectl, as the owner reaches it.
func (c *cluster) withForward(ctx context.Context, f func(base string) error) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(forwardPort))
	pf := exec.CommandContext(ctx, "kubectl", "--kubeconfig", c.kubeconfig, "--context", vmName,
		"-n", namespace, "port-forward", "deployment/"+deployment, fmt.Sprintf("%d:internal", forwardPort))
	if err := pf.Start(); err != nil {
		return err
	}
	defer func() { cancel(); _ = pf.Wait() }()
	for {
		conn, err := net.DialTimeout("tcp", addr, time.Second)
		if err == nil {
			conn.Close()
			break
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("smoke: kubectl port-forward never listened: %w", err)
		case <-time.After(200 * time.Millisecond):
		}
	}
	return f("http://" + addr)
}

// plainRefused runs keel migrate in a pod of its own, as keel with its
// password, but without TLS: the database must refuse it.
func (c *cluster) plainRefused(ctx context.Context, build string) error {
	out, err := c.kubectl(ctx, nil, "-n", namespace, "run", "keel-plain-check", "--rm", "-i", "--quiet",
		"--restart=Never", "--image="+localImage+":"+build, "--overrides="+plainPod(build))
	if err == nil {
		return errors.New("smoke: the database accepted a connection without TLS")
	}
	if !strings.Contains(string(out)+err.Error(), "pg_hba.conf rejects connection") {
		return fmt.Errorf("smoke: a connection without TLS failed, but not as refused by pg_hba.conf: %w\n%s", err, out)
	}
	return nil
}

// plainPod is the pod plainRefused runs: keel's image, its database
// password, sslmode=disable.
func plainPod(build string) string {
	pod := map[string]any{
		"apiVersion": "v1",
		"spec": map[string]any{
			"automountServiceAccountToken": false,
			"securityContext": map[string]any{
				"runAsNonRoot": true, "runAsUser": 65532, "seccompProfile": map[string]any{"type": "RuntimeDefault"},
			},
			"containers": []any{map[string]any{
				"name":            "keel-plain-check",
				"image":           localImage + ":" + build,
				"imagePullPolicy": "Never",
				"args":            []string{"migrate"},
				"env": []any{
					map[string]any{"name": "KEEL_DATABASE_URL", "value": "postgres://keel@keel-db-rw." + namespace + ".svc:5432/keel?sslmode=disable"},
					map[string]any{"name": "PGPASSWORD", "valueFrom": map[string]any{"secretKeyRef": map[string]any{"name": "keel-db-app", "key": "password"}}},
				},
				"securityContext": map[string]any{
					"allowPrivilegeEscalation": false, "readOnlyRootFilesystem": true,
					"capabilities": map[string]any{"drop": []string{"ALL"}},
				},
			}},
		},
	}
	b, _ := json.Marshal(pod)
	return string(b)
}
