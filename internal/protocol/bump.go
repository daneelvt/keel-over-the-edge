// SPDX-License-Identifier: AGPL-3.0-only

package protocol

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
)

// ArticleName is an Article's number as the Racing Rules of Sailing give
// the rule: "10", "16.1"; "" for none.
func ArticleName(a uint8) string {
	switch a {
	case physics.Article10:
		return "10"
	case physics.Article11:
		return "11"
	case physics.Article12:
		return "12"
	case physics.Article13:
		return "13"
	case physics.Article15:
		return "15"
	case physics.Article16:
		return "16.1"
	case physics.Article22:
		return "22"
	}
	return ""
}

// Bump is the message of bump b for the sailor of boat who of it
// (physics.First or Second), or, for physics.Neither, for a connection that
// only saw it: no verdict.
func Bump(b *bus.Bump, who uint8) *pb.Bump {
	m := &pb.Bump{
		Tick:    b.Tick,
		X:       int32(steps(b.X/PositionStep, math.MinInt32, math.MaxInt32)),
		Y:       int32(steps(b.Y/PositionStep, math.MinInt32, math.MaxInt32)),
		Closing: uint32(steps(b.Closing*100, 0, math.MaxUint32)),
	}
	if who == physics.Neither {
		return m
	}
	m.Article = ArticleName(b.Article)
	switch b.Fault {
	case who:
		m.Part = pb.BumpPart_BUMP_PART_YOURS
	case physics.Neither:
		m.Part = pb.BumpPart_BUMP_PART_NONE
	default:
		m.Part = pb.BumpPart_BUMP_PART_THEIRS
	}
	return m
}
