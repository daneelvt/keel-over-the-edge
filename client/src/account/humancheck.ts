// SPDX-License-Identifier: AGPL-3.0-only

// The human check a new sailor passes, Cloudflare Turnstile, on the start
// screen. Its script is loaded only once the new-sailor form shows (never
// for a player with a session, nor for a returning browser until it asks
// for a new sailor), and the widget runs at once, into its slot under the
// look picker, while the player chooses: it shows itself only when it must
// ask the player something. Set sail waits for its token, which the server
// checks once, so a fresh one is asked for after every answer to the first
// step, and again when one expires. When the widget fails, or the browser
// cannot run it, the start screen says so with Try again.

import { type Signal, signal } from '@preact/signals';
import { loadScript } from '../boot/scripts';
import type { HumanCheck } from './me';

/** The action the server expects the token for. */
export const CHECK_ACTION = 'new-sailor';

/** The widget's options, as Turnstile's render() takes them. */
export interface WidgetOptions {
  sitekey: string;
  action: string;
  /** Rendered, then run by execute(), at once. */
  execution: 'execute';
  /** Shown only when the player must be asked. */
  appearance: 'interaction-only';
  /** As wide as its slot, 300 px at the least. */
  size: 'flexible';
  'refresh-expired': 'auto';
  language: string;
  callback: (token: string) => void;
  'error-callback': (code: string) => boolean;
  'expired-callback': () => void;
  'unsupported-callback': () => void;
  'before-interactive-callback': () => void;
}

/** The parts of Cloudflare Turnstile's script the page uses. */
export interface Turnstile {
  render(container: HTMLElement, options: WidgetOptions): string | null | undefined;
  execute(widget: string): void;
  reset(widget: string): void;
  remove(widget: string): void;
  isExpired(widget: string): boolean;
}

/** Loads the check's script and gives its widget's API. */
export type LoadTurnstile = (script: string) => Promise<Turnstile>;

/** The browser's: the script added through the page's policy, and the global it defines. */
export async function loadTurnstile(script: string): Promise<Turnstile> {
  await loadScript(script);
  const t = (globalThis as { turnstile?: Turnstile }).turnstile;
  if (t === undefined) {
    throw new Error('The human check’s script defined no widget.');
  }
  return t;
}

/**
 * Where the check is: not running; asking for a token; holding one; or
 * failed, until Try again.
 */
export type CheckState = 'idle' | 'checking' | 'ready' | 'failed';

/** The page's language, as the widget is told it. */
function pageLanguage(): string {
  const lang = typeof document === 'undefined' ? '' : document.documentElement.lang;
  return lang === '' ? 'auto' : lang;
}

/** The human check on the start screen: its widget, its state, and its token for Set sail. */
export class NewSailorCheck {
  readonly state: Signal<CheckState> = signal('idle');
  readonly #check: HumanCheck;
  readonly #load: LoadTurnstile;
  readonly #language: string;
  #turnstile: Turnstile | null = null;
  #widget: string | null = null;
  #slot: HTMLElement | null = null;
  #token = '';
  #waiting: ((token: string | null) => void)[] = [];
  /** Each mount's own, so a script that loads after the form has gone does nothing. */
  #mounts = 0;

  constructor(check: HumanCheck, load: LoadTurnstile = loadTurnstile, language = pageLanguage()) {
    this.#check = check;
    this.#load = load;
    this.#language = language;
  }

  /** Loads the script (once a page) and runs the widget in slot, at once. */
  async mount(slot: HTMLElement): Promise<void> {
    this.unmount();
    const mount = ++this.#mounts;
    this.#slot = slot;
    this.state.value = 'checking';
    let t: Turnstile;
    try {
      t = await this.#load(this.#check.script);
    } catch {
      if (mount === this.#mounts) {
        this.#fail();
      }
      return;
    }
    if (mount !== this.#mounts) {
      return;
    }
    this.#turnstile = t;
    try {
      const id = t.render(slot, this.#options());
      if (id === null || id === undefined) {
        throw new Error('no widget');
      }
      this.#widget = id;
      t.execute(id);
    } catch {
      this.#fail();
    }
  }

  /** Removes the widget, the form gone; Set sail waiting is told there is no token. */
  unmount(): void {
    this.#mounts++;
    if (this.#turnstile !== null && this.#widget !== null) {
      try {
        this.#turnstile.remove(this.#widget);
      } catch {
        // Gone already.
      }
    }
    this.#widget = null;
    this.#slot = null;
    this.#token = '';
    this.state.value = 'idle';
    this.#settle(null);
  }

  /**
   * The token for the first step: the one held, unless it has expired;
   * otherwise the next the widget gives. null when the check has failed.
   */
  token(): Promise<string | null> {
    const s = this.state.value;
    if (s === 'failed' || s === 'idle') {
      return Promise.resolve(null);
    }
    if (this.#token !== '') {
      if (!this.#expired()) {
        return Promise.resolve(this.#token);
      }
      this.#again();
    }
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  /** The first step answered: its token is spent, and a fresh one asked for at once. */
  spent(): void {
    if (this.#widget !== null) {
      this.#again();
    }
  }

  /** Try again, after the widget failed: the widget run anew, or the script loaded again. */
  retry(): void {
    if (this.#widget !== null) {
      this.#again();
    } else if (this.#slot !== null) {
      void this.mount(this.#slot);
    }
  }

  #options(): WidgetOptions {
    return {
      sitekey: this.#check.siteKey,
      action: CHECK_ACTION,
      execution: 'execute',
      appearance: 'interaction-only',
      size: 'flexible',
      'refresh-expired': 'auto',
      language: this.#language,
      callback: (token) => this.#got(token),
      'error-callback': () => {
        this.#fail();
        // Handled: Turnstile need not throw it.
        return true;
      },
      'expired-callback': () => this.#again(),
      'unsupported-callback': () => this.#fail(),
      // The widget about to ask the player: in view, above Set sail.
      'before-interactive-callback': () => this.#slot?.scrollIntoView({ block: 'nearest' }),
    };
  }

  #expired(): boolean {
    if (this.#turnstile === null || this.#widget === null) {
      return true;
    }
    try {
      return this.#turnstile.isExpired(this.#widget);
    } catch {
      return true;
    }
  }

  /** A fresh token asked for: the widget reset, and run again. */
  #again(): void {
    this.#token = '';
    if (this.#turnstile === null || this.#widget === null) {
      return;
    }
    this.state.value = 'checking';
    try {
      this.#turnstile.reset(this.#widget);
      this.#turnstile.execute(this.#widget);
    } catch {
      this.#fail();
    }
  }

  #got(token: string): void {
    if (token === '') {
      return;
    }
    this.#token = token;
    this.state.value = 'ready';
    this.#settle(token);
  }

  #fail(): void {
    this.#token = '';
    this.state.value = 'failed';
    this.#settle(null);
  }

  #settle(token: string | null): void {
    for (const w of this.#waiting.splice(0)) {
      w(token);
    }
  }
}
