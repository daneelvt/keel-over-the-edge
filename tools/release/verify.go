// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/manifests"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/pinned"
)

// keyedVerifier checks the signatures Flux cannot: of the sources listed
// in manifests.KeyedSources, each against its publisher's key in the
// repository, and of the images vendored manifests run, keyless.
type keyedVerifier struct {
	out io.Writer
	// run runs cosign and returns what it printed.
	run func(ctx context.Context, args ...string) ([]byte, error)
}

func newKeyedVerifier(out io.Writer) *keyedVerifier {
	return &keyedVerifier{out: out, run: func(ctx context.Context, args ...string) ([]byte, error) {
		bin, err := pinned.Install(ctx, stateDir, os.Stderr, pinned.Cosign)
		if err != nil {
			return nil, err
		}
		out, err := exec.CommandContext(ctx, filepath.Join(bin, "cosign"), args...).CombinedOutput()
		if err != nil {
			return out, fmt.Errorf("cosign %s: %w\n%s", args[0], err, strings.TrimSpace(string(out)))
		}
		return out, nil
	}}
}

// digestRef is an image's reference by tag and digest, as a manifest pins
// it: name:tag@sha256:….
var digestRef = regexp.MustCompile(`^([^:@]+):([^:@]+)@(sha256:[0-9a-f]{64})$`)

// verifyKeyed checks every keyed source and signed image the manifests
// name, by the digest they pin: what Flux fetches by that digest, and what
// the cluster pulls, is what was checked here. Nothing is rendered or
// released if one fails.
func (v *keyedVerifier) verify(ctx context.Context) error {
	t, err := manifests.ReadTree(clusterDir)
	if err != nil {
		return err
	}
	var objs []manifests.Object
	// Production's controllers hold every one: the local cluster's are
	// among them.
	rm, err := t.Render(manifests.Clusters[1].Entry("controllers"))
	if err != nil {
		return err
	}
	if objs, err = manifests.Objects(rm); err != nil {
		return err
	}
	var errs []error
	for _, k := range manifests.KeyedSources {
		// cert-manager's own way (its documentation, "Verifying
		// signatures"): its key, SHA-512, and no transparency log, which
		// its signatures are not in.
		keyed := []string{"verify", "--key", k.Key, "--signature-digest-algorithm", "sha512", "--insecure-ignore-tlog=true"}
		repo := manifests.Find(objs, "OCIRepository", k.Name)
		if repo == nil || manifests.Str(repo, "spec", "url") != k.URL {
			errs = append(errs, fmt.Errorf("%s: no OCIRepository from %s", k.Name, k.URL))
			continue
		}
		ref := strings.TrimPrefix(k.URL, "oci://") + "@" + manifests.Str(repo, "spec", "ref", "digest")
		if _, err := v.run(ctx, append(keyed, ref)...); err != nil {
			errs = append(errs, fmt.Errorf("%s is not signed by %s: %w", ref, k.Key, err))
			continue
		}
		fmt.Fprintf(v.out, "release: %s is signed by %s\n", ref, k.Key)
		values := manifests.Get(manifests.Find(objs, "HelmRelease", k.Name), "spec", "values")
		for _, p := range manifests.ImageValues(values) {
			image, ok := k.Images[p]
			if !ok {
				errs = append(errs, fmt.Errorf("%s: its values pin an image at %s that the list of what to check does not name", k.Name, p))
				continue
			}
			keys := []any{}
			for _, part := range strings.Split(p, ".") {
				keys = append(keys, part)
			}
			ref := image + "@" + manifests.Str(values, append(keys, "digest")...)
			if _, err := v.run(ctx, append(keyed, ref)...); err != nil {
				errs = append(errs, fmt.Errorf("%s is not signed by %s: %w", ref, k.Key, err))
				continue
			}
			fmt.Fprintf(v.out, "release: %s is signed by %s\n", ref, k.Key)
		}
		for p := range k.Images {
			if !slices.Contains(manifests.ImageValues(values), p) {
				errs = append(errs, fmt.Errorf("%s: its values pin no image at %s", k.Name, p))
			}
		}
	}
	for _, s := range manifests.SignedImages {
		found := false
		for _, o := range objs {
			for _, c := range manifests.Containers(manifests.PodSpec(o)) {
				img, _ := c["image"].(string)
				m := digestRef.FindStringSubmatch(img)
				if m == nil || m[1] != s.Image {
					continue
				}
				found = true
				subject := fmt.Sprintf(s.Subject, regexp.QuoteMeta(m[2]))
				if _, err := v.run(ctx, "verify", "--certificate-oidc-issuer-regexp", manifests.ReleaseIssuer,
					"--certificate-identity-regexp", subject, s.Image+"@"+m[3]); err != nil {
					errs = append(errs, fmt.Errorf("%s is not signed by %s: %w", img, subject, err))
					continue
				}
				fmt.Fprintf(v.out, "release: %s is signed by its release workflow at %s\n", img, m[2])
			}
		}
		if !found {
			errs = append(errs, fmt.Errorf("no workload runs %s by tag and digest", s.Image))
		}
	}
	return errors.Join(errs...)
}
