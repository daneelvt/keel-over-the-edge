// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// A client computes the wind at its boat as the server does, from the
// spells of weather in play: so it is sent them whenever they change. The
// frame's spells in play reach ten seconds ahead and ten behind
// (internal/weather), so a client holds every spell a tick it predicts or
// replays needs, and none it does not.

// connWeather is the spells a connection's client was last sent.
type connWeather struct {
	sent   bool
	n      int32
	spells [physics.WeatherSpells]physics.Spell
}

// weather sends the connection the frame's spells in play if its client
// does not hold them. It reports whether the connection is still good.
func (c *conn) weather(f *bus.Frame) bool {
	w := &c.wx
	if w.sent && w.n == f.NSpells && w.spells == f.Spells {
		return true
	}
	w.sent, w.n, w.spells = true, f.NSpells, f.Spells
	m := protocol.WeatherSystems(f.SpellsInPlay())
	return c.send(&pb.ServerMessage{Body: &pb.ServerMessage_WeatherSystems{WeatherSystems: m}}, outWeatherSystems)
}
