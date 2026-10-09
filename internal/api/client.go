// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path"
	"strings"
	"time"
)

// The page's files are cached as the build names them: assets carry a hash
// of their content in their names, so a new build never reuses one and they
// can be kept for a year; the HTML pages and the licences notice keep their
// names, so browsers ask each time whether they changed.
const (
	assetCache = "public, max-age=31536000, immutable"
	pageCache  = "no-cache"
)

// contentTypes are the types the page's files are served as, by extension,
// whatever the machine's own table says. Browsers compile WebAssembly while
// it downloads only when it comes as application/wasm.
var contentTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json",
	".txt":   "text/plain; charset=utf-8",
	".wasm":  "application/wasm",
	".glb":   "model/gltf-binary",
	".woff2": "font/woff2",
	".woff":  "font/woff",
	".ttf":   "font/ttf",
	".otf":   "font/otf",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".webp":  "image/webp",
	".avif":  "image/avif",
	".jpg":   "image/jpeg",
	".ogg":   "audio/ogg",
	".opus":  "audio/ogg",
	".mp3":   "audio/mpeg",
}

// Page is the game's built page, read whole from a directory when the
// server starts: index.html and the other files at its top level, and the
// files in assets/. Nothing else in the directory is served: no listings,
// no other folders, no file whose name starts with a dot.
type Page struct {
	files map[string]pageFile
}

type pageFile struct {
	body        []byte
	contentType string
	modified    time.Time
}

// OpenPage reads the page from dir. It fails if dir has no index.html.
func OpenPage(dir string) (*Page, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, fmt.Errorf("the page's directory: %w", err)
	}
	defer root.Close()
	p := &Page{files: map[string]pageFile{}}
	for _, sub := range []string{".", "assets"} {
		entries, err := fs.ReadDir(root.FS(), sub)
		if sub == "assets" && errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("the page's directory: %w", err)
		}
		for _, e := range entries {
			if !e.Type().IsRegular() || !servable(e.Name()) {
				continue
			}
			name := path.Join(sub, e.Name())
			body, err := fs.ReadFile(root.FS(), name)
			if err != nil {
				return nil, err
			}
			info, err := e.Info()
			if err != nil {
				return nil, err
			}
			ct, ok := contentTypes[path.Ext(name)]
			if !ok {
				ct = "application/octet-stream"
			}
			p.files[name] = pageFile{body: body, contentType: ct, modified: info.ModTime()}
		}
	}
	if _, ok := p.files["index.html"]; !ok {
		return nil, fmt.Errorf("the page's directory %s has no index.html", dir)
	}
	return p, nil
}

// servable is a name the page may serve: not hidden, nothing but a name.
func servable(name string) bool {
	return name != "" && !strings.HasPrefix(name, ".") && !strings.ContainsAny(name, `/\`)
}

// Size is the bytes the page holds.
func (p *Page) Size() int {
	n := 0
	for _, f := range p.files {
		n += len(f.body)
	}
	return n
}

// pageRoutes are the page's routes: GET, and so HEAD. They need no session.
var pageRoutes = map[string]bool{"GET /{$}": true, "GET /{file}": true, "GET /assets/{file}": true}

func (p *Page) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		p.serve(w, r, "index.html", pageCache)
	})
	mux.HandleFunc("GET /{file}", func(w http.ResponseWriter, r *http.Request) {
		p.serve(w, r, r.PathValue("file"), pageCache)
	})
	mux.HandleFunc("GET /assets/{file}", func(w http.ResponseWriter, r *http.Request) {
		p.serve(w, r, "assets/"+r.PathValue("file"), assetCache)
	})
}

func (p *Page) serve(w http.ResponseWriter, r *http.Request, name, cache string) {
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	f, ok := p.files[name]
	if !ok || !servable(path.Base(name)) {
		writeError(w, http.StatusNotFound, "not-found")
		return
	}
	h.Set("Content-Type", f.contentType)
	h.Set("Cache-Control", cache)
	http.ServeContent(w, r, "", f.modified, bytes.NewReader(f.body))
}

// cleanPaths answers 404 to a path with dot segments or repeated slashes,
// where the mux would redirect it to a cleaner one: browsers never send
// such a path, and nothing is reached by it.
func cleanPaths(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		clean := path.Clean(p)
		if strings.HasSuffix(p, "/") && clean != "/" {
			clean += "/"
		}
		if p != "" && p != clean {
			w.Header().Set("X-Content-Type-Options", "nosniff")
			writeError(w, http.StatusNotFound, "not-found")
			return
		}
		next.ServeHTTP(w, r)
	})
}
