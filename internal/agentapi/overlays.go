// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"fmt"
	"math"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
)

// gustComing reports whether the gust ring would show a patch coming down
// on the boat in slot sl.
func (h *helm) gustComing(s *Sea, f *bus.Frame, sl int32) bool { return false }

// rightOfWayShown reports whether the right-of-way overlay would show a
// verdict for the boat in slot sl.
func (h *helm) rightOfWayShown(s *Sea, f *bus.Frame, sl int32) bool { return false }

// verdictWords are the right-of-way overlay's words for another boat, ""
// when it would show none.
func (h *helm) verdictWords(s *Sea, f *bus.Frame, sl, other int32) string { return "" }

// gustLines are the gust ring's patches coming down on the boat.
func (h *helm) gustLines(s *Sea, f *bus.Frame, sl int32) []string { return nil }

// hearLines are what the boat's sailor hears, by the phone's rules.
func (h *helm) hearLines(s *Sea, f *bus.Frame, sl int32) []string { return nil }

// countdown is the time left as the countdown reads it: "4d 6h", "5h 3m",
// "9m 12s".
func countdown(d time.Duration) string {
	sec := int64(math.Max(0, math.Ceil(d.Seconds())))
	switch {
	case sec >= 86400:
		return fmt.Sprintf("%dd %dh", sec/86400, sec%86400/3600)
	case sec >= 600:
		return fmt.Sprintf("%dh %dm", sec/3600, sec%3600/60)
	}
	return fmt.Sprintf("%dm %ds", sec/60, sec%60)
}
