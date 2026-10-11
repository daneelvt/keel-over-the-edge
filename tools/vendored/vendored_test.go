// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestRepositorysFiles: every vendored file in the repository is the one
// its release published.
func TestRepositorysFiles(t *testing.T) {
	t.Chdir("../..")
	if err := checkAll(listFile); err != nil {
		t.Fatal(err)
	}
}

// TestPull: a file is fetched from its release and held to the release's
// checksums and to the SHA-256 the list pins, which is recorded the first
// time; a file that differs from either is not written.
func TestPull(t *testing.T) {
	const manifest = "kind: Namespace\n"
	body, sums := manifest, ""
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/o/r/releases/download/v1.2.3/manifest.yaml":
			io.WriteString(w, body)
		case "/o/r/releases/download/v1.2.3/sha256sum.txt":
			io.WriteString(w, sums)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	// As if GitHub: the list names github.com, and the client goes to srv.
	hc := srv.Client()
	hc.Transport = rewriteHost{hc.Transport, strings.TrimPrefix(srv.URL, "https://")}
	t.Chdir(t.TempDir())
	list := "vendor.yaml"
	write := func(sha string) {
		os.WriteFile(list, []byte("# A comment that stays.\nfiles:\n  - file: out/manifest.yaml\n    url: https://github.com/o/r/releases/download/v1.2.3/manifest.yaml\n"+
			"    checksums: https://github.com/o/r/releases/download/v1.2.3/sha256sum.txt\n    sha256: "+sha+"\n"), 0o644)
	}
	write(`""`)
	sums = sum([]byte(manifest)) + "  dist/artifacts/manifest.yaml\n" + strings.Repeat("0", 64) + "  other.yaml\n"
	if err := pullAll(context.Background(), list, hc, io.Discard); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join("out", "manifest.yaml")); string(got) != manifest {
		t.Errorf("wrote %q", got)
	}
	got, _ := os.ReadFile(list)
	if !strings.Contains(string(got), "sha256: "+sum([]byte(manifest))+"\n") || !strings.HasPrefix(string(got), "# A comment that stays.\n") {
		t.Errorf("the list after a first pull:\n%s", got)
	}
	if err := checkAll(list); err != nil {
		t.Fatal(err)
	}
	// The release's file changes: refused by its own checksums, then, were
	// they changed with it, by the pin.
	body = "kind: Namespace # and more\n"
	if err := pullAll(context.Background(), list, hc, io.Discard); err == nil || !strings.Contains(err.Error(), "its release's checksums say") {
		t.Errorf("a file its checksums do not match: %v", err)
	}
	sums = sum([]byte(body)) + "  manifest.yaml\n"
	if err := pullAll(context.Background(), list, hc, io.Discard); err == nil || !strings.Contains(err.Error(), "pinned") {
		t.Errorf("a file the pin does not match: %v", err)
	}
	if got, _ := os.ReadFile(filepath.Join("out", "manifest.yaml")); string(got) != manifest {
		t.Errorf("a refused file was written: %q", got)
	}
	// The file in the repository edited: -check says so.
	os.WriteFile(filepath.Join("out", "manifest.yaml"), []byte(manifest+"# edited\n"), 0o644)
	if err := checkAll(list); err == nil || !strings.Contains(err.Error(), "kept as published") {
		t.Errorf("an edited file: %v", err)
	}
	// A branch's file is no release's.
	os.WriteFile(list, []byte("files:\n  - file: out/manifest.yaml\n    url: https://raw.githubusercontent.com/o/r/main/manifest.yaml\n    sha256: "+sum([]byte(manifest))+"\n"), 0o644)
	if err := pullAll(context.Background(), list, hc, io.Discard); err == nil || !strings.Contains(err.Error(), "not a file of a release") {
		t.Errorf("a branch's file: %v", err)
	}
}

// rewriteHost sends every request to host, whatever host it names.
type rewriteHost struct {
	next http.RoundTripper
	host string
}

func (r rewriteHost) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	req.URL.Host = r.host
	return r.next.RoundTrip(req)
}
