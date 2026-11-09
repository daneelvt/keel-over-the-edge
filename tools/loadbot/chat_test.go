// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/moderation"
)

// TestChatLinesPass: what the bots say passes the filter, so a run's
// refusals are the server's limits, never its words.
func TestChatLinesPass(t *testing.T) {
	for _, l := range chatLines {
		if _, why := moderation.CheckChat(l); why != "" {
			t.Errorf("%q is refused: %s", l, why)
		}
	}
}
