// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// harness is a world of open sea ticking in a test's bubble, and the
// machine sailors' core sailing in it.
type harness struct {
	core *Core
	sea  *Sea
	w    *sim.World
	stop context.CancelFunc
	done chan struct{}
}

// newHarness is a world of limit boats in a steady wind of knots from
// from degrees, ticking at the world's pace; it stops as the test ends.
func newHarness(t *testing.T, limit int, knots, from float64) *harness {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	waves, kinds := cat.Prepare()
	tl := weather.FixedIn(cat.PrepareWeather(), physics.SteadySpell(knots*nm/3600, from*3.141592653589793/180, 0))
	enc := cat.PrepareEncounters()
	w, err := sim.New(sim.Config{Capacity: 64, Kinds: kinds, Waves: waves, Weather: tl, Encounters: enc, Limit: limit, Tick: 1000})
	if err != nil {
		t.Fatal(err)
	}
	s := &Sea{Number: 1, Epoch: time.Now(), Bus: w.Bus(), Boats: cat.Boats, Limit: limit, AICap: w.AICap(), AIReserve: w.AIReserve(),
		Timeline: tl, Waves: waves, Words: weather.WordsOf(cat), Catalog: cat, Kinds: kinds, Encounters: enc}
	h := &harness{core: NewCore(CoreConfig{Silence: time.Minute, Log: slog.New(slog.DiscardHandler)}), sea: s, w: w, done: make(chan struct{})}
	w.Record(h.core.Open(s))
	ctx, cancel := context.WithCancel(context.Background())
	h.stop = cancel
	go func() {
		defer close(h.done)
		go h.core.Run(ctx)
		for {
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Second / physics.StepsPerSecond):
				w.Tick()
			}
		}
	}()
	t.Cleanup(func() {
		h.stop()
		<-h.done
		w.Close()
	})
	return h
}

// sailor is a machine sailor the door accepted.
func sailor(n byte, name string) *oauth.Accepted {
	return &oauth.Accepted{Account: [16]byte{0x01, 0x9a, n}, Name: name, OwnerName: "Ann Bonny", ClientName: "test"}
}

// call calls a tool as sailor a, and returns its text and whether it was
// refused.
func (h *harness) call(t *testing.T, a *oauth.Accepted, tool string, args map[string]any) (string, bool) {
	t.Helper()
	return h.callCtx(t, t.Context(), a, tool, args)
}

func (h *harness) callCtx(t *testing.T, ctx context.Context, a *oauth.Accepted, tool string, args map[string]any) (string, bool) {
	var def toolDef
	for _, d := range tools() {
		if d.tool.Name == tool {
			def = d
		}
	}
	raw, _ := json.Marshal(args)
	req := &mcp.CallToolRequest{
		Params: &mcp.CallToolParamsRaw{Name: tool, Arguments: raw},
		Extra:  &mcp.RequestExtra{TokenInfo: &auth.TokenInfo{Extra: map[string]any{extraAccepted: a}}},
	}
	res, err := h.core.handler(def)(ctx, req)
	if err != nil {
		t.Errorf("%s: %v", tool, err)
		return "", true
	}
	var b strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	return b.String(), res.IsError
}

// boats counts the world's boats.
func (h *harness) boats() int {
	f := h.w.Bus().Frames.Acquire()
	defer f.Release()
	return len(f.Live)
}

func TestOneWaitAtATime(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, 8, 12, 0)
		a := sailor(1, "Iron Mary")
		h.call(t, a, "observe", nil)
		first := make(chan string, 1)
		go func() {
			text, refused := h.call(t, a, "observe", map[string]any{"wait": 30})
			if !refused {
				text = "not refused: " + text
			}
			first <- text
		}()
		time.Sleep(time.Second)
		text, refused := h.call(t, a, "observe", map[string]any{"wait": 2})
		if refused || !strings.Contains(text, "waited 2 s, nothing new") {
			t.Fatalf("the second wait: %v %q", refused, text)
		}
		if got := <-first; got != wordsSuperseded {
			t.Fatalf("the first wait: %q", got)
		}
	})
}

func TestTwoAppsOneBoat(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, 8, 12, 0)
		a, b := sailor(1, "Iron Mary"), sailor(1, "Iron Mary")
		b.ClientName = "another app"
		h.call(t, a, "observe", nil)
		text, _ := h.call(t, b, "steer", map[string]any{"wind_angle": 90})
		if !strings.Contains(text, "holding wind 90° port") || strings.Contains(text, "At sea") {
			t.Fatalf("the other app's order: %q", text)
		}
		if n := h.boats(); n != 1 {
			t.Fatalf("%d boats for one machine sailor", n)
		}
	})
}

func TestSinceAfterALostAnswer(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, 8, 12, 0)
		a := sailor(1, "Iron Mary")
		h.call(t, a, "observe", nil)
		h.call(t, a, "steer", map[string]any{"wind_angle": 60, "boom": 30})
		time.Sleep(10 * time.Second)
		h.call(t, a, "steer", map[string]any{"wind_angle": 60, "side": "starboard", "boom": 25})
		text, _ := h.call(t, a, "observe", map[string]any{"wait": 30, "wake_on": []string{"pilot"}})
		if !strings.Contains(text, "woke: pilot") || !strings.Contains(text, "the autopilot finished its tack") {
			t.Fatalf("the tack's end: %q", text)
		}
		var rep struct {
			Seq int64 `json:"seq"`
		}
		text, _ = h.call(t, a, "observe", map[string]any{"format": "json"})
		if err := json.Unmarshal([]byte(text), &rep); err != nil || rep.Seq == 0 {
			t.Fatalf("the report's seq: %v %q", err, text)
		}
		if strings.Contains(text, "finished its tack") {
			t.Fatalf("an event told twice: %q", text)
		}
		// The answer that told it was lost: since asks again.
		text, _ = h.call(t, a, "observe", map[string]any{"since": rep.Seq - 1})
		if !strings.Contains(text, "the autopilot finished its tack") {
			t.Fatalf("since: %q", text)
		}
	})
}

func TestMachineSailorsQueue(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		// Two boats: one for machine sailors, none kept for them.
		h := newHarness(t, 2, 12, 0)
		a, b := sailor(1, "Iron Mary"), sailor(2, "Brass Ned")
		if text, _ := h.call(t, a, "observe", nil); !strings.Contains(text, "At sea") {
			t.Fatalf("the first: %q", text)
		}
		text, refused := h.call(t, b, "observe", nil)
		if refused || !strings.Contains(text, "1st in line for a machine sailor's place") {
			t.Fatalf("the second: %v %q", refused, text)
		}
		if text, refused := h.call(t, b, "steer", map[string]any{"wind_angle": 90}); !refused || !strings.Contains(text, "The sea is full") {
			t.Fatalf("an order while queued: %v %q", refused, text)
		}
		woke := make(chan string, 1)
		go func() {
			text, _ := h.call(t, b, "observe", map[string]any{"wait": 30})
			woke <- text
		}()
		time.Sleep(2 * time.Second)
		if text, _ := h.call(t, a, "boat", map[string]any{"action": "leave"}); !strings.Contains(text, "left the water") {
			t.Fatalf("leave: %q", text)
		}
		if got := <-woke; !strings.Contains(got, "woke: admitted") || !strings.Contains(got, "Boat: sailing") {
			t.Fatalf("the waiting one: %q", got)
		}
	})
}

func TestWaitsEndWithKeel(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, 8, 12, 0)
		a, b := sailor(1, "Iron Mary"), sailor(2, "Brass Ned")
		h.call(t, a, "observe", nil)
		h.call(t, b, "observe", nil)
		got := make(chan string, 2)
		for _, s := range []*oauth.Accepted{a, b} {
			go func() {
				text, _ := h.call(t, s, "observe", map[string]any{"wait": 40})
				got <- text
			}()
		}
		time.Sleep(time.Second)
		start := time.Now()
		h.core.Shutdown()
		for range 2 {
			if text := <-got; text != wordsRestarting {
				t.Fatalf("a wait as keel stops: %q", text)
			}
		}
		if time.Since(start) > time.Second {
			t.Fatal("the waits took their time to end")
		}
	})
}

func TestACutWaitLosesNothing(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, 8, 12, 0)
		a := sailor(1, "Iron Mary")
		h.call(t, a, "observe", nil)
		ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
		defer cancel()
		h.callCtx(t, ctx, a, "observe", map[string]any{"wait": 30})
		// The helm is free again at once, and its boat sails on.
		if text, refused := h.call(t, a, "observe", nil); refused || !strings.Contains(text, "Boat: sailing") {
			t.Fatalf("after a cut wait: %v %q", refused, text)
		}
	})
}

func TestOrdersOutOfBounds(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, 8, 12, 0)
		a := sailor(1, "Iron Mary")
		for _, c := range []struct {
			tool string
			args map[string]any
			has  string
		}{
			{"steer", map[string]any{"wind_angle": 25}, "inside 30° the sail cannot draw"},
			{"steer", map[string]any{"heading": 10}, "it is 10° off the wind"},
			{"steer", map[string]any{"wind_angle": 90, "heading": 90}, "Send exactly one of"},
			{"steer", map[string]any{"rudder": 60}, "The rudder goes"},
			{"steer", map[string]any{"tiller": 3}, "not this tool's"},
			{"trim", map[string]any{"boom": 120}, "out of range"},
			{"trim", nil, "trim takes boom"},
			{"observe", map[string]any{"wake_on": []string{"heel"}}, "needs heel_over"},
			{"observe", map[string]any{"wait": 90}, "wait is 0 to 50"},
			{"chart", map[string]any{"place": "Nowhere"}, "No charted place"},
		} {
			text, refused := h.call(t, a, c.tool, c.args)
			if !refused || !strings.Contains(text, c.has) {
				t.Errorf("%s %v: %v %q", c.tool, c.args, refused, text)
			}
			time.Sleep(time.Second)
		}
	})
}

func TestLeaveAndSailAgain(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, 8, 12, 0)
		a := sailor(1, "Iron Mary")
		h.call(t, a, "observe", nil)
		time.Sleep(5 * time.Second)
		if text, _ := h.call(t, a, "boat", map[string]any{"action": "leave"}); !strings.Contains(text, "left the water") {
			t.Fatalf("leave: %q", text)
		}
		text, refused := h.call(t, a, "observe", nil)
		t.Logf("observe: %v %q", refused, text)
		text, refused = h.call(t, a, "steer", map[string]any{"rudder": 0, "boom": 95})
		t.Logf("steer: %v %q", refused, text)
		text, refused = h.call(t, a, "observe", map[string]any{"wait": 5, "wake_on": []string{"heel"}, "heel_over": 60})
		t.Logf("wait: %v %q", refused, text)
		if refused || !strings.Contains(text, "waited 5 s") {
			t.Fatalf("after leaving and sailing again: %v %q", refused, text)
		}
		if n := h.boats(); n != 1 {
			t.Fatalf("%d boats", n)
		}
	})
}
