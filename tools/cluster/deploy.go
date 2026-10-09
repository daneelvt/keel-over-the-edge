// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"sigs.k8s.io/kustomize/api/resmap"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/devcert"
)

// keepImages is how many of the game's images the node keeps: the one
// running and the two before it.
const keepImages = 3

// up makes the cluster, or brings it back, and deploys the game.
func (c *cluster) up(ctx context.Context) error {
	if err := c.checkTools(); err != nil {
		return err
	}
	if err := c.startVM(ctx); err != nil {
		return err
	}
	if err := c.installK3s(ctx); err != nil {
		return err
	}
	if err := c.writeKubeconfig(ctx); err != nil {
		return err
	}
	if err := c.waitKubectl(ctx, "the node", 5*time.Minute, "wait", "--for=condition=Ready", "node", "--all"); err != nil {
		return err
	}
	t, err := readTree(clusterDir)
	if err != nil {
		return err
	}
	if err := c.applyEntry(ctx, t, "flux-system"); err != nil {
		return err
	}
	if err := c.waitKubectl(ctx, "Flux's controllers", 5*time.Minute, "-n", "flux-system", "wait", "--for=condition=Available", "deployment", "--all"); err != nil {
		return err
	}
	if err := c.applyEntry(ctx, t, "clusters/local/controllers"); err != nil {
		return err
	}
	if err := c.waitKubectl(ctx, "the CloudNativePG operator", 10*time.Minute, "-n", "cnpg-system", "wait", "--for=condition=Ready", "helmrelease/cloudnative-pg"); err != nil {
		return err
	}
	if err := c.applyEntry(ctx, t, "clusters/local/configs"); err != nil {
		return err
	}
	if err := c.waitKubectl(ctx, "Traefik's Gateway API", 5*time.Minute, "wait", "--for=condition=Accepted", "gatewayclass/traefik"); err != nil {
		return err
	}
	return c.deployGame(ctx)
}

// applyEntry renders an entry point, checks its rules, and applies it.
func (c *cluster) applyEntry(ctx context.Context, t *tree, entry string) error {
	rm, err := t.render(entry)
	if err != nil {
		return err
	}
	return c.apply(ctx, entry, rm)
}

// apply applies rendered manifests on the server's side, as Flux does,
// once they keep the rules.
func (c *cluster) apply(ctx context.Context, entry string, rm resmap.ResMap) error {
	objs, err := objects(rm)
	if err != nil {
		return err
	}
	if err := checkRules(objs, true); err != nil {
		return fmt.Errorf("%s: %w", entry, err)
	}
	manifests, err := rm.AsYaml()
	if err != nil {
		return err
	}
	c.logf("applying %s (%d objects)", entry, len(objs))
	_, err = c.kubectl(ctx, bytes.NewReader(manifests), "apply", "--server-side", "--force-conflicts", "--field-manager=tools-cluster", "-f", "-")
	return err
}

// deployGame builds the game's image, imports it into the node, and
// applies the game's manifests with it.
func (c *cluster) deployGame(ctx context.Context) error {
	if err := c.checkTools(); err != nil {
		return err
	}
	t, err := readTree(clusterDir)
	if err != nil {
		return err
	}
	build, err := c.buildID(ctx, time.Now())
	if err != nil {
		return err
	}
	host, err := c.localHost(ctx)
	if err != nil {
		return err
	}
	d := deploy{build: build, host: host, sailors: os.Getenv("KEEL_DEV_SAILORS")}
	rm, err := t.renderApps(d)
	if err != nil {
		return err
	}
	if err := c.buildImage(ctx, build); err != nil {
		return err
	}
	if err := c.importImage(ctx, build); err != nil {
		return err
	}
	if err := c.secrets(ctx, rm, host); err != nil {
		return err
	}
	start := time.Now()
	if err := c.apply(ctx, "clusters/local/apps", rm); err != nil {
		return err
	}
	if err := c.waitKubectl(ctx, "the database", 10*time.Minute, "-n", namespace, "wait", "--for=condition=Ready", "cluster/keel-db"); err != nil {
		return err
	}
	if err := c.waitKubectl(ctx, "keel "+build, 10*time.Minute, "-n", namespace, "rollout", "status", "deployment/"+deployment); err != nil {
		return err
	}
	c.logf("keel %s is ready, %.0f s after it was applied", build, time.Since(start).Seconds())
	devcert.PrintAddresses(c.out, "", "https://"+host)
	return nil
}

// buildID names a build: the commit's first 12 characters, and when the
// tree has changes not committed, the time too, so no two builds share a
// tag.
func (c *cluster) buildID(ctx context.Context, now time.Time) (string, error) {
	rev, err := c.run(ctx, "git", "rev-parse", "--short=12", "HEAD")
	if err != nil {
		return "", err
	}
	changes, err := c.run(ctx, "git", "status", "--porcelain")
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(string(rev))
	if len(bytes.TrimSpace(changes)) > 0 {
		id += "-dirty-" + now.UTC().Format("20060102T150405Z")
	}
	return id, nil
}

// localHost is the name phones reach this Mac by: its Bonjour name.
func (c *cluster) localHost(ctx context.Context) (string, error) {
	if out, err := c.run(ctx, "scutil", "--get", "LocalHostName"); err == nil {
		if name := strings.TrimSpace(string(out)); name != "" {
			return strings.ToLower(name) + ".local", nil
		}
	}
	name, err := os.Hostname()
	if err != nil {
		return "", err
	}
	short, _, _ := strings.Cut(name, ".")
	return strings.ToLower(short) + ".local", nil
}

// buildImage builds the game's image for the VM's platform.
func (c *cluster) buildImage(ctx context.Context, build string) error {
	c.logf("building the image keel:%s", build)
	return c.stream(ctx, "docker", "buildx", "build", "--platform", "linux/arm64",
		"--provenance=false", "--sbom=false", "--build-arg", "BUILD="+build,
		"--tag", localImage+":"+build, "--load", ".")
}

// importImage puts the image into the node's containerd, where the
// kubelet finds it without a registry, and removes the oldest of the
// game's images beyond keepImages.
func (c *cluster) importImage(ctx context.Context, build string) error {
	if err := os.MkdirAll(c.state, 0o700); err != nil {
		return err
	}
	archive := filepath.Join(c.state, "image.tar")
	defer os.Remove(archive)
	if _, err := c.run(ctx, "docker", "save", "--output", archive, localImage+":"+build); err != nil {
		return err
	}
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	c.logf("importing keel:%s into the node", build)
	if _, err := c.guest(ctx, f, "sudo", "k3s", "ctr", "-n", "k8s.io", "images", "import", "-"); err != nil {
		return err
	}
	history := filepath.Join(c.state, "images.txt")
	old, _ := os.ReadFile(history)
	kept, removed := pruneImages(strings.Fields(string(old)), build, keepImages)
	for _, tag := range removed {
		// An image already gone is no matter.
		_, _ = c.guest(ctx, nil, "sudo", "k3s", "ctr", "-n", "k8s.io", "images", "rm", "docker.io/library/"+localImage+":"+tag)
		_, _ = c.run(ctx, "docker", "image", "rm", localImage+":"+tag)
	}
	return os.WriteFile(history, []byte(strings.Join(kept, "\n")+"\n"), 0o600)
}

// pruneImages adds build, newest last, to the images imported, and splits
// them into the newest keep and the rest.
func pruneImages(history []string, build string, keep int) (kept, removed []string) {
	history = slices.DeleteFunc(slices.Clone(history), func(t string) bool { return t == build })
	history = append(history, build)
	if len(history) <= keep {
		return history, nil
	}
	return history[len(history)-keep:], history[:len(history)-keep]
}

// secrets makes what the game needs that the repository never holds: the
// game's namespace first, then the database's password, made once and
// never replaced, and the TLS certificate for the players' host, replaced
// when its names change.
func (c *cluster) secrets(ctx context.Context, rm resmap.ResMap, host string) (err error) {
	var nsYAML []byte
	for _, r := range rm.Resources() {
		if r.GetKind() == "Namespace" && r.GetName() == namespace {
			if nsYAML, err = r.AsYAML(); err != nil {
				return err
			}
		}
	}
	if nsYAML == nil {
		return fmt.Errorf("the game's manifests have no Namespace %s", namespace)
	}
	if _, err := c.kubectl(ctx, bytes.NewReader(nsYAML), "apply", "--server-side", "--field-manager=tools-cluster", "-f", "-"); err != nil {
		return err
	}
	if err := c.databaseSecret(ctx); err != nil {
		return err
	}
	certs, err := devcert.Make(ctx, c.out, filepath.Join(c.state, "certs"), certHosts(host, devcert.LANAddresses()), true)
	if err != nil {
		return err
	}
	return c.tlsSecret(ctx, certs)
}

// certHosts are the names the cluster's certificate covers: the Mac's
// Bonjour name, its local network addresses, and this Mac's own names.
func certHosts(host string, lan []net.IP) []string {
	hosts := []string{host}
	for _, ip := range lan {
		hosts = append(hosts, ip.String())
	}
	return append(hosts, "localhost", "127.0.0.1")
}

// secretExists asks the cluster for a Secret in the game's namespace.
func (c *cluster) secretExists(ctx context.Context, name string) (bool, error) {
	out, err := c.kubectl(ctx, nil, "-n", namespace, "get", "secret", name, "--ignore-not-found", "-o", "name")
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(string(out)) != "", nil
}

// databaseSecret makes keel-db-app, the database's owner and password, if
// it is missing. The password exists only in the cluster; a new one for a
// database made with the old would lock the game out.
func (c *cluster) databaseSecret(ctx context.Context) error {
	ok, err := c.secretExists(ctx, "keel-db-app")
	if err != nil || ok {
		return err
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return err
	}
	c.logf("making the database's password, keel-db-app")
	return c.createSecret(ctx, "keel-db-app", "kubernetes.io/basic-auth", map[string]string{
		"username": "keel",
		"password": base64.RawURLEncoding.EncodeToString(key),
	})
}

// tlsSecret puts the certificate into keel-tls, when it is missing or holds
// another.
func (c *cluster) tlsSecret(ctx context.Context, certs devcert.Certs) error {
	cert, err := os.ReadFile(certs.Cert)
	if err != nil {
		return err
	}
	key, err := os.ReadFile(certs.Key)
	if err != nil {
		return err
	}
	have, err := c.kubectl(ctx, nil, "-n", namespace, "get", "secret", "keel-tls", "--ignore-not-found", "-o", "jsonpath={.data.tls\\.crt}")
	if err != nil {
		return err
	}
	if string(bytes.TrimSpace(have)) == base64.StdEncoding.EncodeToString(cert) {
		return nil
	}
	if len(bytes.TrimSpace(have)) > 0 {
		c.logf("the certificate's names changed: replacing keel-tls")
		if _, err := c.kubectl(ctx, nil, "-n", namespace, "delete", "secret", "keel-tls"); err != nil {
			return err
		}
	}
	return c.createSecret(ctx, "keel-tls", "kubernetes.io/tls", map[string]string{"tls.crt": string(cert), "tls.key": string(key)})
}

// createSecret creates a Secret from stdin, so its values never appear in a
// command line; it fails if the Secret exists.
func (c *cluster) createSecret(ctx context.Context, name, kind string, data map[string]string) error {
	s := map[string]any{
		"apiVersion": "v1",
		"kind":       "Secret",
		"metadata":   map[string]any{"name": name, "namespace": namespace},
		"type":       kind,
		"stringData": data,
	}
	body, err := json.Marshal(s)
	if err != nil {
		return err
	}
	_, err = c.kubectl(ctx, bytes.NewReader(body), "create", "-f", "-")
	if err != nil {
		// Never repeat what was sent: it holds the secret.
		return errors.New("creating the Secret " + name + " failed: " + strings.ReplaceAll(err.Error(), string(body), "(the secret)"))
	}
	return nil
}
