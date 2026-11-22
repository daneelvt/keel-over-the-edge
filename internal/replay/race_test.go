// SPDX-License-Identifier: AGPL-3.0-only

package replay

import (
	"bytes"
	"reflect"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
)

// TestARaceHandedReadsBack: a race handed to the committee is written and
// read back the same, a reach and a Dash among them; a race written before the reach
// was, its flags the four an older build knew, still reads, as no reach;
// and a flag nobody writes is refused.
func TestARaceHandedReadsBack(t *testing.T) {
	entrants := []bus.RaceEntrant{{Account: account(1), Number: 1, Machine: true, BoatLook: 7, BoatName: "Gull"}, {Account: account(2), Number: 2, Crew: true}}
	for _, c := range []*bus.RaceCall{
		{ID: [16]byte{1}, Run: 3, Trial: true, Across: true, Kind: 2, Entrants: entrants[:1]},
		{ID: [16]byte{5}, Course: 2, Across: true, Dash: true, Start: 7000, Entrants: entrants},
		{ID: [16]byte{2}, Course: 1, Triangle: true, Long: true, Kind: 1, Start: 9000, Entrants: entrants},
		{ID: [16]byte{3}, Island: true, Course: 4, Start: 12000, Entrants: entrants},
		{ID: [16]byte{4}, Run: 1, Trial: true, Long: true},
	} {
		enc := appendRaceCall(nil, c)
		p := &payload{b: enc}
		got := p.raceCall()
		if p.err != nil || len(p.b) != 0 {
			t.Fatalf("%+v read back: %v, %d bytes left", c, p.err, len(p.b))
		}
		if !reflect.DeepEqual(got, c) {
			t.Errorf("read back %+v, wrote %+v", got, c)
		}
		// Its flags: the byte after its ID and run.
		flags := enc[17]
		if c.Across != (flags&raceAcross != 0) {
			t.Errorf("flags %d for a race across %v", flags, c.Across)
		}
		if !c.Across {
			// What an older build wrote for it, byte for byte: it reads
			// as it was written, and is no reach.
			if flags&^(raceTrial|raceIsland|raceTriangle|raceLong) != 0 {
				t.Errorf("flags %d an older build did not know", flags)
			}
			old := &payload{b: bytes.Clone(enc)}
			if r := old.raceCall(); old.err != nil || r.Across {
				t.Errorf("an older race read as %+v: %v", r, old.err)
			}
		}
		// A flag nobody writes.
		bad := bytes.Clone(enc)
		bad[17] |= 64
		if p := (&payload{b: bad}); p.raceCall() == nil || p.err == nil {
			t.Error("a race with an unknown flag read")
		}
	}
}
