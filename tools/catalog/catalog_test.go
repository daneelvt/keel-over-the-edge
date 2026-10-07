// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const validBoats = `boats:
  - id: test-boat
    name: Test boat
    description: A boat for tests
    capacity: 2
    lengthOverall: 3.5
`

// fixture makes a repository root holding the real schema and the given
// files, relative to that root.
func fixture(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	schema, err := os.ReadFile(filepath.Join("..", "..", schemaPath))
	if err != nil {
		t.Fatal(err)
	}
	files[schemaPath] = string(schema)
	for p, content := range files {
		full := filepath.Join(root, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

// checkAll runs every check of the tool except generation.
func checkAll(root string) error {
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
	if _, err := checkArt(root, doc); err != nil {
		return err
	}
	return checkIDsNotInCode(root, ids(doc))
}

func TestValidCatalog(t *testing.T) {
	root := fixture(t, map[string]string{"shared/catalog/boats.yaml": validBoats})
	if err := checkAll(root); err != nil {
		t.Fatal(err)
	}
}

func TestRejects(t *testing.T) {
	cases := []struct {
		name  string
		files map[string]string
		want  string
	}{
		{
			name:  "schema violation",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats, "capacity: 2", "capacity: 0", 1)},
			want:  "/boats/0/capacity",
		},
		{
			name:  "unknown field",
			files: map[string]string{"shared/catalog/boats.yaml": validBoats + "    colour: red\n"},
			want:  "colour",
		},
		{
			name:  "bad id",
			files: map[string]string{"shared/catalog/boats.yaml": strings.Replace(validBoats, "test-boat", "Test Boat", 1)},
			want:  "/boats/0/id",
		},
		{
			name: "duplicate id",
			files: map[string]string{"shared/catalog/boats.yaml": validBoats + strings.Replace(
				strings.TrimPrefix(validBoats, "boats:\n"), "Test boat", "Another", 1)},
			want: `id "test-boat" is used more than once`,
		},
		{
			name: "list defined twice",
			files: map[string]string{
				"shared/catalog/a.yaml": validBoats,
				"shared/catalog/b.yaml": validBoats,
			},
			want: "already defined",
		},
		{
			name: "missing art",
			files: map[string]string{"shared/catalog/boats.yaml": validBoats +
				"    art:\n      model: boats/test-boat/model.glb\n"},
			want: "art/boats/test-boat/model.glb does not exist",
		},
		{
			name: "id in code",
			files: map[string]string{
				"shared/catalog/boats.yaml": validBoats,
				"internal/x/x.go":           "package x\n\nvar special = \"test-boat\"\n",
			},
			want: `internal/x/x.go: "test-boat"`,
		},
		{
			name: "id in client code",
			files: map[string]string{
				"shared/catalog/boats.yaml": validBoats,
				"client/src/x.ts":           "export const special = 'test-boat';\n",
			},
			want: `client/src/x.ts: 'test-boat'`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := checkAll(fixture(t, tc.files))
			if err == nil {
				t.Fatal("accepted")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not mention %q", err, tc.want)
			}
		})
	}
}

func TestIDsAllowedInTestsAndGeneratedFiles(t *testing.T) {
	root := fixture(t, map[string]string{
		"shared/catalog/boats.yaml":        validBoats,
		"internal/x/x_test.go":             "package x\n\nvar b = \"test-boat\"\n",
		"internal/x/types.gen.go":          "package x\n\nvar b = \"test-boat\"\n",
		"client/src/x.test.ts":             "const b = 'test-boat';\n",
		"internal/x/testdata/fixture.go":   "package x\n\nvar b = \"test-boat\"\n",
		"client/node_modules/pkg/index.ts": "const b = 'test-boat';\n",
	})
	if err := checkAll(root); err != nil {
		t.Fatal(err)
	}
}

func TestArtPresentAndUnreferenced(t *testing.T) {
	root := fixture(t, map[string]string{
		"shared/catalog/boats.yaml":     validBoats + "    art:\n      model: boats/test-boat/model.glb\n",
		"art/boats/test-boat/model.glb": "glTF",
		"art/boats/orphan.png":          "png",
		"art/README.md":                 "readme",
	})
	doc, err := readCatalog(root)
	if err != nil {
		t.Fatal(err)
	}
	warnings, err := checkArt(root, doc)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "art/boats/orphan.png") {
		t.Fatalf("warnings = %q, want one about the orphan", warnings)
	}
}

func TestCanonicalJSONIgnoresFileOrderAndLayout(t *testing.T) {
	a := fixture(t, map[string]string{"shared/catalog/boats.yaml": validBoats})
	reordered := `boats:
  - lengthOverall: 3.50
    capacity: 2
    description: A boat for tests
    name: Test boat
    id: test-boat
`
	b := fixture(t, map[string]string{"shared/catalog/boats.yaml": reordered})
	encode := func(root string) string {
		doc, err := readCatalog(root)
		if err != nil {
			t.Fatal(err)
		}
		out, err := json.Marshal(doc)
		if err != nil {
			t.Fatal(err)
		}
		return string(out)
	}
	if encode(a) != encode(b) {
		t.Fatalf("canonical JSON differs:\n%s\n%s", encode(a), encode(b))
	}
}

func TestWriteOrCheck(t *testing.T) {
	root := t.TempDir()
	files := map[string][]byte{"out/a.json": []byte("{}\n")}
	if err := writeOrCheck(root, files, true); err == nil {
		t.Fatal("check passed with the file missing")
	}
	if err := writeOrCheck(root, files, false); err != nil {
		t.Fatal(err)
	}
	if err := writeOrCheck(root, files, true); err != nil {
		t.Fatalf("check failed after writing: %v", err)
	}
}
