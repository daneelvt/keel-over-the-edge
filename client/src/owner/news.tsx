// SPDX-License-Identifier: AGPL-3.0-only

// The world page's News tab: the day's edition as the owner reads it,
// every name shown, read again every 10 s while the tab is shown; each
// story with Strike, which hides it for everyone, and a story struck with
// Put back. Earlier days are a tap away. What players wrote, names and
// boats, is shown as text, never as markup.

import { useEffect, useReducer, useState } from 'preact/hooks';
import { type Edition, type NewsStory, storyText } from '../ui/newswords';
import { getJSON } from './api';
import { hidden } from './life';
import type { Act } from './lifecycle';

/** How often the day's news is read again, ms. */
export const NEWS_EVERY = 10_000;

/** A story as the owner reads it, with the owner's hand on it. */
function StoryRow({ s, act, done }: { s: NewsStory; act: Act; done: () => void }) {
  return (
    <tr data-story={s.id} class={s.struck === true ? 'struck' : ''}>
      <td>{s.kind}</td>
      <td>
        <strong>{s.head}.</strong> {storyText(s)}
      </td>
      <td>
        <button
          type="button"
          name={s.struck === true ? 'unstrike' : 'strike'}
          onClick={() =>
            void act(
              'news/strike',
              { id: s.id, struck: s.struck !== true },
              s.struck === true
                ? `${s.head} put back in the news`
                : `${s.head} struck from the news`,
            ).then(done)
          }
        >
          {s.struck === true ? 'Put back' : 'Strike'}
        </button>
      </td>
    </tr>
  );
}

/** The News tab. */
export function NewsTab({ shown, act }: { shown: boolean; act: Act }) {
  const [day, setDay] = useState('');
  const [edition, setEdition] = useState<Edition | null>(null);
  const [why, setWhy] = useState('');
  const [reads, readAgain] = useReducer((n: number): number => n + 1, 0);
  useEffect(() => {
    if (!shown) {
      return;
    }
    let live = true;
    const read = (): void => {
      if (hidden()) {
        return;
      }
      getJSON<Edition>(`news.json${day === '' ? '' : `?day=${day}`}`)
        .then((e) => {
          if (live) {
            setEdition(e);
            setWhy('');
          }
        })
        .catch((err: unknown) => {
          if (live) {
            setWhy(String(err));
          }
        });
    };
    read();
    const t = setInterval(read, NEWS_EVERY);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [shown, day, reads]);
  if (!shown) {
    return null;
  }
  const e = edition;
  return (
    <main class="news-tab">
      <section class="card" aria-label="The news">
        <h2>
          The news{e === null ? '' : `, No. ${e.number} · ${e.day}${e.set ? ', set' : ', filling'}`}
        </h2>
        {why !== '' ? <p class="small error">{why}</p> : null}
        {e === null ? null : (
          <>
            <p data-field="news-figures">{e.figuresText}</p>
            <nav class="tabs" aria-label="Which day">
              {e.days.map((d) => (
                <button
                  key={d.day}
                  type="button"
                  aria-pressed={d.day === e.day}
                  onClick={() => setDay(d.day)}
                >
                  No. {d.number}
                </button>
              ))}
            </nav>
            <table class="news">
              <tbody>
                {[...e.lead, ...e.stories].map((s) => (
                  <StoryRow key={s.id} s={s} act={act} done={() => readAgain(undefined)} />
                ))}
              </tbody>
            </table>
            {e.lead.length + e.stories.length === 0 ? <p class="small">No stories yet.</p> : null}
          </>
        )}
      </section>
    </main>
  );
}
