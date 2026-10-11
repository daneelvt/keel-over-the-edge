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
	"github.com/daneelvt/keel-over-the-edge/tools/internal/manifests"
)

// The names the manifests give the game's parts, and the local cluster
// among a release's.
const (
	namespace  = manifests.Namespace
	deployment = manifests.Deployment
	localImage = manifests.LocalImage
)

var localCluster = manifests.Clusters[0]

// localTarget is what the local cluster's manifests are rendered for;
// deployTarget, for a deploy from the working tree, whose image is imported.
var (
	localTarget  = manifests.Target{Cluster: localCluster.Name}
	deployTarget = manifests.Target{Cluster: localCluster.Name, Deploy: true}
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
	t, err := manifests.ReadTree(clusterDir)
	if err != nil {
		return err
	}
	// The working tree takes the cluster back from a release it followed,
	// before Flux could put the release's manifests over the tree's.
	if err := c.endRelease(ctx); err != nil {
		return err
	}
	if err := c.applyEntry(ctx, t, manifests.FluxEntry); err != nil {
		return err
	}
	if err := c.waitKubectl(ctx, "Flux's controllers", 5*time.Minute, "-n", manifests.FluxNamespace, "wait", "--for=condition=Available", "deployment", "--all"); err != nil {
		return err
	}
	if err := c.applyEntry(ctx, t, localCluster.Entry("controllers")); err != nil {
		return err
	}
	for _, chart := range [][3]string{
		{"the CloudNativePG operator", "cnpg-system", "cloudnative-pg"},
		{"External Secrets' controller", "external-secrets", "external-secrets"},
		{"cert-manager", "cert-manager", "cert-manager"},
		{"the Barman Cloud plugin", "cnpg-system", "plugin-barman-cloud"},
		{"the VictoriaMetrics operator", "monitoring", "victoria-metrics-operator"},
	} {
		if err := c.waitKubectl(ctx, chart[0], 10*time.Minute, "-n", chart[1], "wait", "--for=condition=Ready", "helmrelease/"+chart[2]); err != nil {
			return err
		}
	}
	if err := c.applyEntry(ctx, t, localCluster.Entry("configs")); err != nil {
		return err
	}
	if err := c.waitKubectl(ctx, "Traefik's Gateway API", 5*time.Minute, "wait", "--for=condition=Accepted", "gatewayclass/traefik"); err != nil {
		return err
	}
	if err := c.deployGame(ctx, false); err != nil {
		return err
	}
	return c.monitoring(ctx)
}

// monitoring applies the monitoring layer, beside the game: Grafana's
// passwords first, which the repository never holds, then the layer, and
// waits for the stack's chart.
func (c *cluster) monitoring(ctx context.Context) error {
	if err := c.checkTools(); err != nil {
		return err
	}
	t, err := manifests.ReadTree(clusterDir)
	if err != nil {
		return err
	}
	if err := c.monitoringSecrets(ctx); err != nil {
		return err
	}
	if err := c.applyEntry(ctx, t, localCluster.Entry("monitoring")); err != nil {
		return err
	}
	if err := c.waitKubectl(ctx, "the monitoring stack", 15*time.Minute, "-n", "monitoring", "wait", "--for=condition=Ready", "helmrelease/victoria-metrics-k8s-stack"); err != nil {
		return err
	}
	c.logf("Grafana: kubectl -n monitoring port-forward svc/grafana-forward 3000:80, then http://localhost:3000 as admin, with the password in the Secret monitoring/grafana-admin")
	return nil
}

// applyEntry renders an entry point, checks its rules, and applies it.
func (c *cluster) applyEntry(ctx context.Context, t *manifests.Tree, entry string) error {
	rm, err := t.Render(entry)
	if err != nil {
		return err
	}
	return c.apply(ctx, entry, rm, localTarget)
}

// apply applies rendered manifests on the server's side, as Flux does,
// once they keep the rules.
func (c *cluster) apply(ctx context.Context, entry string, rm resmap.ResMap, target manifests.Target) error {
	objs, err := manifests.Objects(rm)
	if err != nil {
		return err
	}
	if err := manifests.CheckRules(objs, target); err != nil {
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

// backupsFile holds the key to the local cluster's own bucket of backups,
// as KEEL_B2_KEY_ID and KEEL_B2_KEY: the owner copies it there once
// (infra/MANUAL-STEPS.md). Never in the repository.
const backupsFile = ".dev/backups.env"

// backupsKey reads the key from file; none, with no error, when the file
// is not there.
func backupsKey(file string) (id, key string, err error) {
	data, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return "", "", nil
	}
	if err != nil {
		return "", "", err
	}
	for _, line := range strings.Split(string(data), "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		switch {
		case !ok || strings.HasPrefix(k, "#"):
		case k == "KEEL_B2_KEY_ID":
			id = strings.TrimSpace(v)
		case k == "KEEL_B2_KEY":
			key = strings.TrimSpace(v)
		}
	}
	if id == "" || key == "" {
		return "", "", fmt.Errorf("%s must set KEEL_B2_KEY_ID and KEEL_B2_KEY", file)
	}
	return id, key, nil
}

// deployGame builds the game's image, imports it into the node, and
// applies the game's manifests with it. A release the cluster followed is
// let go of first: the working tree is in charge again. With rebuild, the
// database is the rebuild form's: made, if it is not there, by recovering
// the live archive from the backups.
func (c *cluster) deployGame(ctx context.Context, rebuild bool) error {
	if err := c.checkTools(); err != nil {
		return err
	}
	t, err := manifests.ReadTree(clusterDir)
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
	keyID, _, err := backupsKey(c.backups)
	if err != nil {
		return err
	}
	d := manifests.Deploy{Build: build, Host: host, Sailors: os.Getenv("KEEL_DEV_SAILORS"), Rebuild: rebuild, NoBackups: keyID == ""}
	target := deployTarget
	target.Rebuild, target.NoBackups = d.Rebuild, d.NoBackups
	if d.NoBackups {
		c.logf("no %s: deploying without backups. The database archives nowhere, and there is no restore test", c.backups)
	}
	rm, err := t.RenderDeploy(d)
	if err != nil {
		return err
	}
	// The rules before the build, which takes longer; apply checks them too.
	objs, err := manifests.Objects(rm)
	if err != nil {
		return err
	}
	apps := localCluster.Entry("apps")
	if err := manifests.CheckRules(objs, target); err != nil {
		return fmt.Errorf("%s: %w", apps, err)
	}
	if err := c.buildImage(ctx, build); err != nil {
		return err
	}
	if err := c.importImage(ctx, build); err != nil {
		return err
	}
	if err := c.endRelease(ctx); err != nil {
		return err
	}
	if err := c.secrets(ctx, rm, host); err != nil {
		return err
	}
	start := time.Now()
	if err := c.apply(ctx, apps, rm, target); err != nil {
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
// manifests' namespaces first, then the database's passwords (its owner's
// and its read-only roles'), made once and never replaced, the backups'
// key, if this Mac has one, and the TLS certificate for the players' host,
// replaced when its names change.
func (c *cluster) secrets(ctx context.Context, rm resmap.ResMap, host string) (err error) {
	var namespaces []byte
	for _, r := range rm.Resources() {
		if r.GetKind() == "Namespace" {
			y, err := r.AsYAML()
			if err != nil {
				return err
			}
			namespaces = append(append(namespaces, "---\n"...), y...)
		}
	}
	if !bytes.Contains(namespaces, []byte("name: "+namespace+"\n")) {
		return fmt.Errorf("the game's manifests have no Namespace %s", namespace)
	}
	if _, err := c.kubectl(ctx, bytes.NewReader(namespaces), "apply", "--server-side", "--field-manager=tools-cluster", "-f", "-"); err != nil {
		return err
	}
	for _, role := range []string{"keel", "reader", "grafana"} {
		name := "keel-db-" + role
		if role == "keel" {
			name = "keel-db-app"
		}
		if err := c.passwordSecret(ctx, namespace, name, role); err != nil {
			return err
		}
	}
	if err := c.backupsSecrets(ctx); err != nil {
		return err
	}
	certs, err := c.certificate(ctx, filepath.Join(c.state, "certs"), certHosts(host, devcert.LANAddresses()))
	if err != nil {
		return err
	}
	return c.tlsSecret(ctx, certs)
}

// backupsSecrets puts the key of .dev/backups.env where the object stores
// read it: the database's, and the restore test's, which production reads
// with a key of its own. The local key is one, for the local bucket alone.
// The dump's key is made up: the local dump uploads nowhere. A key that
// changed replaces the Secret's.
func (c *cluster) backupsSecrets(ctx context.Context) error {
	keyID, key, err := backupsKey(c.backups)
	if err != nil {
		return err
	}
	if err := c.replaceSecret(ctx, namespace, "keel-dumps", map[string]string{"keyID": "none", "key": "the-local-dump-uploads-nowhere"}); err != nil {
		return err
	}
	if keyID == "" {
		return nil
	}
	for _, s := range [][2]string{{namespace, manifests.ObjectStore}, {manifests.RestoreNamespace, manifests.RestoreStore}} {
		if err := c.replaceSecret(ctx, s[0], s[1], map[string]string{"keyID": keyID, "key": key}); err != nil {
			return err
		}
	}
	return nil
}

// monitoringSecrets makes Grafana's: its admin password, made once, and
// the password of the database's role grafana, the one keel-db-grafana
// holds for the role itself.
func (c *cluster) monitoringSecrets(ctx context.Context) error {
	if err := c.passwordSecret(ctx, "monitoring", "grafana-admin", "admin"); err != nil {
		return err
	}
	out, err := c.kubectl(ctx, nil, "-n", namespace, "get", "secret", "keel-db-grafana", "--ignore-not-found", "-o", "jsonpath={.data.password}")
	if err != nil {
		return err
	}
	password, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(out)))
	if err != nil || len(password) == 0 {
		return errors.New("the Secret keel/keel-db-grafana has no password: go run ./tools/cluster -deploy makes it")
	}
	return c.replaceSecret(ctx, "monitoring", "grafana-db", map[string]string{"password": string(password)})
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

// secretExists asks the cluster for a Secret.
func (c *cluster) secretExists(ctx context.Context, ns, name string) (bool, error) {
	out, err := c.kubectl(ctx, nil, "-n", ns, "get", "secret", name, "--ignore-not-found", "-o", "name")
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(string(out)) != "", nil
}

// passwordSecret makes a Secret of a user and a password of its own, if it
// is missing. The password exists only in the cluster; a new one for a
// database made with the old would lock its user out.
func (c *cluster) passwordSecret(ctx context.Context, ns, name, user string) error {
	ok, err := c.secretExists(ctx, ns, name)
	if err != nil || ok {
		return err
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return err
	}
	c.logf("making the password of %s, %s/%s", user, ns, name)
	return c.createSecret(ctx, ns, name, "kubernetes.io/basic-auth", map[string]string{
		"username": user,
		"password": base64.RawURLEncoding.EncodeToString(key),
	})
}

// replaceSecret makes an opaque Secret hold data, replacing one that holds
// something else.
func (c *cluster) replaceSecret(ctx context.Context, ns, name string, data map[string]string) error {
	out, err := c.kubectl(ctx, nil, "-n", ns, "get", "secret", name, "--ignore-not-found", "-o", "json")
	if err != nil {
		return err
	}
	if len(bytes.TrimSpace(out)) > 0 {
		var have struct{ Data map[string][]byte }
		if err := json.Unmarshal(out, &have); err != nil {
			return errors.New("reading the Secret " + ns + "/" + name + " failed")
		}
		same := len(have.Data) == len(data)
		for k, v := range data {
			same = same && string(have.Data[k]) == v
		}
		if same {
			return nil
		}
		if _, err := c.kubectl(ctx, nil, "-n", ns, "delete", "secret", name); err != nil {
			return err
		}
	}
	return c.createSecret(ctx, ns, name, "Opaque", data)
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
	return c.createSecret(ctx, namespace, "keel-tls", "kubernetes.io/tls", map[string]string{"tls.crt": string(cert), "tls.key": string(key)})
}

// createSecret creates a Secret from stdin, so its values never appear in a
// command line; it fails if the Secret exists.
func (c *cluster) createSecret(ctx context.Context, ns, name, kind string, data map[string]string) error {
	s := map[string]any{
		"apiVersion": "v1",
		"kind":       "Secret",
		"metadata":   map[string]any{"name": name, "namespace": ns},
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
