// SPDX-License-Identifier: AGPL-3.0-only

package race

import "testing"

func TestCallLines(t *testing.T) {
	for _, c := range []struct{ got, want string }{
		{CallLine("10", 10), "Port tack keeps clear of starboard (Article 10) · 10 seconds added"},
		{CallLine("16.1", 10), "A boat with right of way changing course gives room (Article 16.1) · 10 seconds added"},
		{CallLine("", 10), "A bump · 10 seconds added"},
		{OverEarlyLine(10), "Over early · 10 seconds added"},
		{MissedLine(2), "Mark 2 missed: go back"},
	} {
		if c.got != c.want {
			t.Errorf("%q, want %q", c.got, c.want)
		}
	}
}
