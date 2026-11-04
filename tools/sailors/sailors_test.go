// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBlenderVersion(t *testing.T) {
	for out, want := range map[string]string{
		"Blender 5.2.0 LTS\n\tbuild date: 2026-07-14\n": "5.2.0",
		"Blender 5.2.3 LTS (hash 1234)\n":               "5.2.3",
	} {
		if got, err := blenderVersion(out); err != nil || got != want {
			t.Errorf("%q: %s, %v", out, got, err)
		}
	}
	for _, out := range []string{"Blender 5.1.2\n", "Blender 5.2.0\n", "Blender 4.2.9 LTS\n", "something else\n"} {
		if v, err := blenderVersion(out); err == nil {
			t.Errorf("%q was accepted as %s", out, v)
		}
	}
}

func TestShown(t *testing.T) {
	for line, want := range map[string]bool{
		"[INFO ] mpfb.init ......: MPFB initialization has finished.": false,
		"OBJ import of 'base.obj' took 5.29 ms":                       false,
		"Blender 5.2.0 LTS (hash fbe6228777e7)":                       false,
		"build: test in 13.2 s":                                       true,
		"Traceback (most recent call last):":                          true,
		"   ":                                                         false,
	} {
		if shown(line) != want {
			t.Errorf("%q shown: %v", line, !want)
		}
	}
}

// sources writes a SOURCES.md and the vendored files into a temporary
// sailors folder.
func sources(t *testing.T, table string, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for p, body := range files {
		full := filepath.Join(dir, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	doc := "# Sources\n\n## Programs\n\n| Program | Version | Licence | From | SHA-256 |\n|---|---|---|---|---|\n" +
		"| MPFB | 2.0.18 | GPL | here | " + mpfbSHA256 + " |\n" +
		"| gltfpack | 1.3 | MIT | here | " + gltfpackSHA256() + " |\n\n## Files\n\n| File | Pack | Licence | SHA-256 |\n|---|---|---|---|\n" + table
	if err := os.WriteFile(filepath.Join(dir, sourcesFile), []byte(doc), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func digestOf(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func TestReadSources(t *testing.T) {
	eyes := "o eyes\n"
	dir := sources(t, "| `vendor/eyes.obj` | system assets | CC0-1.0 | "+digestOf(eyes)+" |\n",
		map[string]string{"vendor/eyes.obj": eyes})
	got, err := readSources(dir)
	if err != nil {
		t.Fatal(err)
	}
	if s := got["vendor/eyes.obj"]; s.Pack != "system assets" || s.Licence != "CC0-1.0" {
		t.Errorf("read %+v", got)
	}
}

func TestReadSourcesRefuses(t *testing.T) {
	eyes := "o eyes\n"
	for name, c := range map[string]struct {
		table string
		files map[string]string
		want  string
	}{
		"a vendored file not listed": {"", map[string]string{"vendor/eyes.obj": eyes}, "is not in SOURCES.md"},
		"a changed file": {"| vendor/eyes.obj | p | CC0-1.0 | " + digestOf("o other\n") + " |\n",
			map[string]string{"vendor/eyes.obj": eyes}, "has SHA-256"},
		"a listed file missing": {"| vendor/eyes.obj | p | CC0-1.0 | " + digestOf(eyes) + " |\n", nil, "cannot be read"},
		"a licence that asks for credit": {"| vendor/eyes.obj | p | CC-BY-4.0 | " + digestOf(eyes) + " |\n",
			map[string]string{"vendor/eyes.obj": eyes}, "only CC0-1.0"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := readSources(sources(t, c.table, c.files))
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("%v, want %q", err, c.want)
			}
		})
	}
}

// TestRepositorySources: the repository's own list is whole and true.
func TestRepositorySources(t *testing.T) {
	if _, err := readSources(filepath.Join("..", "..", sailorsDir)); err != nil {
		t.Fatal(err)
	}
}

func TestReadLooks(t *testing.T) {
	looks, err := readLooks(filepath.Join("..", "..", looksDir), "")
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, l := range looks {
		ids[l.ID] = true
	}
	if !ids["test"] {
		t.Errorf("no test sailor among %v", ids)
	}
	if _, err := readTables(filepath.Join("..", "..", sailorsDir)); err != nil {
		t.Fatal(err)
	}
}

func TestLookRefused(t *testing.T) {
	good := "id: x\nname: X\nversions:\n  female:\n    base: female\npalette: {main: '#000000', skin: '#111111', hair: '#222222'}\n"
	for name, c := range map[string]struct{ body, want string }{
		"a field no look has": {good + "colour: red\n", "not found"},
		"another id":          {strings.Replace(good, "id: x", "id: y", 1), "not its file's name"},
		"a third version":     {strings.Replace(good, "female:", "child:", 1), "a look's versions"},
		"a fixed part without its colour": {good + "garments:\n  - {id: coat, family: coat, region: fixed}\n",
			"a fixed region has its own colour"},
		"a part twice": {good + "garments:\n  - {id: coat, family: coat, region: main}\n  - {id: coat, family: coat, region: main}\n",
			"used twice"},
		"a palette not a colour": {strings.Replace(good, "'#000000'", "black", 1), "not #RRGGBB"},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "x.yaml"), []byte(c.body), 0o644); err != nil {
				t.Fatal(err)
			}
			_, err := readLooks(dir, "x")
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("%v, want %q", err, c.want)
			}
		})
	}
}

func TestJob(t *testing.T) {
	l := look{ID: "rover", Committed: true}
	j := newJob("/repo", l, tables{}, nil, ".dev/gltfpack/1.3/gltfpack")
	if j.Out != "/repo/art/sailors/rover" || j.Work != "/repo/.dev/sailors/runs/rover" || j.Gltfpack != "/repo/.dev/gltfpack/1.3/gltfpack" {
		t.Errorf("a committed look's job: %+v", j)
	}
	l.Committed = false
	if j := newJob("/repo", l, tables{}, nil, "/bin/gltfpack"); j.Out != "/repo/.dev/sailors/rover" || j.Gltfpack != "/bin/gltfpack" {
		t.Errorf("a check's job: %+v", j)
	}
	file, err := j.write(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var back map[string]any
	if err := json.Unmarshal(raw, &back); err != nil || back["out"] != j.Out {
		t.Errorf("the job read back: %v, %v", back["out"], err)
	}
}
