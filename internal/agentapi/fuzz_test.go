// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"golang.org/x/time/rate"
)

// FuzzToolArguments: every tool's arguments, whatever an agent sends,
// are read as the door hands them over without a panic, and answered with
// text: a result, or a refusal in the result. The core has no world open,
// so nothing reaches the sea, and its budgets have no end, so every call
// is read.
func FuzzToolArguments(f *testing.F) {
	defs := tools()
	for i := range defs {
		f.Add(uint8(i), []byte(`{}`))
		f.Add(uint8(i), []byte(`null`))
		f.Add(uint8(i), []byte(`{"unknown":1}`))
	}
	for _, c := range []struct {
		tool string
		args string
	}{
		{toolObserve, `{"wait":30}`},
		{toolObserve, `{"wait":20,"detail":"full"}`},
		{toolObserve, `{"wait":25,"wake_on":["bearing"],"place":"Kittiwake Rock","bearing":90}`},
		{toolObserve, `{"wait":-1,"near_nm":0.01}`},
		{toolSteer, `{"wind_angle":90,"boom":40}`},
		{toolSteer, `{"heading":400,"side":"port","via":"gybe"}`},
		{toolSteer, `{"rudder":-41}`},
		{toolTrim, `{"boom":22,"reef":1}`},
		{toolTrim, `{"boom":1e400}`},
		{toolChart, `{"group":"islands","limit":30}`},
		{toolForecast, `{"hours":6}`},
		{toolNews, `{"day":"today","log":true}`},
		{toolBoat, `{"action":"take","boat":"skiff"}`},
		{toolBoat, `{"paint":"red","number":-1,"name":"Ann's"}`},
		{toolSay, `{"text":"ahoy","to":"Ann Bonny"}`},
		{toolRace, `{"action":"enter","race":"x","in":-5}`},
		{toolCourse, `{"place":"Kittiwake Rock"}`},
		{toolCourse, `{"position":"12.5 N 3 W","clear":true}`},
		{toolHandbook, `{"topic":"start"}`},
		{toolHandbook, `{"topic":"navigation"}`},
	} {
		for i, d := range defs {
			if d.tool.Name == c.tool {
				f.Add(uint8(i), []byte(c.args))
			}
		}
	}
	core := NewCore(CoreConfig{
		Log:    slog.New(slog.DiscardHandler),
		Limits: Limits{Orders: rate.Inf, OrderBurst: 1, Looks: rate.Inf, LookBurst: 1},
	})
	a := sailor(1, "Iron Mary")
	f.Fuzz(func(t *testing.T, which uint8, raw []byte) {
		d := defs[int(which)%len(defs)]
		req := &mcp.CallToolRequest{
			Params: &mcp.CallToolParamsRaw{Name: d.tool.Name, Arguments: json.RawMessage(raw)},
			Extra:  &mcp.RequestExtra{TokenInfo: &auth.TokenInfo{Extra: map[string]any{extraAccepted: a}}},
		}
		res, err := core.handler(d)(t.Context(), req)
		if err != nil || res == nil {
			t.Fatalf("%s %q: %v", d.tool.Name, raw, err)
		}
		var text strings.Builder
		for _, c := range res.Content {
			if tc, ok := c.(*mcp.TextContent); ok {
				text.WriteString(tc.Text)
			}
		}
		if text.Len() == 0 {
			t.Fatalf("%s %q: no words", d.tool.Name, raw)
		}
	})
}
