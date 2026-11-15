// SPDX-License-Identifier: AGPL-3.0-only

// The course on the chart, laid as a course is laid on a paper chart: a
// faint pencil line from the boat to where it is, and a brass pin there
// with its name under it, which a tap opens the course's box from; and a
// pin dropped on open water whose box is open, before it is the course or
// is taken away. The line is a strip of quads on the paper, its width a
// pixel count held at the camera's distance, as the race's lines are; the
// pins are the page's own elements in the chart's labels layer.

import {
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  type PerspectiveCamera,
  Vector3,
} from 'three';
import { chartMaterial } from '../render/materials';
import { Strips } from './racelayer';

/** What the layer draws: the course, with its name, and a pin dropped. */
export interface CourseDrawing {
  course: { east: number; north: number; name: string } | null;
  pin: { east: number; north: number } | null;
}

/** The pencil line's width on the screen, CSS pixels, its colour and how faint. */
const LINE = 1.6;
const PENCIL = '#3f3a36';
const FAINT = 0.55;
/** Its height above the paper, m: over the weather's sheet, under a race's lines. */
const LIFT = 5;
/** How far the boat moves before the line is laid again, in the camera's metres a pixel. */
const MOVES = 2;

const SVG = 'http://www.w3.org/2000/svg';

/** A pin's head, as a chart's drawing pin is drawn: its point at the foot. */
function pinHead(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'chart-pin-head');
  svg.setAttribute('viewBox', '0 0 16 22');
  svg.setAttribute('aria-hidden', 'true');
  const body = document.createElementNS(SVG, 'path');
  body.setAttribute(
    'd',
    'M8 21.2 C 8 21.2 1.2 12.6 1.2 8 A 6.8 6.8 0 0 1 14.8 8 C 14.8 12.6 8 21.2 8 21.2 Z',
  );
  const eye = document.createElementNS(SVG, 'circle');
  eye.setAttribute('cx', '8');
  eye.setAttribute('cy', '8');
  eye.setAttribute('r', '2.4');
  svg.append(body, eye);
  return svg;
}

export class CourseLayer {
  readonly group = new Group();
  readonly #mesh = new Mesh(
    new BufferGeometry(),
    chartMaterial({ vertexColors: true, transparent: true, side: DoubleSide, depthWrite: false }),
  );
  #course: HTMLButtonElement | null = null;
  #pin: HTMLElement | null = null;
  /** What was last laid: the course's point and name, the pin, the boat and the scale. */
  #laid = '';
  #boat = { east: Number.NaN, north: Number.NaN };
  #metres = 0;
  #drawing: CourseDrawing = { course: null, pin: null };
  readonly #v = new Vector3();
  /** Told when the course's pin is tapped: its box opens. */
  onTap: (() => void) | null = null;
  /** What was last drawn (the tests): whether the line, and how many pins. */
  drawn = { line: false, pins: 0 };

  constructor() {
    this.#mesh.name = 'course';
    this.#mesh.frustumCulled = false;
    this.#mesh.renderOrder = 2;
    this.group.add(this.#mesh);
    this.group.visible = false;
  }

  /**
   * Lays the course and the pin again if either has changed, the boat has
   * moved or the camera's scale has (m a pixel at what it looks at): true
   * if anything changed.
   */
  update(d: CourseDrawing, boat: { east: number; north: number }, metres: number): boolean {
    const c = d.course;
    const laid = `${c === null ? '' : `${c.east.toFixed(1)},${c.north.toFixed(1)},${c.name}`}|${d.pin === null ? '' : `${d.pin.east},${d.pin.north}`}`;
    const moved =
      c !== null &&
      Math.hypot(boat.east - this.#boat.east, boat.north - this.#boat.north) > MOVES * metres;
    const scaled = Math.abs(metres - this.#metres) > this.#metres * 0.08;
    if (laid === this.#laid && !moved && !(c !== null && scaled)) {
      return false;
    }
    this.#laid = laid;
    this.#boat = { east: boat.east, north: boat.north };
    this.#metres = metres;
    this.#drawing = d;
    this.group.visible = c !== null;
    this.#mesh.geometry.dispose();
    if (c === null) {
      this.#mesh.geometry = new BufferGeometry();
    } else {
      const s = new Strips();
      s.segment(boat, c, LINE * metres, new Color(PENCIL), FAINT, LIFT);
      this.#mesh.geometry = s.geometry();
    }
    this.drawn = { line: c !== null, pins: (c === null ? 0 : 1) + (d.pin === null ? 0 : 1) };
    this.#label();
    return true;
  }

  /** The labels' layer: the chart's own. */
  attach(layer: HTMLElement | null): void {
    this.#course?.remove();
    this.#pin?.remove();
    this.#course = null;
    this.#pin = null;
    this.#laid = '';
    if (layer === null) {
      return;
    }
    const course = document.createElement('button');
    course.type = 'button';
    course.className = 'chart-pin chart-course';
    course.append(pinHead());
    const name = document.createElement('span');
    name.className = 'chart-pin-name';
    course.append(name);
    course.hidden = true;
    course.dataset.readout = 'chart-course';
    course.addEventListener('click', () => this.onTap?.());
    const pin = document.createElement('span');
    pin.className = 'chart-pin chart-dropped';
    pin.append(pinHead());
    pin.hidden = true;
    pin.dataset.readout = 'chart-pin';
    layer.append(course, pin);
    this.#course = course;
    this.#pin = pin;
  }

  /** The course's pin's name and words, as drawn. */
  #label(): void {
    const el = this.#course;
    const c = this.#drawing.course;
    if (el === null || c === null) {
      return;
    }
    const name = el.querySelector('.chart-pin-name');
    if (name !== null && name.textContent !== c.name) {
      name.textContent = c.name;
    }
    el.setAttribute('aria-label', `Course: ${c.name}`);
  }

  /** Lays the pins over the picture where the camera puts them. */
  place(camera: PerspectiveCamera, width: number, height: number): void {
    const at = (el: HTMLElement | null, p: { east: number; north: number } | null) => {
      if (el === null) {
        return;
      }
      if (p === null) {
        el.hidden = true;
        return;
      }
      this.#v.set(p.east, LIFT, -p.north).project(camera);
      const x = (this.#v.x * 0.5 + 0.5) * width;
      const y = (-this.#v.y * 0.5 + 0.5) * height;
      const on = this.#v.z < 1 && x > -40 && x < width + 40 && y > -40 && y < height + 40;
      el.hidden = !on;
      if (on) {
        el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      }
    };
    at(this.#course, this.#drawing.course);
    at(this.#pin, this.#drawing.pin);
  }
}
