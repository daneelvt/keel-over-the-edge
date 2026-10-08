// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"go/format"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"go.yaml.in/yaml/v3"
)

// Paths, relative to the repository root.
const (
	schemaPath  = "shared/catalog.schema.json"
	catalogDir  = "shared/catalog"
	artDir      = "art"
	soundDir    = "sound" // under artDir
	goJSONPath  = "internal/catalog/catalog.gen.json"
	goTypesPath = "internal/catalog/types.gen.go"
	tsJSONPath  = "client/src/catalog/catalog.gen.json"
	tsTypesPath = "client/src/catalog/types.gen.ts"
	json2ts     = "client/node_modules/.bin/json2ts"
)

const spdx = "SPDX-License-Identifier: AGPL-3.0-only"

// run validates the catalog under root and writes, or with check compares,
// every generated file. Warnings go to out.
func run(root string, check bool, out io.Writer) error {
	doc, err := readCatalog(root)
	if err != nil {
		return err
	}
	if err := validate(root, doc); err != nil {
		return err
	}
	if err := checkIDs(doc); err != nil {
		return err
	}
	warnings, err := checkArt(root, doc)
	if err != nil {
		return err
	}
	for _, w := range warnings {
		fmt.Fprintln(out, "warning:", w)
	}
	if err := checkIDsNotInCode(root, ids(doc)); err != nil {
		return err
	}

	canonical, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	canonical = append(canonical, '\n')
	version := Version(canonical)

	goTypes, err := goTypes(root, version)
	if err != nil {
		return err
	}
	tsTypes, err := tsTypes(root, version)
	if err != nil {
		return err
	}
	fields, err := physicsFields(root)
	if err != nil {
		return err
	}
	if err := checkParams(fields); err != nil {
		return err
	}
	goPhysics, err := goPhysics(fields)
	if err != nil {
		return err
	}
	files := map[string][]byte{
		goJSONPath:    canonical,
		goTypesPath:   goTypes,
		goPhysicsPath: goPhysics,
		tsJSONPath:    canonical,
		tsTypesPath:   tsTypes,
		tsParamsPath:  tsParams(fields),
	}
	return writeOrCheck(root, files, check)
}

// Version is the catalog version: the first 16 hex digits of the SHA-256 of
// the canonical JSON. A client and a server with different versions never
// play together.
func Version(canonical []byte) string {
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:])[:16]
}

// readCatalog reads every YAML file of the catalog and merges their top-level
// lists into one document, decoded as JSON values (json.Number for numbers).
func readCatalog(root string) (map[string]any, error) {
	paths, err := filepath.Glob(filepath.Join(root, catalogDir, "*.yaml"))
	if err != nil {
		return nil, err
	}
	if len(paths) == 0 {
		return nil, fmt.Errorf("no catalog files in %s", catalogDir)
	}
	sort.Strings(paths)

	merged := map[string]any{}
	from := map[string]string{}
	for _, p := range paths {
		raw, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		var part map[string]any
		if err := yaml.Unmarshal(raw, &part); err != nil {
			return nil, fmt.Errorf("%s: %w", rel(root, p), err)
		}
		// Round-trip through JSON so the values are what the schema validator
		// and the canonical encoding expect.
		asJSON, err := json.Marshal(part)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", rel(root, p), err)
		}
		v, err := jsonschema.UnmarshalJSON(bytes.NewReader(asJSON))
		if err != nil {
			return nil, fmt.Errorf("%s: %w", rel(root, p), err)
		}
		obj, ok := v.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("%s: the top level must be a mapping of lists", rel(root, p))
		}
		for key, list := range obj {
			if prev, dup := from[key]; dup {
				return nil, fmt.Errorf("%s: list %q is already defined in %s", rel(root, p), key, prev)
			}
			from[key] = rel(root, p)
			merged[key] = list
		}
	}
	return merged, nil
}

func validate(root string, doc map[string]any) error {
	raw, err := os.ReadFile(filepath.Join(root, schemaPath))
	if err != nil {
		return err
	}
	schemaDoc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("%s: %w", schemaPath, err)
	}
	c := jsonschema.NewCompiler()
	if err := c.AddResource(schemaPath, schemaDoc); err != nil {
		return err
	}
	sch, err := c.Compile(schemaPath)
	if err != nil {
		return fmt.Errorf("%s: %w", schemaPath, err)
	}
	if err := sch.Validate(any(doc)); err != nil {
		var ve *jsonschema.ValidationError
		if errors.As(err, &ve) {
			return fmt.Errorf("the catalog does not match %s:\n%s", schemaPath, describe(ve))
		}
		return err
	}
	return nil
}

// describe lists the leaf validation errors, each with its location in the
// catalog (list, kind and field).
func describe(ve *jsonschema.ValidationError) string {
	var lines []string
	var walk func(e *jsonschema.ValidationError)
	walk = func(e *jsonschema.ValidationError) {
		if len(e.Causes) == 0 {
			lines = append(lines, fmt.Sprintf("  /%s: %s", strings.Join(e.InstanceLocation, "/"), e.ErrorKind))
			return
		}
		for _, c := range e.Causes {
			walk(c)
		}
	}
	walk(ve)
	sort.Strings(lines)
	return strings.Join(slices.Compact(lines), "\n")
}

// kinds returns every kind of every list, by list name.
func kinds(doc map[string]any) map[string][]map[string]any {
	out := map[string][]map[string]any{}
	for name, list := range doc {
		items, _ := list.([]any)
		for _, it := range items {
			if k, ok := it.(map[string]any); ok {
				out[name] = append(out[name], k)
			}
		}
	}
	return out
}

func ids(doc map[string]any) []string {
	var out []string
	for _, ks := range kinds(doc) {
		for _, k := range ks {
			if id, ok := k["id"].(string); ok {
				out = append(out, id)
			}
		}
	}
	sort.Strings(out)
	return slices.Compact(out)
}

// checkIDs fails on an id used twice within one list.
func checkIDs(doc map[string]any) error {
	var problems []string
	for name, ks := range kinds(doc) {
		seen := map[string]bool{}
		for _, k := range ks {
			id, _ := k["id"].(string)
			if seen[id] {
				problems = append(problems, fmt.Sprintf("  %s: id %q is used more than once", name, id))
			}
			seen[id] = true
		}
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return fmt.Errorf("duplicate ids:\n%s", strings.Join(problems, "\n"))
	}
	return nil
}

// checkArt fails when an art path names a missing file, and warns about files
// under art/ that no kind references. Art paths live only in objects named
// "art", so the check needs no knowledge of the families of kinds.
func checkArt(root string, doc map[string]any) (warnings []string, err error) {
	referenced := map[string]bool{}
	var missing []string
	var walk func(v any, where string)
	walk = func(v any, where string) {
		switch t := v.(type) {
		case map[string]any:
			for key, child := range t {
				if key == "art" {
					art, _ := child.(map[string]any)
					for role, p := range art {
						path, _ := p.(string)
						referenced[path] = true
						if _, err := os.Stat(filepath.Join(root, artDir, filepath.FromSlash(path))); err != nil {
							missing = append(missing, fmt.Sprintf("  %s.art.%s: %s/%s does not exist", where, role, artDir, path))
						}
					}
					continue
				}
				walk(child, where+"."+key)
			}
		case []any:
			for i, child := range t {
				label := fmt.Sprintf("%s[%d]", where, i)
				if k, ok := child.(map[string]any); ok {
					if id, ok := k["id"].(string); ok {
						label = fmt.Sprintf("%s[%s]", where, id)
					}
				}
				walk(child, label)
			}
		}
	}
	walk(any(doc), "catalog")
	if len(missing) > 0 {
		sort.Strings(missing)
		return nil, fmt.Errorf("missing art:\n%s", strings.Join(missing, "\n"))
	}

	artRoot := filepath.Join(root, artDir)
	err = filepath.WalkDir(artRoot, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) && p == artRoot {
				return fs.SkipAll
			}
			return err
		}
		// The scripts that build the art are its source, not art a kind uses;
		// the sound recipes are read by the client's sound engine, not named
		// by a kind.
		if d.IsDir() || d.Name() == "README.md" || strings.HasSuffix(d.Name(), ".ts") {
			return nil
		}
		if r := filepath.ToSlash(rel(artRoot, p)); strings.HasPrefix(r, soundDir+"/") {
			return nil
		}
		r := filepath.ToSlash(rel(artRoot, p))
		if !referenced[r] {
			warnings = append(warnings, fmt.Sprintf("%s/%s is not referenced by any kind", artDir, r))
		}
		return nil
	})
	sort.Strings(warnings)
	return warnings, err
}

// checkIDsNotInCode fails when a kind's id appears as a string literal in Go
// or TypeScript source: code reads a kind's properties, never its name.
// Generated files, tests and test fixtures are not checked.
func checkIDsNotInCode(root string, ids []string) error {
	var found []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		name := d.Name()
		if d.IsDir() {
			switch name {
			case "node_modules", "dist", ".git", ".dev", "testdata":
				return fs.SkipDir
			}
			return nil
		}
		if !(strings.HasSuffix(name, ".go") || strings.HasSuffix(name, ".ts")) ||
			strings.Contains(name, ".gen.") || strings.HasSuffix(name, "_test.go") ||
			strings.HasSuffix(name, ".test.ts") {
			return nil
		}
		src, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		for _, id := range ids {
			for _, q := range []string{`"`, `'`, "`"} {
				if bytes.Contains(src, []byte(q+id+q)) {
					found = append(found, fmt.Sprintf("  %s: %s%s%s", rel(root, p), q, id, q))
				}
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	if len(found) > 0 {
		sort.Strings(found)
		return fmt.Errorf("code compares against a kind's id; read a property instead:\n%s", strings.Join(found, "\n"))
	}
	return nil
}

func goTypes(root, version string) ([]byte, error) {
	cmd := exec.Command("go", "tool", "go-jsonschema", schemaPath,
		"--package", "catalog", "--only-models", "--tags", "json",
		"--capitalization", "ID", "--struct-name-from-title", "--minimal-names")
	cmd.Dir = root
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	gen, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("go-jsonschema: %w\n%s", err, stderr.String())
	}
	var b bytes.Buffer
	fmt.Fprintf(&b, "// %s\n\n", spdx)
	b.Write(gen)
	fmt.Fprintf(&b, "\n// Version is the catalog version (tools/catalog).\nconst Version = %q\n", version)
	return format.Source(b.Bytes())
}

func tsTypes(root, version string) ([]byte, error) {
	bin := filepath.Join(root, json2ts)
	if _, err := os.Stat(bin); err != nil {
		return nil, fmt.Errorf("%s is missing: run npm ci in client/ first", json2ts)
	}
	banner := fmt.Sprintf("// %s\n// Code generated by tools/catalog from %s. DO NOT EDIT.", spdx, schemaPath)
	cmd := exec.Command(bin, "--input", schemaPath, "--bannerComment", banner,
		"--additionalProperties", "false", "--unreachableDefinitions")
	cmd.Dir = root
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	gen, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("json2ts: %w\n%s", err, stderr.String())
	}
	var b bytes.Buffer
	b.Write(gen)
	fmt.Fprintf(&b, "\n/** The catalog version (tools/catalog). */\nexport const CATALOG_VERSION = '%s';\n", version)
	return b.Bytes(), nil
}

func writeOrCheck(root string, files map[string][]byte, check bool) error {
	paths := make([]string, 0, len(files))
	for p := range files {
		paths = append(paths, p)
	}
	sort.Strings(paths)

	var stale []string
	for _, p := range paths {
		full := filepath.Join(root, filepath.FromSlash(p))
		old, err := os.ReadFile(full)
		if err == nil && bytes.Equal(old, files[p]) {
			continue
		}
		if check {
			stale = append(stale, "  "+p)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(full, files[p], 0o644); err != nil {
			return err
		}
	}
	if len(stale) > 0 {
		return fmt.Errorf("generated files are out of date; run go run ./tools/catalog:\n%s", strings.Join(stale, "\n"))
	}
	return nil
}

func rel(root, p string) string {
	r, err := filepath.Rel(root, p)
	if err != nil {
		return p
	}
	return filepath.ToSlash(r)
}
