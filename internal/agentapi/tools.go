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

// hints are a tool's annotations: read-only, or what it changes.
func hints(title string, readOnly, idempotent, destructive bool) *mcp.ToolAnnotations {
	closed := false
	a := &mcp.ToolAnnotations{Title: title, ReadOnlyHint: readOnly, IdempotentHint: idempotent, OpenWorldHint: &closed}
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
				`"wait":{"type":"integer","minimum":0,"maximum":50,"description":"Seconds to wait for something to happen (0 = answer now). Default 0; up to 25 is safe in every app."},` +
				`"wake_on":{"type":"array","items":{"type":"string","enum":["gust","boat","land","sighting","heel","wind_shift","bearing","near","chat","race","pilot"]},"description":"What ends the wait early. Default: everything except heel, wind_shift, bearing and near, which need a value."},` +
				`"heel_over":{"type":"integer","minimum":5,"maximum":60,"description":"With heel: wake when the boat heels this many degrees."},` +
				`"shift_over":{"type":"integer","minimum":3,"maximum":90,"description":"With wind_shift: wake when the mean wind turns this many degrees."},` +
				`"place":{"type":"string","description":"A charted place's name, for bearing and near."},` +
				`"bearing":{"type":"integer","minimum":0,"maximum":359,"description":"With place: wake when its bearing from you reaches this."},` +
				`"near_nm":{"type":"number","minimum":0.05,"maximum":5,"description":"With place: wake within this many nautical miles of it."},` +
				`"detail":{"type":"string","enum":["brief","full"],"description":"brief (default): what changed and the vital lines. full: everything in sight."},` +
				`"since":{"type":"integer","description":"Report events after this seq (to recover after a lost answer)."},` +
				`"format":{"type":"string","enum":["text","json"],"description":"text (default) or json, the same facts."}` +
				`},"additionalProperties":false}`),
		}},
		{budget: orders, joins: true, tool: &mcp.Tool{
			Name: toolSteer, Title: "Steer",
			Description: "Steer by autopilot (wind_angle with side, or heading) or by hand (rudder). " +
				"The autopilot steers but never trims: set the sail with trim, and ease it in gusts or the boat capsizes. " +
				"Orders are targets, not nudges, so sending the same order twice changes nothing.",
			Annotations: hints("Steer", false, true, false), Meta: alwaysLoad(),
			InputSchema: schema(`{"type":"object","properties":{` +
				`"wind_angle":{"type":"integer","minimum":30,"maximum":180,"description":"Autopilot holds this angle off the true wind."},` +
				`"side":{"type":"string","enum":["port","starboard","same"],"description":"The tack to sail on, with wind_angle: the side the wind comes over. Default same."},` +
				`"heading":{"type":"integer","minimum":0,"maximum":359,"description":"Autopilot holds this compass heading, degrees true."},` +
				`"via":{"type":"string","enum":["auto","tack","gybe"],"description":"How to turn if the side changes. auto never turns through dead downwind."},` +
				`"rudder":{"type":"integer","minimum":-40,"maximum":40,"description":"Hand steering: degrees, negative turns to port. Turns the autopilot off."},` +
				`"boom":{"type":"integer","minimum":4,"maximum":95,"description":"Optional: set the sheet in the same order, as trim does."}` +
				`},"additionalProperties":false}`),
		}},
		{budget: orders, joins: true, tool: &mcp.Tool{
			Name: toolTrim, Title: "Trim",
			Description: "Set the sheet: how far out the boom may swing, in degrees, from 4 (hauled in hard) to 95 (let fly). " +
				"A rough guide is half the apparent wind's angle. Ease it in gusts and in a breeze, or the boat heels too far and capsizes.",
			Annotations: hints("Trim", false, true, false), Meta: alwaysLoad(),
			InputSchema: schema(`{"type":"object","properties":{` +
				`"boom":{"type":"integer","minimum":4,"maximum":95,"description":"How far out the boom may swing, in degrees. Ease (larger) in gusts; a rough guide is half the apparent wind angle."}` +
				`},"required":["boom"],"additionalProperties":false}`),
		}},
		{budget: looks, tool: &mcp.Tool{
			Name: toolChart, Title: "Chart",
			Description: "The world's shared chart: charted places nearest first, each with its position and its bearing and distance from you, and who charted it. " +
				"Uncharted places have no names until someone sights them. Steer by the bearings: there is no steering to a place by name.",
			Annotations: hints("Chart", true, true, false), Meta: alwaysLoad(),
			InputSchema: schema(`{"type":"object","properties":{` +
				`"group":{"type":"string","enum":["all","islands","places","features"],"description":"What to list. Default all."},` +
				`"limit":{"type":"integer","minimum":1,"maximum":30,"description":"How many, nearest first. Default 10."},` +
				`"place":{"type":"string","description":"One charted place by name, with its light if it has one."}` +
				`},"additionalProperties":false}`),
		}},
		{budget: looks, tool: &mcp.Tool{
			Name: toolPencil, Title: "Pencil",
			Description: "Write or rub out a private note on your own chart. Not yet: pencil notes come with a later update.",
			Annotations: hints("Pencil", false, true, false),
			InputSchema: schema(`{"type":"object","properties":{` +
				`"note":{"type":"string","maxLength":200,"description":"The note to write; empty rubs out the note at place."},` +
				`"place":{"type":"string","description":"A charted place's name the note is by."}` +
				`},"additionalProperties":false}`),
		}},
		{budget: looks, tool: &mcp.Tool{
			Name: toolForecast, Title: "Forecast",
			Description: "The latest forecast, as every sailor's chart shows it: gale warnings in force, and the weather systems with where they are heading. " +
				"With place, one charted place's local weather and outlook, as its harbourmaster's board gives them.",
			Annotations: hints("Forecast", true, true, false),
			InputSchema: schema(`{"type":"object","properties":{` +
				`"place":{"type":"string","description":"A charted place's name: its box and outlook."},` +
				`"ahead":{"type":"integer","enum":[0,30,60,90],"description":"Minutes after the issue: where the systems are forecast to be then. Default 0."}` +
				`},"additionalProperties":false}`),
		}},
		{budget: looks, tool: &mcp.Tool{
			Name: toolNews, Title: "News",
			Description: "The world's news sheet, newest first: what was charted and by whom, the world's notices and gale warnings. " +
				"Names in «» are written by players.",
			Annotations: hints("News", true, true, false),
			InputSchema: schema(`{"type":"object","properties":{` +
				`"before":{"type":"string","description":"The page after this item, by the id the last answer gave. Default the newest."},` +
				`"limit":{"type":"integer","minimum":1,"maximum":20,"description":"How many items. Default 10."}` +
				`},"additionalProperties":false}`),
		}},
		{budget: looks, tool: &mcp.Tool{
			Name: toolSay, Title: "Say",
			Description: "Chat aboard, hail the boats close by, or speak to your spectators. Not yet: chat comes with a later update.",
			Annotations: hints("Say", false, false, false),
			InputSchema: schema(`{"type":"object","properties":{` +
				`"text":{"type":"string","maxLength":200,"description":"What to say."},` +
				`"to":{"type":"string","enum":["aboard","hail","spectators"],"description":"Who hears it. Default hail."}` +
				`},"additionalProperties":false}`),
		}},
		{budget: orders, tool: &mcp.Tool{
			Name: toolRace, Title: "Race",
			Description: "List the races, enter one, vote to start it, or retire. Not yet: races come with a later update.",
			Annotations: hints("Race", false, false, false),
			InputSchema: schema(`{"type":"object","properties":{` +
				`"action":{"type":"string","enum":["list","enter","start","retire"],"description":"What to do. Default list."},` +
				`"race":{"type":"string","description":"The race, by its name in the list."}` +
				`},"additionalProperties":false}`),
		}},
		{budget: orders, tool: &mcp.Tool{
			Name: toolBoat, Title: "Boat",
			Description: "Your owner's fleet: list the boats you may take, take one to sea, or leave the water. " +
				"Calling observe, steer or trim takes you to sea in your boat anyway; leave ends your voyage.",
			Annotations: hints("Boat", false, false, false),
			InputSchema: schema(`{"type":"object","properties":{` +
				`"action":{"type":"string","enum":["list","take","leave","look","sailor_look"],"description":"What to do. Default list."},` +
				`"boat":{"type":"string","description":"With take: the boat, by its name in the list."}` +
				`},"additionalProperties":false}`),
		}},
		{budget: looks, tool: &mcp.Tool{
			Name: toolBottle, Title: "Bottle",
			Description: "Write a message, put it in a bottle and drop it over the side for someone to find. Not yet: messages in bottles come with a later update.",
			Annotations: hints("Bottle", false, false, false),
			InputSchema: schema(`{"type":"object","properties":{` +
				`"message":{"type":"string","maxLength":280,"description":"The message."}` +
				`},"additionalProperties":false}`),
		}},
		{budget: looks, tool: &mcp.Tool{
			Name: toolHandbook, Title: "Handbook",
			Description: "How to sail and how the game works, a short page a topic: start, sailing, trim, autopilot, articles, charting, edge, weather, tools, limits. " +
				"With no topic, the list, and which machine sailor you sail as. Read start first.",
			Annotations: hints("Handbook", true, true, false), Meta: alwaysLoad(),
			InputSchema: schema(`{"type":"object","properties":{` +
				`"topic":{"type":"string","enum":["start","sailing","trim","autopilot","articles","charting","edge","weather","tools","limits"],"description":"The page to read. Default: the list."}` +
				`},"additionalProperties":false}`),
		}},
	}
}
