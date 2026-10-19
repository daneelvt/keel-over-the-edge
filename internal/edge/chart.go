// SPDX-License-Identifier: AGPL-3.0-only

package edge

import "github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"

// The world's chart goes to every connection: whole after the Welcome
// (Chart), then each subject charted as it is written (Charted), each once.
// A chart only grows, so a connection is sent the entries past those it
// has; a name reaches a client only here, once its place is charted.

// ChartSource is the world's chart as it stands: its entries, in the order
// they were charted. The entries it returns never change, and a later call
// returns them and more.
type ChartSource interface {
	Entries() []*pb.ChartEntry
}

// chart sends the connection what has been charted since it was last sent
// any. It reports whether the connection is still good.
func (c *conn) chart(src ChartSource) bool {
	if src == nil {
		return true
	}
	entries := src.Entries()
	if len(entries) <= c.charted {
		return true
	}
	m := &pb.ServerMessage{Body: &pb.ServerMessage_Charted{Charted: &pb.Charted{Entries: entries[c.charted:]}}}
	c.charted = len(entries)
	return c.send(m, outCharted)
}
