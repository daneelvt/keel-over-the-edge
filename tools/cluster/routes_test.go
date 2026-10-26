// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"slices"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/manifests"
)

// The agents' listener, which only the MCP address and its resource's
// metadata may reach, and the paths that reach it.
const (
	agentsPort     = 8081
	mcpPath        = "/mcp"
	resourcePrefix = "/.well-known/oauth-protected-resource"
)

// reached is what a request finds through the Gateway: the container port
// of keel's its route leads to (0 for none, a redirect or no route at
// all), and the middlewares on the way.
type reached struct {
	port        int
	middlewares []string
}

// route resolves a request as a Gateway API implementation does: among
// the Gateway's listeners on the entry point's port, the one with the most
// specific hostname that matches; among the rules of the routes attached
// to it that answer the host, an exact path first, then the longest
// prefix, matched path element by path element.
func route(t *testing.T, objs []manifests.Object, port int, host, path string) reached {
	t.Helper()
	listener := ""
	best := -1
	for _, l := range manifests.List(manifests.Find(objs, "Gateway", "keel"), "spec", "listeners") {
		h := manifests.Str(l, "hostname")
		if manifests.Get(l, "port") != port || (h != "" && h != host) {
			continue
		}
		if len(h) > best {
			listener, best = manifests.Str(l, "name"), len(h)
		}
	}
	if listener == "" {
		return reached{}
	}
	game := manifests.Container(manifests.PodSpec(manifests.Find(objs, "Deployment", "keel")), "containers", "keel")
	var found reached
	exact, prefix := false, -1
	for _, o := range objs {
		if o.Kind() != "HTTPRoute" {
			continue
		}
		on := slices.ContainsFunc(manifests.List(o, "spec", "parentRefs"), func(p any) bool {
			return manifests.Str(p, "name") == "keel" && manifests.Str(p, "sectionName") == listener
		})
		hosts := manifests.List(o, "spec", "hostnames")
		if !on || (len(hosts) > 0 && !slices.Contains(hosts, any(host))) {
			continue
		}
		for _, rule := range manifests.List(o, "spec", "rules") {
			matches := manifests.List(rule, "matches")
			if len(matches) == 0 {
				matches = []any{map[string]any{"path": map[string]any{"type": "PathPrefix", "value": "/"}}}
			}
			for _, m := range matches {
				typ, value := manifests.Str(m, "path", "type"), manifests.Str(m, "path", "value")
				switch {
				case typ == "Exact" && path == value:
					exact = true
				case typ == "PathPrefix" && !exact && len(value) > prefix && underPrefix(path, value):
					prefix = len(value)
				default:
					continue
				}
				found = reached{port: backendPort(objs, game, rule)}
				for _, f := range manifests.List(rule, "filters") {
					if manifests.Str(f, "type") == "ExtensionRef" && manifests.Str(f, "extensionRef", "kind") == "Middleware" {
						found.middlewares = append(found.middlewares, manifests.Str(f, "extensionRef", "name"))
					}
				}
			}
		}
	}
	return found
}

// underPrefix is whether path is prefix or below it, element by element:
// /mcp is under /mcp, /mcp/x too, /mcpx not.
func underPrefix(path, prefix string) bool {
	prefix = strings.TrimSuffix(prefix, "/")
	return path == prefix || strings.HasPrefix(path, prefix+"/") || prefix == ""
}

// backendPort is the container port of keel's a rule's backend reaches,
// through its Service's port, or 0.
func backendPort(objs []manifests.Object, game map[string]any, rule any) int {
	for _, b := range manifests.List(rule, "backendRefs") {
		svc := manifests.Find(objs, "Service", manifests.Str(b, "name"))
		for _, sp := range manifests.List(svc, "spec", "ports") {
			if manifests.Get(sp, "port") != manifests.Get(b, "port") {
				continue
			}
			target := manifests.Get(sp, "targetPort")
			for _, cp := range manifests.List(game, "ports") {
				if manifests.Get(cp, "name") == target || manifests.Get(cp, "containerPort") == target {
					n, _ := manifests.Get(cp, "containerPort").(int)
					return n
				}
			}
		}
	}
	return 0
}

// TestAgentsRoutes: the MCP address and its resource's metadata reach
// keel's agents' listener, through the per-address rate limit, and
// nothing else does: on the local cluster on the players' host, beside
// every other path, which stays on the game's listener; in production on
// agents. alone, where nothing else has a route, and play. never reaches
// it. keel's MCP address is the one the routes serve.
func TestAgentsRoutes(t *testing.T) {
	chdirRoot(t)
	tr, err := manifests.ReadTree(clusterDir)
	if err != nil {
		t.Fatal(err)
	}
	image := manifests.GameImage + "@sha256:" + strings.Repeat("ab", 32)
	render := func(entry string) []manifests.Object {
		rm, err := tr.RenderRelease(entry, image)
		if err != nil {
			t.Fatal(err)
		}
		objs, err := manifests.Objects(rm)
		if err != nil {
			t.Fatal(err)
		}
		return objs
	}
	deployed := func(host string) []manifests.Object {
		rm, err := tr.RenderDeploy(manifests.Deploy{Build: "0123456789ab", Host: host})
		if err != nil {
			t.Fatal(err)
		}
		objs, err := manifests.Objects(rm)
		if err != nil {
			t.Fatal(err)
		}
		return objs
	}
	agentsPaths := []string{mcpPath, resourcePrefix, resourcePrefix + mcpPath}
	otherPaths := []string{
		"/", "/ws", "/api/status", "/assets/index.js", "/w/chunk.bin",
		"/oauth/authorize", "/oauth/token", "/oauth/register", "/.well-known/oauth-authorization-server",
		"/mcp/", "/mcp/x", "/mcpx", "/.well-known/oauth-protected-resourcex", "/.well-known/",
	}
	type place struct {
		name string
		objs []manifests.Object
		port int    // Traefik's entry point the Gateway's listener is on
		host string // the players' host
		mcp  string // the MCP address's host, where it is not the players'
	}
	places := []place{
		{"a local release", render(localCluster.Entry("apps")), 8443, "macbook.local", ""},
		{"a local deploy", deployed("harbour.local"), 8443, "harbour.local", ""},
	}
	for _, c := range manifests.Clusters[1:] {
		places = append(places, place{c.Name, render(c.Entry("apps")), 8000, manifests.PlayHost, "agents.keelovertheedge.com"})
	}
	for _, p := range places {
		check := func(host, path string, want int) {
			t.Helper()
			got := route(t, p.objs, p.port, host, path)
			if got.port != want {
				t.Errorf("%s: %s%s reaches %d, want %d", p.name, host, path, got.port, want)
			}
			if got.port != 0 && !slices.Equal(got.middlewares, []string{"per-address-rate"}) && path != "/ws" {
				t.Errorf("%s: %s%s passes through %v, not the per-address rate alone", p.name, host, path, got.middlewares)
			}
		}
		mcpHost := p.mcp
		if mcpHost == "" {
			mcpHost = p.host
		}
		for _, path := range agentsPaths {
			check(mcpHost, path, agentsPort)
			if p.mcp != "" {
				check(p.host, path, 8080)
			}
		}
		for _, path := range otherPaths {
			check(p.host, path, 8080)
			if p.mcp != "" {
				check(p.mcp, path, 0)
			}
		}
		// Production answers its two hosts alone (the local cluster any,
		// as a phone opens the Mac by its address).
		if p.mcp != "" {
			for _, path := range append(agentsPaths, otherPaths...) {
				check("elsewhere.example", path, 0)
			}
		}
		// Every rule to the agents' listener matches the two paths alone.
		game := manifests.Container(manifests.PodSpec(manifests.Find(p.objs, "Deployment", "keel")), "containers", "keel")
		for _, o := range p.objs {
			if o.Kind() != "HTTPRoute" {
				continue
			}
			for _, rule := range manifests.List(o, "spec", "rules") {
				if backendPort(p.objs, game, rule) != agentsPort {
					continue
				}
				var matches []string
				for _, m := range manifests.List(rule, "matches") {
					matches = append(matches, manifests.Str(m, "path", "type")+" "+manifests.Str(m, "path", "value"))
				}
				if !slices.Equal(matches, []string{"Exact " + mcpPath, "PathPrefix " + resourcePrefix}) {
					t.Errorf("%s: %s reaches the agents' listener for %v", p.name, o.ID(), matches)
				}
			}
		}
		// keel's MCP address is on the host the route serves: production's
		// set outright, the local cluster's the play origin's /mcp.
		var agentsURL string
		for _, o := range p.objs {
			if o.Kind() == "ConfigMap" && strings.HasPrefix(o.Name(), "keel-") && manifests.Str(o, "data", "KEEL_PLAY_ORIGIN") != "" {
				agentsURL = manifests.Str(o, "data", "KEEL_AGENTS_URL")
			}
		}
		want := ""
		if p.mcp != "" {
			want = "https://" + p.mcp + mcpPath
		}
		if agentsURL != want {
			t.Errorf("%s: KEEL_AGENTS_URL is %q, want %q", p.name, agentsURL, want)
		}
	}
	// Plain HTTP on the local cluster redirects, the MCP address too.
	objs := places[0].objs
	for _, path := range append(agentsPaths, "/") {
		if got := route(t, objs, 8000, places[0].host, path); got.port != 0 {
			t.Errorf("a local release: http://%s%s reaches %d, not the redirect to HTTPS", places[0].host, path, got.port)
		}
	}
}
