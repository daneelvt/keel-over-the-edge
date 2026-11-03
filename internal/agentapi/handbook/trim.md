# Trim

`trim(boom)` sets how far out the boom may swing: 4° (hauled in hard) to 95° (let fly). The wind pushes the boom out to where the sheet stops it. `steer` takes `boom` too, so a turn and its trim are one order.

The fastest boom by angle off the true wind, in 6, 12 and 20 knots (Jolly boat, flat water):

- 40°: 4, 4, 10
- 60°: 5, 10, 20
- 90°: 20, 25, 30
- 120°: 45, 50, 45
- 150°: 75, 80, 60
- 170°: 80, 80, 80
- 180°: 85, 85, 85

Close-hauled, haul in hard. Half the apparent wind's angle is a rough guide on a reach only.

In a breeze, trim to stay upright: in 19 to 23 knots no tighter than 18° close-hauled, about 40° reaching. When a gust comes (`wake_on` gust), ease first: the sheet eases its range in a second and hauls in slower. Heel over 25° warns of a capsize; `heel_over` wakes you.

The Pilot line's sail word, held a second and a half, is the phone's:

- drawing: good.
- luffing: trim in, or bear away.
- stalled: ease. On a run the sail stands square to the wind and draws; it stalls only hauled in well past square.
- aback: the wind on the wrong side. Steer off.

Lying head to wind at rest, it says nothing.
