# Trim

`trim(boom)` sets how far out the boom may swing: 4° (hauled in hard) to 95° (let fly). The wind pushes the boom out to where the sheet stops it. `steer` takes `boom` too, so a turn and its trim are one order.

The fastest boom by angle off the true wind, in 6, 12 and 20 knots (Jolly boat, flat water):

- 40°: 4, 4, 5
- 60°: 4, 10, 15
- 90°: 20, 25, 30
- 120°: 45, 50, 50
- 150°: 75, 80, 70
- 170°: 80, 80, 80
- 180°: 85, 85, 85

The fastest boom by angle off the true wind, in 6, 12 and 20 knots (Keelboat, flat water):

- 40°: 4, 4, 10
- 60°: 4, 15, 20
- 90°: 20, 30, 30
- 120°: 45, 50, 55
- 150°: 75, 80, 65
- 170°: 80, 80, 80
- 180°: 80, 80, 80

The fastest braces, the yards' angle off the centreline, by angle off the true wind, in 6, 12 and 20 knots (Tall ship, flat water):

- 40°: aback, aback, aback
- 60°: 42, 42, 42
- 90°: 42, 42, 42
- 120°: 50, 55, 65
- 150°: 90, 90, 90
- 170°: 90, 90, 90
- 180°: 90, 90, 90

The fastest boom by angle off the true wind, in 6, 12 and 20 knots (Skiff, flat water):

- 40°: 4, 4, 10
- 60°: 4, 10, 20
- 90°: 15, 15, 35
- 120°: 20, 20, 45
- 150°: 65, 70, 65
- 170°: 75, 75, 75
- 180°: 75, 75, 75

The Skiff's crew sets its gennaker as it bears away with the true wind 105° or more off the bow, and takes it in as it comes up with the wind forward of 90°; between the two it stays as it is. Set, the one sheet trims it with the main, and the sail word is the gennaker's. Reef 1 (Gennaker in) keeps it in, the main and jib full. From 15 knots it no longer pays at 105°, where they set it: bear away further, or keep it in.

Reef (trim or steer with reef 1 or 2; 0 shakes the reefs out) when close-hauled the sheet hauled in hard heels the boat past its trim: from there only easing holds her up, and reefed she heels less and stands up. Reef the Jolly boat from 19 knots, the Keelboat from 13 knots, the Tall ship from 27 knots and the Skiff from 14 knots (reef 2: its reef 1 keeps the gennaker in and shortens nothing).

Close-hauled, haul in hard. Half the apparent wind's angle is a rough guide on a reach only.

In a breeze, trim to stay upright: in 19 to 23 knots no tighter than 18° close-hauled, about 40° reaching. When a gust comes (`wake_on` gust), ease first: the sheet eases its range in a second and hauls in slower. Heel over 25° warns of a capsize; `heel_over` wakes you.

The Pilot line's sail word, held a second and a half, is the phone's:

- drawing: good.
- luffing: trim in, or bear away.
- stalled: ease. On a run the sail stands square to the wind and draws; it stalls only hauled in well past square.
- aback: the wind on the wrong side. Steer off.

Lying head to wind at rest, it says nothing.
