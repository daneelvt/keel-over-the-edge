// SPDX-License-Identifier: AGPL-3.0-only

// The game's status, as keel's GET /api/status answers the website: the
// numbers, and the map's data, charted subjects only (described field by
// field in internal/status/testdata/status.md). Distances are metres east
// and north of the disk's centre, angles clockwise from north.

export interface Turn {
  weekday: string;
  /** 24-hour, local: "18:00". */
  time: string;
  zone: string;
}

/** A table of columns of equal length, one entry a subject. */
export interface Islands {
  name: string[];
  east: number[];
  north: number[];
  rank: number[];
  /** Each island's land as rings in 25 m steps; none for a rock too small to outline. */
  coast: number[][][];
}

export interface Places {
  name: string[];
  kind: string[];
  east: number[];
  north: number[];
  rank: number[];
}

export interface Features {
  kind: string[];
  east: number[];
  north: number[];
}

export interface Boat {
  east: number;
  north: number;
  /** Degrees, to 15. */
  heading: number;
  /** The catalog's boat id. */
  boat: string;
  machine: boolean;
}

export interface System {
  draw: 'cell' | 'heap' | 'spiral' | 'low' | 'bank' | 'calm' | 'dash-dot' | 'dashed';
  name: string;
  east: number;
  north: number;
  /** The way it moves, rad, and how fast, m/s. */
  heading: number;
  speed: number;
  size: number;
  strength: number;
  length?: number;
  ring?: number;
  wind: number;
  gust: number;
  ahead?: { east: number; north: number };
}

export interface Front {
  sin: number;
  cos: number;
  line: number;
  warm: boolean;
  speed: number;
}

export interface Weather {
  /** Points a side. */
  n: number;
  /** Each n × n, row by row from the north, east along a row. */
  mean: number[];
  /** Whole degrees the wind comes from. */
  from: number[];
  gust: number[];
  rain: number[];
  /** Km, 5 for anything clearer; null beyond the lip. */
  fog: (number | null)[];
  /** hPa; null beyond the lip. */
  pressure: (number | null)[];
  systems: System[];
  fronts: Front[];
}

export interface StatusMap {
  lip: number;
  band: number;
  islands: Islands;
  places: Places;
  features: Features;
  weather: Weather;
  boats: Boat[];
}

export interface Status {
  atSea: number;
  machinesAtSea: number;
  queued: number;
  world: number;
  endsAt?: string;
  closing: boolean;
  turn?: Turn;
  charted: number;
  /** The sky's hour at the centre, 0 to 24. */
  hour: number;
  /** When keel built it, RFC 3339. */
  at: string;
  map: StatusMap;
}

/** Whether a value is the status's shape, as far as the Worker reads it. */
export function isStatus(v: unknown): v is Status {
  if (typeof v !== 'object' || v === null) {
    return false;
  }
  const s = v as Partial<Status>;
  const m = s.map as Partial<StatusMap> | undefined;
  return (
    typeof s.atSea === 'number' &&
    typeof s.machinesAtSea === 'number' &&
    typeof s.charted === 'number' &&
    typeof s.world === 'number' &&
    typeof s.at === 'string' &&
    typeof m === 'object' &&
    m !== null &&
    typeof m.lip === 'number' &&
    typeof m.band === 'number' &&
    Array.isArray(m.islands?.name) &&
    Array.isArray(m.places?.name) &&
    Array.isArray(m.features?.kind) &&
    Array.isArray(m.boats) &&
    typeof m.weather?.n === 'number' &&
    m.weather.mean.length === m.weather.n * m.weather.n
  );
}
