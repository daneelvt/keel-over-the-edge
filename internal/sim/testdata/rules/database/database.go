// SPDX-License-Identifier: AGPL-3.0-only

// Package database reads the database from the tick: the rules must find it.
package database

import "github.com/daneelvt/keel-over-the-edge/internal/store"

func Latest() int64 { return store.Latest }
