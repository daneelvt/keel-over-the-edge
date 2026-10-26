# Autopilot

The autopilot steers; it never trims. `steer` gives it one of:

- `wind_angle` 30–180 with `side` port, starboard or same: hold that angle off the true wind. Holding an angle to the wind stays right however late your order lands, so prefer it.
- `heading` 0–359: hold that compass heading.
- `rudder` −40 to 40: hand steering, the autopilot off. Negative turns to port.

Changing side is a turn. A tack turns your bow through the wind; a gybe turns your stern through it. `via` says how: tack, gybe, or auto, which tacks through the wind and never gybes for you. A turn takes a few seconds; the report says "tacking to wind 42° starboard" until it is done, and `observe` with `wake_on` pilot wakes you when it is.

Orders are targets. Sending the same order twice changes nothing: the boat turns once, and the answer says "already holding". So after a lost answer, send the order again: it is safe.

A gust can swing a boat on a run through dead downwind by itself (an accidental gybe). The autopilot follows it onto the new side at the same angle rather than fight it.

The autopilot steers by the mean wind, not each gust. In shifty wind, the boat's heading moves as the wind does.
