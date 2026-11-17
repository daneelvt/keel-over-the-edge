// SPDX-License-Identifier: AGPL-3.0-only

// The numbers e2e/framecost.ts measures, and the Markdown tables it prints
// them in: what each measurement keeps, the median of several runs, and
// two sets of results side by side.

/** A rung of a ladder, and its pixel ratio at each device pixel ratio measured. */
export interface LadderRow {
  index: number;
  name: string;
  ratios: number[];
}

export interface LadderResult {
  dprs: number[];
  /** A ladder from each top tier. */
  ladders: { top: string; rows: LadderRow[] }[];
}

/** A value measured once a run, and their median. */
export interface Measured {
  runs: number[];
  median: number;
}

export interface GpuRow extends Measured {
  index: number;
  name: string;
  /** The mean interval, each run's: finer than the median where the clock is coarse. */
  mean: Measured;
}

export interface GpuResult {
  /** The canvas, in device pixels. */
  width: number;
  height: number;
  rows: GpuRow[];
}

export interface PartStep extends Measured {
  /** What is hidden at this step, as well as everything above it. */
  name: string;
}

export interface PartsResult {
  width: number;
  height: number;
  /** By tier: the rung measured, and each step's interval. */
  tiers: { tier: string; rung: string; steps: PartStep[] }[];
}

export interface CpuRow {
  boat: string;
  tier: string;
  rung: string;
  work: Measured;
  workP90: Measured;
  interval: Measured;
}

export interface CpuResult {
  width: number;
  height: number;
  throttle: number;
  rows: CpuRow[];
}

/** A buffer written, as the counting hooks tell it. */
export interface WrittenRow {
  label: string;
  owner: string;
  size: number;
  perFrame: number;
  bytesPerFrame: number;
}

export interface CountsRow {
  tier: string;
  rung: string;
  frames: number;
  /** Each count's median and largest a frame, the median over runs. */
  counts: Record<CountName, { median: number; max: number }>;
  largest: WrittenRow[];
  passList: { label: string; perFrame: number }[];
  /** The GPU's render passes a frame, by what began them (WebGPU). */
  gpuPassList?: { label: string; perFrame: number }[];
}

export const COUNT_NAMES = [
  'writes',
  'bytes',
  'textureWrites',
  'passes',
  'renders',
  'dispatches',
  'draws',
  'triangles',
] as const;
export type CountName = (typeof COUNT_NAMES)[number];

export interface CountsResult {
  width: number;
  height: number;
  rows: CountsRow[];
}

export interface Meta {
  date: string;
  commit: string;
  chrome: string;
  backend: string;
  /** The device pixel ratio each measurement ran at. */
  dpr: Record<string, number>;
  runs: number;
  args: string[];
}

export interface Results {
  meta: Meta;
  ladder?: LadderResult;
  gpu?: GpuResult;
  parts?: PartsResult;
  cpu?: CpuResult;
  counts?: CountsResult;
}

/**
 * Results measured apart, a section or more each, as one: a section
 * measured twice is the later one's. The first date, Chrome and back end
 * are kept.
 */
export function merge(parts: readonly Results[]): Results {
  const first = parts[0];
  if (first === undefined) {
    throw new Error('nothing to merge');
  }
  const out: Results = { meta: { ...first.meta, dpr: {}, args: [] } };
  for (const r of parts) {
    Object.assign(out.meta.dpr, r.meta.dpr);
    out.meta.args.push(...r.meta.args);
    if (out.meta.chrome === '') {
      out.meta.chrome = r.meta.chrome;
    }
    if (r.meta.date < out.meta.date) {
      out.meta.date = r.meta.date;
    }
    for (const k of ['ladder', 'gpu', 'parts', 'cpu', 'counts'] as const) {
      if (r[k] !== undefined) {
        (out as unknown as Record<string, unknown>)[k] = r[k];
      }
    }
  }
  return out;
}

/** The median of values; NaN for none. */
export function median(values: readonly number[]): number {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) {
    return Number.NaN;
  }
  return n % 2 === 1
    ? (s[(n - 1) / 2] as number)
    : ((s[n / 2 - 1] as number) + (s[n / 2] as number)) / 2;
}

/** Values measured once a run, with their median. */
export function measured(runs: readonly number[]): Measured {
  return { runs: [...runs], median: median(runs) };
}

/** A number with digits after the point, or a dash for none. */
export function fixed(v: number, digits = 1): string {
  return Number.isFinite(v) ? v.toFixed(digits) : '–';
}

/** A whole number with thin groups of thousands, as 212,000. */
export function whole(v: number): string {
  return Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '–';
}

/** The runs' range, as "8.6–9.1", or the one value. */
export function range(m: Measured, digits = 1): string {
  const r = m.runs.filter((v) => Number.isFinite(v));
  if (r.length === 0) {
    return '–';
  }
  const lo = Math.min(...r);
  const hi = Math.max(...r);
  return lo === hi ? fixed(lo, digits) : `${fixed(lo, digits)}–${fixed(hi, digits)}`;
}

/** A Markdown table. A cell's pipe is escaped. */
export function table(
  head: readonly string[],
  rows: readonly (readonly (string | number)[])[],
): string {
  const cell = (c: string | number): string => String(c).replaceAll('|', '\\|');
  const lines = [
    `| ${head.map(cell).join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ];
  return `${lines.join('\n')}\n`;
}

/** The ladder's tables: a rung whose pixel ratio is above the one before it is marked ↑. */
export function ladderTables(l: LadderResult): string {
  let out = '';
  for (const { top, rows } of l.ladders) {
    out += `\n**Ladder from ${top}**, pixel ratio at each device pixel ratio (↑: more pixels than the rung above)\n\n`;
    out += table(
      ['Rung', 'Name', ...l.dprs.map((d) => `DPR ${d}`)],
      rows.map((r, i) => [
        r.index,
        r.name,
        ...r.ratios.map((v, j) => {
          const before = i > 0 ? rows[i - 1]?.ratios[j] : undefined;
          return `${fixed(v, 3)}${before !== undefined && v > before + 1e-9 ? ' ↑' : ''}`;
        }),
      ]),
    );
  }
  return out;
}

/**
 * The buffers written, summed by the size of each write, the most bytes a
 * frame first; each with the owner that wrote that size most often and
 * how many owners did.
 */
export function bySize(written: readonly WrittenRow[]): WrittenRow[] {
  const sizes = new Map<number, { rows: WrittenRow[]; perFrame: number }>();
  for (const w of written) {
    const s = sizes.get(w.size) ?? { rows: [], perFrame: 0 };
    s.rows.push(w);
    s.perFrame += w.perFrame;
    sizes.set(w.size, s);
  }
  return [...sizes.entries()]
    .map(([size, s]) => {
      const top = [...s.rows].sort((a, b) => b.perFrame - a.perFrame)[0] as WrittenRow;
      const owners = new Set(s.rows.map((r) => r.owner)).size;
      return {
        label: top.label,
        owner: owners > 1 ? `${top.owner}, and ${owners - 1} more` : top.owner,
        size,
        perFrame: s.perFrame,
        bytesPerFrame: s.perFrame * size,
      };
    })
    .sort((a, b) => b.bytesPerFrame - a.bytesPerFrame || b.perFrame - a.perFrame);
}

/** The share of a step: what the part hidden at it cost, the step above's interval less its own. */
export function shares(steps: readonly PartStep[]): number[] {
  return steps.map((s, i) => (i === 0 ? Number.NaN : (steps[i - 1] as PartStep).median - s.median));
}

/** All the results as Markdown, ready for a pull request. */
export function report(r: Results): string {
  const m = r.meta;
  const chrome = m.chrome === '' ? '' : `, Chrome ${m.chrome}, ${m.backend}`;
  let out = `Measured ${m.date} at ${m.commit}${chrome}; medians of ${m.runs} run${m.runs === 1 ? '' : 's'}, ranges over runs.\n`;
  if (r.ladder !== undefined) {
    out += ladderTables(r.ladder);
  }
  if (r.gpu !== undefined) {
    const g = r.gpu;
    out += `\n**Each rung at a fixed ${g.width} × ${g.height}**, frame rate limit and vsync off, median interval between drawn frames (ms)\n\n`;
    out += table(
      ['Rung', 'Name', 'Median interval', 'Runs', 'Mean'],
      g.rows.map((row) => [
        row.index,
        row.name,
        fixed(row.median),
        range(row),
        fixed(row.mean.median, 2),
      ]),
    );
  }
  if (r.parts !== undefined) {
    const p = r.parts;
    for (const t of p.tiers) {
      const sh = shares(t.steps);
      out += `\n**The ${t.tier} tier's frame (${t.rung}) at ${p.width} × ${p.height}, its parts hidden one after another** (ms)\n\n`;
      out += table(
        ['Step', 'Median interval', 'Runs', "The part's share"],
        t.steps.map((s, i) => {
          const v = sh[i] as number;
          return [s.name, fixed(s.median), range(s), i === 0 ? '' : v > 0.05 ? fixed(v) : 'none'];
        }),
      );
    }
  }
  if (r.cpu !== undefined) {
    const c = r.cpu;
    out += `\n**The main thread's work a drawn frame** at ${c.width} × ${c.height}, ${c.throttle}× CPU throttle (ms)\n\n`;
    out += table(
      ['Boat', 'Rung', 'Work median', 'Work p90', 'Runs (median)', 'Interval median'],
      c.rows.map((row) => [
        row.boat,
        row.rung,
        fixed(row.work.median),
        fixed(row.workP90.median),
        range(row.work),
        fixed(row.interval.median),
      ]),
    );
  }
  if (r.counts !== undefined) {
    const c = r.counts;
    const mm = (v: { median: number; max: number }, f: (n: number) => string = whole): string =>
      v.median === v.max ? f(v.median) : `${f(v.median)} (${f(v.max)})`;
    const kb = (n: number): string => fixed(n / 1024, 0);
    out += `\n**Counts a drawn frame** at ${c.width} × ${c.height}, median (largest) over the frames\n\n`;
    out += table(
      [
        'Rung',
        'Buffer writes',
        'KB written',
        'Texture writes',
        'Render passes',
        'three.js renders',
        'Dispatches',
        'Draws',
        'Triangles',
      ],
      c.rows.map((row) => [
        row.rung,
        mm(row.counts.writes),
        mm(row.counts.bytes, kb),
        mm(row.counts.textureWrites),
        mm(row.counts.passes),
        mm(row.counts.renders),
        mm(row.counts.dispatches),
        mm(row.counts.draws),
        mm(row.counts.triangles),
      ]),
    );
    for (const row of c.rows) {
      out += `\n**The largest buffer writes, ${row.rung}** (a frame, over ${row.frames} frames)\n\n`;
      out += table(
        ['Bytes each', 'Writes', 'KB', 'Buffer', 'Written while drawing'],
        row.largest
          .slice(0, 20)
          .map((w) => [
            whole(w.size),
            fixed(w.perFrame, 1),
            fixed(w.bytesPerFrame / 1024, 1),
            w.label,
            w.owner,
          ]),
      );
      out += `\n**Buffer writes by size, ${row.rung}** (a frame)\n\n`;
      out += table(
        ['Bytes each', 'Writes', 'KB', 'Written while drawing (the most written)'],
        bySize(row.largest)
          .slice(0, 20)
          .map((w) => [
            whole(w.size),
            fixed(w.perFrame, 1),
            fixed(w.bytesPerFrame / 1024, 1),
            w.owner,
          ]),
      );
      out += `\n**three.js's passes a frame, ${row.rung}**\n\n`;
      out += table(
        ['Pass', 'A frame'],
        row.passList.map((p) => [p.label, fixed(p.perFrame, 1)]),
      );
      if (row.gpuPassList !== undefined && row.gpuPassList.length > 0) {
        out += `\n**The GPU's render passes a frame, ${row.rung}**, by the render call or encoder that began them\n\n`;
        out += table(
          ['Begun by', 'A frame'],
          row.gpuPassList.map((p) => [p.label, fixed(p.perFrame, 1)]),
        );
      }
    }
  }
  return out;
}

/** One number of the results, to set beside the same number of others. */
export interface Measure {
  section: string;
  label: string;
  value: number;
  /** Digits to show. */
  digits: number;
}

/** Every number worth comparing, by a key that names it the same in any run. */
export function measures(r: Results): Map<string, Measure> {
  const out = new Map<string, Measure>();
  const put = (section: string, label: string, value: number, digits = 1): void => {
    out.set(`${section}/${label}`, { section, label, value, digits });
  };
  for (const row of r.gpu?.rows ?? []) {
    put('gpu', `${row.name} (rung ${row.index})`, row.median);
  }
  for (const t of r.parts?.tiers ?? []) {
    for (const s of t.steps) {
      put('parts', `${t.tier}: ${s.name}`, s.median);
    }
  }
  for (const row of r.cpu?.rows ?? []) {
    put('cpu', `${row.boat}, ${row.tier}: work median`, row.work.median);
    put('cpu', `${row.boat}, ${row.tier}: work p90`, row.workP90.median);
  }
  for (const row of r.counts?.rows ?? []) {
    for (const name of COUNT_NAMES) {
      const v = row.counts[name].median;
      put(
        'counts',
        `${row.tier}: ${name === 'bytes' ? 'KB written' : name}`,
        name === 'bytes' ? v / 1024 : v,
        0,
      );
    }
  }
  return out;
}

/** Two sets of results side by side: each number before, after, and how much it changed. */
export function compare(before: Results, after: Results): string {
  const a = measures(before);
  const b = measures(after);
  const keys = [...new Set([...a.keys(), ...b.keys()])];
  const sections = [...new Set(keys.map((k) => (a.get(k) ?? b.get(k))?.section ?? ''))];
  let out = `Before: ${before.meta.commit} (${before.meta.date}); after: ${after.meta.commit} (${after.meta.date}).\n`;
  const titles: Record<string, string> = {
    gpu: 'Each rung at a fixed size, median interval (ms)',
    parts: "The frame's parts hidden one after another, median interval (ms)",
    cpu: "The main thread's work a drawn frame, 4× throttle (ms)",
    counts: 'Counts a drawn frame, medians',
  };
  for (const s of sections) {
    out += `\n**${titles[s] ?? s}**\n\n`;
    out += table(
      ['Measure', 'Before', 'After', 'Change'],
      keys
        .filter((k) => (a.get(k) ?? b.get(k))?.section === s)
        .map((k) => {
          const x = a.get(k);
          const y = b.get(k);
          const digits = (x ?? y)?.digits ?? 1;
          const change =
            x !== undefined && y !== undefined && x.value !== 0
              ? `${y.value >= x.value ? '+' : '−'}${fixed(Math.abs((100 * (y.value - x.value)) / x.value), 0)}%`
              : '';
          return [
            (x ?? y)?.label ?? k,
            x === undefined ? '–' : fixed(x.value, digits),
            y === undefined ? '–' : fixed(y.value, digits),
            change,
          ];
        }),
    );
  }
  return out;
}
