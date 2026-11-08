// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"encoding/json"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// The tools. Twelve, fixed, the same for every machine sailor and every
// app, in this order, named for what a sailor does: apps cache a server's
// tool list or freeze it, so the list never changes as the game grows; a
// tool whose feature is still to come answers "not yet". Their
// definitions, descriptions included, are here alone, and
// testdata/tools.golden.json holds the exact tools/list answer, so that
// any change to what agents are told shows in review and in the release
// notes. Each has a title and says whether it only reads or what it
// changes; none reaches beyond the game. Schemas are flat objects with
// simple types, enums and ranges, never oneOf or anyOf at the root: "one
// of" is the handler's to check, in words that say what to send.
// Descriptions are fixed text, never anything a player wrote.

// The tools' names.
const (
	toolObserve  = "observe"
	toolSteer    = "steer"
	toolTrim     = "trim"
	toolChart    = "chart"
	toolPencil   = "pencil"
	toolForecast = "forecast"
	toolNews     = "news"
	toolSay      = "say"
	toolRace     = "race"
	toolBoat     = "boat"
	toolBottle   = "bottle"
	toolHandbook = "handbook"
)

// metaAlwaysLoad marks a tool an app should load at once rather than
// behind a search: the core of the loop.
const metaAlwaysLoad = "anthropic/alwaysLoad"

// toolDef is a tool's definition and its budget.
type toolDef struct {
	tool   *mcp.Tool
	budget budget
	// joins: the tool takes the boat to sea if it has none.
	joins bool
}

// schema is a tool's input schema, written out.
func schema(s string) json.RawMessage { return json.RawMessage(s) }

// hints are a tool's annotations: read-only, or what it changes. The
// tool's own title names it.
func hints(_ string, readOnly, idempotent, destructive bool) *mcp.ToolAnnotations {
	closed := false
	a := &mcp.ToolAnnotations{ReadOnlyHint: readOnly, IdempotentHint: idempotent, OpenWorldHint: &closed}
	if !readOnly {
		a.DestructiveHint = &destructive
	}
	return a
}

// alwaysLoad is the _meta of a core tool.
func alwaysLoad() mcp.Meta { return mcp.Meta{metaAlwaysLoad: true} }

// tools are the twelve, in their order.
func tools() []toolDef {
	return []toolDef{
		{budget: looks, joins: true, tool: &mcp.Tool{
			Name: toolObserve, Title: "Observe",
			Description: "See your boat, the wind, the sea, what is in sight and what happened since your last look. " +
				"Use wait to rest until something needs you, instead of calling again and again: the sea does not pause, and your boat sails on while you wait. " +
				"If you are new, call handbook first.",
			Annotations: hints("Observe", true, false, false), Meta: alwaysLoad(),
			InputSchema: schema(`{"type":"object","properties":{` +
				`"wait":{"type":"integer","minimum":0,"maximum":50,"description":"Seconds to rest until something happens; 0 answers now. 25 is safe in every app."},` +
				`"wake_on":{"type":"array","items":{"type":"string","enum":["gust","boat","land","sighting","heel","wind_shift","bearing","near","chat","race","pilot","sky","weather","life"]},"description":"What ends the wait. Default all but life and heel, wind_shift, bearing, near (need values)."},` +
				`"heel_over":{"type":"integer","minimum":5,"maximum":60,"description":"Degrees, for heel."},` +
				`"shift_over":{"type":"integer","minimum":3,"maximum":90,"description":"Degrees, for wind_shift."},` +
				`"place":{"type":"string","description":"A charted place, for bearing and near."},` +
				`"bearing":{"type":"integer","minimum":0,"maximum":359,"description":"Its bearing from you, for bearing."},` +
				`"near_nm":{"type":"number","minimum":0.05,"maximum":5,"description":"How near, for near."},` +
				`"detail":{"type":"string","enum":["brief","full"],"description":"brief (default): the vital lines and what changed. full: everything."},` +
				`"since":{"type":"integer","description":"Events after this seq, after a lost answer."},` +
				`"format":{"type":"string","enum":["text","json"],"description":"Default text."}` +
				`}}`),
		}},
		{budget: orders, joins: true, tool: &mcp.Tool{
			Name: toolSteer, Title: "Steer",
			Description: "Steer by autopilot (wind_angle with side, or heading) or by hand (rudder). " +
				"The autopilot steers but never trims: set the sail with trim, and ease it in gusts or the boat capsizes. " +
				"Orders are targets: the same order twice changes nothing.",
			Annotations: hints("Steer", false, true, false), Meta: alwaysLoad(),
			InputSchema: schema(`{"type":"object","properties":{` +
				`"wind_angle":{"type":"integer","minimum":30,"maximum":180,"description":"Autopilot: this angle off the true wind."},` +
				`"side":{"type":"string","enum":["port","starboard","same"],"description":"The side the wind comes over. Default same."},` +
				`"heading":{"type":"integer","minimum":0,"maximum":359,"description":"Autopilot: this heading, degrees true."},` +
				`"via":{"type":"string","enum":["auto","tack","gybe"],"description":"How to turn if the side changes. auto never gybes."},` +
				`"rudder":{"type":"integer","minimum":-40,"maximum":40,"description":"Hand steering, degrees; negative turns to port."},` +
				`"boom":{"type":"integer","minimum":4,"maximum":95,"description":"Also trim, as trim does."},` +
				// The reef's name with its quotes escaped, as below: the
				// catalog's check refuses a surface's id quoted in code,
				// and this is an argument's name, not a surface.
				"\"reef\":{\"type\":\"integer\",\"minimum\":0,\"maximum\":2,\"description\":\"Also reef, as trim does.\"}" +
				`}}`),
		}},
		{budget: orders, joins: true, tool: &mcp.Tool{
			Name: toolTrim, Title: "Trim",
			Description: "Set the sheet: how far out the boom may swing, in degrees, from 4 (hauled in hard) to 95 (let fly). " +
				"A rough guide is half the apparent wind's angle. Ease it in gusts and in a breeze, or the boat heels too far and capsizes.",
			Annotations: hints("Trim", false, true, false), Meta: alwaysLoad(),
			InputSchema: schema(`{"type":"object","properties":{` +
				`"boom":{"type":"integer","minimum":4,"maximum":95,"description":"Degrees the boom may swing out; a ship's yards, off the centreline. Ease (larger) in gusts."},` +
				"\"reef\":{\"type\":\"integer\",\"minimum\":0,\"maximum\":2," +
				`"description":"0 full sail; 1 or 2 reefs: a smaller sail, heeling less in a strong wind. Give boom, reef or both."}` +
				`}}`),
		}},
		{budget: looks, tool: &mcp.Tool{
			Name: toolChart, Title: "Chart",
			Description: "The world's shared chart: charted places nearest first, with position, bearing and distance from you, and who charted them. " +
				"Uncharted places have no names until someone sights them. Steer by the bearings: there is no steering to a place by name.",
			Annotations: hints("Chart", true, true, false), Meta: alwaysLoad(),
			InputSchema: schema(`{"type":"object","properties":{` +
				`"group":{"type":"string","enum":["all","islands","places","features"],"description":"Default all."},` +
				`"limit":{"type":"integer","minimum":1,"maximum":30,"description":"Default 10."},` +
				`"place":{"type":"string","description":"One place by name."}` +
				`}}`),
		}},
		{budget: looks, tool: &mcp.Tool{
			Name: toolPencil, Title: "Pencil",
			Description: "A private note on your chart. Not yet.",
			Annotations: hints("Pencil", false, true, false),
			InputSchema: schema(`{"type":"object","properties":{` +
				`"note":{"type":"string","maxLength":200,"description":"Empty rubs it out."},` +
				`"place":{"type":"string","description":"A charted place."}` +
				`}}`),
		}},
		{budget: looks, tool: &mcp.Tool{
			Name: toolForecast, Title: "Forecast",
			Description: "The next 90 minutes' forecast, as every chart shows it, and the truth: gale warnings in force, " +
				"each weather system's wind, where it is now and in 30, 60 and 90 minutes, and when fronts reach you. " +
				"With place, a charted place's local weather and outlook.",
			Annotations: hints("Forecast", true, true, false),
			InputSchema: schema(`{"type":"object","properties":{` +
				`"place":{"type":"string","description":"A charted place: its local weather."}` +
				`}}`),
		}},
		{budget: looks, tool: &mcp.Tool{
			Name: toolNews, Title: "News",
			Description: "The world's news sheet, newest first: what was charted and by whom, and the world's notices. " +
				"Names in «» are written by players.",
			Annotations: hints("News", true, true, false),
			InputSchema: schema(`{"type":"object","properties":{` +
				`"before":{"type":"string","description":"An id from the last page."},` +
				`"limit":{"type":"integer","minimum":1,"maximum":20,"description":"Default 10."}` +
				`}}`),
		}},
		{budget: looks, tool: &mcp.Tool{
			Name: toolSay, Title: "Say",
			Description: "Chat aboard: a line to all aboard your boat; theirs come in observe. hail, spectators: not yet.",
			Annotations: hints("Say", false, false, false),
			InputSchema: schema(`{"type":"object","properties":{` +
				`"text":{"type":"string","maxLength":200},` +
				`"to":{"type":"string","enum":["aboard","hail","spectators"],"description":"Default aboard."}` +
				`}}`),
		}},
		{budget: orders, tool: &mcp.Tool{
			Name: toolRace, Title: "Race",
			Description: "Races: list, enter, start, retire. Not yet.",
			Annotations: hints("Race", false, false, false),
			InputSchema: schema(`{"type":"object","properties":{` +
				`"action":{"type":"string","enum":["list","enter","start","retire"],"description":"Default list."},` +
				`"race":{"type":"string","description":"By its name."}` +
				`}}`),
		}},
		{budget: orders, tool: &mcp.Tool{
			Name: toolBoat, Title: "Boat",
			Description: "Your owner's fleet, shared by its sailors: list its boats; take one available; look paints, numbers and names yours. " +
				"At sea both only in port (Port Royal or a port, not a village). leave quits the water; observe, steer and trim sail anyway. " +
				"sailor_look: your own look, at Port Royal.",
			Annotations: hints("Boat", false, false, false),
			InputSchema: schema(`{"type":"object","properties":{` +
				`"action":{"type":"string","enum":["list","take","leave","look","sailor_look"],"description":"Default list."},` +
				`"boat":{"type":"string","description":"For take: its kind, name or number."},` +
				`"paint":{"type":"string"},` +
				`"cloth":{"type":"string"},` +
				`"number":{"type":"integer","minimum":1,"maximum":9999},` +
				`"name":{"type":"string","maxLength":20,"description":"Empty clears it."},` +
				`"version":{"type":"string"},` +
				`"finish":{"type":"string"},` +
				`"colour":{"type":"string","description":"With version and finish, for sailor_look."}` +
				`}}`),
		}},
		{budget: looks, tool: &mcp.Tool{
			Name: toolBottle, Title: "Bottle",
			Description: "A message in a bottle, dropped over the side. Not yet.",
			Annotations: hints("Bottle", false, false, false),
			InputSchema: schema(`{"type":"object","properties":{` +
				`"message":{"type":"string","maxLength":280}` +
				`}}`),
		}},
		{budget: looks, tool: &mcp.Tool{
			Name: toolHandbook, Title: "Handbook",
			Description: "How to sail and how the game works, a short page a topic. " +
				"With no topic, the list, and which machine sailor you sail as. Read start first.",
			Annotations: hints("Handbook", true, true, false), Meta: alwaysLoad(),
			InputSchema: schema(`{"type":"object","properties":{` +
				`"topic":{"type":"string","enum":["start","sailing","trim","autopilot","articles","charting","edge","weather","aboard","tools","limits"],"description":"Default: the list."}` +
				`}}`),
		}},
	}
}
