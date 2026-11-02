// SPDX-License-Identifier: AGPL-3.0-only

// Command pictures adopts the pictures a pr.render run drew where they
// differ from the expected ones: after a dependency update (three.js
// changes pixels in most of its releases) or a change of the software GPU,
// which redraws every picture. It downloads the run's playwright-*
// artifacts through the owner's gh login, takes the picture each test that
// failed at a picture drew (its -actual.png, the last try's), writes it over
// the expected one under client/e2e/pictures/<project>-linux/, and lists
// what changed, with the share of each picture's pixels that differed. Look
// at the pictures (the -diff.png beside each in the artifact shows where)
// and commit them. The Mac's pictures (-darwin) are recorded by hand.
//
//	go run ./tools/pictures -run 41462049097        adopt that run's pictures
//	go run ./tools/pictures -run 41462049097 -n     list them, writing nothing
//	go run ./tools/pictures -dir path/to/artifacts  from artifacts already downloaded
//
// It runs from the repository root.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// pictures is where the expected pictures are, one folder a project and
// platform.
const pictures = "client/e2e/pictures"

func main() {
	run := flag.String("run", "", "the id of the pr.render run whose pictures to adopt")
	dir := flag.String("dir", "", "a folder of the run's artifacts, already downloaded, instead of -run")
	repo := flag.String("repo", "daneelvt/keel-over-the-edge", "the repository, owner/name")
	dry := flag.Bool("n", false, "list the pictures, writing nothing")
	flag.Parse()
	if err := adopt(pictures, *run, *dir, *repo, *dry, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "pictures:", err)
		os.Exit(1)
	}
}

// adopt writes the run's pictures into the folders under pics.
func adopt(pics, run, dir, repo string, dry bool, out io.Writer) error {
	if (run == "") == (dir == "") {
		return errors.New("give -run or -dir")
	}
	projects, err := projectsIn(pics)
	if err != nil {
		return err
	}
	if run != "" {
		tmp, err := os.MkdirTemp("", "pictures-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(tmp)
		get := exec.Command("gh", "run", "download", run, "-R", repo, "-p", "playwright-*", "-D", tmp)
		get.Stdout, get.Stderr = os.Stderr, os.Stderr
		if err := get.Run(); err != nil {
			return fmt.Errorf("gh run download %s: %w", run, err)
		}
		dir = tmp
	}
	found, err := failed(dir, projects)
	if err != nil {
		return err
	}
	if len(found) == 0 {
		fmt.Fprintln(out, "no picture failed in the run")
		return nil
	}
	for _, f := range found {
		to := filepath.Join(pics, f.project+"-linux", f.name+".png")
		what := "new"
		if f.ratio != "" {
			what = f.ratio + " of its pixels differed"
		}
		fmt.Fprintf(out, "%s/%s.png: %s\n", f.project, f.name, what)
		if dry {
			continue
		}
		if err := copyFile(f.actual, to); err != nil {
			return err
		}
	}
	if !dry {
		fmt.Fprintf(out, "%d pictures written under %s: look at them, then commit\n", len(found), pics)
	}
	return nil
}

// A picture a test drew that was not the expected one.
type picture struct {
	project string
	// name is the picture's, as the test names it, without .png.
	name   string
	actual string
	// retry is the try that drew it, 0 for the first.
	retry int
	// ratio is the share of pixels that differed, as Playwright said it;
	// empty for a picture that had none expected.
	ratio string
}

// projectsIn lists the projects that have Linux pictures, by their folders.
func projectsIn(root string) ([]string, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range entries {
		if p, ok := strings.CutSuffix(e.Name(), "-linux"); ok && e.IsDir() {
			out = append(out, p)
		}
	}
	return out, nil
}

var (
	// A try's output folder ends with its project, and -retryN after the first.
	retrySuffix = regexp.MustCompile(`-retry(\d+)$`)
	// What error-context.md says of a picture that differed, and of one
	// that had none expected.
	differed  = regexp.MustCompile(`toHaveScreenshot\(expected\) failed[\s\S]*?ratio ([0-9.]+) of all image pixels`)
	noPicture = regexp.MustCompile(`A snapshot doesn't exist at`)
)

// failed finds, under dir, every picture a test failed at, the last try's
// of each.
func failed(dir string, projects []string) ([]picture, error) {
	last := map[string]picture{}
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, "-actual.png") {
			return err
		}
		folder := filepath.Base(filepath.Dir(path))
		retry := 0
		if m := retrySuffix.FindStringSubmatch(folder); m != nil {
			retry, _ = strconv.Atoi(m[1])
			folder = strings.TrimSuffix(folder, m[0])
		}
		project := ""
		for _, p := range projects {
			if strings.HasSuffix(folder, "-"+p) && len(p) > len(project) {
				project = p
			}
		}
		if project == "" {
			return nil
		}
		ctx, err := os.ReadFile(filepath.Join(filepath.Dir(path), "error-context.md"))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		f := picture{
			project: project,
			name:    strings.TrimSuffix(filepath.Base(path), "-actual.png"),
			actual:  path,
			retry:   retry,
		}
		switch m := differed.FindSubmatch(ctx); {
		case m != nil:
			f.ratio = string(m[1])
		case noPicture.Match(ctx):
		default:
			// The test failed at something other than a picture.
			return nil
		}
		key := f.project + "/" + f.name
		if was, ok := last[key]; !ok || f.retry > was.retry {
			last[key] = f
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	out := make([]picture, 0, len(last))
	for _, f := range last {
		out = append(out, f)
	}
	slices.SortFunc(out, func(a, b picture) int {
		return strings.Compare(a.project+"/"+a.name, b.project+"/"+b.name)
	})
	return out, nil
}

func copyFile(from, to string) error {
	b, err := os.ReadFile(from)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return err
	}
	return os.WriteFile(to, b, 0o644)
}
