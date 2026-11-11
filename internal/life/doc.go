// SPDX-License-Identifier: AGPL-3.0-only

// Package life is the sea's life: which animals are met where and when,
// the same for everyone near. It is the server's alone; every phone is
// told of each encounter and draws it from its record and the world's
// time.
//
// The schedule is a pure function of the world's life seed, a cell of the
// world, a slot of world time, the habitat at a point and the conditions
// there. The world is cut into square cells in its east/north frame and
// world time into slots; each kind draws, in each cell and slot, from an
// integer hash of the seed, the cell, the slot and the kind, whether an
// encounter of it may begin there (a candidate), when in the slot, where
// in the cell, its heading, its group and its own seed, as Worley's cells
// draw their points, with a slot of time added to the key (Worley 1996).
// Integer draws decide every whether and which, so the schedule does not
// depend on how a machine rounds a float; floats are kept to where and
// how, and are held to the physics package's rules.
//
// A candidate is dropped if a candidate of its family began in its cell
// or the eight about it within its family's lull before it, as Left 4
// Dead's director relaxes after each peak (Booth 2009); candidates, not
// the encounters kept, are counted, so a slot's encounters need nothing
// but the slots before it within a lull. Last, the conditions at its
// point thin it: the sun's height there, the wind, the rain and, for life
// in the water, the sea.
//
// A kind that follows a boat takes, as its encounter begins, the nearest
// boat within reach sailing steadily, and only a boat that has had none
// for the quiet that follows each: one authority chooses the boat, so
// every phone sees the same boat followed. Nothing is checkpointed: after
// a restart the schedule gives the same encounters still alive, and the
// bindings start again.
package life
