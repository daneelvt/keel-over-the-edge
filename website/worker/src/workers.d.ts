// SPDX-License-Identifier: AGPL-3.0-only

// The few of the Workers runtime's types the Worker uses. Cloudflare's own
// (@cloudflare/workers-types) cannot stand beside the DOM's, which the
// chart's painters it shares with the game are written against.

interface KVNamespace {
  get(key: string, type: 'text'): Promise<string | null>;
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
  noRetry(): void;
}

interface ExportedHandler<E> {
  fetch?(request: Request, env: E, ctx: ExecutionContext): Response | Promise<Response>;
  scheduled?(controller: ScheduledController, env: E, ctx: ExecutionContext): void | Promise<void>;
}

declare namespace Cloudflare {
  interface Env {
    WEBSITE: KVNamespace;
    STATUS_URL: string;
  }
}

declare module 'cloudflare:workers' {
  export const env: Cloudflare.Env;
}

/** The runtime's streaming HTML rewriter, as much of it as the page's hour takes. */
interface HTMLRewriterElement {
  readonly tagName: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): HTMLRewriterElement;
}

interface HTMLRewriterText {
  readonly text: string;
  readonly lastInTextNode: boolean;
}

interface HTMLRewriterHandlers {
  element?(element: HTMLRewriterElement): void | Promise<void>;
  text?(text: HTMLRewriterText): void | Promise<void>;
}

declare class HTMLRewriter {
  on(selector: string, handlers: HTMLRewriterHandlers): HTMLRewriter;
  transform(response: Response): Response;
}
