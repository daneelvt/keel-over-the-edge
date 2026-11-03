// SPDX-License-Identifier: AGPL-3.0-only

// The cover over the page: painted first, from the page's own HTML, and
// kept over the scene until the world under it is ready; then faded out
// as the camera comes down into the first view, the screen at sea coming
// in over its last moments. A change of boat brings it down again. Its
// line says what it waits for, once the wait passes a second; Set sail's
// own answer, at once.

/** How long the cover takes to fall over the page, and to lift, s; with reduced motion. */
export const DROP = 0.3;
export const LIFT = 0.8;
export const LIFT_REDUCED = 0.2;
/** How long a wait goes without words, ms. */
export const QUIET = 1000;

export class Cover {
  readonly el: HTMLElement;
  readonly #line: HTMLElement | null;
  readonly #root: HTMLElement;
  #up = true;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(el: HTMLElement, root: HTMLElement) {
    this.el = el;
    this.#root = root;
    this.#line = el.querySelector('.cover-line');
  }

  /** Whether it covers the page, or is falling over it. */
  get up(): boolean {
    return this.#up;
  }

  /** Its line's words. */
  say(text: string): void {
    if (this.#line !== null && this.#line.textContent !== text) {
      this.#line.textContent = text;
    }
  }

  /** Falls over the page over seconds; resolves once it covers it. */
  drop(seconds: number): Promise<void> {
    this.#clear();
    this.#up = true;
    this.say('');
    const el = this.el;
    el.hidden = false;
    // From where it is, faded out, to over the page.
    el.style.transition = seconds > 0 ? `opacity ${seconds}s ease-in` : 'none';
    el.classList.add('lifting');
    void el.offsetWidth;
    el.classList.remove('lifting');
    return new Promise((resolve) => {
      this.#timer = setTimeout(() => {
        this.#root.classList.add('covered');
        resolve();
      }, seconds * 1000);
    });
  }

  /**
   * Fades out over seconds, the screen at sea coming in over its last
   * moments; at once for 0. Resolves once it is gone.
   */
  lift(seconds: number): Promise<void> {
    this.#clear();
    this.#up = false;
    this.el.style.removeProperty('transition');
    this.el.style.setProperty('--lift', `${seconds}s`);
    this.el.classList.add('lifting');
    this.#root.classList.toggle('at-once', seconds === 0);
    this.#root.classList.remove('covered');
    return new Promise((resolve) => {
      this.#timer = setTimeout(() => {
        this.el.hidden = true;
        this.say('');
        resolve();
      }, seconds * 1000);
    });
  }

  #clear(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}

/** The page's cover, or one made where the page has none (another page's HTML). */
export function takeCover(doc: Document): Cover {
  let el = doc.getElementById('cover');
  if (el === null) {
    el = doc.createElement('div');
    el.id = 'cover';
    el.className = 'cover';
    const line = doc.createElement('p');
    line.className = 'cover-line';
    line.setAttribute('role', 'status');
    el.append(line);
    doc.documentElement.classList.add('covered');
  }
  return new Cover(el, doc.documentElement);
}
