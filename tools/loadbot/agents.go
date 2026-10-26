// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/auth/softkey"
	"github.com/daneelvt/keel-over-the-edge/tools/internal/smoke"
)

// The machine sailors' load: with -agents, instead of sailing on phones,
// that many machine sailors sail over the MCP address, each of its own
// sailor, with a connection token, as an agent does: observe with a wait
// of 25 s, then now and then a steer and a trim. It reports each tool's
// times and refusals as this side saw them, and what ended the waits;
// keel's metrics have the server's. The sailors it makes it deletes at the
// end.

// agentCall is one call's answer.
type agentCall struct {
	tool    string
	took    time.Duration
	refused bool
	woke    string
}

// runAgents sails n machine sailors for d.
func runAgents(ctx context.Context, hc *http.Client, base, mcp string, n int, d time.Duration) error {
	type made struct {
		name  string
		jar   http.CookieJar
		key   *softkey.Key
		token string
	}
	stamp := time.Now().UnixNano() % 1_000_000
	sailors := make([]made, 0, n)
	defer func() {
		for _, s := range sailors {
			_ = smoke.Delete(context.WithoutCancel(ctx), hc, s.jar, s.key, base, s.name)
		}
	}()
	for i := range n {
		name, jar, key, err := smoke.SailorNamed(ctx, hc, base, fmt.Sprintf("Zz Load %06d %d", stamp, i))
		if err != nil {
			return err
		}
		sailors = append(sailors, made{name: name, jar: jar, key: key})
		m, err := smoke.Machine(ctx, hc, jar, base, fmt.Sprintf("Zz Agent %06d %d", stamp, i))
		if err != nil {
			return err
		}
		token, err := smoke.ConnectionToken(ctx, hc, jar, key, base, m.Machines[0].ID)
		if err != nil {
			return err
		}
		sailors[i].token = token
	}
	fmt.Printf("%d machine sailors made; sailing %v\n", n, d)
	// A wait holds its call 25 s: the agents' client waits longer.
	agents := *hc
	agents.Timeout = time.Minute
	hc = &agents
	calls := make(chan agentCall, 1024)
	sctx, cancel := context.WithTimeout(ctx, d)
	defer cancel()
	var wg sync.WaitGroup
	for i, s := range sailors {
		wg.Go(func() { agent(sctx, hc, mcp, s.token, uint64(i), calls) })
	}
	go func() {
		wg.Wait()
		close(calls)
	}()
	by := map[string][]time.Duration{}
	refused := map[string]int{}
	woke := map[string]int{}
	for c := range calls {
		by[c.tool] = append(by[c.tool], c.took)
		if c.refused {
			refused[c.tool]++
		}
		if c.woke != "" {
			woke[c.woke]++
		}
	}
	tools := make([]string, 0, len(by))
	for t := range by {
		tools = append(tools, t)
	}
	slices.Sort(tools)
	fmt.Println("tool       calls   p50       p99       refused")
	for _, t := range tools {
		ts := by[t]
		slices.Sort(ts)
		fmt.Printf("%-10s %5d   %-9v %-9v %d\n", t, len(ts), ts[len(ts)/2].Round(time.Millisecond), ts[len(ts)*99/100].Round(time.Millisecond), refused[t])
	}
	fmt.Println("waits ended by:", woke)
	return nil
}

// agent sails one machine sailor until ctx ends, telling calls of each
// call.
func agent(ctx context.Context, hc *http.Client, mcp, token string, seed uint64, calls chan<- agentCall) {
	rng := rand.New(rand.NewPCG(seed, 51))
	call := func(tool, args string) {
		start := time.Now()
		status, said, err := smoke.CallTool(ctx, hc, mcp, token, tool, args)
		if ctx.Err() != nil {
			return
		}
		c := agentCall{tool: tool, took: time.Since(start), refused: err != nil || status != http.StatusOK || strings.Contains(said, `"isError":true`)}
		if tool == "observe" {
			c.woke = wokeOf(said)
		}
		calls <- c
		if c.refused || c.took < 200*time.Millisecond && tool == "observe" {
			// As an agent does: a refusal says to wait, and a wait that
			// ended at once is no reason to call again at once.
			select {
			case <-ctx.Done():
			case <-time.After(time.Second):
			}
		}
	}
	call("observe", `{}`)
	for k := 0; ctx.Err() == nil; k++ {
		if k%3 == 0 {
			side := []string{"port", "starboard"}[rng.IntN(2)]
			angle := 50 + rng.IntN(100)
			call("steer", fmt.Sprintf(`{"wind_angle":%d,"side":%q,"boom":%d}`, angle, side, 10+angle/3))
		}
		call("observe", `{"wait":25}`)
	}
}

// wokeOf is what ended a wait, from the report's first line.
func wokeOf(said string) string {
	i := strings.Index(said, "data: ")
	if i < 0 {
		return "no answer"
	}
	var m struct {
		Result struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(said[i+len("data: "):])), &m) != nil || len(m.Result.Content) == 0 {
		return "no answer"
	}
	line, _, _ := strings.Cut(m.Result.Content[0].Text, "\n")
	switch {
	case strings.Contains(line, "woke: "):
		return strings.TrimSpace(line[strings.Index(line, "woke: ")+len("woke: "):])
	case strings.Contains(line, "nothing new"):
		return "time"
	}
	return "other"
}
