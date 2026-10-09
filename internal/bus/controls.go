// SPDX-License-Identifier: AGPL-3.0-only

// Package bus is how everything outside the simulation reaches it: a held
// control slot for each boat, a queue of commands, and the frames the
// simulation publishes after every tick. The simulation is the only writer of
// world state; the bus is the only way in and out.
package bus

import "sync/atomic"

// Steps is the number of steps across each control's range: a control is one
// of Steps + 1 values. Players' controls arrive already rounded to it.
const Steps = 1024

// A Word is a boat's controls packed into 64 bits, so that a slot is written
// and read with one atomic operation, without a lock and without tearing:
//
//	bits 63–32  input sequence: the low 32 bits of the tick the controls are for
//	bits 31–21  helm, 0 (hard to port) … 1024 (hard to starboard)
//	bits 20–10  sheet, 0 (hauled in) … 1024 (let fly)
//	bits  9–0   generation of the slot the word is meant for
//
// The generation is the slot's count of reuses: the simulation ignores a word
// whose generation is not the boat's, so a writer left over from a boat that
// has gone cannot steer the next boat in its slot. It wraps at 1024.
type Word uint64

const (
	genBits   = 10
	indexBits = 11
	genMask   = 1<<genBits - 1
	indexMask = 1<<indexBits - 1
)

// GenMask is the largest generation; generations count modulo GenMask + 1.
const GenMask = genMask

// Pack makes a word. Helm and sheet above Steps are clamped to Steps; the
// generation is taken modulo GenMask + 1.
func Pack(seq uint32, helm, sheet, gen uint16) Word {
	return Word(seq)<<32 |
		Word(min(helm, Steps))<<(indexBits+genBits) |
		Word(min(sheet, Steps))<<genBits |
		Word(gen&genMask)
}

// Seq is the low 32 bits of the tick the word is for.
func (w Word) Seq() uint32 { return uint32(w >> 32) }

// MaxAhead is the most ticks ahead of the tick being run a word may be
// stamped for and still be held for its tick; a word further ahead is
// applied at once, so a client whose clock has gone wrong is never frozen.
const MaxAhead = 60

// Due reports whether a word stamped seq may be applied by tick: its tick
// has come (or passed), or it is more than MaxAhead ticks ahead. Ticks are
// compared modulo 2³², as a signed difference, so the rule holds across the
// wrap of the low 32 bits.
func Due(seq uint32, tick int64) bool {
	d := int32(seq - uint32(tick))
	return d <= 0 || d > MaxAhead
}

// HelmIndex is the helm in steps, 0 … Steps.
func (w Word) HelmIndex() uint16 { return min(uint16(w>>(indexBits+genBits))&indexMask, Steps) }

// SheetIndex is the sheet in steps, 0 … Steps.
func (w Word) SheetIndex() uint16 { return min(uint16(w>>genBits)&indexMask, Steps) }

// Gen is the generation of the slot the word is meant for.
func (w Word) Gen() uint16 { return uint16(w) & genMask }

// Helm is the helm as the physics takes it, −1 … 1. The division by a power
// of two is exact, so this is bit for bit the value the client computes from
// the same step, lo + (k × (hi − lo)) / Steps.
func (w Word) Helm() float64 { return float64(int32(w.HelmIndex())-Steps/2) / (Steps / 2) }

// Sheet is the sheet as the physics takes it, 0 … 1, exactly.
func (w Word) Sheet() float64 { return float64(w.SheetIndex()) / Steps }

// Centred is the control word of a boat that has just appeared: the helm
// centred and the sheet half out.
func Centred(gen uint16) Word { return Pack(0, Steps/2, Steps/2, gen) }

// Controls is a held control slot for every boat slot. Each slot has one
// writer, the boat's sailor; the simulation reads every occupied slot at the
// start of a tick and applies what it finds.
type Controls struct {
	slots []atomic.Uint64
}

// NewControls makes n slots.
func NewControls(n int) *Controls {
	return &Controls{slots: make([]atomic.Uint64, n)}
}

// Store sets a slot's word. The latest word stored before a tick reads it is
// the one applied, at the first tick by which it is Due; until then the
// boat keeps the word in force.
func (c *Controls) Store(slot int32, w Word) { c.slots[slot].Store(uint64(w)) }

// Load reads a slot's word.
func (c *Controls) Load(slot int32) Word { return Word(c.slots[slot].Load()) }

// Len is the number of slots.
func (c *Controls) Len() int { return len(c.slots) }
