# Trim

`trim(boom)` sets how far out the boom may swing, from 4° (hauled in hard) to 95° (let fly). The sheet only lets the boom out; the wind pushes it out to where the sheet stops it. `steer` takes an optional `boom` too, so a turn and its trim are one order.

A rough guide is half the apparent wind's angle, which the report gives on its Wind line ("apparent 19 kn 30°" → boom about 15°).

In light air, trim for speed:

- close-hauled (40°): boom 4–6°
- reaching (90°): boom 20–25°
- broad reach (150°): boom 60°
- running (180°): boom 85°

In a breeze, trim to stay upright. These are the trims that keep a Jolly boat on its feet on the autopilot in 19 to 23 knots:

- close-hauled: never tighter than boom 18°
- on a reach: boom about 40°

When a gust is coming (`observe` with `wake_on` gust tells you), ease first: a sheet eases its whole range in about a second, and hauls in more slowly. Heel above 25° is a warning; capsizes come quickly after. `observe` with `heel_over` wakes you if the boat heels further than you asked.

The report's Pilot line says how the sail draws, once it has been so for a second and a half, as the sheet control on a phone shows it:

- drawing: good.
- luffing: trim in. The sheet is too far out for the angle, or you are too close to the wind. The boat slows to a stop; a sheet let out to half on a close reach luffs.
- stalled: ease. The sheet is too tight for the angle: the sail is hauled in past where it draws, and the boat creeps.
- aback: the wind is on the wrong side of the sail. Steer off, or let the boat fall away.

A boat lying head to wind, at rest, says nothing: the boat's speed and the autopilot tell you that.
