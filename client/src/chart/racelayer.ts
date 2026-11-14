// SPDX-License-Identifier: AGPL-3.0-only

// A race on the chart: its course (the way sailed, faint; the start and
// finish lines inked; the marks, numbered, the next ringed in gold) and
// its boats' tracks from the start, one colour a boat from a set of eight
// a colour-blind reader can tell apart (Okabe and Ito's), the watched
// boat's widest and brightest, the others thinner and paler; each boat a
// dot where it is now. Only the watched boat and the leader carry a tag
// (a colour bar, the name, the place); the rest their place alone. Every
// line is a strip of quads laid on the paper, a pixel width held at the
// camera's distance, as a line of WebGL's is one pixel whatever is asked.
//
// What is drawn comes from a RaceDrawing, which the race the boat sails
// in gives, and a replay can give at its slider's moment.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  type PerspectiveCamera,
  Vector3,
} from 'three';
import type { RacePoint, RaceToldIn } from '../net/messages';
import { chartMaterial } from '../render/materials';

/** A race as the chart draws it. */
export interface RaceDrawing {
  told: RaceToldIn;
  /** Each boat's track, by its race number: east, north, … m. */
  tracks: ReadonlyMap<number, readonly number[]>;
  /** Each boat where it is now, with its place (0 none). */
  boats: readonly { number: number; east: number; north: number; place: number }[];
  /** The boat watched (the player's own while racing), and the leader; 0 none. */
  watched: number;
  leader: number;
  /** The leg the watched boat makes for: its mark is ringed; −1 none. */
  next: number;
  /** A boat's name as its tag says it. */
  name: (n: number) => string;
  /** Counts up whenever any of it changes. */
  version: number;
}

export { TRACK_COLOURS, trackColour } from '../ui/racecolours';

import { trackColour } from '../ui/racecolours';

/** Widths on the screen, CSS pixels: the watched boat's track, the others', the lines', a dash's. */
const WIDE = 4;
const THIN = 2;
const INK = 2.2;
/** The marks' and boats' radii on the screen, CSS pixels. */
const MARK = 5;
const DOT = 4;
/** Heights above the paper, m: over the weather's sheet and the wind's streaks. */
const LIFT = 6;

/** A strip of quads, coloured by its corners. */
class Strips {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];

  /** A quad from a to b, w m wide. */
  segment(a: RacePoint, b: RacePoint, w: number, c: Color, alpha: number, y = LIFT): void {
    const dx = b.east - a.east;
    const dy = b.north - a.north;
    const l = Math.hypot(dx, dy);
    if (l < 1e-6) {
      return;
    }
    const nx = (-dy / l) * (w / 2);
    const ny = (dx / l) * (w / 2);
    this.quad(
      [a.east + nx, a.north + ny],
      [a.east - nx, a.north - ny],
      [b.east + nx, b.north + ny],
      [b.east - nx, b.north - ny],
      c,
      alpha,
      y,
    );
  }

  quad(
    a: [number, number],
    b: [number, number],
    c: [number, number],
    d: [number, number],
    colour: Color,
    alpha: number,
    y: number,
  ): void {
    const base = this.pos.length / 3;
    for (const p of [a, b, c, d]) {
      this.pos.push(p[0], y, -p[1]);
      this.col.push(colour.r, colour.g, colour.b, alpha);
    }
    this.idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }

  /** A disc of radius r about p, as a fan. */
  disc(p: RacePoint, r: number, colour: Color, alpha: number, y: number, sides = 12): void {
    const base = this.pos.length / 3;
    this.pos.push(p.east, y, -p.north);
    this.col.push(colour.r, colour.g, colour.b, alpha);
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      this.pos.push(p.east + Math.sin(a) * r, y, -(p.north + Math.cos(a) * r));
      this.col.push(colour.r, colour.g, colour.b, alpha);
    }
    for (let i = 0; i < sides; i++) {
      this.idx.push(base, base + 1 + i, base + 2 + i);
    }
  }

  /** A ring of radius r and width w about p. */
  ring(
    p: RacePoint,
    r: number,
    w: number,
    colour: Color,
    alpha: number,
    y: number,
    sides = 16,
  ): void {
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      const at = (a: number, rr: number): [number, number] => [
        p.east + Math.sin(a) * rr,
        p.north + Math.cos(a) * rr,
      ];
      this.quad(
        at(a0, r + w / 2),
        at(a0, r - w / 2),
        at(a1, r + w / 2),
        at(a1, r - w / 2),
        colour,
        alpha,
        y,
      );
    }
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 4));
    g.setIndex(this.idx);
    return g;
  }
}

/** A label of the race's on the chart: its element and where it stands. */
interface RaceLabel {
  el: HTMLElement;
  east: number;
  north: number;
}

export class RaceLayer {
  readonly group = new Group();
  readonly #mesh = new Mesh(
    new BufferGeometry(),
    chartMaterial({ vertexColors: true, transparent: true, side: DoubleSide, depthWrite: false }),
  );
  #version = -1;
  #metres = 0;
  #labels: RaceLabel[] = [];
  #layer: HTMLElement | null = null;
  readonly #v = new Vector3();
  /** How many tracks, marks and tags were last drawn (the tests). */
  drawn = { tracks: 0, marks: 0, tags: 0, boats: 0 };

  constructor() {
    this.#mesh.name = 'race';
    this.#mesh.frustumCulled = false;
    this.#mesh.renderOrder = 2;
    this.group.add(this.#mesh);
    this.group.visible = false;
  }

  /**
   * Lays the race again if it has changed or the camera's scale has (m a
   * pixel at what it looks at): true if anything changed.
   */
  update(d: RaceDrawing | null, metres: number, ink: string): boolean {
    if (d === null) {
      if (!this.group.visible) {
        return false;
      }
      this.group.visible = false;
      this.#version = -1;
      this.#setLabels([]);
      return true;
    }
    if (
      d.version === this.#version &&
      this.group.visible &&
      Math.abs(metres - this.#metres) <= this.#metres * 0.08
    ) {
      return false;
    }
    this.#version = d.version;
    this.#metres = metres;
    this.group.visible = true;
    const s = new Strips();
    const t = d.told;
    const inkC = new Color(ink);
    // The way, faint and dashed.
    const dash = 8 * metres;
    for (let i = 0; i + 1 < t.way.length; i++) {
      const a = t.way[i] as RacePoint;
      const b = t.way[i + 1] as RacePoint;
      const l = Math.hypot(b.east - a.east, b.north - a.north);
      for (let at = 0; at < l; at += 2 * dash) {
        const f0 = at / l;
        const f1 = Math.min(1, (at + dash) / l);
        s.segment(
          { east: a.east + (b.east - a.east) * f0, north: a.north + (b.north - a.north) * f0 },
          { east: a.east + (b.east - a.east) * f1, north: a.north + (b.north - a.north) * f1 },
          1.2 * metres,
          inkC,
          0.35,
          LIFT - 1,
        );
      }
    }
    // The lines.
    if (t.pin !== null && t.committee !== null) {
      s.segment(t.pin, t.committee, INK * metres, inkC, 0.9, LIFT - 0.5);
    }
    if (t.finish !== null) {
      s.segment(t.finish[0], t.finish[1], INK * metres, inkC, 0.9, LIFT - 0.5);
    }
    // The tracks, the watched boat's last, over the rest.
    const order = [...d.tracks.keys()].sort((a, b) =>
      a === d.watched ? 1 : b === d.watched ? -1 : a - b,
    );
    let tracks = 0;
    for (const n of order) {
      const tr = d.tracks.get(n) ?? [];
      const mine = n === d.watched;
      const c = new Color(trackColour(n));
      const w = (mine ? WIDE : THIN) * metres;
      for (let i = 0; i + 3 < tr.length; i += 2) {
        s.segment(
          { east: tr[i] ?? 0, north: tr[i + 1] ?? 0 },
          { east: tr[i + 2] ?? 0, north: tr[i + 3] ?? 0 },
          w,
          c,
          mine ? 1 : 0.6,
          LIFT + (mine ? 1 : 0),
        );
      }
      if (tr.length >= 4) {
        tracks++;
      }
    }
    // The marks, the next ringed in gold.
    const markC = new Color('#e0782c');
    const gold = new Color('#c8952c');
    const nextMark = t.legs[d.next]?.mark ?? 0;
    for (const m of t.marks) {
      s.disc(m, MARK * metres + metres, inkC, 0.9, LIFT + 2);
      s.disc(m, MARK * metres, markC, 1, LIFT + 2.2);
      if (m.number === nextMark && nextMark > 0) {
        s.ring(m, (MARK + 5) * metres, 2.4 * metres, gold, 1, LIFT + 2.4);
      }
    }
    // The boats where they are now.
    for (const b of d.boats) {
      const mine = b.number === d.watched;
      s.disc(b, (DOT + (mine ? 2 : 0) + 1) * metres, inkC, 0.9, LIFT + 3);
      s.disc(b, (DOT + (mine ? 2 : 0)) * metres, new Color(trackColour(b.number)), 1, LIFT + 3.2);
    }
    this.#mesh.geometry.dispose();
    this.#mesh.geometry = s.geometry();
    this.drawn = { tracks, marks: t.marks.length, tags: 0, boats: d.boats.length };
    this.#labelsOf(d);
    return true;
  }

  /** The labels' layer: the chart's own. */
  attach(layer: HTMLElement | null): void {
    this.#setLabels([]);
    this.#layer = layer;
    this.#version = -1;
  }

  #setLabels(labels: RaceLabel[]): void {
    for (const l of this.#labels) {
      l.el.remove();
    }
    this.#labels = labels;
    if (this.#layer !== null) {
      for (const l of labels) {
        this.#layer.append(l.el);
      }
    }
  }

  /** The marks' numbers, the watched boat's and the leader's tags, the others' places. */
  #labelsOf(d: RaceDrawing): void {
    const out: RaceLabel[] = [];
    if (this.#layer === null) {
      this.#setLabels(out);
      return;
    }
    for (const m of d.told.marks) {
      const el = document.createElement('span');
      el.className = 'race-chart-mark';
      el.textContent = String(m.number);
      out.push({ el, east: m.east, north: m.north });
    }
    if (d.told.pin !== null && d.told.committee !== null) {
      const el = document.createElement('span');
      el.className = 'race-chart-line';
      el.textContent = d.told.finish === null ? 'Start' : 'Start · finish';
      const a = d.told.pin;
      const b = d.told.committee;
      out.push({ el, east: (a.east + b.east) / 2, north: (a.north + b.north) / 2 });
    }
    let tags = 0;
    for (const b of d.boats) {
      const el = document.createElement('span');
      const tagged = b.number === d.watched || b.number === d.leader;
      el.className = tagged ? 'race-chart-tag' : 'race-chart-place';
      el.style.setProperty('--race-colour', trackColour(b.number));
      if (tagged) {
        tags++;
        const bar = document.createElement('span');
        bar.className = 'race-chart-bar';
        const name = document.createElement('span');
        name.textContent = d.name(b.number);
        el.append(bar, name);
        if (b.place > 0) {
          const place = document.createElement('span');
          place.className = 'race-chart-tag-place';
          place.textContent = String(b.place);
          el.append(place);
        }
      } else {
        el.textContent = b.place > 0 ? String(b.place) : '·';
      }
      el.dataset.number = String(b.number);
      out.push({ el, east: b.east, north: b.north });
    }
    this.drawn.tags = tags;
    this.#setLabels(out);
  }

  /** Lays the labels over the picture where the camera puts them. */
  place(camera: PerspectiveCamera, width: number, height: number): void {
    for (const l of this.#labels) {
      this.#v.set(l.east, LIFT, -l.north).project(camera);
      const x = (this.#v.x * 0.5 + 0.5) * width;
      const y = (-this.#v.y * 0.5 + 0.5) * height;
      const on =
        this.group.visible &&
        this.#v.z < 1 &&
        x > -60 &&
        x < width + 60 &&
        y > -30 &&
        y < height + 30;
      l.el.hidden = !on;
      if (on) {
        l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      }
    }
  }
}
