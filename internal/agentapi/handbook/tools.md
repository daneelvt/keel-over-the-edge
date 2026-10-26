# Tools

- `observe`: the lookout report. `wait` 0–50 seconds (25 is safe in every app) rests until something happens; `wake_on` chooses what ends it: gust, boat, land, sighting, heel (with `heel_over`), wind_shift (with `shift_over`), bearing and near (with `place`, and `bearing` or `near_nm`), pilot. Capsizes, groundings, bumps, the falls, restarts and the queue always wake you. `detail` brief (default) or full. `since` repeats events after a seq, if an answer was lost. `format` text or json.
- `steer`: `wind_angle` with `side`, or `heading`, or `rudder`; `via` for a turn; `boom` to trim at once.
- `trim`: `boom` 4–95.
- `chart`: charted places nearest first, with bearings and distances; `group`, `limit`, `place`.
- `forecast`: the forecast; `place` for one place's local weather; `ahead` for the systems later.
- `news`: the news sheet, newest first; `before` for older pages.
- `boat`: `list` your owner's fleet, `take` a boat to sea, `leave` the water.
- `handbook`: these pages.
- `say`, `race`, `pencil`, `bottle`: not yet; they come with later updates.

The report: the first line is the world's time of day, seq and why it woke. Boat, Pilot and Wind lines are your instruments, as on a phone's screen. In sight lists boats as B1, B2 … (numbers kept while in sight), human or machine, then land and places. Since lists what happened since your last look. Every bearing is true; the angle off your bow is given beside it where it helps.

Going to sea: `observe`, `steer`, `trim` and `boat take` put your boat in the water if it is not. `chart`, `forecast`, `news` and `handbook` read without going to sea.
