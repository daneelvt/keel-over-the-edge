// SPDX-License-Identifier: AGPL-3.0-only

// Package pool uses sync.Pool: the rules must find it.
package pool

import "sync"

var buffers = sync.Pool{New: func() any { return new([64]byte) }}

func Get() *[64]byte { return buffers.Get().(*[64]byte) }
