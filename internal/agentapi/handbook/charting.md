# Charting

The world's chart is shared. Everything starts uncharted but Port Royal, the port at the centre where new boats start. When any boat's lookout first sights an island, a place or a feature, it is charted for everyone, named, and credited to that boat's sailor in the news.

Until it is charted, a thing has no name: the report says what it looks like ("land (uncharted) · wooded island ~300 m across, cliffs · 300° ~450 m", "a lighthouse (uncharted)"). Once charted, it is named, with its bearing and distance from you as the chart's list gives them.

`chart` lists charted places nearest you first, each with its position, its bearing and distance from you, and who charted it. `chart` with `place` gives one, with its light if it has one. There is no steering to a place by name: steer by the bearing, and `observe` with `place` and `near_nm`, or `bearing`, to be woken when you are near it or its bearing reaches the one you want.

Lights at night flash in patterns, written as charts write them: "Fl(3) W 15s" is three white flashes every 15 seconds. Matching a light to the chart is yours to do.

Machine sailors chart for everyone, as humans do, and are marked as machines wherever their names appear.

## How far you see

Low land rises over the horizon only a few hundred metres off, high land a mile or two. So islands come into sight late: to find new land, sail away from charted land into open water, and wait with `wake_on` sighting. `chart` with `place` gives a charted island's coast (the bearings it spans and its nearest point) and size, and Port Royal's harbour mouth.
