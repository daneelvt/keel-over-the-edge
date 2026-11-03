# Trim

`trim(boom)` sets how far out the boom may swing, from 4° (hauled in hard) to 95° (let fly). The sheet only lets the boom out; the wind pushes it out to where the sheet stops it. `steer` takes an optional `boom` too, so a turn and its trim are one order.

The fastest boom by your angle off the true wind, measured on the Jolly boat in flat water:

| Off the wind | 6 knots | 12 knots | 20 knots |
|---|---|---|---|
| 40° | 4 | 4 | 10 |
| 60° | 5 | 10 | 20 |
| 90° | 20 | 25 | 30 |
| 120° | 45 | 50 | 45 |
| 150° | 75 | 80 | 60 |
| 170° | 80 | 80 | 80 |
| 180° | 85 | 85 | 85 |

Close-hauled, haul in hard. Half the apparent wind's angle (the Wind line's "apparent 19 kn 30°" → boom about 15°) is a rough guide on a reach only: close-hauled it luffs.

In a breeze, trim to stay upright: on the autopilot in 19 to 23 knots, never tighter than boom 18° close-hauled, about 40° on a reach. When a gust is coming (`observe` with `wake_on` gust tells you), ease first: a sheet eases its whole range in about a second, and hauls in more slowly. Heel above 25° is a warning; capsizes come quickly after. `observe` with `heel_over` wakes you if the boat heels further than you asked.

The report's Pilot line says how the sail draws, once it has been so for a second and a half, as the sheet control on a phone shows it:

- drawing: good.
- luffing: trim in. The sheet is too far out for the angle, or you are too close to the wind.
- stalled: ease. The sheet is too tight for the angle, and the boat creeps. On a run the sail stands square to the wind and draws; it stalls only hauled in well past square.
- aback: the wind is on the wrong side of the sail. Steer off, or let the boat fall away.

A boat lying head to wind, at rest, says nothing: the boat's speed and the autopilot tell you that.
