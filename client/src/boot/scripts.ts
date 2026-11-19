// SPDX-License-Identifier: AGPL-3.0-only

// The one place the page adds a <script> of its own to itself: today only
// the human check's, Cloudflare Turnstile's, loaded once the new-sailor
// form shows. Its address goes through the page's keel Trusted Types
// policy (policy.ts), which refuses anything but the page's own files and
// the check's script, so no other address can be loaded this way, even
// where the browser has no Trusted Types.

import { scriptURL } from './policy';

/** The parts of a document a script is added to. */
export interface ScriptDocument {
  createElement(tag: 'script'): HTMLScriptElement;
  head: { append(node: Node): void };
}

/** Scripts asked for, by address: each loaded once, a failed one asked again. */
const loading = new Map<string, Promise<void>>();

/**
 * Loads a script by its address, once: resolves when it has run, rejects
 * when it cannot be loaded, or when the address is not one the page loads.
 * A script that failed is removed, and asked for anew next time.
 */
export function loadScript(address: string, doc: ScriptDocument = document): Promise<void> {
  const asked = loading.get(address);
  if (asked !== undefined) {
    return asked;
  }
  const loaded = new Promise<void>((resolve, reject) => {
    // Throws for an address the page never loads, before any element is made.
    const src = scriptURL(address);
    const script = doc.createElement('script');
    script.async = true;
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener(
      'error',
      () => {
        script.remove();
        reject(new Error(`The script did not load: ${address}`));
      },
      { once: true },
    );
    script.src = src;
    doc.head.append(script);
  });
  loading.set(address, loaded);
  loaded.catch(() => loading.delete(address));
  return loaded;
}
