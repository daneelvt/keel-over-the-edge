// SPDX-License-Identifier: AGPL-3.0-only

// Package maprange ranges over a map: the rules must find it.
package maprange

type byName map[string]int

func Sum(m byName) int {
	n := 0
	for _, v := range m {
		n += v
	}
	return n
}
