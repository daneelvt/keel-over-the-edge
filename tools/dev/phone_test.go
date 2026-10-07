// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"bytes"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestPhoneSetupPage(t *testing.T) {
	h, err := phoneHandler([]byte("PEM"), `https://192.168.1.20:5173`)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	defer srv.Close()

	get := func(path string) (*http.Response, string) {
		t.Helper()
		res, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		return res, string(body)
	}

	res, page := get("/")
	if res.StatusCode != http.StatusOK || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/html") {
		t.Fatalf("page: %d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	for _, want := range []string{`href="/keel-dev-root.crt"`, `href="https://192.168.1.20:5173"`, "Certificate Trust Settings", "CA certificate"} {
		if !strings.Contains(page, want) {
			t.Errorf("page does not contain %q", want)
		}
	}

	res, cert := get("/keel-dev-root.crt")
	if res.StatusCode != http.StatusOK || cert != "PEM" {
		t.Fatalf("certificate: %d %q", res.StatusCode, cert)
	}
	if ct := res.Header.Get("Content-Type"); ct != "application/x-x509-ca-cert" {
		t.Errorf("Content-Type = %q", ct)
	}
	if cd := res.Header.Get("Content-Disposition"); !strings.Contains(cd, `filename="keel-dev-root.crt"`) {
		t.Errorf("Content-Disposition = %q", cd)
	}

	if res, _ := get("/rootCA-key.pem"); res.StatusCode != http.StatusNotFound {
		t.Errorf("unknown path answered %d", res.StatusCode)
	}
	post, err := http.Post(srv.URL+"/", "text/plain", nil)
	if err != nil {
		t.Fatal(err)
	}
	post.Body.Close()
	if post.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST answered %d", post.StatusCode)
	}
}

func TestPhonePageEscapesTheGameAddress(t *testing.T) {
	h, err := phoneHandler(nil, `https://x"><script>`)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if strings.Contains(rec.Body.String(), "<script>") {
		t.Fatal("the game address is not escaped")
	}
}

func TestPrintAddressesShowsBothSteps(t *testing.T) {
	var mu sync.Mutex
	var out bytes.Buffer
	printAddresses(&mu, &out, "https://192.168.1.20:5173", []net.IP{net.ParseIP("192.168.1.20")})
	text := out.String()
	setup := strings.Index(text, "1. Once per phone, trust this computer: http://192.168.1.20:5174/")
	game := strings.Index(text, "2. The game: https://192.168.1.20:5173")
	if setup < 0 || game < setup {
		t.Fatalf("output:\n%s", text)
	}
}
