// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// A client steps its own boat ahead of the server, in the same waves: so it
// is sent what raises the waves about its boat, and derives them as the
// server does. It gets a square of SeaWindow sea areas a side centred on the
// boat's, which covers the water it draws; and since the sea's changes are
// fixed a second before they apply (bus.Sea), it gets each before it
// predicts a tick the change applies to.
const (
	// SeaWindow is how many sea areas a side a client is sent.
	SeaWindow = physics.SeaClientWindow
	// seaSlack is how far past an area's edge a boat sails before its
	// window follows it, m: a boat tacking along an edge does not have its
	// window sent on every tack.
	seaSlack = 60.0
)

type seaWindow [SeaWindow * SeaWindow]physics.SeaInput

// connSea is what a connection's client holds of the sea: the window in
// effect, and the one it has been sent for a tick still to come, if any.
type connSea struct {
	sent     bool
	col, row int32 // the window's first area
	now      seaWindow
	hasNext  bool
	next     seaWindow
	nextFrom int64 // the tick next applies from
}

// seaAreas sends the connection whatever of the sea about its boat, in
// frame f, its client does not hold: all of it at first and when the window
// moves with the boat, the window for the next second when it differs from
// the one in effect, and the one in effect if it changed without having
// been sent ahead, as when the world's time jumps. It reports whether the
// connection is still good.
func (c *conn) seaAreas(f *bus.Frame, boat *physics.State) bool {
	st := &c.sea
	from := bus.SeaSecond(f.Tick) * bus.SeaPeriod
	if st.hasNext && f.Tick >= st.nextFrom {
		// Its tick has come: the client has made it the one in effect.
		st.now, st.hasNext = st.next, false
	}
	col, row := st.col, st.row
	moved := !st.sent
	if cx := col + SeaWindow/2; moved || physics.SeaAreaOf(boat.X-seaSlack) > cx || physics.SeaAreaOf(boat.X+seaSlack) < cx {
		col = physics.SeaAreaOf(boat.X) - SeaWindow/2
	}
	if cy := row + SeaWindow/2; moved || physics.SeaAreaOf(boat.Y-seaSlack) > cy || physics.SeaAreaOf(boat.Y+seaSlack) < cy {
		row = physics.SeaAreaOf(boat.Y) - SeaWindow/2
	}
	moved = moved || col != st.col || row != st.row
	var now, next seaWindow
	cut(f.Sea.Now, col, row, &now)
	cut(f.Sea.Next, col, row, &next)
	st.sent, st.col, st.row = true, col, row
	if moved || now != st.now {
		st.now = now
		// A window for a later tick about the old place is no use.
		st.hasNext = false
		if !c.sendSea(from, col, row, &now) {
			return false
		}
	}
	if nextFrom := from + bus.SeaPeriod; next != st.now && !(st.hasNext && st.nextFrom == nextFrom && next == st.next) {
		st.next, st.nextFrom, st.hasNext = next, nextFrom, true
		return c.sendSea(nextFrom, col, row, &next)
	}
	return true
}

// cut copies the window whose first area is (col, row) out of the world's
// areas. Past the world's edge the sea is the edge's, as the server's own
// steps have it.
func cut(areas []physics.SeaInput, col, row int32, w *seaWindow) {
	for r := range int32(SeaWindow) {
		y := min(max(row+r, 0), physics.SeaAreas-1)
		for k := range int32(SeaWindow) {
			x := min(max(col+k, 0), physics.SeaAreas-1)
			w[r*SeaWindow+k] = areas[y*physics.SeaAreas+x]
		}
	}
}

func (c *conn) sendSea(tick int64, col, row int32, w *seaWindow) bool {
	m := &pb.SeaAreas{
		Tick: tick, Col: col, Row: row, Size: SeaWindow,
		Speed: make([]uint32, len(w)), From: make([]uint32, len(w)), Fetch: make([]uint32, len(w)),
	}
	for i, in := range w {
		m.Speed[i], m.From[i], m.Fetch[i] = in.Speed, in.From, in.Fetch
	}
	return c.send(&pb.ServerMessage{Body: &pb.ServerMessage_SeaAreas{SeaAreas: m}}, outSeaAreas)
}
