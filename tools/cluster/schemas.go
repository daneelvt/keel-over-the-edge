// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/manifests"
)

// anyImage stands for a release's image where only the manifests' kinds
// matter.
const anyImage = manifests.GameImage + "@sha256:0000000000000000000000000000000000000000000000000000000000000000"

// used is a kind the manifests use, at a version of its API group.
type used struct{ group, kind, version string }

// usedKinds are the kinds of every object the manifests render to, in
// every entry point of every cluster.
func usedKinds(t *manifests.Tree) ([]used, error) {
	seen := map[used]bool{}
	add := func(objs []manifests.Object) {
		for _, o := range objs {
			group, version, ok := strings.Cut(manifests.Str(o, "apiVersion"), "/")
			if !ok {
				group, version = "", group
			}
			seen[used{group, o.Kind(), version}] = true
		}
	}
	for _, c := range manifests.Clusters {
		for _, e := range c.Entries {
			rm, err := t.RenderRelease(c.Entry(e), anyImage)
			if err != nil {
				return nil, err
			}
			objs, err := manifests.Objects(rm)
			if err != nil {
				return nil, err
			}
			add(objs)
		}
	}
	sync, err := t.RenderSync(manifests.ProdTag)
	if err != nil {
		return nil, err
	}
	objs, err := manifests.Objects(sync)
	if err != nil {
		return nil, err
	}
	add(objs)
	var kinds []used
	for k := range seen {
		kinds = append(kinds, k)
	}
	slices.SortFunc(kinds, func(a, b used) int {
		return strings.Compare(a.group+"/"+a.kind+"/"+a.version, b.group+"/"+b.kind+"/"+b.version)
	})
	return kinds, nil
}

// crd is the parts of a CustomResourceDefinition a schema is made from.
type crd struct {
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Spec struct {
		Group string `json:"group"`
		Names struct {
			Kind string `json:"kind"`
		} `json:"names"`
		Versions []struct {
			Name   string `json:"name"`
			Schema struct {
				OpenAPIV3Schema map[string]any `json:"openAPIV3Schema"`
			} `json:"schema"`
		} `json:"versions"`
	} `json:"spec"`
}

// selfDescribed are the kinds of Kubernetes' own whose schema comes from
// the cluster too. A CustomResourceDefinition holds schemas, so its own
// schema holds itself, and the published set of schemas, each whole in one
// file, has none for it.
var selfDescribed = []used{{"apiextensions.k8s.io", "CustomResourceDefinition", "v1"}}

// schemas writes infra/schemas: for each kind the manifests use that the
// cluster defines as a custom resource, the JSON schema of the version
// they use, from the cluster's own definition; and for a
// CustomResourceDefinition itself, from the cluster's description of its
// API. The cluster runs exactly the versions of Kubernetes, Flux,
// CloudNativePG, the Gateway API, Traefik and k3s the manifests are
// written for, so its definitions are the ones to check them against.
// Schemas no longer used are removed. The other kinds are Kubernetes' own,
// whose schemas are not kept here.
func (c *cluster) schemas(ctx context.Context) error {
	if err := c.checkTools(); err != nil {
		return err
	}
	t, err := manifests.ReadTree(clusterDir)
	if err != nil {
		return err
	}
	kinds, err := usedKinds(t)
	if err != nil {
		return err
	}
	out, err := c.kubectl(ctx, nil, "get", "customresourcedefinitions.apiextensions.k8s.io", "-o", "json")
	if err != nil {
		return err
	}
	var list struct {
		Items []crd `json:"items"`
	}
	if err := json.Unmarshal(out, &list); err != nil {
		return fmt.Errorf("reading the cluster's custom resource definitions: %w", err)
	}
	files, err := crdSchemas(kinds, list.Items)
	if err != nil {
		return err
	}
	for _, k := range selfDescribed {
		if !slices.Contains(kinds, k) {
			continue
		}
		// The API group's description, in OpenAPI 3 (Kubernetes'
		// documentation, "The Kubernetes API", OpenAPI V3).
		doc, err := c.kubectl(ctx, nil, "get", "--raw", "/openapi/v3/apis/"+k.group+"/"+k.version)
		if err != nil {
			return err
		}
		data, err := apiSchema(doc, k)
		if err != nil {
			return err
		}
		files[manifests.SchemaFile(k.group, k.kind, k.version)] = data
	}
	written, removed, err := writeSchemas(schemasDir, files)
	if err != nil {
		return err
	}
	for _, f := range written {
		c.logf("wrote %s", filepath.Join(schemasDir, f))
	}
	for _, f := range removed {
		c.logf("removed %s, which no manifest uses", filepath.Join(schemasDir, f))
	}
	c.logf("%s holds the %d schemas the manifests need beside those of Kubernetes' own kinds; %d changed", schemasDir, len(files), len(written)+len(removed))
	return nil
}

// crdSchemas makes the schema file of each used kind a definition exists
// for, by its path under infra/schemas.
func crdSchemas(kinds []used, crds []crd) (map[string][]byte, error) {
	files := map[string][]byte{}
	for _, k := range kinds {
		for _, d := range crds {
			if d.Spec.Group != k.group || d.Spec.Names.Kind != k.kind {
				continue
			}
			var schema map[string]any
			for _, v := range d.Spec.Versions {
				if v.Name == k.version {
					schema = v.Schema.OpenAPIV3Schema
				}
			}
			if schema == nil {
				return nil, fmt.Errorf("the manifests use %s %s at %s, a version the cluster's %s does not define", k.group, k.kind, k.version, d.Metadata.Name)
			}
			schema = strictSchema(schema).(map[string]any)
			schema["$comment"] = fmt.Sprintf("The schema of %s %s/%s, from the definition %s in the local cluster, written by go run ./tools/cluster -schemas. Not edited by hand.", k.kind, k.group, k.version, d.Metadata.Name)
			data, err := json.MarshalIndent(schema, "", "  ")
			if err != nil {
				return nil, err
			}
			files[manifests.SchemaFile(k.group, k.kind, k.version)] = append(data, '\n')
		}
	}
	return files, nil
}

// componentRef is how an OpenAPI 3 description refers to one of its
// schemas; defRef, how a JSON schema refers to one of its definitions.
const (
	componentRef = "#/components/schemas/"
	defRef       = "#/$defs/"
)

// apiSchema makes the schema file of a kind of Kubernetes' own from the
// OpenAPI 3 description of its API group: the kind's schema, with the
// schemas it refers to, however deep, beside it as definitions.
func apiSchema(doc []byte, k used) ([]byte, error) {
	var api struct {
		Components struct {
			Schemas map[string]map[string]any `json:"schemas"`
		} `json:"components"`
	}
	if err := json.Unmarshal(doc, &api); err != nil {
		return nil, fmt.Errorf("reading the cluster's description of %s/%s: %w", k.group, k.version, err)
	}
	root := ""
	for name, s := range api.Components.Schemas {
		for _, gvk := range manifests.List(s, "x-kubernetes-group-version-kind") {
			if manifests.Str(gvk, "group") == k.group && manifests.Str(gvk, "kind") == k.kind && manifests.Str(gvk, "version") == k.version {
				root = name
			}
		}
	}
	if root == "" {
		return nil, fmt.Errorf("the cluster's description of %s/%s has no %s", k.group, k.version, k.kind)
	}
	defs := map[string]any{}
	var need func(name string) error
	need = func(name string) error {
		if _, done := defs[name]; done {
			return nil
		}
		s, ok := api.Components.Schemas[name]
		if !ok {
			return fmt.Errorf("the cluster's description of %s/%s refers to %s, which it does not hold", k.group, k.version, name)
		}
		defs[name] = nil // being made: a schema may refer to itself
		var err error
		defs[name] = rewriteRefs(strictSchema(s), func(ref string) {
			if e := need(ref); e != nil {
				err = e
			}
		})
		return err
	}
	if err := need(root); err != nil {
		return nil, err
	}
	schema := map[string]any{
		"$comment": fmt.Sprintf("The schema of %s %s/%s, from the local cluster's description of its API, written by go run ./tools/cluster -schemas. Not edited by hand.", k.kind, k.group, k.version),
		"$ref":     defRef + root,
		"$defs":    defs,
	}
	data, err := json.MarshalIndent(schema, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

// rewriteRefs turns each reference to a component of an OpenAPI
// description into one to a definition of the schema, and calls found
// with the component's name.
func rewriteRefs(v any, found func(name string)) any {
	switch v := v.(type) {
	case map[string]any:
		for key, val := range v {
			if ref, ok := val.(string); ok && key == "$ref" && strings.HasPrefix(ref, componentRef) {
				name := strings.TrimPrefix(ref, componentRef)
				v[key] = defRef + name
				found(name)
				continue
			}
			v[key] = rewriteRefs(val, found)
		}
	case []any:
		for i, val := range v {
			v[i] = rewriteRefs(val, found)
		}
	}
	return v
}

// strictSchema turns the OpenAPI schema of a custom resource's version
// into the JSON schema kubeconform checks manifests against. An object
// with named properties accepts no others, as the API server prunes or
// refuses them, unless it says it keeps unknown fields. OpenAPI's
// nullable and its exclusive bounds are written the JSON Schema way.
// Descriptions are dropped: they check nothing.
func strictSchema(v any) any {
	s, ok := v.(map[string]any)
	if !ok {
		return v
	}
	out := map[string]any{}
	for key, val := range s {
		switch key {
		case "description":
		case "properties", "patternProperties", "definitions":
			// Names to schemas: a name is not a keyword.
			props, _ := val.(map[string]any)
			named := map[string]any{}
			for name, p := range props {
				named[name] = strictSchema(p)
			}
			out[key] = named
		case "items", "additionalProperties", "not":
			out[key] = strictSchema(val)
		case "allOf", "anyOf", "oneOf":
			list, _ := val.([]any)
			each := make([]any, len(list))
			for i, p := range list {
				each[i] = strictSchema(p)
			}
			out[key] = each
		default:
			out[key] = val
		}
	}
	if _, has := out["properties"]; has && out["additionalProperties"] == nil && out["x-kubernetes-preserve-unknown-fields"] != true {
		out["additionalProperties"] = false
	}
	if t, isString := out["type"].(string); isString && out["nullable"] == true {
		out["type"] = []any{t, "null"}
	}
	delete(out, "nullable")
	for bound, exclusive := range map[string]string{"minimum": "exclusiveMinimum", "maximum": "exclusiveMaximum"} {
		switch out[exclusive] {
		case true:
			out[exclusive] = out[bound]
			delete(out, bound)
		case false:
			delete(out, exclusive)
		}
	}
	return out
}

// writeSchemas makes dir hold exactly files: it writes those that differ,
// removes the JSON files that are not among them, and says which.
func writeSchemas(dir string, files map[string][]byte) (written, removed []string, err error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, nil, err
	}
	for name, data := range files {
		p := filepath.Join(dir, name)
		if have, err := os.ReadFile(p); err == nil && bytes.Equal(have, data) {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return nil, nil, err
		}
		if err := os.WriteFile(p, data, 0o644); err != nil {
			return nil, nil, err
		}
		written = append(written, name)
	}
	err = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || filepath.Ext(p) != ".json" {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		if _, ok := files[rel]; ok {
			return nil
		}
		removed = append(removed, rel)
		return os.Remove(p)
	})
	if err != nil {
		return nil, nil, err
	}
	// A group's folder left empty goes with its last schema.
	groups, err := os.ReadDir(dir)
	if err != nil {
		return nil, nil, err
	}
	for _, g := range groups {
		if g.IsDir() {
			_ = os.Remove(filepath.Join(dir, g.Name()))
		}
	}
	slices.Sort(written)
	slices.Sort(removed)
	return written, removed, nil
}
