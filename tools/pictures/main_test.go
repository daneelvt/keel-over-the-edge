// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A test's try that failed at a picture that differed, as error-context.md says it.
const differs = "Error: expect(locator).toHaveScreenshot(expected) failed\n\nLocator: locator('canvas.scene')\n" +
	"  77033 pixels (ratio 0.54 of all image pixels) are different.\n\n  Snapshot: %s.png\n"

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// try writes a try's output folder in an artifact: its error-context.md and
// the pictures it drew.
func try(t *testing.T, root, artifact, folder, context string, actual map[string]string) {
	t.Helper()
	dir := filepath.Join(root, artifact, "test-results", folder)
	write(t, filepath.Join(dir, "error-context.md"), context)
	for name, body := range actual {
		write(t, filepath.Join(dir, name+"-actual.png"), body)
		write(t, filepath.Join(dir, name+"-diff.png"), "diff")
	}
}

func TestAdoptTakesTheLastTryOfEachFailedPicture(t *testing.T) {
	root := t.TempDir()
	pics := filepath.Join(root, "pictures")
	for _, p := range []string{"webgl2-linux", "webgpu-linux", "webgl2-darwin"} {
		write(t, filepath.Join(pics, p, "sea-calm.png"), "old")
	}
	run := filepath.Join(root, "run")
	// The sea, on WebGL 2: both tries differed; the retry's is adopted.
	try(t, run, "playwright-webgl2-short-1", "sea-the-calm-sea-webgl2", strings.ReplaceAll(differs, "%s", "sea-calm"),
		map[string]string{"sea-calm": "first"})
	try(t, run, "playwright-webgl2-short-1", "sea-the-calm-sea-webgl2-retry1", strings.ReplaceAll(differs, "%s", "sea-calm"),
		map[string]string{"sea-calm": "second"})
	// A new picture on WebGPU, with no expected one; the folder's middle cut
	// short, as Playwright cuts a long title.
	try(t, run, "playwright-webgpu-short-2", "fog-a-bank-of-fo-3f2a1-on-the-boat-webgpu",
		"Error: A snapshot doesn't exist at /x/fog-bank.png, writing actual.", map[string]string{"fog-bank": "new"})
	// A test that failed at something else after drawing: not adopted.
	try(t, run, "playwright-webgl2-short-2", "lights-the-lantern-webgl2", "Error: expect(received).toBe(expected)",
		map[string]string{"lantern": "wrong"})
	// A project with no Linux pictures: not adopted.
	try(t, run, "playwright-webkit", "layout-the-list-webkit", strings.ReplaceAll(differs, "%s", "list"),
		map[string]string{"list": "webkit"})

	var out strings.Builder
	if err := adopt(pics, "", run, "", false, &out); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"webgl2-linux/sea-calm.png":  "second",
		"webgpu-linux/sea-calm.png":  "old",
		"webgpu-linux/fog-bank.png":  "new",
		"webgl2-darwin/sea-calm.png": "old",
	}
	for path, body := range want {
		got, err := os.ReadFile(filepath.Join(pics, path))
		if err != nil || string(got) != body {
			t.Errorf("%s is %q (%v), want %q", path, got, err, body)
		}
	}
	for _, missing := range []string{"webgl2-linux/lantern.png", "webkit-linux/list.png"} {
		if _, err := os.Stat(filepath.Join(pics, missing)); err == nil {
			t.Errorf("%s was written", missing)
		}
	}
	for _, line := range []string{
		"webgl2/sea-calm.png: 0.54 of its pixels differed",
		"webgpu/fog-bank.png: new",
		"2 pictures written",
	} {
		if !strings.Contains(out.String(), line) {
			t.Errorf("the list does not say %q:\n%s", line, out.String())
		}
	}
}

func TestAdoptListsWithoutWriting(t *testing.T) {
	root := t.TempDir()
	pics := filepath.Join(root, "pictures")
	write(t, filepath.Join(pics, "webgl2-linux", "sea-calm.png"), "old")
	run := filepath.Join(root, "run")
	try(t, run, "playwright-webgl2-short-1", "sea-the-calm-sea-webgl2", strings.ReplaceAll(differs, "%s", "sea-calm"),
		map[string]string{"sea-calm": "new"})
	var out strings.Builder
	if err := adopt(pics, "", run, "", true, &out); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(pics, "webgl2-linux", "sea-calm.png")); string(got) != "old" {
		t.Errorf("-n wrote the picture: %q", got)
	}
	if !strings.Contains(out.String(), "webgl2/sea-calm.png: 0.54") {
		t.Errorf("-n did not list it:\n%s", out.String())
	}
}

func TestAdoptWithNothingFailed(t *testing.T) {
	root := t.TempDir()
	pics := filepath.Join(root, "pictures")
	write(t, filepath.Join(pics, "webgl2-linux", "sea-calm.png"), "old")
	var out strings.Builder
	if err := adopt(pics, "", t.TempDir(), "", false, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "no picture failed") {
		t.Errorf("said %q", out.String())
	}
	if err := adopt(pics, "", "", "", false, &out); err == nil {
		t.Error("neither -run nor -dir was taken")
	}
}
