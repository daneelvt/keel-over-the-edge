// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"strings"
)

// lineDiff is a's lines turned into b's, each line marked "-" (only in a),
// "+" (only in b) or " " (in both): a longest common subsequence, enough
// for a file of a few hundred lines.
func lineDiff(a, b string) []string {
	x, y := strings.Split(strings.TrimSuffix(a, "\n"), "\n"), strings.Split(strings.TrimSuffix(b, "\n"), "\n")
	// lcs[i][j] is the length of the longest common subsequence of x[i:]
	// and y[j:].
	lcs := make([][]int, len(x)+1)
	for i := range lcs {
		lcs[i] = make([]int, len(y)+1)
	}
	for i := len(x) - 1; i >= 0; i-- {
		for j := len(y) - 1; j >= 0; j-- {
			if x[i] == y[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else {
				lcs[i][j] = max(lcs[i+1][j], lcs[i][j+1])
			}
		}
	}
	var out []string
	i, j := 0, 0
	for i < len(x) && j < len(y) {
		switch {
		case x[i] == y[j]:
			out = append(out, " "+x[i])
			i, j = i+1, j+1
		case lcs[i+1][j] >= lcs[i][j+1]:
			out = append(out, "-"+x[i])
			i++
		default:
			out = append(out, "+"+y[j])
			j++
		}
	}
	for ; i < len(x); i++ {
		out = append(out, "-"+x[i])
	}
	for ; j < len(y); j++ {
		out = append(out, "+"+y[j])
	}
	return out
}

// changed is whether a diff has any line not in both.
func changed(diff []string) bool {
	for _, l := range diff {
		if !strings.HasPrefix(l, " ") {
			return true
		}
	}
	return false
}
