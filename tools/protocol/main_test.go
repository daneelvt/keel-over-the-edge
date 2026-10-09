// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// tree writes a scratch repository with the schema and the layout.
func tree(t *testing.T, proto, snapshot string) string {
	t.Helper()
	root := t.TempDir()
	for path, data := range map[string]string{schema: proto, layout: snapshot} {
		if err := os.MkdirAll(filepath.Join(root, filepath.Dir(path)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, path), []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestVersionFollowsBothFiles(t *testing.T) {
	v := func(proto, snapshot string) string {
		got, err := version(tree(t, proto, snapshot))
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 16 {
			t.Fatalf("version %q is not 16 digits", got)
		}
		return got
	}
	base := v("message A {}", "layout 1")
	if again := v("message A {}", "layout 1"); again != base {
		t.Errorf("the same files gave %s and %s", base, again)
	}
	if v("message B {}", "layout 1") == base {
		t.Error("a change to the schema left the version unchanged")
	}
	if v("message A {}", "layout 2") == base {
		t.Error("a change to the snapshot's layout left the version unchanged")
	}
	// Text moved from one file to the other is a change too.
	if v("message A {}l", "ayout 1") == base {
		t.Error("moving text between the files left the version unchanged")
	}
}

func TestCompareFindsStaleFiles(t *testing.T) {
	root, gen := t.TempDir(), t.TempDir()
	write := func(dir, path, data string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Join(dir, filepath.Dir(path)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, path), []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(root, "out/a.go", "same")
	write(gen, "out/a.go", "same")
	write(root, "out/b.go", "old")
	write(gen, "out/b.go", "new")
	write(root, "out/gone.go", "left behind")
	write(gen, "out/new.go", "not committed")
	write(root, "v.go", "1")
	write(gen, "v.go", "1")
	stale, err := compare(root, gen, []string{"out", "v.go"})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"out/b.go", "out/gone.go", "out/new.go"}; !slices.Equal(stale, want) {
		t.Fatalf("stale %v, want %v", stale, want)
	}
	write(gen, "v.go", "2")
	if stale, _ := compare(root, gen, []string{"v.go"}); !slices.Equal(stale, []string{"v.go"}) {
		t.Fatalf("a changed version file: stale %v", stale)
	}
}

// TestCommittedFilesAreCurrent runs the check on the repository itself,
// when buf has been installed.
func TestCommittedFilesAreCurrent(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, buf)); err != nil {
		t.Skip("buf is not installed: npm ci in client")
	}
	if err := runCheck(t.Context(), root); err != nil {
		t.Fatal(err)
	}
}
