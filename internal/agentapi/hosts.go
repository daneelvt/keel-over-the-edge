// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// The apps that call. How long each app holds a call, and what it does
// with a wait, is little documented and sometimes contradicted, so the
// game measures it: each call is counted by the app it came from and its
// protocol's era, and each wait cut short by how long it ran. The app is
// told by the client's name as the request carries it (in each request's
// _meta from 2026-07-28, in initialize before), else its User-Agent,
// mapped to a fixed set of labels so the metrics stay bounded. Nothing
// about the model is learned.

// The apps' labels.
const (
	appClaudeAI   = "claude-ai"
	appClaudeCode = "claude-code"
	appChatGPT    = "chatgpt"
	appCodex      = "codex"
	appGemini     = "gemini"
	appGeminiCLI  = "gemini-cli"
	appVSCode     = "vscode"
	appCopilot    = "copilot"
	appCursor     = "cursor"
	appInspector  = "inspector"
	appGoSDK      = "go-sdk"
	appOther      = "other"
)

// appLabels are the labels, for the metrics and the tests.
var appLabels = []string{appClaudeAI, appClaudeCode, appChatGPT, appCodex, appGemini, appGeminiCLI, appVSCode, appCopilot, appCursor, appInspector, appGoSDK, appOther}

// appNames are what a client's name or User-Agent contains for each
// label, checked in order: the more particular first.
var appNames = []struct{ has, label string }{
	{"claude-code", appClaudeCode},
	{"claude code", appClaudeCode},
	{"claude-ai", appClaudeAI},
	{"claudeai", appClaudeAI},
	{"anthropic", appClaudeAI},
	{"claude", appClaudeAI},
	{"chatgpt", appChatGPT},
	{"openai-mcp", appChatGPT},
	{"codex", appCodex},
	{"gemini-cli", appGeminiCLI},
	{"gemini cli", appGeminiCLI},
	{"gemini", appGemini},
	{"visual studio code", appVSCode},
	{"vscode", appVSCode},
	{"copilot", appCopilot},
	{"cursor", appCursor},
	{"inspector", appInspector},
	{"go-sdk", appGoSDK},
	{"go-http-client", appGoSDK},
}

// appOf is the label of the app a name or User-Agent tells of.
func appOf(name, userAgent string) string {
	for _, s := range []string{name, userAgent} {
		l := strings.ToLower(s)
		if l == "" {
			continue
		}
		for _, a := range appNames {
			if strings.Contains(l, a.has) {
				return a.label
			}
		}
	}
	return appOther
}

// The protocol's eras, as the metrics label them.
var eras = map[string]bool{"2024-11-05": true, "2025-03-26": true, "2025-06-18": true, "2025-11-25": true, "2026-07-28": true}

// hostOf is the app a call came from, and its protocol's era.
func hostOf(req *mcp.CallToolRequest) (app, era string) {
	name, ua := "", ""
	if ci := req.ClientInfo(); ci != nil {
		name = ci.Name
	}
	if req.Extra != nil && req.Extra.Header != nil {
		ua = req.Extra.Header.Get("User-Agent")
	}
	era = req.ProtocolVersion()
	if !eras[era] {
		era = "unknown"
	}
	return appOf(name, ua), era
}
