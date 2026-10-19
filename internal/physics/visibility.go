// SPDX-License-Identifier: AGPL-3.0-only

package physics

// The mist band's visibility. Over the clear air lies a mist whose density
// at the sea rises linearly across the band, from nothing at its inner edge
// to the lip's, where the visual range is the mist's own; beyond the lip it
// is the lip's. The visual range in air of extinction σ is Koschmieder's
// 3.912 / σ, the distance at which a dark object's contrast falls to 2%,
// and extinctions add: the clear air's and the mist's. The page draws the
// mist by the same rule (client/src/edge/mist.ts, visualRangeAt), and what
// a boat's lookout sees through it is decided by this one.

// Koschmieder is ln(1/0.02): the visual range is Koschmieder over the air's
// extinction, for a contrast threshold of 2%.
const Koschmieder = 3.912

// Visibility is the mist band's visibility: where it lies, the clear air's
// visual range, and the lip's.
type Visibility struct {
	// Band and Lip are the band's inner edge and the lip, m from the
	// centre.
	Band, Lip float64
	// Clear is the clear air's visual range, m; Range the visual range at
	// the lip, at the sea, m.
	Clear, Range float64
}

// VisualRangeAt is the visual range at the sea r m from the centre, m: the
// clear air's inside the band, the lip's at the lip and beyond, and between
// them as the mist's density rises.
func VisualRangeAt(v *Visibility, r float64) float64 {
	m := min(max((r-v.Band)/(v.Lip-v.Band), 0), 1)
	clear := Koschmieder / v.Clear
	sigma := max(Koschmieder/v.Range-clear, 0)
	return Koschmieder / (clear + float64(sigma*m))
}
