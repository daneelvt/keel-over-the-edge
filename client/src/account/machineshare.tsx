// SPDX-License-Identifier: AGPL-3.0-only

// On the start screen, a machine sailor's row at sea: "Sail with me" for
// it, its link to share, as the skipper's own is shared (sailwithme.tsx),
// which another player opens to send a machine sailor of theirs aboard;
// and, while it is crew aboard another's boat, Call ashore.

import { useState } from 'preact/hooks';
import { reasonText } from '../account/reasons';
import {
  COPIED,
  COPY,
  endsText,
  LINK_NOT_HERE,
  LINKS_OFF,
  NEW_LINK,
  NO_LINK,
  READING_LINK,
} from '../ui/deckwords';
import { CALL_ASHORE, callAshoreText, sailWithMeFor } from '../ui/machinewords';
import {
  keepLink,
  keptLink,
  type LinkServer,
  type LinkShown,
  linkServer,
  madeProblem,
  shownLink,
} from '../ui/sailwithme';
import type { Fetch } from './me';
import { call } from './passkeys';

/** A machine sailor's share, opened from its row: its link, made, copied or ended. */
export function MachineShare({
  name,
  id,
  aboard,
  from,
  f = (input, init) => fetch(input, init),
}: {
  name: string;
  id: string;
  /** Crew aboard another's boat: it may be called ashore. */
  aboard: boolean;
  from?: LinkServer;
  f?: Fetch;
}) {
  const [server] = useState(() => from ?? linkServer(f, name));
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<LinkShown>({ kind: 'reading' });
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [called, setCalled] = useState(false);
  const key = `machine:${name}`;

  const show = async () => {
    setOpen(true);
    const s = shownLink(await server.status(), keptLink(key), Date.now());
    if (s.forget) {
      keepLink(key, null);
    }
    setShown(s.shown);
  };
  const make = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setProblem('');
    const m = await server.make();
    if ('link' in m) {
      keepLink(key, m.link);
      setShown({ kind: 'here', link: m.link });
      setCopied(false);
    } else {
      setProblem(
        m.error === 'born' || m.error === 'rules' ? reasonText(m.error) : madeProblem(m.error),
      );
    }
    setBusy(false);
  };
  const end = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    if (await server.end()) {
      keepLink(key, null);
      setShown({ kind: 'none', ended: true });
    } else {
      setProblem(reasonText('unavailable'));
    }
    setBusy(false);
  };
  const ashore = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    const a = await call(f, '/api/sail/ashore', { machine: id });
    setCalled(a.status === 204);
    setBusy(false);
  };

  const link = shown.kind === 'here' ? shown.link : null;
  return (
    <span class="machine-share">
      {aboard && !called ? (
        <button
          type="button"
          class="start-sign-in"
          disabled={busy}
          aria-label={callAshoreText(name)}
          onClick={() => void ashore()}
        >
          {CALL_ASHORE}
        </button>
      ) : null}
      {open ? null : (
        <button type="button" class="start-sign-in" onClick={() => void show()}>
          {sailWithMeFor(name)}
        </button>
      )}
      {open ? (
        <span class="machine-share-link" data-readout="machine-link">
          {shown.kind === 'reading' ? <span class="start-text">{READING_LINK}</span> : null}
          {shown.kind === 'none' || shown.kind === 'unread' ? (
            <span class="start-text start-faint">{NO_LINK}</span>
          ) : null}
          {shown.kind === 'elsewhere' ? (
            <span class="start-text start-faint">{LINK_NOT_HERE}</span>
          ) : null}
          {link !== null ? (
            <>
              <input
                class="machine-share-url"
                type="text"
                name="machine-link"
                readOnly
                aria-label={sailWithMeFor(name)}
                value={link.url}
                onFocus={(e) => e.currentTarget.select()}
              />
              <span class="machine-faint">{endsText(link.expires, Date.now())}</span>
              <button
                type="button"
                class="start-sign-in"
                onClick={() =>
                  void navigator.clipboard.writeText(link.url).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  )
                }
              >
                {copied ? COPIED : COPY}
              </button>
            </>
          ) : null}
          {shown.kind !== 'reading' ? (
            <button type="button" class="start-sign-in" disabled={busy} onClick={() => void make()}>
              {NEW_LINK}
            </button>
          ) : null}
          {shown.kind === 'here' || shown.kind === 'elsewhere' ? (
            <button type="button" class="start-sign-in" disabled={busy} onClick={() => void end()}>
              {LINKS_OFF}
            </button>
          ) : null}
          {problem !== '' ? (
            <span class="start-text" role="status">
              {problem}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
