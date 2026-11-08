// SPDX-License-Identifier: AGPL-3.0-only

// Links to come aboard on the world page's Accounts tab: how long a
// skipper's link lasts, set in minutes, hours or days, and links and
// boarding switched on or off for everyone; and chat's switches beside
// them, as one group: chat for everyone, shipmates' messages, spectators
// reading machine sailors' chat, each with its state and its key, then the
// countries where chat is off. Each change is first checked, then
// confirmed in the card with what it would do and how many live links it
// ends, so that no stray click cuts every crew off or silences everyone.

import { useEffect, useState } from 'preact/hooks';
import { control, getJSON, type SailSettings, type SettingsAnswer } from './api';
import type { Act } from './lifecycle';
import { plural } from './machines';
import { countriesOf, countriesWords } from './reportwords';

/** The link lifetime's bounds, s, as keel holds them. */
export const MIN_LINK_LIFETIME = 300;
export const MAX_LINK_LIFETIME = 7 * 86_400;

/** The units a link lifetime is set in, s. */
const UNITS = { minutes: 60, hours: 3600, days: 86_400 } as const;
type Unit = keyof typeof UNITS;

/**
 * A link lifetime in words: whole days from two days up, else hours and
 * minutes: "24 hours", "2 days", "1 hour 30 minutes", "5 minutes".
 */
export function linkLifetimeWords(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s >= 2 * 86_400 && s % 86_400 === 0) {
    return plural(s / 86_400, 'day');
  }
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(plural(hours, 'hour'));
  }
  if (minutes > 0) {
    parts.push(plural(minutes, 'minute'));
  }
  if (rest > 0 || parts.length === 0) {
    parts.push(plural(rest, 'second'));
  }
  return parts.join(' ');
}

/** A switch's state in words. */
export function onOff(on: boolean): string {
  return on ? 'on' : 'off';
}

/** The seconds an amount and unit come to, or 0 while the amount is not a whole number. */
export function lifetimeOf(amount: string, unit: Unit): number {
  const n = Number(amount);
  return amount.trim() !== '' && Number.isInteger(n) && n > 0 ? n * UNITS[unit] : 0;
}

/** Whether a link lifetime is one keel takes. */
export function lifetimeAllowed(seconds: number): boolean {
  return seconds >= MIN_LINK_LIFETIME && seconds <= MAX_LINK_LIFETIME;
}

/** Whether a change reaches links, so that the links it ends are told. */
export function touchesLinks(body: Partial<SailSettings>): boolean {
  return body.linkLifetime !== undefined || body.links !== undefined;
}

/** The question a change asks before keel's words, or "": chat off asks plainly. */
export function changeQuestion(body: Partial<SailSettings>): string {
  return body.chat === false ? 'Chat off for everyone? Every line stops at once.' : '';
}

/** One of chat's switches for everyone, as the group shows it: its name, its field, whether it is on, and the change its key asks. */
export interface ChatSwitch {
  field: string;
  name: string;
  on: boolean;
  key: string;
  body: Partial<SailSettings>;
  what: string;
}

/** Chat's switches for everyone, in the group's order: chat, shipmates' messages, spectators' reading. */
export function chatSwitches(s: SailSettings): ChatSwitch[] {
  return [
    {
      field: 'chat',
      name: 'Chat for everyone',
      on: s.chat,
      key: s.chat ? 'Switch chat off' : 'Switch chat on',
      body: { chat: !s.chat },
      what: `chat switched ${onOff(!s.chat)} for everyone`,
    },
    {
      field: 'shipmate-messages',
      name: "Shipmates' messages",
      on: s.shipmateMessages,
      key: s.shipmateMessages ? "Switch shipmates' messages off" : "Switch shipmates' messages on",
      body: { shipmateMessages: !s.shipmateMessages },
      what: `shipmates' messages switched ${onOff(!s.shipmateMessages)} for everyone`,
    },
    {
      field: 'spectator-chat',
      name: "Spectators read machine sailors' chat",
      on: s.spectatorChat,
      key: s.spectatorChat ? "Switch spectators' reading off" : "Switch spectators' reading on",
      body: { spectatorChat: !s.spectatorChat },
      what: `spectators reading machine sailors' chat switched ${onOff(!s.spectatorChat)} for everyone`,
    },
  ];
}

/** A change asked for, and what its check answered. */
interface Asked {
  body: Partial<SailSettings>;
  what: string;
  answer: SettingsAnswer;
}

/**
 * The owner's hand on links to come aboard. Each change is checked with
 * check: true and made only once its confirmation is confirmed; one left
 * open is closed when the figure is changed.
 */
export function SailWithSettings({ act }: { act: Act }) {
  const [settings, setSettings] = useState<SailSettings | null>(null);
  const [amount, setAmount] = useState('');
  const [unit, setUnit] = useState<Unit>('hours');
  const [countries, setCountries] = useState('');
  const [asked, setAsked] = useState<Asked | null>(null);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [why, setWhy] = useState('');

  const read = (): void => {
    void getJSON<SailSettings>('settings.json')
      .then(setSettings)
      .catch((e: unknown) => setWhy(`Failed: ${String(e)}`));
  };
  useEffect(read, []);

  if (settings === null) {
    return (
      <section class="card sail-with" aria-label="Links to come aboard">
        <h2>Links to come aboard</h2>
        <p class="small">{why === '' ? '—' : why}</p>
      </section>
    );
  }

  const seconds = lifetimeOf(amount, unit);
  const outOfBounds = seconds !== 0 && !lifetimeAllowed(seconds);
  const typedCountries = countriesOf(countries);

  const check = (body: Partial<SailSettings>, what: string): void => {
    setChecking(true);
    setWhy('');
    setAsked(null);
    void control('settings', { ...body, check: true })
      .then((a) => {
        if (!a.ok) {
          setWhy(`Refused (${a.status}): ${a.text}`);
          return;
        }
        setAsked({ body, what, answer: JSON.parse(a.text) as SettingsAnswer });
      })
      .catch((e: unknown) => setWhy(`Failed: ${String(e)}`))
      .finally(() => setChecking(false));
  };

  const confirm = (c: Asked): void => {
    setSending(true);
    void act('settings', c.body, c.what).then((ok) => {
      setSending(false);
      setAsked(null);
      if (ok) {
        setAmount('');
        if (c.body.chatCountries !== undefined) {
          setCountries('');
        }
      }
      read();
    });
  };

  return (
    <section class="card sail-with" aria-label="Links to come aboard">
      <h2>Links to come aboard</h2>
      <dl>
        <dt>Link lifetime</dt>
        <dd data-field="link-lifetime">{linkLifetimeWords(settings.linkLifetime)}</dd>
        <dt>Links</dt>
        <dd data-field="links">{onOff(settings.links)}</dd>
        <dt>Boarding</dt>
        <dd data-field="boarding">{onOff(settings.boarding)}</dd>
      </dl>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          check(
            { linkLifetime: seconds },
            `the link lifetime set to ${linkLifetimeWords(seconds)}`,
          );
        }}
      >
        <input
          type="number"
          name="link-lifetime"
          min={1}
          step={1}
          aria-label="The link lifetime"
          value={amount}
          onInput={(e) => {
            setAmount(e.currentTarget.value);
            setAsked(null);
          }}
        />
        <select
          name="link-lifetime-unit"
          value={unit}
          onChange={(e) => {
            setUnit(e.currentTarget.value as Unit);
            setAsked(null);
          }}
        >
          {Object.keys(UNITS).map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
        <button
          type="submit"
          name="set-link-lifetime"
          disabled={seconds === 0 || outOfBounds || checking}
        >
          Set the link lifetime
        </button>
      </form>
      {outOfBounds ? (
        <p class="small" data-field="link-lifetime-why">
          A link lasts from 5 minutes to 7 days.
        </p>
      ) : null}
      <p>
        <button
          type="button"
          name="links"
          disabled={checking}
          onClick={() =>
            check(
              { links: !settings.links },
              `links switched ${onOff(!settings.links)} for everyone`,
            )
          }
        >
          {settings.links ? 'Switch links off' : 'Switch links on'}
        </button>{' '}
        <button
          type="button"
          name="boarding"
          disabled={checking}
          onClick={() =>
            check(
              { boarding: !settings.boarding },
              `boarding switched ${onOff(!settings.boarding)} for everyone`,
            )
          }
        >
          {settings.boarding ? 'Switch boarding off' : 'Switch boarding on'}
        </button>
      </p>
      <section class="chat-switches" aria-label="Chat" data-field="chat-switches">
        <h3>Chat</h3>
        {chatSwitches(settings).map((s) => (
          <div class="switch-row" key={s.field} data-switch={s.field}>
            <span class="switch-name">{s.name}</span>
            <span class={`switch-state ${s.on ? 'on' : 'off'}`} data-field={s.field}>
              {onOff(s.on)}
            </span>
            <button
              type="button"
              name={s.field}
              class={s.field === 'chat' && s.on ? 'danger' : ''}
              disabled={checking}
              onClick={() => check(s.body, s.what)}
            >
              {s.key}
            </button>
          </div>
        ))}
        <div class="switch-row" data-switch="chat-countries">
          <span class="switch-name">Chat off in</span>
          <span class="switch-state wide" data-field="chat-countries">
            {countriesWords(settings.chatCountries)}
          </span>
        </div>
      </section>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const codes = typedCountries.codes;
          check(
            { chatCountries: codes },
            codes.length === 0 ? 'chat off in no country' : `chat off in ${codes.join(', ')}`,
          );
        }}
      >
        <input
          type="text"
          name="chat-countries"
          autocomplete="off"
          spellcheck={false}
          placeholder="BR, AU; nothing for none"
          aria-label="The countries where chat is off, two letters each, comma separated"
          value={countries}
          onInput={(e) => {
            setCountries(e.currentTarget.value);
            setAsked(null);
          }}
        />
        <button type="submit" name="set-chat-countries" disabled={!typedCountries.ok || checking}>
          Set the countries
        </button>
      </form>
      {!typedCountries.ok ? (
        <p class="small" data-field="chat-countries-why">
          Two letters each, as ISO 3166 has them, comma separated: BR, AU.
        </p>
      ) : null}
      {why !== '' ? <p class="small error">{why}</p> : null}
      {asked !== null ? (
        <div class="confirm" data-field="settings-confirmation">
          {changeQuestion(asked.body) !== '' ? (
            <p>
              <strong data-field="settings-question">{changeQuestion(asked.body)}</strong>
            </p>
          ) : null}
          <p>
            {asked.answer.words}{' '}
            {!touchesLinks(asked.body) ? null : asked.answer.ended > 0 ? (
              <strong data-field="settings-ends">
                It ends {plural(asked.answer.ended, 'live link')} at once.
              </strong>
            ) : (
              <span data-field="settings-ends">It ends no link now.</span>
            )}
          </p>
          <button type="button" name="confirm" disabled={sending} onClick={() => confirm(asked)}>
            Confirm
          </button>{' '}
          <button type="button" name="cancel" onClick={() => setAsked(null)}>
            Cancel
          </button>
        </div>
      ) : null}
    </section>
  );
}
