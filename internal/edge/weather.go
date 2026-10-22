// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// A client computes the wind at its boat as the server does, from the
// spells of weather in play and the weather systems' keyframes: so it is
// sent them whenever they change. The frame's spells in play reach ten
// seconds ahead and ten behind (internal/weather), and its keyframes are at
// the last keyframe's tick and the two after, twenty seconds ahead at
// most; so a client holds every spell and keyframe a tick it predicts or
// replays needs, and none of what is to come beyond. Beside them goes the
// coming front's line, which its cirrus shows before its spell is in play,
// never its spell.

// connWeather is the spells and keyframes a connection's client was last
// sent.
type connWeather struct {
	sent   bool
	n      int32
	spells [physics.WeatherSpells]physics.Spell
	keys   [bus.KeyFrames]physics.Keyframe
	coming physics.ComingFront
}

// weather sends the connection the frame's spells in play and keyframes
// that its client does not hold. It reports whether the connection is
// still good.
func (c *conn) weather(f *bus.Frame) bool {
	w := &c.wx
	spells := !w.sent || w.n != f.NSpells || w.spells != f.Spells
	var keys []*physics.Keyframe
	for k := range f.Keys {
		if !w.sent || !held(&w.keys, &f.Keys[k]) {
			keys = append(keys, &f.Keys[k])
		}
	}
	if !spells && len(keys) == 0 && w.coming == f.Coming {
		return true
	}
	w.sent, w.n, w.spells, w.keys, w.coming = true, f.NSpells, f.Spells, f.Keys, f.Coming
	m := protocol.WeatherSystems(f.SpellsInPlay(), !spells, keys...)
	protocol.SetComing(m, &f.Coming)
	return c.send(&pb.ServerMessage{Body: &pb.ServerMessage_WeatherSystems{WeatherSystems: m}}, outWeatherSystems)
}

// held reports whether keys holds k as it is.
func held(keys *[bus.KeyFrames]physics.Keyframe, k *physics.Keyframe) bool {
	for i := range keys {
		if keys[i].Tick == k.Tick {
			return keys[i] == *k
		}
	}
	return false
}
