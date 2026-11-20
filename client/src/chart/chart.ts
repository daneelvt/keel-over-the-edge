// SPDX-License-Identifier: AGPL-3.0-only

// The chart as the screen uses it: whether it is open, and as the chart,
// its list, the news or a log; what is picked on it, a charted thing, a
// weather system, a race course's start or a pin dropped on open water;
// the course steered for a system from its box; the course set, the one
// point the sailor sails for (or a shipmate's boat, or the player's own
// machine sailor's, where the server says it is), kept for the week's
// world and cleared on arrival; and the notices its chartings raise: one for each place the
// player charts, and one for each great discovery anyone does.

import { signal } from '@preact/signals';
import type { ChartEntry, CourseEndWhy, CourseOpen, ShipmateAtIn } from '../net/messages';
import type { CompassCourse } from '../ui/model';
import type { Notices } from '../ui/notices';
import {
  BoatFixes,
  type Course,
  type CourseAim,
  type CourseKeep,
  courseAim,
  defaultKeep,
  loadCourse,
  reached,
  sameCourse,
  saveCourse,
} from './course';
import { courseEndedText, tagText } from './coursewords';
import type { ChartStore } from './store';
import { courseFrame, zoneWhere } from './store';
import type { ChartView } from './view';
import { LAYERS_AT_FIRST, type Layer, type Layers } from './weather';

export type ChartMode = 'chart' | 'list' | 'news' | 'log';

/**
 * Whose log the Log tab shows: the reader's own, a sailor's by name, or
 * one of the player's machine sailors' by its account's id.
 */
export type LogWho =
  | { kind: 'own'; tab?: 'ribbons' | 'certificates' }
  | { kind: 'sailor'; name: string }
  | { kind: 'machine'; id: string; name: string };

/** A point on the paper, m east and north of the centre. */
export interface PaperPoint {
  east: number;
  north: number;
}

/**
 * A weather system or a front tapped on the chart: which, as the scene had
 * it then, and where the tap fell, for a pin there.
 */
export type TappedWeather =
  | { kind: 'system'; slot: number; seed: number; at?: PaperPoint }
  | { kind: 'front'; sin: number; cos: number; at?: PaperPoint };

/** A point on the paper whose box is open: a race course's start, or a pin dropped on open water. */
export type Marked =
  | { kind: 'start'; course: CourseOpen }
  | ({ kind: 'pin' } & PaperPoint)
  /** The boat the course is set to, its box opened from its pin. */
  | { kind: 'boat'; sailor: string; name: string; machine: boolean };

/**
 * The course the sailor steered for a tapped system, from its box: the
 * heading, and where and when the boat meets it, m and the world's tick.
 */
export interface SteeredCourse {
  heading: number;
  east: number;
  north: number;
  at: number;
}

export class Chart {
  readonly store: ChartStore;
  readonly view: ChartView;
  readonly notices: Notices;
  readonly open = signal(false);
  readonly mode = signal<ChartMode>('chart');
  /** The entry whose box is open, or null. */
  readonly picked = signal<ChartEntry | null>(null);
  /** The weather system or front whose box is open, or null. */
  readonly tapped = signal<TappedWeather | null>(null);
  /** The course last steered for a system from its box, or null. */
  readonly steered = signal<SteeredCourse | null>(null);
  /** The race course's start or the pin whose box is open, or null. */
  readonly marked = signal<Marked | null>(null);
  /** The course set: the point sailed for, or null. */
  readonly course = signal<Course | null>(null);
  /** Where the boat the course is set to was last told to be. */
  readonly boats = new BoatFixes(() => this.now());
  /** Whether the boat drawn is another's, watched: the course is the sailor's own, and not shown. */
  watching: () => boolean = () => false;
  /** Whether the boat races: the race line points to its next mark, and the compass gives way to it. */
  racing: () => boolean = () => false;
  /** Where the course is kept; null where the phone refuses. */
  keep: CourseKeep | null = defaultKeep();
  /** The world the course is kept for; "" before one is known. */
  #world = '';
  /** The slider: the forecast ahead, its minutes from now; 0 is now. Play runs it on. */
  readonly minutes = signal(0);
  readonly playing = signal(false);
  /** Whose log the Log tab shows. */
  readonly logOf = signal<LogWho>({ kind: 'own' });
  /** The edition the News tab was last asked for: a day's (2006-01-02), or today's for null; each asking a new one. */
  readonly newsDay = signal<{ day: string | null }>({ day: null });
  /** The weather's layers, each switched on or off. */
  readonly layers = signal<Layers>({ ...LAYERS_AT_FIRST });
  /** The clock notices are raised by, ms. */
  now: () => number = () => performance.now();

  constructor(store: ChartStore, view: ChartView, notices: Notices) {
    this.store = store;
    this.view = view;
    this.notices = notices;
    view.onPick = (e) => {
      this.picked.value = e;
      this.tapped.value = null;
      this.marked.value = null;
    };
    store.onCharted((es) => this.#told(es));
  }

  /** Opens it as the chart, the list, the news or the log; or closes it. */
  show(mode: ChartMode | null): void {
    if (mode === null) {
      this.open.value = false;
      this.picked.value = null;
      this.tapped.value = null;
      this.marked.value = null;
      this.view.show(false);
      // Back to now for the next look.
      this.minutes.value = 0;
      this.playing.value = false;
      return;
    }
    this.mode.value = mode;
    this.open.value = true;
    this.view.show(mode === 'chart');
  }

  /** Opens the chart at an entry, its box open. */
  showAt(e: ChartEntry): void {
    this.show('chart');
    // An island from where its name and its neighbours' show; a place or a
    // feature from where it is lettered too.
    this.view.lookAt(e.east, e.north, e.subject === 'island' ? 4500 : 2000);
    this.picked.value = e;
    this.tapped.value = null;
    this.marked.value = null;
  }

  /** Opens the Log tab on a log: the reader's own, or a sailor's by name. */
  showLog(who: LogWho): void {
    this.logOf.value = who;
    this.show('log');
  }

  /** Opens the News tab on a day's edition, or today's for null. */
  showNews(day: string | null): void {
    this.newsDay.value = { day };
    this.show('news');
  }

  /** Opens the chart on an island course, the whole of its way in sight. */
  showCourse(c: CourseOpen): void {
    const f = courseFrame(c);
    this.show('chart');
    this.picked.value = null;
    this.tapped.value = null;
    this.marked.value = null;
    this.view.lookAt(f.east, f.north, f.distance);
  }

  /** Opens the chart at a point, no box open. */
  showPoint(east: number, north: number): void {
    this.show('chart');
    this.picked.value = null;
    this.tapped.value = null;
    this.marked.value = null;
    this.view.lookAt(east, north, 4000);
  }

  /**
   * The world sailed, by its ID: its course is had back if one was kept
   * for it; another world's is dropped.
   */
  atWorld(id: string): void {
    if (id === this.#world) {
      return;
    }
    this.#world = id;
    this.course.value = loadCourse(id, this.keep);
    if (this.course.value === null) {
      saveCourse(id, null, this.keep);
    }
  }

  /** Sets the course, replacing the last, and keeps it for the world. */
  setCourse(c: Course): void {
    if (!sameCourse(this.course.peek(), c)) {
      this.boats.forget();
    }
    this.course.value = c;
    if (this.#world !== '') {
      saveCourse(this.#world, c, this.keep);
    }
  }

  /** Clears the course. */
  clearCourse(): void {
    this.boats.forget();
    this.course.value = null;
    if (this.#world !== '') {
      saveCourse(this.#world, null, this.keep);
    }
  }

  /** Whether a course is the one set. */
  isCourse(c: Course): boolean {
    return sameCourse(this.course.value, c);
  }

  /**
   * The course from a boat at (east, north): null with none set, while
   * what it names is not charted, or while another's boat is watched.
   */
  aim(east: number, north: number): CourseAim | null {
    const c = this.course.peek();
    if (c === null || this.watching()) {
      return null;
    }
    return courseAim(c, this.store, east, north, this.boats);
  }

  /**
   * Told where the boat of a sailor sailed to is: its pin moves there, and
   * on between, and a name changed since is kept. Nothing for another's.
   */
  boatAt(at: ShipmateAtIn): void {
    const c = this.course.peek();
    if (c?.kind !== 'boat' || c.sailor !== at.sailor) {
      return;
    }
    this.boats.take(at.sailor, at.east, at.north);
    if (at.name !== '' && at.name !== c.name) {
      this.setCourse({ ...c, name: at.name });
    }
  }

  /** Told a course to a sailor's boat ended: cleared, and said why. */
  boatEnded(sailor: string, why: CourseEndWhy): void {
    const c = this.course.peek();
    if (c?.kind !== 'boat' || c.sailor !== sailor) {
      return;
    }
    this.clearCourse();
    this.notices.raise('course-ended', { why: courseEndedText(why, c.name) }, this.now());
  }

  /**
   * Told the sailor's boat is at (east, north): within a tenth of a mile
   * of the course's point it is reached, said, and cleared. Not while
   * racing, when the compass points to the next mark, nor watching.
   */
  arrive(east: number, north: number): void {
    if (this.racing()) {
      return;
    }
    const a = this.aim(east, north);
    if (a === null || !reached(a)) {
      return;
    }
    const boat = this.course.peek()?.kind === 'boat';
    this.clearCourse();
    if (boat) {
      this.notices.raise('course-alongside', { who: a.reached }, this.now());
    } else {
      this.notices.raise('course-reached', { name: a.reached }, this.now());
    }
  }

  /**
   * The course as the compass reads it: its point from the boat, and
   * reached; in a race none, the race line pointing to the next mark.
   */
  compass(): CompassCourse {
    return {
      aim: (east, north) => (this.racing() ? null : this.aim(east, north)),
      arrive: (east, north) => this.arrive(east, north),
    };
  }

  /**
   * The course's tag in the sea from a boat at (east, north): its name and
   * distance over its point, shown only within sight; none in a race.
   */
  seaTag(
    east: number,
    north: number,
  ): { east: number; north: number; text: string; sight: true } | null {
    const a = this.racing() ? null : this.aim(east, north);
    return a === null
      ? null
      : { east: a.east, north: a.north, text: tagText(a.name, a.distance), sight: true };
  }

  /** Switches a layer of the weather on or off. */
  setLayer(layer: Layer, on: boolean): void {
    this.layers.value = { ...this.layers.value, [layer]: on };
  }

  #told(es: ChartEntry[]): void {
    const now = this.now();
    for (const e of es) {
      if (e.withSubject !== null) {
        continue;
      }
      const fill = {
        name: this.store.title(e),
        who: e.by,
        where: zoneWhere(e.zone),
        worth: String(Math.round(e.worth)),
      };
      if (this.store.mine(e)) {
        this.notices.raise('charted-own', fill, now);
      } else if (this.store.great(e) && e.by !== '') {
        this.notices.raise('charted-great', fill, now);
      }
    }
  }
}
