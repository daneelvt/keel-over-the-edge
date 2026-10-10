// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/devcert"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/manifests"
)

// Flux's kinds a release is followed through, by their whole names: a
// short one could be another API group's.
const (
	sourceKind = "ocirepositories.source.toolkit.fluxcd.io"
	layerKind  = "kustomizations.kustomize.toolkit.fluxcd.io"
)

// reconcileAnnotation asks a Flux controller to look at an object now; it
// answers by copying the value into the object's status (Flux's
// documentation, "Triggering a reconcile").
const reconcileAnnotation = "reconcile.fluxcd.io/requestedAt"

// revisionAnnotation is where a release's artifact says what it was made
// from, as main@sha1:<commit>.
const revisionAnnotation = "org.opencontainers.image.revision"

// fluxObject is what the cluster holds of a source or a layer of Flux's.
type fluxObject struct {
	Metadata struct {
		Name       string `json:"name"`
		Generation int64  `json:"generation"`
	} `json:"metadata"`
	Spec struct {
		Ref struct {
			Tag string `json:"tag"`
		} `json:"ref"`
		DeletionPolicy string `json:"deletionPolicy"`
	} `json:"spec"`
	Status struct {
		ObservedGeneration     int64  `json:"observedGeneration"`
		LastHandledReconcileAt string `json:"lastHandledReconcileAt"`
		LastAppliedRevision    string `json:"lastAppliedRevision"`
		Conditions             []struct {
			Type    string `json:"type"`
			Status  string `json:"status"`
			Reason  string `json:"reason"`
			Message string `json:"message"`
		} `json:"conditions"`
		Artifact *struct {
			Revision string            `json:"revision"`
			Digest   string            `json:"digest"`
			Metadata map[string]string `json:"metadata"`
		} `json:"artifact"`
	} `json:"status"`
}

// condition is a condition's status, "True" or "False", with its reason
// and message together; "" when the object has none of the kind yet.
func (o *fluxObject) condition(kind string) (status, why string) {
	for _, c := range o.Status.Conditions {
		if c.Type == kind {
			return c.Status, c.Reason + ": " + c.Message
		}
	}
	return "", ""
}

// current is whether the status is of the object as it is now.
func (o *fluxObject) current() bool {
	return o.Status.ObservedGeneration == o.Metadata.Generation
}

// build is the build a source's artifact was made from: the first 12
// characters of the commit its revision names.
func (o *fluxObject) build() (string, error) {
	if o.Status.Artifact == nil {
		return "", fmt.Errorf("no release fetched by Flux yet: %s", o.summary())
	}
	revision := o.Status.Artifact.Metadata[revisionAnnotation]
	_, commit, ok := strings.Cut(revision, "@sha1:")
	if !ok || len(commit) != 40 {
		return "", fmt.Errorf("the release %s does not say what commit it was made from (%s is %q)", o.Status.Artifact.Revision, revisionAnnotation, revision)
	}
	return commit[:12], nil
}

// summary is what Flux says of the object, in a line.
func (o *fluxObject) summary() string {
	status, why := o.condition("Ready")
	switch {
	case status == "True" && o.Status.Artifact != nil:
		return "verified, " + o.Status.Artifact.Revision
	case status == "":
		return "not looked at by Flux yet"
	}
	return "not ready: " + why
}

// fluxInstalled is whether the cluster has Flux's kinds.
func (c *cluster) fluxInstalled(ctx context.Context) (bool, error) {
	out, err := c.kubectl(ctx, nil, "get", "crd", sourceKind, layerKind, "--ignore-not-found", "-o", "name")
	if err != nil {
		return false, err
	}
	return len(strings.Fields(string(out))) == 2, nil
}

// fluxGet reads an object of Flux's; nil if there is none.
func (c *cluster) fluxGet(ctx context.Context, kind, name string) (*fluxObject, error) {
	out, err := c.kubectl(ctx, nil, "-n", manifests.FluxNamespace, "get", kind, name, "--ignore-not-found", "-o", "json")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(string(out)) == "" {
		return nil, nil
	}
	var o fluxObject
	if err := json.Unmarshal(out, &o); err != nil {
		return nil, fmt.Errorf("reading %s %s: %w", kind, name, err)
	}
	return &o, nil
}

// followed is the release the cluster follows through Flux; nil when the
// working tree is in charge.
func (c *cluster) followed(ctx context.Context) (*fluxObject, error) {
	if ok, err := c.fluxInstalled(ctx); err != nil || !ok {
		return nil, err
	}
	return c.fluxGet(ctx, sourceKind, manifests.Source)
}

// release takes a published release through Flux, as production takes
// one, and checks the game then answers with its build.
func (c *cluster) release(ctx context.Context, tag string) error {
	if err := c.checkTools(); err != nil {
		return err
	}
	start := time.Now()
	build, err := c.follow(ctx, tag)
	if err != nil {
		return err
	}
	if err := c.smoke(ctx); err != nil {
		return err
	}
	c.logf("the game answers with build %s, %.1f s after the release was asked for", build, time.Since(start).Seconds())
	host, err := c.localHost(ctx)
	if err != nil {
		return err
	}
	devcert.PrintAddresses(c.out, "", "https://"+host)
	return nil
}

// follow makes the cluster follow the release at tag, a build or what
// production follows, and returns its build once Flux has applied it: the
// source is fetched only if its signature is the release workflow's, and
// the artifact's layers for the local cluster are applied in order, each
// once the one before is ready.
func (c *cluster) follow(ctx context.Context, tag string) (string, error) {
	t, err := manifests.ReadTree(clusterDir)
	if err != nil {
		return "", err
	}
	sync, err := t.RenderSync(tag)
	if err != nil {
		return "", err
	}
	apps, err := t.Render(localCluster.Entry("apps"))
	if err != nil {
		return "", err
	}
	objs, err := manifests.Objects(apps)
	if err != nil {
		return "", err
	}
	host, err := c.localHost(ctx)
	if err != nil {
		return "", err
	}
	// Flux applies the artifact as it is: nothing puts this Mac's name
	// into it, as a deploy does.
	if origin := manifests.PlayOrigin(objs); origin != "https://"+host {
		return "", fmt.Errorf("a release's manifests for the local cluster are rendered for %s, and this Mac is %s: keel would refuse its players. go run ./tools/cluster -deploy works on any Mac", origin, "https://"+host)
	}
	if ok, err := c.fluxInstalled(ctx); err != nil {
		return "", err
	} else if !ok {
		return "", errors.New("the cluster has no Flux: go run ./tools/cluster -up first")
	}
	// What no release holds: the database's password and the certificate.
	if err := c.secrets(ctx, apps, host); err != nil {
		return "", err
	}

	c.logf("following the release %s:%s through Flux", manifests.ManifestsRepo, tag)
	start := time.Now()
	since := func() float64 { return time.Since(start).Seconds() }
	if err := c.apply(ctx, manifests.LocalRelease, sync, localTarget); err != nil {
		return "", err
	}
	asked := start.UTC().Format(time.RFC3339Nano)
	if _, err := c.kubectl(ctx, nil, "-n", manifests.FluxNamespace, "annotate", sourceKind, manifests.Source, reconcileAnnotation+"="+asked, "--overwrite"); err != nil {
		return "", err
	}
	src, err := c.waitSource(ctx, asked, 5*time.Minute)
	if err != nil {
		return "", err
	}
	build, err := src.build()
	if err != nil {
		return "", err
	}
	if tag != manifests.ProdTag && build != tag {
		return "", fmt.Errorf("the artifact tagged %s says it was made from build %s", tag, build)
	}
	revision := src.Status.Artifact.Revision
	c.logf("the release is verified, %.1f s after it was applied: %s, build %s, signed by the release workflow on main", since(), revision, build)
	for _, layer := range localCluster.Entries {
		if err := c.waitLayer(ctx, layer, revision, 15*time.Minute); err != nil {
			return "", err
		}
		c.logf("%s is ready, %.1f s after the release was applied", layer, since())
	}
	return build, nil
}

// waitSource waits until Flux has looked at the release's source since
// asked, and returns it verified and fetched. A source Flux refuses, or
// cannot fetch, fails at once with what Flux said: Flux marks such a
// source as not observed at all, so only its answer to asked says the
// refusal is of this release.
func (c *cluster) waitSource(ctx context.Context, asked string, timeout time.Duration) (*fluxObject, error) {
	c.logf("waiting for Flux to fetch the release and check its signature")
	deadline := time.Now().Add(timeout)
	last := "Flux has not looked at it"
	for {
		src, err := c.fluxGet(ctx, sourceKind, manifests.Source)
		if err != nil {
			return nil, err
		}
		if src != nil && src.Status.LastHandledReconcileAt == asked {
			ready, why := src.condition("Ready")
			verified, whyNot := src.condition("SourceVerified")
			switch {
			case verified == "False":
				return nil, fmt.Errorf("the release was refused by Flux, and nothing of it applied: %s", whyNot)
			case ready == "False":
				return nil, fmt.Errorf("the release could not be fetched by Flux: %s. Is the build released, by the release workflow's run of its commit on main, and is the package %s public?", why, manifests.ManifestsRepo)
			case ready == "True" && verified == "True" && src.current() && src.Status.Artifact != nil:
				return src, nil
			}
			last = "Ready " + why
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("the release: not fetched within %v: %s", timeout, last)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(c.poll):
		}
	}
}

// waitLayer waits until a layer has applied revision and what it applied
// is healthy. What Flux says meanwhile is shown as it changes: a layer
// that fails is tried again by Flux, so only the time runs out.
func (c *cluster) waitLayer(ctx context.Context, layer, revision string, timeout time.Duration) error {
	c.logf("waiting for %s", layer)
	deadline := time.Now().Add(timeout)
	said := ""
	for {
		o, err := c.fluxGet(ctx, layerKind, layer)
		if err != nil {
			return err
		}
		if o != nil {
			ready, why := o.condition("Ready")
			if ready == "True" && o.current() && o.Status.LastAppliedRevision == revision {
				return nil
			}
			if ready != "True" && why != said {
				c.logf("%s: %s", layer, why)
				said = why
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%s: not ready within %v: %s", layer, timeout, said)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(c.poll):
		}
	}
}

// endRelease lets go of a release the cluster follows: it deletes the
// layers, the last first, and then the source, and nothing else. Each
// layer leaves what it applied in place (its deletionPolicy, Orphan), the
// database with its world among it; a layer that would not is left alone,
// and the deploy stops.
func (c *cluster) endRelease(ctx context.Context) error {
	if ok, err := c.fluxInstalled(ctx); err != nil || !ok {
		return err
	}
	layers := slices.Clone(localCluster.Entries)
	slices.Reverse(layers)
	said := false
	for _, layer := range layers {
		o, err := c.fluxGet(ctx, layerKind, layer)
		if err != nil {
			return err
		}
		if o == nil {
			continue
		}
		if o.Spec.DeletionPolicy != "Orphan" {
			return fmt.Errorf("the layer %s of Flux's has the deletionPolicy %q, not Orphan: deleting it could delete what it applied, the database among it. Not touching it", layer, o.Spec.DeletionPolicy)
		}
		if !said {
			c.logf("letting go of the release the cluster followed: the working tree is in charge again")
			said = true
		}
		if _, err := c.kubectl(ctx, nil, "-n", manifests.FluxNamespace, "delete", layerKind, layer, "--wait", "--timeout=2m"); err != nil {
			return err
		}
	}
	src, err := c.fluxGet(ctx, sourceKind, manifests.Source)
	if err != nil || src == nil {
		return err
	}
	_, err = c.kubectl(ctx, nil, "-n", manifests.FluxNamespace, "delete", sourceKind, manifests.Source, "--wait", "--timeout=2m")
	return err
}
