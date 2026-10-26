// SPDX-License-Identifier: AGPL-3.0-only

package smoke

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/auth/softkey"
)

// Machines is the account's machine sailors and the MCP address, as GET
// /api/machines answers.
type Machines struct {
	MCP      string `json:"mcp"`
	Machines []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"machines"`
	Looks struct {
		Versions, Finishes, Colours []struct {
			ID string `json:"id"`
		}
	} `json:"looks"`
}

func get(ctx context.Context, c *http.Client, url string, v any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	res, err := c.Do(req)
	if err != nil {
		return fmt.Errorf("smoke: %w", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("smoke: GET %s: %s %s", url, res.Status, body)
	}
	return json.Unmarshal(body, v)
}

// Machine makes a machine sailor of the name for the signed-in sailor of
// jar, of the first look the game offers, and returns the account's
// machine sailors after.
func Machine(ctx context.Context, client *http.Client, jar http.CookieJar, base, name string) (Machines, error) {
	c := *client
	c.Jar = jar
	var m Machines
	if err := get(ctx, &c, base+"/api/machines", &m); err != nil {
		return m, err
	}
	if len(m.Looks.Versions) == 0 || len(m.Looks.Finishes) == 0 || len(m.Looks.Colours) == 0 {
		return m, fmt.Errorf("smoke: the game offers no machine look")
	}
	body, _ := json.Marshal(map[string]string{
		"name": name, "version": m.Looks.Versions[0].ID, "finish": m.Looks.Finishes[0].ID, "colour": m.Looks.Colours[0].ID,
	})
	out, err := Post(ctx, &c, base, "/api/machines", body, http.StatusCreated)
	if err != nil {
		return m, err
	}
	err = json.Unmarshal(out, &m)
	return m, err
}

// confirm confirms the sailor's passkey for what cannot be undone.
func confirm(ctx context.Context, c *http.Client, key *softkey.Key, base string) error {
	opts, err := Post(ctx, c, base, "/api/account/confirm/begin", nil, http.StatusOK)
	if err != nil {
		return err
	}
	answer, err := key.Get(opts)
	if err != nil {
		return err
	}
	_, err = Post(ctx, c, base, "/api/account/confirm/finish", answer, http.StatusOK)
	return err
}

// ConnectionToken makes a connection token for a machine sailor, after the
// sailor's passkey, and returns it.
func ConnectionToken(ctx context.Context, client *http.Client, jar http.CookieJar, key *softkey.Key, base, machine string) (string, error) {
	c := *client
	c.Jar = jar
	if err := confirm(ctx, &c, key, base); err != nil {
		return "", err
	}
	body, _ := json.Marshal(map[string]string{"machine": machine})
	out, err := Post(ctx, &c, base, "/api/machines/token", body, http.StatusCreated)
	if err != nil {
		return "", err
	}
	var t struct {
		Token string `json:"token"`
	}
	err = json.Unmarshal(out, &t)
	return t.Token, err
}

// DeleteMachine deletes a machine sailor, after the sailor's passkey.
func DeleteMachine(ctx context.Context, client *http.Client, jar http.CookieJar, key *softkey.Key, base, machine, name string) error {
	c := *client
	c.Jar = jar
	if err := confirm(ctx, &c, key, base); err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]string{"machine": machine, "name": name})
	_, err := Post(ctx, &c, base, "/api/machines/delete", body, http.StatusOK)
	return err
}

// Handbook calls the MCP address's handbook with a token, as a program
// that sends only the header does, and returns the status and what it
// answered: the tool's words, or the refusal's.
func Handbook(ctx context.Context, client *http.Client, mcp, token string) (int, string, error) {
	return CallTool(ctx, client, mcp, token, "handbook", "{}")
}

// CallTool calls a tool at the MCP address with a token, its arguments
// as JSON, and returns the status and the answer as the stream carries
// it, or the challenge of a refusal.
func CallTool(ctx context.Context, client *http.Client, mcp, token, tool, args string) (int, string, error) {
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"` + tool + `","arguments":` + args + `}}`
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, mcp, strings.NewReader(body))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Mcp-Protocol-Version", "2025-06-18")
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := client.Do(req)
	if err != nil {
		return 0, "", fmt.Errorf("smoke: %w", err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusOK {
		return res.StatusCode, res.Header.Get("WWW-Authenticate"), nil
	}
	return res.StatusCode, string(out), nil
}
