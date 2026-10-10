// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// coreSchemas is where the JSON schemas of Kubernetes' own kinds come
// from: yannh/kubernetes-json-schema, made from each release's OpenAPI
// description, each kind's whole in one file, and with -strict refusing a
// field it does not know. At one commit, so what a kind may hold never
// changes under a check. A kubeconform schema location (its Readme,
// "Overriding schemas location").
const coreSchemas = "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/5f1fa4f7908afc9b6641c62d282a4a22437626e1/" +
	"{{.NormalizedKubernetesVersion}}-standalone{{.StrictSuffix}}/{{.ResourceKind}}{{.KindSuffix}}.json"

// crdSchema is a schema file under Schemas.CRDs, as a kubeconform schema
// location and as SchemaFile names it: a custom resource's, or that of the
// one kind of Kubernetes' own the set above lacks, CustomResourceDefinition.
const crdSchema = "{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"

// SchemaFile is the file, under the repository's folder of schemas, of a
// kind in an API group at a version.
func SchemaFile(group, kind, version string) string {
	return filepath.Join(group, strings.ToLower(kind)+"_"+version+".json")
}

// Schemas is where the schemas rendered manifests are checked against are.
type Schemas struct {
	// CRDs is the folder of the schemas kept in the repository, the custom
	// resources' above all: infra/schemas.
	CRDs string
	// Cache keeps the schemas of Kubernetes' own kinds once downloaded:
	// .dev/schemas.
	Cache string
	// Kubernetes is the version the cluster runs, as 1.36.5.
	Kubernetes string
}

// Validate checks every manifest in paths, files or folders of YAML, with
// kubeconform: each object against the schema of its kind, with no field
// the schema does not know and no key twice. A kind with no schema fails.
func (s Schemas) Validate(ctx context.Context, paths ...string) error {
	crds, err := filepath.Abs(s.CRDs)
	if err != nil {
		return err
	}
	// kubeconform writes a schema it downloads into its cache in place,
	// where another check running beside this one could read half of it.
	// So each check works on a copy of the cache of its own, and puts back
	// whole what it downloaded.
	if err := os.MkdirAll(s.Cache, 0o755); err != nil {
		return err
	}
	work, err := os.MkdirTemp("", "keel-schemas-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(work)
	if err := copyNew(s.Cache, work); err != nil {
		return err
	}
	args := []string{"tool", "kubeconform", "-strict", "-summary",
		"-kubernetes-version", s.Kubernetes,
		// The repository's own schemas first: a custom resource never
		// costs a request, and Kubernetes' kinds fall through to theirs.
		"-schema-location", filepath.Join(crds, crdSchema),
		"-schema-location", coreSchemas,
		"-cache", work,
	}
	cmd := exec.CommandContext(ctx, "go", append(args, paths...)...)
	out, runErr := cmd.CombinedOutput()
	if err := copyNew(work, s.Cache); err != nil {
		return err
	}
	if runErr != nil {
		return fmt.Errorf("kubeconform: %w\n%s", runErr, strings.TrimSpace(string(out)))
	}
	return nil
}

// copyNew copies the files of from that to lacks, each appearing in to
// whole or not at all.
func copyNew(from, to string) error {
	entries, err := os.ReadDir(from)
	if err != nil {
		return err
	}
	for _, e := range entries {
		target := filepath.Join(to, e.Name())
		if _, err := os.Stat(target); err == nil || !e.Type().IsRegular() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(from, e.Name()))
		if err != nil {
			return err
		}
		tmp, err := os.CreateTemp(to, ".copy-*")
		if err != nil {
			return err
		}
		_, err = tmp.Write(data)
		if cerr := tmp.Close(); err == nil {
			err = cerr
		}
		if err == nil {
			err = os.Rename(tmp.Name(), target)
		}
		if err != nil {
			os.Remove(tmp.Name())
			return err
		}
	}
	return nil
}
