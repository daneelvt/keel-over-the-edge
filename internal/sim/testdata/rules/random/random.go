// SPDX-License-Identifier: AGPL-3.0-only

// Package random draws from the unseeded generator: the rules must find it.
package random

import "math/rand/v2"

func Draw() float64 { return rand.Float64() }

// Seeded draws from a seeded generator, which the rules allow.
func Seeded() float64 { return rand.New(rand.NewPCG(1, 2)).Float64() }
