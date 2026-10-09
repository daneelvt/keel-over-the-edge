// SPDX-License-Identifier: AGPL-3.0-only

package devcert

import (
	"bytes"
	"fmt"
	"html/template"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/mdp/qrterminal/v3"
)

// CertFile is the name a phone saves the local root under. Android's
// certificate installer accepts .crt; some versions refuse .pem.
const CertFile = "keel-dev-root.crt"

// Phone is what the phone setup page names: the game's address, and the
// command that must keep running while the phone is set up.
type Phone struct {
	Game, Command string
}

// ServePhoneSetup serves on port, over plain HTTP, a page that walks a
// phone through trusting the local root, and the root certificate itself
// (never its key).
func ServePhoneSetup(rootPath string, port int, p Phone) (*http.Server, error) {
	pem, err := os.ReadFile(rootPath)
	if err != nil {
		return nil, err
	}
	h, err := PhoneHandler(pem, p)
	if err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", net.JoinHostPort("", strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	srv := &http.Server{Handler: h, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	return srv, nil
}

// PhoneHandler serves the phone setup page and the root certificate pem.
func PhoneHandler(pem []byte, p Phone) (http.Handler, error) {
	var page bytes.Buffer
	if err := phonePage.Execute(&page, struct{ Cert, Game, Command string }{"/" + CertFile, p.Game, p.Command}); err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(page.Bytes())
	})
	mux.HandleFunc("GET /"+CertFile, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/x-x509-ca-cert")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", CertFile))
		_, _ = w.Write(pem)
	})
	return mux, nil
}

var phonePage = template.Must(template.New("phone").Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Keel Over the Edge: trust this computer</title>
<style>
  body { font: 17px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 36rem; padding: 1rem; color: #2b2118; background: #efe4c8; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 1.5rem; }
  a.button { display: block; text-align: center; padding: 0.9rem; margin: 1rem 0; background: #2b2118; color: #efe4c8; border-radius: 0.5rem; text-decoration: none; font-weight: 600; }
  li { margin: 0.4rem 0; } code { overflow-wrap: anywhere; }
</style>
</head>
<body>
<h1>Trust this computer, once per phone</h1>
<p>The game on this computer uses HTTPS with a certificate the computer made
itself. Install the computer's certificate authority below, and the phone
trusts the game. Keep <code>{{.Command}}</code> running meanwhile.</p>

<a class="button" href="{{.Cert}}">Download the certificate</a>

<h2>iPhone</h2>
<ol>
  <li>Use <strong>Safari</strong> for this page. Tap the button above, then
    <strong>Allow</strong> and <strong>Close</strong>.</li>
  <li>Open <strong>Settings</strong>. Near the top, tap <strong>Profile
    Downloaded</strong>, then <strong>Install</strong>. (If it is not there:
    General → VPN &amp; Device Management → the mkcert profile.)</li>
  <li>Settings → General → About →
    <strong>Certificate Trust Settings</strong>, at the very bottom. Turn on the switch for
    <strong>mkcert</strong>. Without this step the phone still does not trust
    it.</li>
</ol>

<h2>Android</h2>
<ol>
  <li>Use <strong>Chrome</strong>. Tap the button above to download the
    file.</li>
  <li>Settings → search for <strong>CA certificate</strong> (usually Security →
    Encryption &amp; credentials → Install a certificate → CA
    certificate).</li>
  <li>Tap <strong>Install anyway</strong> and choose
    <code>keel-dev-root.crt</code> from Downloads.</li>
</ol>

<h2>Then</h2>
<p>Open the game: <a href="{{.Game}}">{{.Game}}</a>. It should load with no
warning and show <strong>Secure context: HTTPS</strong>.</p>
</body>
</html>
`))

// PrintAddresses prints, with a QR code each, the phone setup page, when
// there is one, and the game.
func PrintAddresses(out io.Writer, setup, game string) {
	if setup != "" {
		fmt.Fprintf(out, "\n  1. Once per phone, trust this computer: %s\n\n", setup)
		qrterminal.GenerateHalfBlock(setup, qrterminal.L, out)
		fmt.Fprintf(out, "\n  2. The game: %s\n\n", game)
	} else {
		fmt.Fprintf(out, "\n  The game: %s\n\n", game)
	}
	qrterminal.GenerateHalfBlock(game, qrterminal.L, out)
	fmt.Fprintln(out)
}
