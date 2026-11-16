// SPDX-License-Identifier: AGPL-3.0-only

// The pictures the website shows: each one's pick among the takes
// (takes.ts), its words for those who cannot see it, and the widths it is
// encoded at. To show another take, name it here and run
// npm run pictures -- --encode.

/** Which of the sea's hours a picture of the edge is, for the page to choose by. */
export type Hour = 'dawn' | 'day' | 'dusk' | 'night';

export interface Picture {
  /** Its name, and its files': art/website/<name>-<width>.<avif|jpg>. */
  name: string;
  /** The take it is: pictures/raw/<take>.png. */
  take: string;
  /** Plain words for what it shows. */
  alt: string;
  /** The widths it is encoded at, px: none wider than its take. */
  widths: number[];
  /** The edge's pictures: the hour at sea it is for. */
  hour?: Hour;
  /** The edge's pictures: wide for a desktop, upright for a phone held upright. */
  frame?: 'wide' | 'upright';
  /** The most bytes any of its AVIFs may take: its quality is lowered until it fits. */
  budget?: number;
}

const WIDE = [800, 1200, 1600, 2400];
const UPRIGHT = [800, 1200];
const CARD = [800, 1200];
const LEAD = [800, 1200, 1600];

/** The opening picture's budgets: a phone's whole frame, a desktop's (AVIF). */
const PHONE_BUDGET = 120_000;
const DESKTOP_BUDGET = 250_000;

/** The boat at the edge, the page's opening, for each hour at sea: wide, and upright for phones. */
const edge = (hour: Hour, take: string, upright: string, alt: string): Picture[] => [
  { name: `edge-${hour}`, take, alt, widths: WIDE, hour, frame: 'wide', budget: DESKTOP_BUDGET },
  {
    name: `edge-${hour}-upright`,
    take: upright,
    alt,
    widths: UPRIGHT,
    hour,
    frame: 'upright',
    budget: PHONE_BUDGET,
  },
];

export const pictures: Picture[] = [
  ...edge(
    'dawn',
    'edge-dawn-keel-b',
    'edge-dawn-upright-keel-along',
    'A keelboat and her crew sail along the edge of the world at sunrise, where the sea pours over the falls and breaks away into the mist.',
  ),
  ...edge(
    'day',
    'edge-day-keel-b',
    'edge-day-upright-keel-along',
    'A keelboat and her crew sail along the edge of the world on a bright morning, the sea pouring white over the falls beside them.',
  ),
  ...edge(
    'dusk',
    'edge-dusk-keel-b',
    'edge-dusk-upright-keel-along',
    'A keelboat and her crew sail along the edge of the world at sunset, where the sea pours over the falls and breaks away into the mist.',
  ),
  ...edge(
    'night',
    'edge-night-keel-a',
    'edge-night-upright-keel-along',
    'A keelboat and her crew sail along the edge of the world by moonlight, her masthead light burning above the falls.',
  ),
  {
    name: 'race',
    take: 'race-c',
    alt: 'The game’s chart during a race: six boats’ tracks in their own colours, tacking up to mark 1 and round marks 2 and 3, the leader named.',
    widths: LEAD,
  },
  {
    name: 'together-keelboat',
    take: 'together-keelboat-c',
    alt: 'Five friends sit out on the rail of a keelboat as she heels in the low evening sun.',
    widths: LEAD,
  },
  {
    name: 'together-yacht',
    take: 'together-yacht-c',
    alt: 'Eight aboard a yacht under sail in the evening light.',
    widths: CARD,
  },
  {
    name: 'together-tall-ship',
    take: 'together-tall-ship-c',
    alt: 'A tall ship under full sail at golden hour, the low sun warm on her canvas.',
    widths: CARD,
  },
  {
    name: 'storm',
    take: 'storm-a',
    alt: 'A small boat sails toward a storm cloud towering over the sea.',
    widths: CARD,
  },
  {
    name: 'lightning',
    take: 'lightning-d',
    alt: 'Lightning forks down to the sea at night beside a small boat.',
    widths: CARD,
  },
  {
    name: 'squall',
    take: 'squall-a',
    alt: 'A squall’s cloud overhead and rain driving across the sea around a small boat.',
    widths: CARD,
  },
  {
    name: 'fog',
    take: 'fog-a',
    alt: 'A small boat in fog, the low sun glittering on the water through it.',
    widths: CARD,
  },
  {
    name: 'out-gale',
    take: 'out-gale-a',
    alt: 'A small boat in a gale among whitecaps.',
    widths: CARD,
  },
  {
    name: 'out-reefs',
    take: 'out-reefs-c',
    alt: 'Surf breaking white along the foot of the cliffs, a small boat just off it.',
    widths: CARD,
  },
  {
    name: 'out-land',
    take: 'out-land-a',
    alt: 'A boat sails toward an island whose crater smokes.',
    widths: CARD,
  },
  {
    name: 'out-lagoon',
    take: 'out-lagoon-b',
    alt: 'A boat in a lagoon before a waterfall, palms and a village around it.',
    widths: CARD,
  },
  {
    name: 'out-stars',
    take: 'out-stars-a',
    alt: 'A boat at night under the moon and stars, her masthead light burning.',
    widths: CARD,
  },
  {
    name: 'out-edge',
    take: 'out-edge-a',
    alt: 'Looking back along the falls at a small boat close to the lip, the sea pouring over beside her.',
    widths: CARD,
  },
];

/** Which hour's opening the page shows when it knows none (the sea resting). */
export const DEFAULT_HOUR: Hour = 'dusk';

/**
 * The game's own art the page shows as it is, by repository path: the
 * inked portraits beside watching and the AI's block, the boats' glyphs
 * (their names and how many each takes aboard from the catalog), and the
 * glyphs that stand as the page's medals.
 */
export const ART = {
  watch: ['art/sailors/buccaneer/female.ink.webp', 'art/sailors/buccaneer/male.ink.webp'],
  machine: ['art/sailors/machine/female.ink.webp', 'art/sailors/machine/male.ink.webp'],
  medals: ['art/glyphs/magnificent-frigatebird.webp', 'art/glyphs/sperm-whale.webp'],
} as const;
