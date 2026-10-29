// SPDX-License-Identifier: AGPL-3.0-only

package weather

import "strings"

// The sky at a boat as one of seven decals, as the phone's weather pusher
// draws it: read from the box of the weather about the boat, a storm near
// outranking the box's words, and a fair sky with less wind than force 1
// calm. The phone's twin is client/src/chart/pocketsky.ts; both are held
// to testdata/pocketsky.json.

// The decals of the sky at a boat.
const (
	SkyFair    = "fair"
	SkyShowers = "showers"
	SkyRain    = "rain"
	SkySqualls = "squalls"
	SkyFog     = "fog"
	SkyStorm   = "storm"
	SkyCalm    = "calm"
)

// SkyOf is the decal of a place's weather w and its box b.
func SkyOf(w *PlaceWeather, b Box) string {
	for _, p := range w.Points {
		if p.Near&NearStorm != 0 {
			return SkyStorm
		}
	}
	switch strings.ToLower(b.Sky) {
	case skies[skyShowers]:
		return SkyShowers
	case skies[skyFog]:
		return SkyFog
	case skies[skyRain]:
		return SkyRain
	case skies[skySqually], skies[skySqualls]:
		return SkySqualls
	}
	if len(w.Points) == 0 || ForceOf(w.Points[0].Mean) < 1 {
		return SkyCalm
	}
	return SkyFair
}
