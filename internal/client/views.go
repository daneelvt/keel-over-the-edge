// SPDX-License-Identifier: AGPL-3.0-only

package client

import (
	"errors"
	"hash/fnv"

	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
)

// ViewsKept is how many decoded views the client keeps, to find each
// snapshot's base among: over TCP the base is the newest snapshot the
// server's writer had taken, a snapshot or two back.
const ViewsKept = 4

// ErrMissingBase is a snapshot whose base the client no longer holds: it is
// dropped, and the client asks for a full one (Command's Resync).
var ErrMissingBase = errors.New("client: the snapshot's base is not among the views kept")

// Views are the views a connection's snapshots made, the newest
// ViewsKept: the net worker's ViewRing's twin.
type Views struct {
	views [ViewsKept + 1]protocol.View
	ticks [ViewsKept + 1]int64
	have  int
	next  int
}

// Reset forgets every view: a new connection starts from a full snapshot.
func (vs *Views) Reset() { vs.have = 0 }

// Decode applies the entries of snapshot b, whose header is sn, to a copy
// of its base's view, and returns the view, which stays valid until
// ViewsKept more are decoded, and what the entries did.
func (vs *Views) Decode(b []byte, sn *protocol.Snapshot) (*protocol.View, protocol.Changes, error) {
	var ch protocol.Changes
	out := &vs.views[vs.next]
	if sn.Base == 0 {
		*out = protocol.View{}
	} else {
		base := vs.find(sn.Tick - int64(sn.Base))
		if base == nil {
			return nil, ch, ErrMissingBase
		}
		*out = *base
	}
	if err := out.ApplyEntries(b[protocol.HeaderSize:], sn.Entries, &ch); err != nil {
		return nil, ch, err
	}
	vs.ticks[vs.next] = sn.Tick
	vs.next = (vs.next + 1) % len(vs.views)
	vs.have = min(vs.have+1, ViewsKept)
	return out, ch, nil
}

func (vs *Views) find(tick int64) *protocol.View {
	for k := 1; k <= vs.have; k++ {
		i := (vs.next - k + len(vs.views)) % len(vs.views)
		if vs.ticks[i] == tick {
			return &vs.views[i]
		}
	}
	return nil
}

// ViewDigest is a 32-bit FNV-1a hash of a view's boats: for each slot that
// holds one, its slot and fields as little-endian int32s. Traces carry it
// for each snapshot, and the TypeScript tests hash what the net worker
// decoded the same way.
func ViewDigest(v *protocol.View) uint32 {
	h := fnv.New32a()
	var b [4]byte
	put := func(x int32) {
		b[0], b[1], b[2], b[3] = byte(x), byte(x>>8), byte(x>>16), byte(x>>24)
		h.Write(b[:])
	}
	for slot := range protocol.ViewSlots {
		if !v.Has(slot) {
			continue
		}
		q := &v.Boats[slot]
		for _, x := range [...]int32{int32(slot), int32(q.Kind), int32(q.Flags), q.X, q.Y, int32(q.Heading),
			int32(q.Heel), int32(q.Boom), int32(q.Rudder), int32(q.Sailor), int32(q.Sail)} {
			put(x)
		}
	}
	return h.Sum32()
}
