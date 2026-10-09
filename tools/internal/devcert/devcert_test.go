// SPDX-License-Identifier: AGPL-3.0-only

package devcert

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestPhoneSetupPage(t *testing.T) {
	h, err := PhoneHandler([]byte("PEM"), Phone{Game: `https://192.168.1.20:5173`, Command: "go run ./tools/dev"})
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
	for _, want := range []string{`href="/keel-dev-root.crt"`, `href="https://192.168.1.20:5173"`, "Certificate Trust Settings", "CA certificate", "<code>go run ./tools/dev</code> running"} {
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
	h, err := PhoneHandler(nil, Phone{Game: `https://x"><script>`, Command: "go run ./tools/dev"})
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if strings.Contains(rec.Body.String(), "<script>") {
		t.Fatal("the game address is not escaped")
	}
}

// TestMakeOnlyWhenTheNamesChange makes certificates with a root of the
// test's own: the same names reuse the certificate, new names make another.
func TestMakeOnlyWhenTheNamesChange(t *testing.T) {
	if testing.Short() {
		t.Skip("runs mkcert")
	}
	t.Setenv("CAROOT", t.TempDir())
	dir := filepath.Join(t.TempDir(), "certs")
	ctx := context.Background()
	names := func(c Certs) []string {
		t.Helper()
		data, err := os.ReadFile(c.Cert)
		if err != nil {
			t.Fatal(err)
		}
		block, _ := pem.Decode(data)
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			t.Fatal(err)
		}
		got := slices.Clone(cert.DNSNames)
		for _, ip := range cert.IPAddresses {
			got = append(got, ip.String())
		}
		return got
	}
	first := []string{"macbook.local", "localhost", "127.0.0.1", "192.168.178.110"}
	c, err := Make(ctx, io.Discard, dir, first, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := names(c); !slices.Equal(got, []string{"macbook.local", "localhost", "127.0.0.1", "192.168.178.110"}) {
		t.Fatalf("names %v", got)
	}
	info, _ := os.Stat(c.Cert)
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(c.Cert, old, old); err != nil {
		t.Fatal(err)
	}
	if _, err := Make(ctx, io.Discard, dir, first, false); err != nil {
		t.Fatal(err)
	}
	if again, _ := os.Stat(c.Cert); !again.ModTime().Equal(old) {
		t.Fatalf("made again for the same names (%v, then %v)", info.ModTime(), again.ModTime())
	}
	if !Current(dir, first) || Current(dir, first[:3]) {
		t.Fatal("Current")
	}
	c, err = Make(ctx, io.Discard, dir, first[:3], false)
	if err != nil {
		t.Fatal(err)
	}
	if got := names(c); len(got) != 3 || strings.Contains(strings.Join(got, ","), "192.168") {
		t.Fatalf("not made again for new names: %v", got)
	}
}
