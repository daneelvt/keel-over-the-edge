// SPDX-License-Identifier: AGPL-3.0-only

// The start screen, over the loading sea. A new player makes a sailor: a
// name, a look drawn at random from the catalog (drawn again on asking),
// and Set sail, which makes the sailor's passkey with the browser's own
// prompt and the account with it; then the recovery code, shown once, and
// a choice: Set sail, or make a machine sailor first (one an AI app of
// theirs sails), connect it, and set sail from the start screen with
// machine sailors. A returning player signs in beside it: the browser offers the passkeys it
// holds as the name field is touched (autofill, held open from the start),
// or "Sign in with a passkey" opens the browser's prompt, which reaches a
// passkey on another device by its QR code. "Lost your passkey?" takes the
// recovery code. Every way to sea ends at the player's own sailor and its
// Set sail, with whether others may watch the voyage: beside the machine
// sailors for one who has any, alone for one who has none.
//
// A browser that has had a sailor (the server's mark, told in the session
// check's answer) opens on the same panel the other way round: Welcome
// back, signing in first, and New sailor second, which opens the form.
// The form runs the human check while the player chooses (humancheck.ts),
// and Set sail waits for it.
//
// The page checks only the name's length; the server applies the rest and
// says why it refuses, which is shown in words beside the field. A prompt
// the player closes says nothing and leaves the form as it was. A browser
// that cannot make a passkey is told so before anything is asked.

import './start.css';
import { type JSX, render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { drawLook, type Looks } from '../catalog/looks';
import { loadRaces, type RacesView } from '../ui/raceslazy';
import { MAKE_TO_RACE, SIGN_IN_TO_RACE } from '../ui/racewords';
import { UpdateLine } from '../ui/updateline';
import { useWatch } from '../ui/watchlazy';
import { type ListLink, MAKE_TO_WATCH, SIGN_IN_TO_WATCH } from '../ui/watchwords';
import { BoatChooser } from './boatchooser';
import { LookChooser } from './chooser';
import { AgeQuestion, BornFields } from './firstasks';
import { bornOf, CANT_BE_MADE, youngCookie } from './firstwords';
import type { BoatCatalog } from './fleet';
import { NewSailorCheck } from './humancheck';
import { type InApp, passkeySupport, type Support } from './inapp';
import { useMachines } from './lazy';
import { type Voyage, voyage } from './letwatch';
import type { LookStage } from './lookstage';
import { checkSession, type Fetch, type HumanCheck, type Me } from './me';
import {
  codeForm,
  makeSailor,
  type Outcome,
  publicKeyCredential,
  type Reach,
  type SignedIn,
  signIn,
  useRecoveryCode,
} from './passkeys';
import { chosen, Picker, type PickerState, StageFront, shuffled, undone } from './picker';
import {
  CHECK_FAILED,
  CHECKING,
  lengthProblem,
  MAX_NAME,
  reasonText,
  TAKEN_SIGN_IN,
} from './reasons';
import { AddPasskey, RecoveredNotice, RecoveryCode, SetSailOrMake } from './recovery';
import { TakeOut } from './takeout';
import { YourSailor } from './yoursailor';

export interface StartProps {
  /** The catalog's looks, a new sailor's chosen from. */
  looks: Looks;
  /** The picker's stage, which draws the sailor behind the form; none on a page that draws nothing. */
  stage?: LookStage;
  /** The catalog's boats and their looks, the player's boat chosen from the fleet with; none for no choice. */
  boats?: BoatCatalog;
  done: (me: Me) => void;
  /** Whether a sailor signed in is shown their own before the sea: not one come by a link. */
  panel?: boolean;
  /**
   * Whether a sailor made goes on once its recovery code is shown, with no
   * choice of making a machine sailor first: one come by a link to come aboard.
   */
  straight?: boolean;
  /** Whether the page was opened at a link to watch: the visitor is told they will be watching once they make a sailor. */
  watching?: boolean;
  /** Whether the page was opened at a race's link: the visitor is told they can enter it once they make a sailor. */
  racing?: boolean;
  /** Races ashore: Make a race beside Set sail on the player's own panel; none for no key. */
  races?: RacesView;
  random?: () => number;
  /** The server and the browser's prompt; the browser's own unless a test stands in. */
  reach?: Reach;
  /** Whether this browser has had a sailor: signing in is offered first. */
  sailed?: boolean;
  /** The human check a new sailor passes; none, or null, for none. */
  check?: HumanCheck | null;
}

/** The returning browser's panel: its title, and the key that opens the new-sailor form. */
export const WELCOME_BACK = 'Welcome back';
export const NEW_HERE = 'New here?';
export const NEW_SAILOR = 'New sailor';

/** The returning browser's panel: signing in first, the new-sailor form second. */
export function WelcomeBack({
  lines,
  warning,
  field,
  problem,
  busy,
  signIn,
  lost,
  newSailor,
}: {
  /** What a link the page was opened at says, at the panel's head. */
  lines: JSX.Element | null;
  /** The browser's own warning about passkeys, if any. */
  warning: JSX.Element | null;
  /** The name field, where the browser offers the passkeys it holds. */
  field: JSX.Element;
  problem: string;
  busy: boolean;
  signIn: () => void;
  lost: () => void;
  newSailor: () => void;
}) {
  return (
    <form
      key="welcome"
      class="start-panel start-welcome"
      onSubmit={(e) => {
        e.preventDefault();
        signIn();
      }}
      aria-labelledby="start-title"
      noValidate
    >
      <h1 id="start-title">{WELCOME_BACK}</h1>
      {lines}
      {warning}
      {field}
      <p id="start-problem" class="start-problem" aria-live="polite">
        {problem}
      </p>
      <button type="submit" class="start-go" disabled={busy}>
        Sign in with a passkey
      </button>
      <p class="start-text start-faint" aria-live="polite">
        {busy ? 'Choose your passkey.' : 'Your passkey: your phone’s face, fingerprint or PIN.'}
      </p>
      <button type="button" class="start-link" onClick={lost}>
        Lost your passkey? Use your recovery code
      </button>
      <div class="start-or">
        <span>{NEW_HERE}</span>
        <button type="button" class="start-sign-in" disabled={busy} onClick={newSailor}>
          {NEW_SAILOR}
        </button>
      </div>
    </form>
  );
}

/** Whether a failed ceremony is passed over in silence: the prompt closed, or autofill turned down. */
export function quiet(reason: string, autofill: boolean): boolean {
  if (reason === 'cancelled') {
    return true;
  }
  // An autofill request the browser refuses at once (it holds no passkey
  // of ours, or offers none) is no failure of the player's; a passkey
  // chosen and refused is, and so is the sailor of one chosen stopped.
  return autofill && reason !== 'unknown-passkey' && reason !== 'refused' && reason !== 'stopped';
}

type View =
  | { kind: 'form' }
  | { kind: 'recover' }
  | { kind: 'code'; me: Me; code: string }
  | { kind: 'choose'; me: Me; voyage: Voyage }
  | { kind: 'sailor'; me: Me; first: boolean; voyage: Voyage }
  | { kind: 'recovered'; me: Me; at: number }
  | { kind: 'add-passkey'; me: Me };

export function StartScreen({
  looks,
  boats,
  done,
  random,
  reach,
  stage,
  panel = true,
  straight = false,
  watching = false,
  racing = false,
  races,
  sailed = false,
  check = null,
}: StartProps) {
  const [view, setView] = useState<View>({ kind: 'form' });
  // A returning browser's panel, until New sailor opens the form.
  const [welcome, setWelcome] = useState(sailed);
  const [support, setSupport] = useState<Support | null>(null);
  const [anyway, setAnyway] = useState(false);
  const [name, setName] = useState('');
  // When the player was born: both boxes empty to start.
  const [month, setMonth] = useState('');
  const [year, setYear] = useState('');
  // A sailor that can't be made, now or by this browser's earlier answer:
  // the same answer, and signing in still offered.
  const [young, setYoung] = useState(() =>
    typeof document === 'undefined' ? false : youngCookie(document.cookie),
  );
  // The look drawn at random on arrival, chosen in the picker.
  const [pick, setPick] = useState<PickerState>(() => chosen(drawLook(looks, random)));
  const look = pick.look;
  const [problem, setProblem] = useState('');
  const [taken, setTaken] = useState(false);
  // Too many new sailors from this connection: signing in offered beside the line.
  const [often, setOften] = useState(false);
  const [busy, setBusy] = useState<'' | 'check' | 'create' | 'sign-in' | 'code'>('');
  // The human check, run while the new-sailor form shows; its widget's slot.
  const human = useMemo(() => (check === null ? null : new NewSailorCheck(check)), []);
  const slot = useRef<HTMLDivElement>(null);
  const [code, setCode] = useState('');
  const autofill = useRef<AbortController | null>(null);

  useEffect(() => {
    let live = true;
    void passkeySupport({
      userAgent: navigator.userAgent,
      pkc: reach !== undefined ? reach.pkc : publicKeyCredential(),
    }).then((s) => {
      if (live) {
        setSupport(s);
      }
    });
    return () => {
      live = false;
    };
  }, [reach]);

  // To the player's own sailor and its Set sail; straight to the watch by a link.
  const onward = (me: Me) => {
    if (panel) {
      setView({ kind: 'sailor', me, first: false, voyage: voyage(me, reach?.fetch) });
    } else {
      done(me);
    }
  };

  // The sign-in's answer, and the recovery code's, do not say how many
  // machine sailors the account has, whether its boat is at sea, nor who
  // may watch it; the session's does.
  const fresh = async (me: Me): Promise<Me> => {
    const check = await checkSession(reach?.fetch);
    return check.kind === 'sailor' ? { ...me, ...check.me } : me;
  };

  const signedIn = async (s: SignedIn) => {
    const me = await fresh(s.me);
    if (s.recovered > 0) {
      setView({ kind: 'recovered', me, at: s.recovered });
    } else {
      onward(me);
    }
  };

  const stopAutofill = () => {
    autofill.current?.abort();
    autofill.current = null;
  };

  // The browser's offer of the passkeys it holds, as the name field is
  // touched: begun as the form shows, and again after any other ceremony
  // that did not sign in; aborted before another begins, as only one runs.
  const startAutofill = () => {
    stopAutofill();
    const pkc = reach !== undefined ? reach.pkc : publicKeyCredential();
    const available = pkc?.isConditionalMediationAvailable;
    if (available === undefined) {
      return;
    }
    const ctl = new AbortController();
    autofill.current = ctl;
    void available
      .call(pkc)
      .then(async (yes) => {
        if (!yes || ctl.signal.aborted) {
          return;
        }
        const res = await signIn(true, ctl.signal, reach);
        if (ctl.signal.aborted) {
          return;
        }
        if (res.ok) {
          await signedIn(res.value);
        } else if (!quiet(res.reason, true)) {
          setProblem(reasonText(res.reason));
        }
      })
      .catch(() => {
        // Autofill is offered, never relied on.
      });
  };

  const blocked = support?.kind === 'none' || (support?.kind === 'in-app' && !anyway);
  const formShown = view.kind === 'form' && support !== null && !blocked && !young;
  // The new-sailor form, the check's slot in it; not the returning browser's panel.
  const making = formShown && !welcome;
  // The picker's stage behind the form while it is shown, with its look;
  // the cover back over the page once it is not.
  const picking = view.kind === 'form' && !blocked && !young && !welcome;
  useEffect(() => {
    if (stage !== undefined && picking) {
      stage.show(look);
    }
  }, [stage, picking, look]);
  useEffect(() => {
    if (stage !== undefined && !picking) {
      stage.hide();
    }
  }, [stage, picking]);
  useEffect(() => () => stage?.hide(), [stage]);
  useEffect(() => {
    if (formShown) {
      startAutofill();
    }
    return stopAutofill;
  }, [formShown, welcome]);
  // The check's script loaded, and its widget run, only once the form shows.
  useEffect(() => {
    const el = slot.current;
    if (human === null || !making || el === null) {
      return;
    }
    void human.mount(el);
    return () => human.unmount();
  }, [making]);

  const failed = (res: Outcome<unknown>) => {
    if (!res.ok && !quiet(res.reason, false)) {
      setProblem(reasonText(res.reason));
      setTaken(res.reason === 'taken');
      setOften(res.reason === 'often');
    }
    startAutofill();
  };

  const clearProblem = () => {
    setProblem('');
    setTaken(false);
    setOften(false);
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy !== '') {
      return;
    }
    const tooShortOrLong = lengthProblem(name);
    if (tooShortOrLong !== null) {
      setProblem(reasonText(tooShortOrLong));
      setTaken(false);
      return;
    }
    const born = bornOf(month, year);
    if (born === null) {
      setProblem(reasonText('born'));
      setTaken(false);
      return;
    }
    stopAutofill();
    clearProblem();
    // The check's token, waited for if the widget has not given it yet.
    let token: string | null = null;
    if (human !== null) {
      setBusy('check');
      token = await human.token();
      if (token === null) {
        // The widget failed: its line says so, with Try again.
        setBusy('');
        startAutofill();
        return;
      }
    }
    setBusy('create');
    const res = await makeSailor(
      name,
      look,
      born,
      reach,
      human === null || token === null ? undefined : { token, answered: () => human.spent() },
    );
    setBusy('');
    if (res.ok) {
      setView({ kind: 'code', me: res.value.me, code: res.value.recoveryCode });
    } else if (res.reason === 'young') {
      setYoung(true);
    } else {
      failed(res);
    }
  };

  const signInNow = async () => {
    if (busy !== '') {
      return;
    }
    stopAutofill();
    setBusy('sign-in');
    clearProblem();
    const res = await signIn(false, undefined, reach);
    setBusy('');
    if (res.ok) {
      await signedIn(res.value);
    } else {
      failed(res);
    }
  };

  const recover = async (e: Event) => {
    e.preventDefault();
    if (busy !== '') {
      return;
    }
    setBusy('code');
    setProblem('');
    const res = await useRecoveryCode(code, reach);
    setBusy('');
    if (res.ok) {
      setView({ kind: 'add-passkey', me: res.value });
    } else {
      setProblem(reasonText(res.reason));
    }
  };

  switch (view.kind) {
    case 'code':
      return (
        <div class="start">
          <RecoveryCode
            code={view.code}
            name={view.me.name}
            done={() =>
              straight
                ? done(view.me)
                : setView({ kind: 'choose', me: view.me, voyage: voyage(view.me, reach?.fetch) })
            }
          />
        </div>
      );
    case 'choose':
      return (
        <div class="start">
          <SetSailOrMake
            name={view.me.name}
            voyage={view.voyage}
            sail={() => done(view.me)}
            make={() => setView({ kind: 'sailor', me: view.me, first: true, voyage: view.voyage })}
          />
        </div>
      );
    case 'sailor':
      return (
        <Sailor
          first={view.first}
          me={view.me}
          voyage={view.voyage}
          done={done}
          looks={looks}
          stage={stage}
          boats={boats}
          fetcher={reach?.fetch}
          races={races}
        />
      );
    case 'recovered':
      return (
        <div class="start">
          <RecoveredNotice at={view.at} done={() => onward(view.me)} />
        </div>
      );
    case 'add-passkey':
      return (
        <div class="start">
          <AddPasskey
            me={view.me}
            done={(me) => void fresh(me).then(onward)}
            {...(reach !== undefined ? { reach } : {})}
          />
        </div>
      );
    case 'recover':
      return (
        <div class="start">
          <form
            key="recover"
            class="start-panel"
            onSubmit={recover}
            aria-labelledby="start-title"
            noValidate
          >
            <h1 id="start-title">Lost your passkey?</h1>
            <p class="start-text">
              Your recovery code signs your sailor in once. Then you add a new passkey, and get a
              new code.
            </p>
            <label class="start-label" for="start-code">
              Recovery code
            </label>
            <input
              id="start-code"
              class="start-name start-code"
              name="code"
              type="text"
              autocomplete="one-time-code"
              autocapitalize="characters"
              maxLength={32}
              spellcheck={false}
              enterkeyhint="go"
              value={code}
              aria-invalid={problem !== ''}
              aria-describedby="start-problem"
              onInput={(e) => setCode(codeForm(e.currentTarget.value))}
            />
            <p id="start-problem" class="start-problem" aria-live="polite">
              {problem}
            </p>
            <button type="submit" class="start-go" disabled={busy !== ''}>
              Use the code
            </button>
            <p class="start-text start-faint">
              Without your passkey or recovery code we can’t tell the sailor is yours, so we can’t
              give it back. You can make a new sailor.
            </p>
            <button
              type="button"
              class="start-link"
              onClick={() => {
                setProblem('');
                setView({ kind: 'form' });
              }}
            >
              Back
            </button>
          </form>
        </div>
      );
  }

  if (blocked) {
    return (
      <div class="start">
        <OpenElsewhere
          app={support?.kind === 'in-app' ? support.app : null}
          tryAnyway={support?.kind === 'in-app' ? () => setAnyway(true) : null}
        />
      </div>
    );
  }

  if (young) {
    return (
      <div class="start">
        <section class="start-panel" aria-labelledby="start-title">
          <h1 id="start-title">Keel Over the Edge</h1>
          <p class="start-text" role="status" data-readout="cant-be-made">
            {CANT_BE_MADE}
          </p>
          <p class="start-problem" aria-live="polite">
            {problem}
          </p>
          <div class="start-or">
            <span>Sailed before?</span>
            <button
              type="button"
              class="start-sign-in"
              disabled={busy !== ''}
              onClick={() => void signInNow()}
            >
              Sign in with a passkey
            </button>
          </div>
        </section>
      </div>
    );
  }

  // What a link the page was opened at says, at the head of either panel.
  const lines =
    watching || racing ? (
      <>
        {watching ? (
          <p class="start-text start-watching" data-readout="make-to-watch">
            {welcome ? SIGN_IN_TO_WATCH : MAKE_TO_WATCH}
          </p>
        ) : null}
        {racing ? (
          <p class="start-text start-watching" data-readout="make-to-race">
            {welcome ? SIGN_IN_TO_RACE : MAKE_TO_RACE}
          </p>
        ) : null}
      </>
    ) : null;
  const warning =
    support?.kind === 'maybe' ? (
      <p class="start-warning" role="note">
        This browser may not be able to make a passkey. If Set sail fails, try your phone’s own
        browser.
      </p>
    ) : null;
  const field = (
    <>
      <label class="start-label" for="start-name">
        Your sailor’s name
      </label>
      <input
        id="start-name"
        class="start-name"
        name="name"
        type="text"
        autocomplete="username webauthn"
        autocapitalize="words"
        spellcheck={false}
        enterkeyhint="go"
        maxLength={MAX_NAME}
        placeholder={stage === undefined || welcome ? undefined : 'Your sailor’s name'}
        value={name}
        aria-invalid={problem !== ''}
        aria-describedby="start-problem"
        onInput={(e) => setName(e.currentTarget.value)}
      />
    </>
  );
  const toRecover = () => {
    stopAutofill();
    clearProblem();
    setView({ kind: 'recover' });
  };

  if (welcome) {
    return (
      <div class="start">
        <WelcomeBack
          lines={lines}
          warning={warning}
          field={field}
          problem={problem}
          busy={busy !== ''}
          signIn={() => void signInNow()}
          lost={toRecover}
          newSailor={() => {
            clearProblem();
            setWelcome(false);
          }}
        />
      </div>
    );
  }

  const checkFailed = human?.state.value === 'failed';
  const signInKey = (
    <button
      type="button"
      class="start-sign-in"
      disabled={busy !== ''}
      onClick={() => void signInNow()}
    >
      Sign in with a passkey
    </button>
  );

  return (
    <div class={stage === undefined ? 'start' : 'start picking'}>
      {stage === undefined ? null : <StageFront looks={looks} look={pick.look} stage={stage} />}
      <form
        key="start"
        class="start-panel"
        onSubmit={submit}
        aria-labelledby="start-title"
        noValidate
      >
        <h1 id="start-title">Keel Over the Edge</h1>
        {lines}
        {warning}
        {field}
        <BornFields
          id="start-born"
          month={month}
          year={year}
          setMonth={setMonth}
          setYear={setYear}
          invalid={problem === reasonText('born')}
          describedBy="start-problem"
        />
        <p id="start-problem" class="start-problem" aria-live="polite">
          {checkFailed && problem === '' ? CHECK_FAILED : problem}
          {taken ? ` ${TAKEN_SIGN_IN}` : null}
        </p>
        {checkFailed && problem === '' ? (
          <button type="button" class="start-sign-in start-again" onClick={() => human?.retry()}>
            Try again
          </button>
        ) : null}
        {often ? signInKey : null}
        <Picker
          looks={looks}
          look={pick.look}
          choose={(l) => setPick(chosen(l))}
          shuffle={() => setPick(shuffled(looks, pick, random))}
          undo={pick.before === null ? null : () => setPick(undone(pick))}
          figure={stage !== undefined}
          below={human === null ? null : <div ref={slot} class="start-check" />}
          actions={
            <button type="submit" class="start-go" disabled={busy !== ''}>
              Set sail
            </button>
          }
        />
        <p class="start-text start-faint" aria-live="polite">
          {busy === 'check'
            ? CHECKING
            : busy === 'create'
              ? 'Your phone will ask to save a passkey for Keel Over the Edge.'
              : busy === 'sign-in'
                ? 'Choose your passkey.'
                : 'Your sailor is kept with a passkey: your phone’s face, fingerprint or PIN.'}
        </p>
        {often ? null : (
          <div class="start-or">
            <span>Sailed before?</span>
            {signInKey}
          </div>
        )}
        <button type="button" class="start-link" onClick={toRecover}>
          Lost your passkey? Use your recovery code
        </button>
      </form>
    </div>
  );
}

/** Whether the age question was asked of this page's sailor yet: once each time the game is opened. */
let askedAge = false;

/**
 * The player's own sailor before the sea; done is given me to sail, or with
 * the sailor chosen to watch. With no machine sailors it stands alone,
 * centred, and nothing more is loaded. With them (or first, a machine
 * sailor to make), the start screen with machine sailors, once its module
 * is loaded; until then the player's own panel stands where it will be,
 * with its Set sail. Alone, Watch another sailor opens the list of
 * sailors to watch in its place, once that module is loaded. With the
 * catalog's boats, the fleet is read, and the player's boat shown on
 * their panel; its look's chooser and the fleet's boats stand alone.
 * A sailor made before the game asked when its player was born is asked
 * first, once each time the game is opened; Not now sails as before.
 * With the boat still in the water, a watch asks first whether to take it
 * out, as the panel's changes do.
 */
function Sailor({
  first,
  me: given,
  voyage: v,
  done,
  looks,
  stage,
  boats: cat,
  fetcher,
  races,
  opening,
}: {
  first: boolean;
  me: Me;
  voyage: Voyage;
  done: (me: Me) => void;
  looks?: Looks;
  stage?: LookStage | undefined;
  boats?: BoatCatalog | undefined;
  fetcher?: Fetch | undefined;
  /** Races ashore, Make a race offered beside Set sail; none for no key. */
  races?: RacesView | undefined;
  /** Opened by a link into the list of sailors to watch: the list, or one picked from it. */
  opening?: ListLink | undefined;
}) {
  const [asking, setAsking] = useState(() => given.born === false && !askedAge);
  askedAge ||= asking;
  const machines = first || (given.machines ?? 0) > 0;
  const m = useMachines(machines);
  const [listing, setListing] = useState(opening !== undefined);
  const w = useWatch(listing);
  // The player's look, changed here before setting sail.
  const chooser = useMemo(
    () => (looks === undefined ? undefined : new LookChooser(looks, given, stage)),
    [],
  );
  useEffect(() => () => stage?.hide(), []);
  const boats = useMemo(() => (cat === undefined ? undefined : new BoatChooser(cat, fetcher)), []);
  useEffect(() => void boats?.load(), []);
  // The boat still in the water: taken out, the box is for a new voyage,
  // and the fleet says where the boats are now.
  const out = useMemo(() => {
    const o = new TakeOut(given.atSea === true, fetcher);
    o.out = async () => {
      v.ashore();
      await boats?.load();
    };
    return o;
  }, []);
  const chosen = chooser === undefined ? given : chooser.applied(given);
  const me = { ...chosen, atSea: out.atSea.value };
  // A watch takes the boat out of the water: asked first.
  const go = (watch?: string) =>
    watch === undefined ? done(me) : out.guard(() => done({ ...me, atSea: false, watch }));
  const yours = (
    <YourSailor
      me={me}
      voyage={v}
      sail={go}
      watch={machines ? null : () => setListing(true)}
      watchName={(name) => go(name)}
      {...(chooser === undefined ? {} : { chooser })}
      boats={boats}
      {...(races === undefined ? {} : { race: () => void openMakeRace(races) })}
      out={out}
    />
  );
  const picking = chooser !== undefined && chooser.mode.value !== 'shown' && stage !== undefined;
  // The boat's look chosen, or another boat: alone on the screen, over the cover.
  const boating = boats !== undefined && boats.mode.value !== 'shown';
  if (asking) {
    return (
      <div class="start">
        <AgeQuestion
          onAnswered={() => setAsking(false)}
          onYoung={() => {}}
          onNotNow={() => setAsking(false)}
          {...(fetcher === undefined ? {} : { fetch: fetcher })}
        />
      </div>
    );
  }
  return (
    <div class={picking ? 'start picking' : 'start'}>
      {picking && stage !== undefined && chooser !== undefined ? (
        <StageFront looks={chooser.looks} look={chooser.pick.value.look} stage={stage} />
      ) : null}
      {picking || boating ? (
        yours
      ) : m !== null ? (
        <m.MachineStart
          first={first}
          opening={opening}
          done={go}
          me={me}
          voyage={v}
          {...(chooser === undefined ? {} : { chooser })}
          boats={boats}
          out={out}
        />
      ) : listing ? (
        w !== null && (
          <w.WatchList
            choose={go}
            ask={() => false}
            close={() => setListing(false)}
            className="start-panel watch-list-start"
            pick={opening === 'pick'}
          />
        )
      ) : machines ? (
        <div class="start-pair">{yours}</div>
      ) : (
        yours
      )}
    </div>
  );
}

/** Make a race, over the player's own panel before the sea. */
async function openMakeRace(races: RacesView): Promise<void> {
  const m = await loadRaces();
  races.make.value = true;
  await m.showRaces(document.body, races);
}

/** A browser that cannot make the player's passkey: the game's address, to open elsewhere. */
function OpenElsewhere({ app, tryAnyway }: { app: InApp | null; tryAnyway: (() => void) | null }) {
  const [copied, setCopied] = useState(false);
  const link = location.origin;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section class="start-panel" aria-labelledby="start-title">
      <h1 id="start-title">Keel Over the Edge</h1>
      {app !== null ? (
        <>
          <p class="start-text">
            Open Keel Over the Edge in your browser to make your sailor: inside{' '}
            {app.app ?? 'this app'}, passkeys don’t work.
          </p>
          <p class="start-text start-faint">{app.steps}</p>
        </>
      ) : (
        <p class="start-text">
          This browser can’t use passkeys, which keep your sailor. Open the game in your phone’s own
          browser.
        </p>
      )}
      <p class="start-text start-address">{link}</p>
      <button type="button" class="start-go" onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy the link'}
      </button>
      {tryAnyway !== null ? (
        <button type="button" class="start-link" onClick={tryAnyway}>
          Try here anyway
        </button>
      ) : null}
    </section>
  );
}

function mount(parent: HTMLElement, draw: (done: (me: Me) => void) => JSX.Element): Promise<Me> {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    parent.append(root);
    const done = (me: Me) => {
      render(null, root);
      root.remove();
      resolve(me);
    };
    render(
      <>
        <UpdateLine start={true} />
        {draw(done)}
      </>,
      root,
    );
  });
}

/** Shows the start screen in parent until a sailor is made or signed in, then removes it. */
export function showStartScreen(parent: HTMLElement, props: Omit<StartProps, 'done'>): Promise<Me> {
  return mount(parent, (done) => <StartScreen {...props} done={done} />);
}

/**
 * Shows the player's own sailor in parent until Set sail, or a sailor
 * chosen to watch, then removes it; with the catalog's looks, the player
 * may change theirs there, on the picker's stage if there is one; with its
 * boats, choose their boat from the fleet and set its look; with races,
 * make a race before setting sail; opened by a link into the list of
 * sailors to watch, the list in its place, or one picked from it.
 */
export function showSailor(
  parent: HTMLElement,
  me: Me,
  looks?: Looks,
  stage?: LookStage,
  boats?: BoatCatalog,
  races?: RacesView,
  opening?: ListLink,
): Promise<Me> {
  return mount(parent, (done) => (
    <Sailor
      first={false}
      opening={opening}
      me={me}
      voyage={voyage(me)}
      done={done}
      {...(looks === undefined ? {} : { looks })}
      stage={stage}
      boats={boats}
      races={races}
    />
  ));
}

/** Asks a session the recovery code made for a new passkey, then shows the new code. */
export function showAddPasskey(parent: HTMLElement, me: Me): Promise<Me> {
  return mount(parent, (done) => (
    <div class="start">
      <AddPasskey me={me} done={done} />
    </div>
  ));
}

/** A notice that the server cannot be reached, shown and hidden. */
export function backSoon(parent: HTMLElement): (shown: boolean) => void {
  let notice: HTMLElement | null = null;
  return (shown) => {
    if (shown && notice === null) {
      notice = document.createElement('p');
      notice.className = 'back-soon';
      notice.setAttribute('role', 'status');
      notice.textContent = 'Back soon: the harbour cannot be reached. Trying again…';
      parent.append(notice);
    } else if (!shown && notice !== null) {
      notice.remove();
      notice = null;
    }
  };
}
