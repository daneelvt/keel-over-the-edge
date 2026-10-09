// SPDX-License-Identifier: AGPL-3.0-only

// The net worker's work: the game connection's socket, its session, and
// what to do when it ends. Everything it touches outside itself (the
// socket, timers, the clock, the page, fetch, chance) is given to it, so
// the tests drive it with fakes; worker.ts gives it the real ones.

import type { FromWorker, HelloVersions, Status, ToWorker } from '../../net/messages';
import { afterClose } from './policy';
import { Session } from './session';

/** The part of a WebSocket the worker uses. */
export interface Socket {
  binaryType: BinaryType;
  readonly readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
}

export interface NetDeps {
  socket(url: string): Socket;
  post(m: FromWorker, transfer?: Transferable[]): void;
  /** GET /api/me's status, or 0 when it could not be asked. */
  me(): Promise<number>;
  now(): number;
  setTimeout(f: () => void, ms: number): number;
  clearTimeout(id: number): void;
  random(): number;
}

const OPEN = 1;

export class NetWorker {
  readonly #d: NetDeps;
  #session: Session | null = null;
  #url = '';
  #socket: Socket | null = null;
  #status: Status = 'stopped';
  #attempt = 0;
  #timer = -1;
  #wait = -1;
  #traffic = { bytesIn: 0, bytesOut: 0, messagesIn: 0, messagesOut: 0 };

  constructor(deps: NetDeps) {
    this.#d = deps;
  }

  get status(): Status {
    return this.#status;
  }

  /** A record from the page. */
  handle(m: ToWorker): void {
    switch (m.type) {
      case 'start':
        this.#url = m.url;
        this.#session = new Session(m.versions as HelloVersions);
        this.#connect();
        break;
      case 'input':
        if (this.#session?.welcomed) {
          this.#send(this.#session.input(this.#d.now(), m.seq, m.helm, m.sheet));
          this.#arm();
        }
        break;
      case 'frame':
        if (this.#session !== null) {
          this.#session.frameMs = Math.round(m.ms);
        }
        break;
      case 'wake':
        if (this.#status === 'waiting') {
          this.#d.clearTimeout(this.#wait);
          this.#connect();
        }
        break;
      case 'takeover':
        if (this.#status === 'replaced') {
          this.#attempt = 0;
          this.#connect();
        }
        break;
      case 'stop':
        this.#d.clearTimeout(this.#wait);
        this.#setStatus('stopped');
        this.#socket?.close(1000, 'the page is going');
        break;
    }
  }

  #setStatus(status: Status, waitMs = 0, reason = ''): void {
    this.#status = status;
    this.#d.post({ type: 'status', status, waitMs, reason });
  }

  #connect(): void {
    const s = this.#session;
    if (s === null) {
      return;
    }
    this.#setStatus('connecting');
    const ws = this.#d.socket(this.#url);
    ws.binaryType = 'arraybuffer';
    this.#socket = ws;
    let welcomed = false;
    ws.onopen = () => {
      for (const b of s.open(this.#d.now())) {
        this.#send(b);
      }
    };
    ws.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) {
        return;
      }
      this.#traffic.bytesIn += ev.data.byteLength;
      this.#traffic.messagesIn++;
      let r: ReturnType<Session['receive']>;
      try {
        r = s.receive(this.#d.now(), new Uint8Array(ev.data));
      } catch {
        ws.close(1003, 'unreadable');
        return;
      }
      switch (r.kind) {
        case 'welcome': {
          welcomed = true;
          this.#attempt = 0;
          const w = r.welcome;
          this.#d.post({
            type: 'welcome',
            boat: Number(w.boat),
            rejoined: w.rejoined,
            kind: w.kind,
            tick: Number(w.tick),
          });
          this.#d.post({ type: 'clock', clock: { ...s.clock.state } });
          this.#setStatus('sailing');
          break;
        }
        case 'snapshot':
          this.#d.post({ type: 'snapshot', data: ev.data }, [ev.data]);
          break;
        case 'pong':
          this.#d.post({ type: 'clock', clock: { ...s.clock.state } });
          this.#d.post({ type: 'traffic', ...this.#traffic });
          break;
      }
      this.#arm();
    };
    ws.onclose = (ev) => {
      if (this.#socket !== ws) {
        return;
      }
      this.#socket = null;
      this.#d.clearTimeout(this.#timer);
      this.#closed(ev.code || 1006, welcomed, ev.reason);
    };
  }

  #closed(code: number, welcomed: boolean, reason: string): void {
    if (this.#status === 'stopped') {
      return;
    }
    const plan = afterClose(code, this.#attempt, welcomed, () => this.#d.random());
    switch (plan.kind) {
      case 'stop':
        this.#setStatus('stopped');
        return;
      case 'replaced':
      case 'version':
      case 'removed':
        this.#setStatus(plan.kind, 0, reason);
        return;
      case 'check':
        this.#attempt++;
        this.#setStatus('waiting');
        void this.#d.me().then((status) => {
          if (this.#status !== 'waiting') {
            return;
          }
          if (status === 401) {
            this.#setStatus('signed-out');
          } else {
            this.#later(afterClose(1006, this.#attempt - 1, true, () => this.#d.random()));
          }
        });
        return;
      case 'wait':
        this.#attempt++;
        this.#later(plan);
    }
  }

  #later(plan: ReturnType<typeof afterClose>): void {
    const ms = plan.kind === 'wait' ? plan.ms : 0;
    this.#setStatus('waiting', ms);
    this.#wait = this.#d.setTimeout(() => this.#connect(), ms);
  }

  #send(b: Uint8Array<ArrayBuffer>): void {
    const ws = this.#socket;
    if (ws === null || ws.readyState !== OPEN) {
      return;
    }
    ws.send(b);
    this.#traffic.bytesOut += b.byteLength;
    this.#traffic.messagesOut++;
  }

  /** Sets the session's timer for its next deadline. */
  #arm(): void {
    const s = this.#session;
    this.#d.clearTimeout(this.#timer);
    if (s === null) {
      return;
    }
    const at = s.deadline();
    if (!Number.isFinite(at)) {
      return;
    }
    this.#timer = this.#d.setTimeout(
      () => {
        const { out, dead } = s.time(this.#d.now());
        if (dead) {
          // No Pong for 6 s: the connection is gone, whatever the socket says.
          const ws = this.#socket;
          this.#socket = null;
          ws?.close(4000, 'no pong');
          this.#closed(1006, true, '');
          return;
        }
        for (const b of out) {
          this.#send(b);
        }
        this.#arm();
      },
      Math.max(0, (at - this.#d.now()) / 1000),
    );
  }
}
