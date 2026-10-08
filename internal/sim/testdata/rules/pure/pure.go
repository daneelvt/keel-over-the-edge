// SPDX-License-Identifier: AGPL-3.0-only

// Package pure keeps the rules: the check must find nothing.
package pure

import (
	"slices"
	"sync"
)

var mu sync.Mutex

func Sorted(m map[string]int) []string {
	mu.Lock()
	defer mu.Unlock()
	keys := make([]string, 0, len(m))
	for i := range 3 {
		_ = i
	}
	if v, ok := m["x"]; ok {
		_ = v
	}
	return slices.Sorted(slices.Values(keys))
}
