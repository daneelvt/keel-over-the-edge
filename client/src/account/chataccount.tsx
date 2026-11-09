// SPDX-License-Identifier: AGPL-3.0-only

// Chat on the account page: the switch "Chat with other players" (turned
// on, the age question first if it was never answered, and the card for a
// player of 13 to 17), the account's mutes and blocks with an end to each,
// and the page on chat and privacy. Loaded as the account page opens: the
// game's first download holds none of it.

import { useEffect, useState } from 'preact/hooks';
import {
  CHAT_HEADING,
  CHAT_SWITCH,
  CHAT_SWITCH_DETAIL,
  endTieText,
  NO_TIES,
  PRIVACY_PAGE,
  PRIVACY_TITLE,
  READING_TIES,
  TIES_TITLE,
  tieKindText,
} from '../ui/chatwords';
import { type ChatServer, type ChatSetting, chatServer, type Tie } from './chatapi';
import { ChatTurnOn } from './chatcard';
import { reasonText } from './reasons';

/** The switch, and turning chat on when it is switched on. */
export function ChatSwitch({ server }: { server: ChatServer }) {
  const [setting, setSetting] = useState<ChatSetting | null>(null);
  const [turning, setTurning] = useState(false);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    let live = true;
    void server.read().then((s) => {
      if (live) {
        setSetting(s);
        if (s === null) {
          setProblem(reasonText('unavailable'));
        }
      }
    });
    return () => {
      live = false;
    };
  }, []);
  const set = async (on: boolean) => {
    setProblem('');
    if (on) {
      setTurning(true);
      return;
    }
    const was = setting;
    setSetting((s) => (s === null ? s : { ...s, on: false }));
    const r = await server.set(false);
    if (r !== 'ok') {
      setSetting(was);
      setProblem(reasonText(r));
    }
  };
  if (turning) {
    return (
      <ChatTurnOn
        server={server}
        done={(on) => {
          setTurning(false);
          setSetting((s) => (s === null ? s : { ...s, on, asked: true }));
        }}
      />
    );
  }
  return (
    <div class="chat-switch">
      <label class="chat-switch-row">
        <span>
          {CHAT_SWITCH}
          <span class="account-faint chat-switch-detail">{CHAT_SWITCH_DETAIL}</span>
        </span>
        <input
          type="checkbox"
          name="chat"
          checked={setting?.on === true}
          disabled={setting === null}
          onChange={(e) => void set(e.currentTarget.checked)}
        />
      </label>
      {problem !== '' ? (
        <p class="account-faint" aria-live="polite">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/** The account's mutes and blocks, each with its end. */
export function TiesList({ server }: { server: ChatServer }) {
  const [ties, setTies] = useState<Tie[] | null>(null);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    let live = true;
    void server.ties().then((t) => {
      if (live) {
        setTies(t);
        if (t === null) {
          setProblem(reasonText('unavailable'));
        }
      }
    });
    return () => {
      live = false;
    };
  }, []);
  const end = async (t: Tie) => {
    setProblem('');
    if (await server.untie(t)) {
      setTies((all) => all?.filter((x) => x !== t) ?? null);
    } else {
      setProblem(reasonText('unavailable'));
    }
  };
  return (
    <>
      <h3>{TIES_TITLE}</h3>
      {ties === null ? (
        <p class="account-faint">{problem || READING_TIES}</p>
      ) : ties.length === 0 ? (
        <p class="account-faint">{NO_TIES}</p>
      ) : (
        <ul class="account-passkeys chat-ties">
          {ties.map((t) => (
            <li key={`${t.kind}-${t.id}`}>
              <span class="account-passkey">
                <bdi class="player-text">{t.name}</bdi>
                <span class="account-faint"> · {tieKindText(t.kind)}</span>
              </span>
              <button type="button" onClick={() => void end(t)}>
                {endTieText(t.kind)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {ties !== null && problem !== '' ? (
        <p class="account-faint" aria-live="polite">
          {problem}
        </p>
      ) : null}
    </>
  );
}

/** Chat's part of the account page. */
export function ChatAccount({ server = chatServer() }: { server?: ChatServer }) {
  return (
    <>
      <h3>{CHAT_HEADING}</h3>
      <ChatSwitch server={server} />
      <TiesList server={server} />
      <p class="account-faint chat-privacy">
        <a href={PRIVACY_PAGE} target="_blank" rel="noopener">
          {PRIVACY_TITLE}
        </a>
      </p>
    </>
  );
}
