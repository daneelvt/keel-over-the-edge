// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
)

// A call, from the door to its answer: the helm of the machine sailor the
// token names, its turn, its budget, and the tool's own work; then the
// primer if the agent has been away, and the counts.

// The results of a call, as the metrics count them.
const (
	resultOK      = "ok"
	resultRefused = "refused"
	resultError   = "error"
)

// addTools adds the twelve tools to s, answered by c.
func (c *Core) addTools(s *mcp.Server) {
	for _, d := range tools() {
		s.AddTool(d.tool, c.handler(d))
	}
}

// handler answers calls of tool d.
func (c *Core) handler(d toolDef) mcp.ToolHandler {
	name := d.tool.Name
	return func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		start := time.Now()
		a, ok := acceptedOf(req.Extra.TokenInfo)
		if !ok {
			return nil, errors.New("no machine sailor signed in")
		}
		app, era := hostOf(req)
		if c.stopped(a.Account) {
			// Stopped since the door let the token in: no helm is made.
			if m := c.cfg.Metrics; m != nil {
				m.AgentRefusals.WithLabelValues(string(refusedStopped)).Inc()
				m.AgentCalls.WithLabelValues(name, resultRefused, app, era).Inc()
			}
			return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: oauth.WordsStopped}}}, nil
		}
		h := c.helmOf(a)
		h.mu.Lock()
		before, seen := h.lastCall, h.apps[app]
		if h.apps == nil {
			h.apps = map[string]bool{}
		}
		h.apps[app] = true
		h.mu.Unlock()
		if !seen {
			c.cfg.Log.Info("a machine sailor's app called", "account", a.Account.String(), "app", app, "era", era,
				"client", clientName(req))
		}
		h.called(start, app)
		text, data, r := c.call(ctx, d, h, a, req)
		res := &mcp.CallToolResult{}
		result := resultOK
		switch {
		case r != nil:
			result = resultRefused
			res.IsError = true
			text = r.words
			h.mu.Lock()
			h.refusals++
			h.mu.Unlock()
			if c.cfg.Metrics != nil {
				c.cfg.Metrics.AgentRefusals.WithLabelValues(string(r.kind)).Inc()
			}
		case ctx.Err() != nil:
			result = resultError
		}
		if primed(before, start) {
			text = primer + "\n\n" + text
		}
		res.Content = []mcp.Content{&mcp.TextContent{Text: text}}
		if data != nil && r == nil {
			res.StructuredContent = data
		}
		// Waiting is calling: the call's end counts too.
		h.called(time.Now(), "")
		if m := c.cfg.Metrics; m != nil {
			m.AgentCalls.WithLabelValues(name, result, app, era).Inc()
			m.AgentCallTime.WithLabelValues(name).Observe(time.Since(start).Seconds())
		}
		return res, nil
	}
}

// clientName is the client's name and version as the call gives them.
func clientName(req *mcp.CallToolRequest) string {
	if ci := req.ClientInfo(); ci != nil {
		return ci.Name + " " + ci.Version
	}
	if req.Extra != nil && req.Extra.Header != nil {
		return req.Extra.Header.Get("User-Agent")
	}
	return ""
}

// args reads a call's arguments into v: an absent object is none.
func args(req *mcp.CallToolRequest, v any) *refusal {
	raw := req.Params.Arguments
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	d := json.NewDecoder(strings.NewReader(string(raw)))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return refuse(refusedArgs, "The arguments are not this tool's: "+strings.TrimPrefix(err.Error(), "json: ")+
			". The tool's description lists what it takes.")
	}
	return nil
}

// call does a tool's work with the helm's turn held, and answers in text,
// with data for a JSON answer, or with a refusal.
func (c *Core) call(ctx context.Context, d toolDef, h *helm, a *oauth.Accepted, req *mcp.CallToolRequest) (string, any, *refusal) {
	if err := h.take(ctx); err != nil {
		return "", nil, nil
	}
	taken := true
	h.mu.Lock()
	ended := h.ended
	h.mu.Unlock()
	if ended != nil {
		// Stopped while this call waited for its turn.
		h.give()
		return "", nil, ended
	}
	defer func() {
		if taken {
			h.give()
		}
	}()
	if ok, wait := h.spend(d.budget, time.Now()); !ok {
		holds := ""
		if d.budget == orders {
			holds = h.holding()
		}
		return "", nil, overBudget(d.budget, c.cfg.Limits, wait, holds)
	}
	switch d.tool.Name {
	case toolObserve:
		var o observeArgs
		if r := args(req, &o); r != nil {
			return "", nil, r
		}
		text, data, r := c.observe(ctx, h, req, &o, &taken)
		return text, data, r
	case toolSteer:
		var o steerOrder
		if r := args(req, &o); r != nil {
			return "", nil, r
		}
		return c.order(ctx, h, func(s *Sea, f *bus.Frame, sl int32) (written, string) { return h.steer(s, f, sl, &o) })
	case toolTrim:
		var o struct {
			Boom *int `json:"boom"`
		}
		if r := args(req, &o); r != nil {
			return "", nil, r
		}
		if o.Boom == nil {
			return "", nil, refuse(refusedArgs, "trim takes boom: how far out the boom may swing, 4 to 95 degrees.")
		}
		return c.order(ctx, h, func(s *Sea, f *bus.Frame, sl int32) (written, string) { return h.trim(s, f, sl, *o.Boom) })
	case toolChart:
		var o chartArgs
		if r := args(req, &o); r != nil {
			return "", nil, r
		}
		s, x, y, atSea := c.where(h)
		if s == nil {
			return "", nil, refuse(refusedNoWorld, wordsNoWorld)
		}
		text, r := chartList(s, &o, x, y, atSea)
		return text, nil, r
	case toolForecast:
		var o forecastArgs
		if r := args(req, &o); r != nil {
			return "", nil, r
		}
		s, x, y, atSea := c.where(h)
		if s == nil {
			return "", nil, refuse(refusedNoWorld, wordsNoWorld)
		}
		f := s.Bus.Frames.Acquire()
		defer f.Release()
		text, r := forecastWords(s, f, &o, x, y, atSea)
		return text, nil, r
	case toolNews:
		var o newsArgs
		if r := args(req, &o); r != nil {
			return "", nil, r
		}
		s := c.sea.Load()
		if s == nil {
			return "", nil, refuse(refusedNoWorld, wordsNoWorld)
		}
		text, r := newsWords(ctx, s, &o)
		return text, nil, r
	case toolBoat:
		var o struct {
			Action string `json:"action,omitempty"`
			Boat   string `json:"boat,omitempty"`
		}
		if r := args(req, &o); r != nil {
			return "", nil, r
		}
		return c.boat(ctx, h, o.Action, o.Boat)
	case toolHandbook:
		var o handbookArgs
		if r := args(req, &o); r != nil {
			return "", nil, r
		}
		text, r := c.handbookPage(o.Topic, a.Name, a.OwnerName)
		return text, nil, r
	}
	if words, ok := notYet[d.tool.Name]; ok {
		return words, nil, nil
	}
	return "", nil, refuse(refusedArgs, "No such tool.")
}

// holding is the order the helm's boat holds, in words, "" if it has none.
func (h *helm) holding() string {
	s := h.core.sea.Load()
	h.mu.Lock()
	sl, boat := h.slot, h.boat
	h.mu.Unlock()
	if s == nil || boat == 0 {
		return ""
	}
	f := s.Bus.Frames.Acquire()
	defer f.Release()
	if !f.Occupied[sl] || f.Boat[sl] != boat {
		return ""
	}
	p := pilotOf(f, sl)
	word, _ := held(s, f, sl)
	return fmt.Sprintf("%s, boom out to %d°", p.Holds, int(math.Round(boomOf(s.boat(f.Kind[sl]), word.SheetIndex()))))
}

// where is the world and where the helm's boat is, if it is at sea; else
// the start's place.
func (c *Core) where(h *helm) (s *Sea, x, y float64, atSea bool) {
	s = c.sea.Load()
	if s == nil {
		return nil, 0, 0, false
	}
	f := s.Bus.Frames.Acquire()
	defer f.Release()
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.sea == s && h.locate(f) {
		st := &f.State[h.slot]
		return s, st.X, st.Y, true
	}
	return s, 0, 0, false
}

// atSeaRefusal is the refusal for a boat that could not go to sea, or nil.
func atSeaRefusal(err error, jr joinResult) *refusal {
	switch {
	case errors.Is(err, errNoSea):
		return refuse(refusedNoWorld, wordsNoWorld)
	case err != nil:
		return refuse(refusedBusy, wordsBusy)
	case jr.full:
		return refuse(refusedFull, wordsFull)
	}
	return nil
}

// noticesOf are what a call is told of going to sea.
func (c *Core) noticesOf(s *Sea, jr joinResult) []string {
	var out []string
	if w := leftWords(jr.told, c.cfg.Silence); w != "" {
		out = append(out, w)
	}
	if jr.joined {
		where := "at the start"
		if s.Start != "" {
			where = "at " + s.Start
		}
		out = append(out, "At sea: you are in the water "+where+".")
	}
	return out
}

// order gives an order to the helm's boat, taking it to sea first if it
// has none, and answers with the boat as the order leaves it.
func (c *Core) order(ctx context.Context, h *helm, give func(s *Sea, f *bus.Frame, sl int32) (written, string)) (string, any, *refusal) {
	s, f, jr, err := h.atSea(ctx)
	if r := atSeaRefusal(err, jr); r != nil {
		return "", nil, r
	}
	defer f.Release()
	if jr.queued {
		return "", nil, refuse(refusedQueued, queuedWords(jr.position))
	}
	h.mu.Lock()
	sl := h.slot
	h.mu.Unlock()
	if f.Voyage[sl].Falling() {
		return "", nil, refuse(refusedFalling, wordsFalling)
	}
	w, refused := give(s, f, sl)
	if refused != "" {
		return "", nil, refuse(refusedOrder, refused)
	}
	lines := append(c.noticesOf(s, jr), orderLine(s, f, sl, w))
	return strings.Join(lines, "\n"), nil, nil
}

// boat answers boat: the fleet, going to sea, leaving the water.
func (c *Core) boat(ctx context.Context, h *helm, action, which string) (string, any, *refusal) {
	s := c.sea.Load()
	if s == nil {
		return "", nil, refuse(refusedNoWorld, wordsNoWorld)
	}
	name := s.Boats[0].Name
	switch action {
	case "", "list":
		_, _, _, atSea := c.where(h)
		state := "ashore"
		if atSea {
			state = "in the water, sailed by you"
		}
		return fmt.Sprintf("Your owner's fleet: %s (%s). Take it with action take; leave the water with action leave.", name, state), nil, nil
	case "take":
		if which != "" && fold(which) != fold(name) {
			return "", nil, refuse(refusedArgs, fmt.Sprintf("No boat called %q in your owner's fleet: it has %s.", which, name))
		}
		s, f, jr, err := h.atSea(ctx)
		if r := atSeaRefusal(err, jr); r != nil {
			return "", nil, r
		}
		defer f.Release()
		if jr.queued {
			return queuedWords(jr.position), nil, nil
		}
		lines := c.noticesOf(s, jr)
		if !jr.joined {
			lines = append(lines, "Already at sea in your "+name+".")
		}
		return strings.Join(lines, "\n"), nil, nil
	case "leave":
		left, err := h.leave(ctx, s)
		switch {
		case err != nil:
			return "", nil, refuse(refusedBusy, wordsBusy)
		case !left:
			return "Not at sea: your boat is ashore already.", nil, nil
		}
		return "Your boat has left the water: your voyage is over. Calling observe, steer or trim takes you to sea again, at the start.", nil, nil
	case "look":
		return "Not yet: boat looks come with a later update.", nil, nil
	case "sailor_look":
		return "Not yet: sailors' looks come with a later update.", nil, nil
	}
	return "", nil, refuse(refusedArgs, "action is list, take, leave, look or sailor_look.")
}

// observeArgs are observe's.
type observeArgs struct {
	Wait      *int     `json:"wait,omitempty"`
	WakeOn    []string `json:"wake_on,omitempty"`
	HeelOver  *int     `json:"heel_over,omitempty"`
	ShiftOver *int     `json:"shift_over,omitempty"`
	Place     string   `json:"place,omitempty"`
	Bearing   *int     `json:"bearing,omitempty"`
	NearNM    *float64 `json:"near_nm,omitempty"`
	Detail    string   `json:"detail,omitempty"`
	Since     *int64   `json:"since,omitempty"`
	Format    string   `json:"format,omitempty"`
}

// check checks observe's arguments, in words that say what to send.
func (o *observeArgs) check() *refusal {
	switch {
	case o.Wait != nil && (*o.Wait < 0 || *o.Wait > int(MaxWait/time.Second)):
		return refuse(refusedArgs, "wait is 0 to 50 seconds; 25 is safe in every app.")
	case o.Detail != "" && o.Detail != detailBrief && o.Detail != detailFull:
		return refuse(refusedArgs, "detail is brief or full.")
	case o.Format != "" && o.Format != "text" && o.Format != "json":
		return refuse(refusedArgs, "format is text or json.")
	case o.HeelOver != nil && (*o.HeelOver < 5 || *o.HeelOver > 60):
		return refuse(refusedArgs, "heel_over is 5 to 60 degrees.")
	case o.ShiftOver != nil && (*o.ShiftOver < 3 || *o.ShiftOver > 90):
		return refuse(refusedArgs, "shift_over is 3 to 90 degrees.")
	case o.Bearing != nil && (*o.Bearing < 0 || *o.Bearing > 359):
		return refuse(refusedArgs, "bearing is 0 to 359 degrees true.")
	case o.NearNM != nil && (*o.NearNM < 0.05 || *o.NearNM > 5):
		return refuse(refusedArgs, "near_nm is 0.05 to 5 nautical miles.")
	}
	known := map[string]bool{}
	for _, w := range wakeWords {
		known[w] = true
	}
	for _, w := range o.WakeOn {
		if !known[w] {
			return refuse(refusedArgs, fmt.Sprintf("wake_on %q is not one of %s.", w, strings.Join(wakeWords, ", ")))
		}
		switch {
		case w == wakeHeel && o.HeelOver == nil:
			return refuse(refusedArgs, "wake_on heel needs heel_over: the heel in degrees that wakes you, say 25.")
		case w == wakeWindShift && o.ShiftOver == nil:
			return refuse(refusedArgs, "wake_on wind_shift needs shift_over: the turn of the wind in degrees that wakes you, say 15.")
		case w == wakeBearing && (o.Place == "" || o.Bearing == nil):
			return refuse(refusedArgs, "wake_on bearing needs place, a charted place's name, and bearing, the bearing of it from you that wakes you.")
		case w == wakeNear && (o.Place == "" || o.NearNM == nil):
			return refuse(refusedArgs, "wake_on near needs place, a charted place's name, and near_nm, how near in nautical miles.")
		}
	}
	return nil
}

// observe answers observe: the report, at once or after a wait.
func (c *Core) observe(ctx context.Context, h *helm, req *mcp.CallToolRequest, o *observeArgs, taken *bool) (string, any, *refusal) {
	if r := o.check(); r != nil {
		return "", nil, r
	}
	s, f, jr, err := h.atSea(ctx)
	if r := atSeaRefusal(err, jr); r != nil {
		return "", nil, r
	}
	notices := c.noticesOf(s, jr)
	woke := ""
	wait := 0
	if o.Wait != nil {
		wait = *o.Wait
	}
	if wait > 0 {
		var place *placeOf
		if o.Place != "" {
			e, ok := placeNamed(charted(s), o.Place)
			if !ok {
				f.Release()
				return "", nil, refuse(refusedPlace, fmt.Sprintf("No charted place called %q: bearing and near watch a charted place. Call chart for their names.", o.Place))
			}
			place = &placeOf{name: titleOf(e.sub), x: e.sub.X, y: e.sub.Y}
		}
		f.Release()
		why, r := c.wait(ctx, h, req, o, place, wait, taken)
		if r != nil {
			return "", nil, r
		}
		if ctx.Err() != nil {
			return "", nil, nil
		}
		f = s.Bus.Frames.Acquire()
		if why == wokeTime {
			woke = fmt.Sprintf("waited %d s, nothing new", wait)
		} else {
			woke = "woke: " + why
		}
	}
	defer f.Release()
	h.mu.Lock()
	defer h.mu.Unlock()
	if s != c.sea.Load() {
		return "", nil, refuse(refusedEnded, wordsEnded)
	}
	if !h.locate(f) {
		if h.queued {
			text := queuedWords(h.position)
			if woke != "" {
				text = woke + "\n" + text
			}
			return strings.Join(append(notices, text), "\n"), nil, nil
		}
		return "", nil, refuse(refusedNotAtSea, strings.TrimSpace(leftWords(h.left, c.cfg.Silence)+" "+wordsNotAtSea))
	}
	since := h.seq
	if o.Since != nil {
		since = *o.Since
	}
	detail := o.Detail
	if detail == "" {
		detail = detailBrief
	}
	rep := h.reportFor(s, f, h.slot, detail, since)
	rep.Woke, rep.Notices = woke, notices
	h.seq = rep.Seq
	text := rep.text()
	if m := c.cfg.Metrics; m != nil {
		m.AgentReport.WithLabelValues(detail).Observe(float64(estimateTokens(text)))
	}
	if o.Format == "json" {
		return rep.json(), rep, nil
	}
	return text, nil, nil
}

// wait waits for what o asks, with the helm's turn given up, and returns
// why it ended: a wake's word, time, or a refusal for a wait ended by
// another, by the world's end or by keel's restart. It takes the turn
// again before it returns.
func (c *Core) wait(ctx context.Context, h *helm, req *mcp.CallToolRequest, o *observeArgs, place *placeOf, seconds int, taken *bool) (string, *refusal) {
	on := o.WakeOn
	if len(on) == 0 {
		on = wakeDefault
	}
	w := newWaiter(time.Now(), on)
	if o.HeelOver != nil {
		w.heelOver = rad(float64(*o.HeelOver))
	}
	if o.ShiftOver != nil {
		w.shiftOver = rad(float64(*o.ShiftOver))
	}
	if place != nil {
		w.place = place
		if o.Bearing != nil {
			w.bearing = rad(float64(*o.Bearing))
		}
		if o.NearNM != nil {
			w.near = *o.NearNM * nm
		}
	}
	d := time.Duration(seconds) * time.Second
	extendDeadline(ctx, d+deadlineMargin)
	h.wait(w)
	h.give()
	*taken = false
	m := c.cfg.Metrics
	if m != nil {
		m.AgentWaitSeconds.WithLabelValues("asked").Observe(float64(seconds))
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	tick := time.NewTicker(progressEvery)
	defer tick.Stop()
	token := req.Params.GetProgressToken()
	start := time.Now()
	why := ""
	for why == "" {
		select {
		case why = <-w.done:
		case <-timer.C:
			why = wokeTime
		case <-ctx.Done():
			why = wokeCut
		case <-c.stopping:
			why = wokeShutdown
		case <-tick.C:
			if token != nil && req.Session != nil {
				_ = req.Session.NotifyProgress(ctx, &mcp.ProgressNotificationParams{
					ProgressToken: token, Progress: time.Since(start).Seconds(), Total: float64(seconds), Message: "waiting",
				})
			}
		}
	}
	h.unwait(w)
	waited := time.Since(start)
	if m != nil {
		m.AgentWaits.WithLabelValues(wakeLabel(why)).Inc()
		m.AgentWaitSeconds.WithLabelValues("served").Observe(waited.Seconds())
		if why == wokeCut {
			h.mu.Lock()
			app := h.app
			h.mu.Unlock()
			m.AgentWaitCut.WithLabelValues(app).Observe(waited.Seconds())
		}
	}
	switch why {
	case wokeCut:
		return why, nil
	case wokeSuperseded:
		return why, refuse(refusedSuperseded, wordsSuperseded)
	case wokeShutdown:
		return why, refuse(refusedRestarting, wordsRestarting)
	case wokeEnded:
		h.mu.Lock()
		r := h.waitEnd
		if h.waitEnd != h.ended {
			h.waitEnd = nil
		}
		h.mu.Unlock()
		if r == nil {
			r = refuse(refusedStopped, oauth.WordsStopped)
		}
		return why, r
	case evWorldEnded.word():
		return why, refuse(refusedEnded, wordsEnded)
	}
	if err := h.take(ctx); err != nil {
		return wokeCut, nil
	}
	*taken = true
	return why, nil
}

// wakeLabel is what ended a wait, as keel_agent_waits_total counts it: a
// wake_on word, an event's, time, superseded, cut or shutdown.
func wakeLabel(why string) string {
	switch why {
	case wokeTime, wokeSuperseded, wokeCut, wokeShutdown, wokeEnded:
		return why
	}
	for _, w := range wakeWords {
		if w == why {
			return w
		}
	}
	return "event"
}
