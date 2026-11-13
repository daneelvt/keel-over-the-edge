// SPDX-License-Identifier: AGPL-3.0-only

// An account's log on its card: its record over every world and who may
// read it; and, opened, a world's days, every name in them shown, as the
// owner reads every log.

import { useState } from 'preact/hooks';
import { getLog, type OwnerLog } from './api';
import { entryWords, recordWords, shownWords, voyageWords } from './logwords';

/** The log's part of an account's card. */
export function LogPart({ id, log }: { id: string; log: OwnerLog }) {
  const [open, setOpen] = useState<OwnerLog | null>(null);
  const [why, setWhy] = useState('');
  const read = (world: number): void => {
    getLog(id, world)
      .then((l) => {
        setOpen(l);
        setWhy('');
      })
      .catch((e: unknown) => setWhy(String(e)));
  };
  return (
    <div class="log">
      <p data-field="card-log-record">{recordWords(log)}</p>
      <p class="small" data-field="card-log-shown">
        Read by {shownWords(log)}
      </p>
      {open === null ? (
        <button type="button" name="open-log" onClick={() => read(0)}>
          Open the log
        </button>
      ) : (
        <button type="button" name="close-log" onClick={() => setOpen(null)}>
          Close the log
        </button>
      )}
      {why !== '' ? <p class="small error">{why}</p> : null}
      {open !== null ? <LogDays log={open} read={read} /> : null}
    </div>
  );
}

/** A world's days of a log, the newest first, and the log's other worlds to open. */
function LogDays({ log, read }: { log: OwnerLog; read: (world: number) => void }) {
  if (log.world === null) {
    return <p class="small">Not yet to sea.</p>;
  }
  return (
    <div data-field="log-days">
      <p class="small">
        World {log.world.number}, days in {log.zone}.{' '}
        {log.worlds
          .filter((w) => w.number !== log.world?.number)
          .map((w) => (
            <button key={w.number} type="button" class="link" onClick={() => read(w.number)}>
              World {w.number}
            </button>
          ))}
      </p>
      {log.world.days.map((d) => (
        <section key={d.date} class="log-day">
          <h4>
            {d.date} · {(d.runM / 1852).toFixed(1)} NM
          </h4>
          <ul class="plain">
            {d.voyages.map((v) => (
              <li key={`v${v.began}-${v.ended}-${v.boat}`}>{voyageWords(v)}</li>
            ))}
            {d.entries.map((e, i) => (
              <li key={`e${e.at}-${i}`} class="small">
                {entryWords(e)}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
