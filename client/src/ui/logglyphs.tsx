// SPDX-License-Identifier: AGPL-3.0-only

// The collection's glyphs, a kind each, in the log's ink: the sea's life
// and the boats inked from the game's own models (art/glyphs, loaded when
// first shown); the features and the places by the chart's own marks; the
// islands as a chart's view of the land, drawn from each biome's own
// numbers and each size class's; the weather and the edge drawn here. A
// kind not yet found is its glyph as a silhouette.

import { catalog } from '../catalog';
import { FEATURE_MARKS, PLACE_MARKS } from '../chart/marks';

/** Every inked glyph, by its path under art/: one for each kind of the sea's life and each boat. */
const INKED = import.meta.glob<string>('../../../art/glyphs/*.webp', {
  query: '?url&no-inline',
  import: 'default',
  eager: true,
});

/** An inked glyph's URL by its kind's id, or undefined. */
export function inkedGlyph(id: string): string | undefined {
  return INKED[`../../../art/glyphs/${id}.webp`];
}

/** The marks of the kinds of place the chart letters by their light or their water alone, by site. */
const MORE_PLACE_MARKS: Record<string, string> = {
  light: '✶',
  cove: '◡',
  lagoon: '◌',
};

/** A feature's or a place's mark, as the chart letters it; '' for none. */
export function markOf(group: string, id: string): string {
  if (group === 'features') {
    const k = catalog.world.features.kinds.find((x) => x.id === id);
    return FEATURE_MARKS[k?.symbol ?? ''] ?? '';
  }
  if (group === 'places') {
    const k = catalog.world.places.kinds.find((x) => x.id === id);
    const site = k?.site ?? '';
    return PLACE_MARKS[site] ?? MORE_PLACE_MARKS[site] ?? '';
  }
  return '';
}

/** The waterline and its small seas, under every view of the land. */
function Sea() {
  return (
    <g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
      <path d="M3 36 H45" />
      <path d="M7 40 q2 -1.5 4 0 M19 41 q2 -1.5 4 0 M31 40 q2 -1.5 4 0" stroke-width="1.2" />
    </g>
  );
}

/** A view of the land of a biome: its height, its cone and crater, its cliffs and stacks, its trees, its reef. */
function Island({ id }: { id: string }) {
  const b = catalog.world.biomes.find((x) => x.id === id);
  if (b === undefined) {
    return <Sea />;
  }
  const top = Math.max(b.height[0], b.height[1]);
  const h = 4 + 20 * Math.min(1, top / 80);
  const y0 = 36;
  const crest = y0 - h;
  const steep = Math.max(b.cliffs[0], b.cliffs[1]) > 0.5;
  let land: string;
  if (b.cone > 0) {
    // A cone, cut flat by its crater.
    land = `M6 ${y0} L18 ${crest + 1} L21 ${crest} L27 ${crest} L30 ${crest + 1} L42 ${y0} Z`;
  } else if (steep) {
    land = `M9 ${y0} L11 ${crest + 3} Q16 ${crest - 1} 24 ${crest} Q31 ${crest + 1} 36 ${crest + 4} L38 ${y0} Z`;
  } else {
    land = `M5 ${y0} Q12 ${crest + 2} 22 ${crest} Q33 ${crest + 1} 43 ${y0} Z`;
  }
  const canopy = catalog.world.surfaces.find((s) => s.id === b.surfaces.high)?.canopy ?? 0;
  const trees: preact.JSX.Element[] = [];
  if (canopy >= 10 && b.cone === 0) {
    const tops = [16, 23, 30];
    tops.forEach((x, i) => {
      const y = crest + (i === 1 ? 0 : 2);
      trees.push(
        b.mangroves ? (
          <g key={x} fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
            <path d={`M${x} ${y + 1} q1 -5 0 -9`} />
            <path
              d={`M${x} ${y - 8} q-4 -1 -6 2 M${x} ${y - 8} q4 -1 6 2 M${x} ${y - 8} q-2 -3 -5 -3 M${x} ${y - 8} q2 -3 5 -3`}
            />
          </g>
        ) : (
          <circle
            key={x}
            cx={x}
            cy={y - 3}
            r="3.4"
            fill="var(--glyph-paper)"
            stroke="currentColor"
            stroke-width="1.3"
          />
        ),
      );
    });
  }
  const stacks = Math.max(b.stacks[0], b.stacks[1]) > 0;
  return (
    <>
      {trees}
      <path
        d={land}
        fill="var(--glyph-paper)"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linejoin="round"
      />
      {b.cone > 0 ? (
        <path
          d={`M24 ${crest - 2} q-3 -3 0 -5 q3 -2 1 -5 q4 1 2 5`}
          fill="none"
          stroke="currentColor"
          stroke-width="1.2"
          stroke-linecap="round"
        />
      ) : null}
      {top <= 10 ? (
        <path
          d="M14 34 h1 M20 33 h1 M26 33 h1 M32 34 h1 M23 31 h1"
          stroke="currentColor"
          stroke-width="1.4"
        />
      ) : null}
      {stacks ? (
        <path
          d={`M40 ${y0} v-7 h2 v7`}
          fill="var(--glyph-paper)"
          stroke="currentColor"
          stroke-width="1.4"
        />
      ) : null}
      {b.reef ? (
        <path
          d="M41 33 l2 2 m0 -2 l-2 2 M4 33 l2 2 m0 -2 l-2 2"
          stroke="currentColor"
          stroke-width="1.1"
        />
      ) : null}
      <Sea />
    </>
  );
}

/** A view of the land of a size class: wider the larger. */
function Size({ id }: { id: string }) {
  const sizes = catalog.world.sizes;
  const i = Math.max(
    0,
    sizes.findIndex((s) => s.class === id),
  );
  const w = 6 + (36 * i) / Math.max(1, sizes.length - 1);
  const h = 4 + 3 * i;
  const l = 24 - w / 2;
  const r = 24 + w / 2;
  return (
    <>
      <path
        d={`M${l} 36 Q${l + w * 0.3} ${36 - h} 24 ${36 - h} Q${r - w * 0.3} ${36 - h} ${r} 36 Z`}
        fill="var(--glyph-paper)"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linejoin="round"
      />
      <Sea />
    </>
  );
}

/** The log's own kinds of weather, each by a drawing: the storm cone hoisted, two for a storm, fog, the moon. */
function Weather({ id }: { id: string }) {
  const ink = {
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.6,
    'stroke-linecap': 'round',
  } as const;
  switch (id) {
    case 'gale-ridden-out':
      return (
        <>
          <path d="M14 44 V6" {...ink} />
          <path d="M14 8 H30" {...ink} />
          <path
            d="M22 9 L30 22 H14 Z"
            fill="currentColor"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linejoin="round"
          />
          <Sea />
        </>
      );
    case 'storm-ridden-out':
      return (
        <>
          <path d="M14 44 V4" {...ink} />
          <path d="M14 6 H30" {...ink} />
          <path
            d="M22 7 L30 18 H14 Z"
            fill="currentColor"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linejoin="round"
          />
          <path
            d="M14 20 H30 L22 31 Z"
            fill="currentColor"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linejoin="round"
          />
          <Sea />
        </>
      );
    case 'landfall-in-fog':
      return (
        <>
          <path
            d="M20 36 L22 14 H26 L28 36 Z"
            fill="var(--glyph-paper)"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linejoin="round"
          />
          <path d="M21 12 h6 v-4 h-6 z" fill="currentColor" />
          <path d="M6 18 H40 M4 24 H44 M8 30 H38" {...ink} stroke-dasharray="5 3" />
          <Sea />
        </>
      );
    case 'night-at-sea':
      return (
        <>
          <path d="M28 6 a12 12 0 1 0 10 18 a9 9 0 1 1 -10 -18 z" fill="currentColor" />
          <path
            d="M10 10 l1 2 l2 0 l-1.5 1.5 l0.5 2 l-2 -1 l-2 1 l0.5 -2 l-1.5 -1.5 l2 0 z"
            fill="currentColor"
          />
          <path d="M16 22 h0.5 M8 26 h0.5" {...ink} stroke-width="2" />
          <Sea />
        </>
      );
  }
  return <Sea />;
}

/** A rung of the edge's ladder: the boat the nearer the lip, the falls beyond it. */
function Edge({ id }: { id: string }) {
  const m = Number(/\d+/.exec(id)?.[0] ?? 500);
  // 500 m far back, 10 m at the very lip.
  const x = 32 - 24 * Math.min(1, Math.log10(m / 10) / Math.log10(50));
  return (
    <>
      <path
        d="M3 30 H36 Q40 30 41 34 L42 46"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      />
      <path
        d="M38 33 Q41 38 39 46 M44 32 Q46 38 45 46"
        fill="none"
        stroke="currentColor"
        stroke-width="1.1"
        stroke-dasharray="3 2"
      />
      <path d={`M${x - 5} 28 H${x + 5} L${x + 3} 31 H${x - 3} Z`} fill="currentColor" />
      <path
        d={`M${x} 28 V16 L${x + 6} 26 Z`}
        fill="var(--glyph-paper)"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linejoin="round"
      />
    </>
  );
}

/** A kind's glyph in a group of the collection, its silhouette while not found. */
export function Glyph({ group, id, found }: { group: string; id: string; found: boolean }) {
  const cls = `log-glyph${found ? '' : ' unfound'}`;
  const inked = group === 'life' || group === 'boats' ? inkedGlyph(id) : undefined;
  if (inked !== undefined) {
    return (
      <span class={cls} aria-hidden="true">
        <img src={inked} alt="" width={48} height={48} decoding="async" loading="lazy" />
      </span>
    );
  }
  const mark = markOf(group, id);
  if (mark !== '') {
    return (
      <span class={`${cls} log-glyph-mark`} aria-hidden="true">
        {mark}
      </span>
    );
  }
  return (
    <span class={cls} aria-hidden="true">
      <svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">
        {group === 'islands' ? (
          <Island id={id} />
        ) : group === 'sizes' ? (
          <Size id={id} />
        ) : group === 'weather' ? (
          <Weather id={id} />
        ) : group === 'edge' ? (
          <Edge id={id} />
        ) : (
          <Sea />
        )}
      </svg>
    </span>
  );
}
