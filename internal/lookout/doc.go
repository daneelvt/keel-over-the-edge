// SPDX-License-Identifier: AGPL-3.0-only

// Package lookout is what the phone shows and plays a sailor, by the
// phone's own rules, for whatever tells a sailor in words: the wind
// readout, the countdown to the world's end, the beginners' gust ring,
// right-of-way overlay and dirty air, and the sounds about the boat. Each
// rule is the phone's, written again here, and both are held to one file
// of cases in testdata, which this package's tests write with -update and
// the phone's tests read; where the phone asks the physics module, this
// calls the same code in internal/physics.
//
// The inputs are plain values, which the server has as follows. Places are
// m east and north of the world's centre, directions rad clockwise from
// north, world time ticks (30 a second) or seconds of it.
//
// Readout.Add takes the wind at the masthead as the boat sails in it, the
// other boats' shadow in it: the physics.Env a boat's step sails in after
// physics.ShadowAt (its WindSpeed and WindFrom), at ms of world time (ticks
// × 1000 / 30). Show takes the mean wind's speed at the boat, without its
// gusts: physics.WindPointAt's MeanSpeed there.
//
// Countdown takes the time left to the world's end by the world clock, and
// EndText the end and the zone the schedule is published in.
//
// GustRings takes the weather at the tick (physics.WeatherAt) and the
// land's shelter (nil for open water), and the boat: where it is, its
// velocity over the ground (its speed and course over the ground, as
// physics.Out has them) and the direction the mean wind at it comes from
// (physics.WindPointAt's MeanFrom). Its options are the catalog's
// weather.ring.
//
// RightOfWay.Show and DirtyAir.Wedges take each boat's place and pose from
// its physics.State (X, Y, Heading, Heel, Boom, SailorMode) and its
// velocity: the sailor's own over the ground, the others' as the phone
// draws them, their speed along their heading. The Articles also take each
// boat's physics.Course, which the phone follows from what it draws once a
// judgement and the sim keeps every tick: the tack and whether she is
// tacking are what the verdict reads. Each takes the true wind at the boat
// before any shadow: its direction for the Articles, its speed and
// direction, gusts and shelter in it, for a wake (physics.WindPointAt's
// Speed and From). Both judge every boat as the sailor's own kind, as the
// phone's physics module holds one kind.
//
// Hearing.Sounds takes a Heard:
//
//   - Seconds, world time in s; East and North, the boat; Day, whether the
//     sun is up there (sky.SunAltitude above 0); SeaHeight, the sea's
//     significant height at the boat.
//   - Lip, the lip's distance, m: the catalog's world.disk.radius less the
//     boat's distance from the centre; Falling, whether the boat is going
//     over it; EndNear, EndRoar of the seconds left to the world's end.
//   - Features, the worldgen.Bundle's Parts near the boat: each Part's
//     kind's catalog site (catalog Features[Part.Kind].Site), its place,
//     its Level as a waterfall's Drop, its Seed, and a colony's birds' call.
//     Any site but a waterfall, a blowhole or a colony makes no sound.
//   - Harbour: InPort, whether the boat is on water within one of the
//     towns' harbour discs (worldgen's Town.Harbour); Town and NearTown, the
//     nearest of the buildings that are not props, ruins left out; Bell,
//     the nearest building that stands above its town (a belfry), else the
//     nearest on a square that is not a prop; Yard, the nearest on a slip;
//     Quay, the nearest at a quay's edge; and Hour, HourAt of sky time
//     (sky.Time) and the sky's day (sky.Prepared.Day).
//   - Lights, the worldgen.Bundle's Lights, each with its fog signal as
//     chart.FogSignals gives it; Visibility, physics.VisibilityAt at a
//     place at the tick asked, from the weather then.
//   - Flashes, the lightning of the last minute: physics.Flashes for each
//     of its slots.
//
// The chart's list is the chart package's (chart.List).
package lookout
