// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"mime"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
)

// cloudflareCompresses are the media types Cloudflare compresses by default
// on the way to a visitor who accepts it, as its documentation lists them
// (developers.cloudflare.com/speed/optimization/content/compression).
var cloudflareCompresses = map[string]bool{
	"text/html": true, "text/richtext": true, "text/plain": true, "text/css": true,
	"text/x-script": true, "text/x-component": true, "text/x-java-source": true,
	"text/x-markdown": true, "application/javascript": true, "application/x-javascript": true,
	"text/javascript": true, "text/js": true, "image/x-icon": true,
	"image/vnd.microsoft.icon": true, "application/x-perl": true, "application/x-httpd-cgi": true,
	"text/xml": true, "application/xml": true, "application/rss+xml": true,
	"application/vnd.api+json": true, "application/x-protobuf": true, "application/json": true,
	"multipart/bag": true, "multipart/mixed": true, "application/xhtml+xml": true,
	"font/ttf": true, "font/otf": true, "font/x-woff": true, "image/svg+xml": true,
	"application/vnd.ms-fontobject": true, "application/ttf": true, "application/x-ttf": true,
	"application/otf": true, "application/x-otf": true, "application/truetype": true,
	"application/opentype": true, "application/x-opentype": true, "application/font-woff": true,
	"application/eot": true, "application/font": true, "application/font-sfnt": true,
	"application/wasm": true, "application/javascript-binast": true,
	"application/manifest+json": true, "application/ld+json": true,
	"application/graphql+json": true, "application/geo+json": true,
}

// ruleCompresses are the media types the zone's Compression Rule
// (infra/tofu/rules.tf) compresses besides, under /assets/: the models and
// the other binary assets.
var ruleCompresses = map[string]bool{"model/gltf-binary": true, "application/octet-stream": true}

// smallest is the least body Cloudflare compresses, gzip's.
const smallest = 48

// compressed says whether Cloudflare sends a response of the media type, at
// the path, compressed: with the zone's Compression Rule, or as before it.
func compressed(mediaType, path string, rule bool) bool {
	return cloudflareCompresses[mediaType] || (rule && ruleCompresses[mediaType] && strings.HasPrefix(path, "/assets/"))
}

// edge stands in for Cloudflare in front of keel's play listener, for the
// tests of the built page: what Cloudflare compresses comes gzipped to a
// browser that accepts gzip, so that the bytes and the times on a
// throttled connection are those of the wire players have. Everything else,
// the game's connection too, passes as keel sent it. Without the rule, the
// models go out as Cloudflare sent them before it, uncompressed.
func edge(keel string, rule bool) http.Handler {
	proxy := httputil.NewSingleHostReverseProxy(&url.URL{Scheme: "http", Host: keel})
	proxy.ModifyResponse = func(res *http.Response) error { return gzipAsCloudflare(res, rule) }
	return proxy
}

// gzipAsCloudflare compresses a whole answer that Cloudflare would.
func gzipAsCloudflare(res *http.Response, rule bool) error {
	if res.StatusCode != http.StatusOK || res.Header.Get("Content-Encoding") != "" ||
		!strings.Contains(res.Request.Header.Get("Accept-Encoding"), "gzip") {
		return nil
	}
	mediaType, _, _ := mime.ParseMediaType(res.Header.Get("Content-Type"))
	if !compressed(mediaType, res.Request.URL.Path, rule) {
		return nil
	}
	body, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil {
		return err
	}
	res.Header.Add("Vary", "Accept-Encoding")
	if len(body) < smallest {
		res.Body = io.NopCloser(bytes.NewReader(body))
		return nil
	}
	var zipped bytes.Buffer
	w := gzip.NewWriter(&zipped)
	if _, err := w.Write(body); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	res.Header.Del("Accept-Ranges")
	res.Header.Set("Content-Encoding", "gzip")
	res.Header.Set("Content-Length", strconv.Itoa(zipped.Len()))
	res.ContentLength = int64(zipped.Len())
	res.Body = io.NopCloser(&zipped)
	return nil
}
