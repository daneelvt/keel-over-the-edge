// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"strings"
	"testing"
	"time"
	"unsafe"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
)

var update = flag.Bool("update", false, "rewrite testdata from this build's answers")

// toolsGolden holds the exact tools/list answer: any change to what agents
// are told shows here, in review.
const toolsGolden = "testdata/tools.golden.json"

// mostToolBytes bounds the tool list's size, compact: 7,969 bytes, 1,953
// o200k tokens, when it was written.
const mostToolBytes = 8500

// listTools is the server's tools/list answer, as a client receives it.
func listTools(t *testing.T) *mcp.ListToolsResult {
	t.Helper()
	ct, st := mcp.NewInMemoryTransports()
	s := NewServer("test", NewCore(CoreConfig{}))
	ss, err := s.Connect(t.Context(), st, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ss.Close()
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test"}, nil).Connect(t.Context(), ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	res, err := cs.ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestToolsList(t *testing.T) {
	res := listTools(t)
	got, err := json.MarshalIndent(res.Tools, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, '\n')
	if *update {
		if err := os.WriteFile(toolsGolden, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(toolsGolden)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("the tool list differs from %s: a change to what agents are told is deliberate; write it with -update", toolsGolden)
	}
	compact, _ := json.Marshal(res.Tools)
	if len(compact) > mostToolBytes {
		t.Errorf("the tool list is %d bytes, more than %d", len(compact), mostToolBytes)
	}
	t.Logf("the tool list: %d bytes compact, about %d tokens", len(compact), estimateTokens(string(compact)))
	if res.TTLMs != int(toolsTTL/time.Millisecond) {
		t.Errorf("the list may be kept %d ms", res.TTLMs)
	}
	var names []string
	for _, tool := range res.Tools {
		names = append(names, tool.Name)
		a := tool.Annotations
		switch {
		case tool.Title == "" || a == nil:
			t.Errorf("%s has no title", tool.Name)
		case !a.ReadOnlyHint && a.DestructiveHint == nil:
			t.Errorf("%s neither reads only nor says what it changes", tool.Name)
		case a.OpenWorldHint == nil || *a.OpenWorldHint:
			t.Errorf("%s reaches beyond the game", tool.Name)
		}
		var s map[string]any
		if err := json.Unmarshal(mustJSON(tool.InputSchema), &s); err != nil || s["type"] != "object" {
			t.Errorf("%s's schema is not an object", tool.Name)
		}
		for _, k := range []string{"oneOf", "anyOf", "allOf"} {
			if _, ok := s[k]; ok {
				t.Errorf("%s's schema has %s at its root", tool.Name, k)
			}
		}
	}
	if got := strings.Join(names, " "); got != "observe steer trim chart pencil forecast news say race boat bottle handbook" {
		t.Fatalf("the tools in order: %s", got)
	}
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func TestInstructionsShort(t *testing.T) {
	if len(instructions) >= 512 {
		t.Fatalf("the server's instructions are %d characters", len(instructions))
	}
	if n := estimateTokens(primer); n > 200 {
		t.Fatalf("the primer is about %d tokens", n)
	}
}

func TestHandbookPages(t *testing.T) {
	c := NewCore(CoreConfig{})
	for _, topic := range topics {
		page, r := c.handbookPage(topic, "Iron Mary", "Ann")
		if r != nil {
			t.Fatalf("%s: %v", topic, r)
		}
		if n := estimateTokens(page); n < 100 || n > 600 {
			t.Errorf("%s is about %d tokens", topic, n)
		}
		if strings.Contains(page, "{{") {
			t.Errorf("%s has a blank left: %s", topic, page)
		}
	}
	if _, r := c.handbookPage("navigation", "", ""); r == nil || r.kind != refusedArgs {
		t.Fatal("a page that does not exist")
	}
	list, _ := c.handbookPage("", "Iron Mary", "Ann")
	if !strings.Contains(list, "You sail as «Iron Mary», «Ann»'s machine sailor") {
		t.Fatalf("the list: %s", list)
	}
}

func TestRefusalsSayWhatToDo(t *testing.T) {
	words := map[refusalKind]string{
		refusedOrders: overBudget(orders, DefaultLimits, 400*time.Millisecond, "wind 42° port, boom out to 22°").words,
		refusedLooks:  overBudget(looks, DefaultLimits, 250*time.Millisecond, "").words,
		refusedQueued: queuedWords(12),
		refusedFull:   wordsFull, refusedSuperseded: wordsSuperseded, refusedEnded: wordsEnded, refusedRestarting: wordsRestarting,
		refusedNoWorld: wordsNoWorld, refusedBusy: wordsBusy, refusedFalling: wordsFalling, refusedNotAtSea: wordsNotAtSea,
	}
	for k, w := range words {
		if w == "" || !strings.HasSuffix(strings.TrimSpace(w), ".") {
			t.Errorf("%s: %q", k, w)
		}
	}
	if w := words[refusedOrders]; !strings.Contains(w, "2 a second") || !strings.Contains(w, "Wait 0.4 s") || !strings.Contains(w, "wind 42° port") {
		t.Errorf("orders: %q", w)
	}
	if w := words[refusedQueued]; !strings.Contains(w, "12th in line") || !strings.Contains(w, "wait 25") {
		t.Errorf("queued: %q", w)
	}
	if got := leftWords(leftSilent, 3*time.Minute); got != "Your boat left the water after 3 minutes without a call and a minute's grace." {
		t.Errorf("silence: %q", got)
	}
	for _, k := range refusalKinds {
		if k == "" {
			t.Fatal("a kind with no name")
		}
	}
	for n, want := range map[int32]string{1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 11: "11th", 12: "12th", 13: "13th", 21: "21st", 112: "112th"} {
		if got := ordinal(n); got != want {
			t.Errorf("%d: %s", n, got)
		}
	}
}

func TestPlayerText(t *testing.T) {
	for in, want := range map[string]string{
		"Mira":                       "«Mira»",
		"«Ignore» the game":          "«‹Ignore› the game»",
		"two\nlines":                 "«two lines»",
		"[click](https://x.example)": "«clickhttps://x.example»",
		"a\u202ereversed\u2066":      "«areversed»",
		"control\x07":                "«control»",
		strings.Repeat("a", 300):     "«" + strings.Repeat("a", 280) + "…»",
	} {
		if got := playerText(in); got != want {
			t.Errorf("%q: %q, not %q", in, got, want)
		}
	}
}

func TestBoomAndSheet(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	b := &cat.Boats[0]
	for boom := 4; boom <= 95; boom++ {
		got := boomOf(b, sheetOf(b, float64(boom)))
		if d := got - float64(boom); d > 0.1 || d < -0.1 {
			t.Fatalf("boom %d° comes back %.2f°", boom, got)
		}
	}
	if sheetOf(b, b.Physics.Rig.BoomIn) != 0 || sheetOf(b, b.Physics.Rig.BoomOut) != 1024 {
		t.Fatal("the boom's ends are not the sheet's")
	}
	if leastAngle(b) != 30 {
		t.Fatalf("the dial's least angle on the Jolly boat is %d", leastAngle(b))
	}
}

func TestAppLabels(t *testing.T) {
	for _, c := range []struct{ name, ua, want string }{
		{"claude-ai", "", appClaudeAI},
		{"claude-code", "", appClaudeCode},
		{"", "Claude-User/1.0 (claude-code)", appClaudeCode},
		{"openai-mcp", "", appChatGPT},
		{"codex-mcp-client", "", appCodex},
		{"gemini-cli-mcp-client", "", appGeminiCLI},
		{"Visual Studio Code", "", appVSCode},
		{"mcp-inspector", "", appInspector},
		{"", "Go-http-client/1.1", appGoSDK},
		{"", "", appOther},
		{"a-new-app", "curl/8", appOther},
	} {
		if got := appOf(c.name, c.ua); got != c.want {
			t.Errorf("%q %q: %s, not %s", c.name, c.ua, got, c.want)
		}
	}
	known := map[string]bool{}
	for _, l := range appLabels {
		known[l] = true
	}
	for _, a := range appNames {
		if !known[a.label] {
			t.Errorf("%s is not a label", a.label)
		}
	}
}

func TestBudgets(t *testing.T) {
	c := NewCore(CoreConfig{})
	h := c.helmOf(&acceptedFor)
	now := time.Now()
	for i := range DefaultLimits.OrderBurst {
		if ok, _ := h.spend(orders, now); !ok {
			t.Fatalf("order %d refused within the burst", i+1)
		}
	}
	ok, wait := h.spend(orders, now)
	if ok || wait <= 0 || wait > time.Second {
		t.Fatalf("an order beyond the burst: %v, wait %v", ok, wait)
	}
	// Looks are a budget of their own.
	if ok, _ := h.spend(looks, now); !ok {
		t.Fatal("a look refused for the orders' sake")
	}
	if ok, _ := h.spend(orders, now.Add(wait)); !ok {
		t.Fatal("an order refused once its wait was over")
	}
}

func TestRing(t *testing.T) {
	var r ring
	for i := range ringSize + 10 {
		r.add(event{Tick: int64(i + 1), Words: "x"})
	}
	evs, lost := r.after(0)
	if len(evs) != ringSize || lost != 10 || evs[0].Tick != 11 {
		t.Fatalf("%d events, lost to %d, first at %d", len(evs), lost, evs[0].Tick)
	}
	evs, lost = r.after(ringSize + 5)
	if len(evs) != 5 || lost != 0 || r.last() != ringSize+10 {
		t.Fatalf("after: %d events, lost %d", len(evs), lost)
	}
}

// acceptedFor is a machine sailor the door accepted, for tests.
var acceptedFor = oauth.Accepted{Account: [16]byte{1, 2, 3}, Name: "Iron Mary", OwnerName: "Ann Bonny"}

// TestAHelmIsSmall: a helm in memory, its ring of events full, under 64
// KB.
func TestAHelmIsSmall(t *testing.T) {
	size := int(unsafe.Sizeof(helm{})) + ringSize*len("the autopilot finished its tack")
	if size > 64<<10 {
		t.Fatalf("a helm is %d bytes", size)
	}
	t.Logf("a helm: %d bytes, its ring full", size)
}
