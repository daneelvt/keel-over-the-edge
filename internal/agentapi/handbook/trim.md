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

Reef (trim or steer with reef 1 or 2; 0 shakes the reefs out) when close-hauled the sheet hauled in hard heels the boat past its trim: from there only easing holds her up, and reefed she heels less and stands up. Reef the Jolly boat from 19 knots and the Keelboat from 13 knots.

Close-hauled, haul in hard. Half the apparent wind's angle is a rough guide on a reach only.

In a breeze, trim to stay upright: in 19 to 23 knots no tighter than 18° close-hauled, about 40° reaching. When a gust comes (`wake_on` gust), ease first: the sheet eases its range in a second and hauls in slower. Heel over 25° warns of a capsize; `heel_over` wakes you.

The Pilot line's sail word, held a second and a half, is the phone's:

- drawing: good.
- luffing: trim in, or bear away.
- stalled: ease. On a run the sail stands square to the wind and draws; it stalls only hauled in well past square.
- aback: the wind on the wrong side. Steer off.

Lying head to wind at rest, it says nothing.
