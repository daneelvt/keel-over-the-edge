# The status, field by field

`GET /api/status`, as `internal/status` builds it. `seed1.json` beside this
is one: seed 1's world with every subject charted, at a busy moment of the
catalog's sample week (a cold front crossing, eighteen systems), with twelve
boats staged by the test (so `atSea` says 0 while the map shows boats).
`go test ./internal/status -run TestSeed1 -update` writes it again.

Distances are metres east and north of the disk's centre (north up), angles
clockwise from north. Arrays are JSON arrays; `null` is a value not given.

## The numbers

| Field | What |
|---|---|
| `atSea` | Boats in the water, a boat in its grace included |
| `machinesAtSea` | Of them, machine sailors' |
| `queued` | Players waiting for a boat |
| `world` | The world's number |
| `endsAt` | When the world ends, RFC 3339 UTC; left out when not known |
| `closing` | The world is in its last days |
| `turn` | `{weekday, time, zone}`: when every world ends, as `Sunday`, `18:00` (24-hour, local), `America/New_York`; left out for a schedule that is not weekly |
| `charted` | Subjects the world's sailors have charted (not what is known from the start) |
| `hour` | The sky's hour at the centre, 0 to 24, to a hundredth: noon is 12 |
| `at` | When this was built, RFC 3339 UTC |

## `map`

| Field | What |
|---|---|
| `lip` | The disk's radius, m |
| `band` | The mist band's inner edge, m from the centre |
| `islands` | The charted islands, a table (below) |
| `places` | The charted places, a table |
| `features` | The charted features, a table |
| `weather` | The weather now (below) |
| `boats` | Up to 12 boats anyone may watch, the liveliest first |

The three tables are columns of equal length, one entry a subject, in the
order the chart letters them: by `rank`, highest first, then by worth.
Across the tables, by rank, islands first. Only what is charted is ever in
them.

`islands`: `name`; `east`, `north` (to 25 m); `rank` (4 the main port's
island, 3 a great island, 2, 1); `coast`, the island's land as rings, an
empty list for a rock too small to outline at 25 m (draw a dot). Each ring
is in steps of 25 m: its first point's east and north, then for each next
point how many steps east and north it is from the one before; the ring
closes back to its first point. The land is on each ring's left: an outer
ring runs anticlockwise.

`places`: `name`; `kind`, the catalog's place kind id (`world.places.kinds`);
`east`, `north` (to 25 m); `rank` (2 a place whose charting is news, 1
another, 0 one seen by looking into it, lettered only close in).

`features`: `kind`, the catalog's feature kind id (`world.features.kinds`);
`east`, `north` (to 25 m). Marked, never lettered; rank 0.

On the chart, a whole-disk view letters rank 3 and up only.

`boats`: each `{east, north}` (to 100 m), `heading` (degrees, to 15),
`boat` (the catalog's boat id) and `machine` (a machine sailor sails it,
whose sail carries the cog). Nothing says whose it is.

## `map.weather`

The whole disk's weather, as every sailor's chart shows it, sampled with
the physics the chart's module runs.

| Field | What |
|---|---|
| `n` | The grid's points a side, 32 |
| `mean` | Mean wind, m/s to a half |
| `from` | The way it blows from, whole degrees |
| `gust` | Typical strongest gust, m/s to a half |
| `rain` | Rain, mm an hour to a tenth |
| `fog` | Visibility the fog banks leave in clear air 2 m up, km to a tenth, 5 for anything clearer; `null` beyond the lip |
| `pressure` | hPa to a tenth; `null` beyond the lip |
| `systems` | The systems alive |
| `fronts` | The fronts crossing the disk |

Each field is `n × n` values, row by row from the north, east along a row:
point `(i, j)` is the centre of its cell, east `((i + 0.5) / n − 0.5) × 2 ×
lip`, north `(0.5 − (j + 0.5) / n) × 2 × lip`.

A system: `draw`, the catalog's symbol (`cell`, `heap`, `spiral`, `low`,
`bank`, `calm`, `dash-dot`, `dashed`); `name`; `east`, `north`; `heading`
(the way it moves, rad) and `speed` (m/s); `size` (its radius, a line's
half its depth, m); `strength` (0 to about 1); `length` (a line's length
across its motion, m) and `ring` (a low's ring of strongest wind, m), each
left out when 0; `wind` and `gust` (the strongest mean wind it blows and
its typical strongest gust, m/s); `ahead` (`{east, north}` half an hour
on), left out if it is gone by then.

A front: `sin`, `cos` (the way it moves toward, east and north); `line`
(its line's distance from the centre that way, m); `warm` (its rain ahead
of its line); `speed` (m/s).
