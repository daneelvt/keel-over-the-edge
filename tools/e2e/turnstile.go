// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/humancheck"
)

// The human check in the browser tests: a stand-in for Cloudflare
// Turnstile on the page's own origin, under /turnstile/, since Cloudflare
// supports automated browsers with its test keys alone and pull requests'
// tests call no one outside. keel is set up as production is, with a site
// key (Cloudflare's always-passing test key, which the stand-in ignores),
// a secret of the tests' own, siteverify at the stand-in and the script
// on the page's origin.
const (
	turnstileSiteKey = "1x00000000000000000000AA"
	turnstileSecret  = "e2e-turnstile-secret"
	// turnstileToken is the token every widget gives, Cloudflare's test
	// token.
	turnstileToken = humancheck.TestToken
	// turnstileScript is the script's address, a path on the page's
	// origin: Vite sends /turnstile/ to the stand-in, and the built page's
	// origin is the stand-in's own listener.
	turnstileScript = "/turnstile/api.js?render=explicit"
	turnstileVerify = "http://" + edgeAddr + "/turnstile/siteverify"
)

// turnstileEnv is keel's configuration for the stand-in.
func turnstileEnv() []string {
	return []string{
		"KEEL_TURNSTILE_SITEKEY=" + turnstileSiteKey,
		"KEEL_TURNSTILE_SECRET=" + turnstileSecret,
		"KEEL_TURNSTILE_VERIFY_URL=" + turnstileVerify,
		"KEEL_TURNSTILE_SCRIPT=" + turnstileScript,
	}
}

// grant is a token a widget gave, not yet checked: the page's host and
// the widget's action, which siteverify answers with, as Cloudflare does.
type grant struct {
	hostname, action string
	at               time.Time
}

// verdict is siteverify's answer to one check, kept by its idempotency key
// so that keel's retry is answered the same.
type verdict struct {
	status int
	body   []byte
}

// turnstile stands in for Cloudflare Turnstile:
//
//	GET  /turnstile/api.js       the widget: render, execute, reset, remove,
//	                             getResponse, isExpired, ready
//	POST /turnstile/issue        a widget's token, {"action"}, as the page's
//	                             script asks for it on each execute
//	POST /turnstile/siteverify   keel's check: the token passes once for each
//	                             one given, and is refused when repeated
//	POST /turnstile/next?answer=refused|spent|unavailable
//	                             the next check answers so, for a test of
//	                             what the page shows
type turnstile struct {
	mu      sync.Mutex
	granted []grant
	seen    map[string]verdict
	next    []string
}

func newTurnstile() *turnstile { return &turnstile{seen: map[string]verdict{}} }

func (t *turnstile) routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /turnstile/api.js", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte(turnstileJS))
	})
	mux.HandleFunc("POST /turnstile/issue", t.issue)
	mux.HandleFunc("POST /turnstile/siteverify", t.siteverify)
	mux.HandleFunc("POST /turnstile/next", func(w http.ResponseWriter, r *http.Request) {
		switch a := r.URL.Query().Get("answer"); a {
		case "refused", "spent", "unavailable":
			t.mu.Lock()
			t.next = append(t.next, a)
			t.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "answer: refused, spent or unavailable", http.StatusBadRequest)
		}
	})
}

// issue gives a widget its token, kept with the page's host.
func (t *turnstile) issue(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Action string `json:"action"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&in)
	host := r.Host
	if h, _, err := net.SplitHostPort(r.Host); err == nil {
		host = h
	}
	t.mu.Lock()
	t.granted = append(t.granted, grant{hostname: host, action: in.Action, at: time.Now().UTC()})
	t.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"token": turnstileToken})
}

// siteverify answers keel's check as Cloudflare's does.
func (t *turnstile) siteverify(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	key := r.PostForm.Get("idempotency_key")
	t.mu.Lock()
	v, ok := t.seen[key]
	if !ok || key == "" {
		v = t.judge(r.PostForm.Get("secret"), r.PostForm.Get("response"))
		if key != "" {
			t.seen[key] = v
		}
	}
	t.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(v.status)
	_, _ = w.Write(v.body)
}

// judge is a check's answer; t.mu is held.
func (t *turnstile) judge(secret, token string) verdict {
	refused := func(code string) verdict {
		body, _ := json.Marshal(map[string]any{"success": false, "error-codes": []string{code}})
		return verdict{http.StatusOK, body}
	}
	if secret != turnstileSecret {
		return refused("invalid-input-secret")
	}
	if len(t.next) > 0 {
		forced := t.next[0]
		t.next = t.next[1:]
		switch forced {
		case "refused":
			return refused("invalid-input-response")
		case "spent":
			return refused("timeout-or-duplicate")
		default:
			return verdict{http.StatusServiceUnavailable, []byte(`{"error":"the stand-in is down"}`)}
		}
	}
	if token != turnstileToken {
		return refused("invalid-input-response")
	}
	if len(t.granted) == 0 {
		return refused("timeout-or-duplicate")
	}
	g := t.granted[0]
	t.granted = t.granted[1:]
	var body bytes.Buffer
	_ = json.NewEncoder(&body).Encode(map[string]any{
		"success": true, "challenge_ts": g.at.Format(time.RFC3339), "hostname": g.hostname, "action": g.action,
		"cdata": "", "error-codes": []string{},
	})
	return verdict{http.StatusOK, body.Bytes()}
}

// turnstileJS is the stand-in's widget: the calls the page makes of
// Cloudflare's, each token asked of the stand-in, which keeps the page's
// host and the widget's action for siteverify. It writes no HTML: an
// element of its own is the widget.
const turnstileJS = `// The browser tests' stand-in for Cloudflare Turnstile (tools/e2e).
(() => {
  const TOKEN = '` + turnstileToken + `';
  const LIFE = 300_000;
  const widgets = new Map();
  let made = 0;
  const find = (w) => {
    if (w === undefined) return widgets.values().next().value;
    if (typeof w === 'string' && widgets.has(w)) return widgets.get(w);
    const el = typeof w === 'string' ? document.querySelector(w) : w;
    for (const x of widgets.values()) if (el && (x.box === el || el.contains(x.box))) return x;
    return undefined;
  };
  const issue = async (x) => {
    x.token = '';
    try {
      const res = await fetch('/turnstile/issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: x.opts.action ?? '' }),
      });
      if (!res.ok) throw new Error(String(res.status));
      if (!widgets.has(x.id)) return;
      x.token = TOKEN;
      x.at = Date.now();
      x.opts.callback?.(TOKEN);
    } catch {
      x.opts['error-callback']?.('stand-in');
    }
  };
  globalThis.turnstile = {
    render(container, opts = {}) {
      const id = 'stand-in-' + ++made;
      const box = document.createElement('div');
      box.className = 'turnstile-stand-in';
      box.dataset.widget = id;
      const parent = typeof container === 'string' ? document.querySelector(container) : container;
      parent?.appendChild(box);
      const x = { id, opts, box, token: '', at: 0 };
      widgets.set(id, x);
      if (opts.execution !== 'execute') void issue(x);
      return id;
    },
    execute(w) {
      const x = find(w);
      if (x) void issue(x);
    },
    reset(w) {
      const x = find(w);
      if (!x) return;
      x.token = '';
      if (x.opts.execution !== 'execute') void issue(x);
    },
    remove(w) {
      const x = find(w);
      if (!x) return;
      x.box.remove();
      widgets.delete(x.id);
    },
    getResponse(w) {
      const x = find(w);
      return x && x.token !== '' ? x.token : undefined;
    },
    isExpired(w) {
      const x = find(w);
      return x !== undefined && x.token !== '' && Date.now() - x.at > LIFE;
    },
    ready(f) {
      f();
    },
  };
  const onload = document.currentScript && new URL(document.currentScript.src).searchParams.get('onload');
  if (onload && typeof globalThis[onload] === 'function') globalThis[onload]();
})();
`
