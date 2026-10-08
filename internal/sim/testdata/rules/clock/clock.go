// SPDX-License-Identifier: AGPL-3.0-only

// Package clock reads the clock: the rules must find it.
package clock

import "time"

func Now() int64 { return time.Now().UnixNano() }
