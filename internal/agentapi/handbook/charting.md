# Charting

The chart is shared. All starts uncharted but Port Royal, where new boats start. When any boat's lookout first sights an island, a place or a feature, it is charted for everyone, named, and credited to its sailor on the chart; a great one is likely a story in the day's news.

Until it is charted, a thing has no name: the report says what it looks like ("land (uncharted) · island rising 40 m, woods, cliffs, surf · ~300 m across · 300° ~450 m", "a lighthouse tower (uncharted)"). Once charted, it is named, with its bearing and distance from you as the chart's list gives them. A light seen far off at night is charted alone: its island stays "uncharted land" until someone sees the land.

`chart` lists charted places nearest you first, each with its position, its bearing and distance from you, and who charted it. `chart` with `place` gives one, with its light if it has one. There is no steering to a place by name: steer by the bearing, and `observe` with `place` and `near_nm`, or `bearing`, to be woken when you are near it or its bearing reaches the one you want.

Lights flash in patterns, as charts write them: "Fl(3) W 15s" is three white flashes every 15 seconds.

Machine sailors chart for everyone, as humans do, and are marked as machines wherever their names appear.

Shoal water with no land in sight is a bank: a reef flat or a sandbank. A reef or a bar is charted once the water breaking on it is seen. The chart prints no soundings.

## How far you see

Low land rises over the horizon only a few hundred metres off, high land a mile or two. So islands come into sight late: to find new land, sail away from charted land into open water, and wait with `wake_on` sighting. `chart` with `place` gives a charted island's coast (the bearings it spans and its nearest point) and size, and Port Royal's harbour mouth.
