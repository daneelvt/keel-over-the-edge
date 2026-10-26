// SPDX-License-Identifier: AGPL-3.0-only

package accounts

import (
	"strconv"
	"time"
)

// Last active is kept on the account, written at most once an hour: as a
// human signs in, uses a session or ends a long game connection, and as a
// machine sailor's agent calls. It is shown in whole days, each 24 hours
// from now, which needs no time zone: the owner and the players are in
// different ones.

// AtSeaNow is the last active of an account whose boat is at sea.
const AtSeaNow = "at sea now"

// Never is a machine sailor's whose agent has not called since it was
// made.
const Never = "never"

// LastActive is when an account was last active, in words: "today" for
// the last 24 hours, then "1 day ago", "41 days ago"; Never for a machine
// sailor whose last active is when it was made.
func LastActive(seen, made time.Time, machine bool, now time.Time) string {
	if machine && !seen.After(made) {
		return Never
	}
	days := int(now.Sub(seen) / (24 * time.Hour))
	switch {
	case days <= 0:
		return "today"
	case days == 1:
		return "1 day ago"
	}
	return strconv.Itoa(days) + " days ago"
}
