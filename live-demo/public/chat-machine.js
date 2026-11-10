// Explicit lifecycles for the chat demo UI (imported by app.js).
// Pure logic, no DOM access, so it can be unit-tested in Node.

export class IllegalTransitionError extends Error {
  constructor(machine, from, to) {
    super(`illegal ${machine} transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
  }
}

// ---------------------------------------------------------------------------
// Send lifecycle: one coach request at a time.
//
//   idle ──begin()──► sending ──settle()──► idle
//
// begin() while sending is refused, so a second submit cannot race the first.
// ---------------------------------------------------------------------------

export const SEND_STATE = Object.freeze({
  IDLE: "idle",
  SENDING: "sending",
});

const SEND_TRANSITIONS = Object.freeze({
  [SEND_STATE.IDLE]: Object.freeze([SEND_STATE.SENDING]),
  [SEND_STATE.SENDING]: Object.freeze([SEND_STATE.IDLE]),
});

export function canTransitionSend(from, to) {
  return Boolean(SEND_TRANSITIONS[from]?.includes(to));
}

export function createSendMachine() {
  let state = SEND_STATE.IDLE;

  function move(to) {
    if (!canTransitionSend(state, to)) {
      throw new IllegalTransitionError("send", state, to);
    }
    state = to;
  }

  return {
    get state() {
      return state;
    },
    get isSending() {
      return state === SEND_STATE.SENDING;
    },
    begin() {
      move(SEND_STATE.SENDING);
    },
    settle() {
      move(SEND_STATE.IDLE);
    },
  };
}

// The saved draft belongs to whatever is in the composer now. After a reply
// arrives it may be cleared only if the user has not started a new draft while
// the request was in flight.
export function shouldClearSavedDraftAfterReply(composerValue) {
  return !String(composerValue || "").trim();
}

// ---------------------------------------------------------------------------
// Voice input lifecycle. Each recognition object is one "session"; only the
// current session may move the machine. Events from a retired session (a
// recognition the user already stopped and replaced) are ignored, so a late
// "end" from an old session cannot clobber a newer one.
//
//   idle ──start(s)──► starting ──started(s)──► listening
//   starting | listening | errored ──stop()──► stopping
//   starting | listening | stopping ──errored(s)──► errored
//   starting | listening | stopping | errored ──ended(s)──► idle
//   starting ──abort(s)──► idle         (recognition.start() threw)
//   stopping ──abandon()──► idle        (user restarts before the old "end")
//
// Transcript results are accepted from the current session while it is
// starting, listening or stopping (final words often arrive after stop()).
// ---------------------------------------------------------------------------

export const VOICE_STATE = Object.freeze({
  IDLE: "idle",
  STARTING: "starting",
  LISTENING: "listening",
  STOPPING: "stopping",
  ERRORED: "errored",
});

const VOICE_TRANSITIONS = Object.freeze({
  start: Object.freeze({ from: [VOICE_STATE.IDLE], to: VOICE_STATE.STARTING }),
  started: Object.freeze({ from: [VOICE_STATE.STARTING], to: VOICE_STATE.LISTENING }),
  stop: Object.freeze({
    from: [VOICE_STATE.STARTING, VOICE_STATE.LISTENING, VOICE_STATE.ERRORED],
    to: VOICE_STATE.STOPPING,
  }),
  errored: Object.freeze({
    from: [VOICE_STATE.STARTING, VOICE_STATE.LISTENING, VOICE_STATE.STOPPING],
    to: VOICE_STATE.ERRORED,
  }),
  ended: Object.freeze({
    from: [VOICE_STATE.STARTING, VOICE_STATE.LISTENING, VOICE_STATE.STOPPING, VOICE_STATE.ERRORED],
    to: VOICE_STATE.IDLE,
  }),
  abort: Object.freeze({ from: [VOICE_STATE.STARTING], to: VOICE_STATE.IDLE }),
  abandon: Object.freeze({ from: [VOICE_STATE.STOPPING], to: VOICE_STATE.IDLE }),
});

export const VOICE_TRANSITION_NAMES = Object.freeze(Object.keys(VOICE_TRANSITIONS));

export function canVoiceTransition(name, from) {
  return Boolean(VOICE_TRANSITIONS[name]?.from.includes(from));
}

const VOICE_RESULT_STATES = Object.freeze([
  VOICE_STATE.STARTING,
  VOICE_STATE.LISTENING,
  VOICE_STATE.STOPPING,
]);

export function createVoiceMachine() {
  let state = VOICE_STATE.IDLE;
  let session = null;

  function move(name) {
    if (!canVoiceTransition(name, state)) {
      throw new IllegalTransitionError("voice", state, VOICE_TRANSITIONS[name]?.to ?? name);
    }
    const from = state;
    state = VOICE_TRANSITIONS[name].to;
    if (state === VOICE_STATE.IDLE) {
      session = null;
    }
    return from;
  }

  const isCurrent = (candidate) => candidate != null && candidate === session;

  return {
    get state() {
      return state;
    },
    get session() {
      return session;
    },
    isCurrent,
    acceptsResults(candidate) {
      return isCurrent(candidate) && VOICE_RESULT_STATES.includes(state);
    },
    start(candidate) {
      if (candidate == null) {
        throw new TypeError("voice session is required");
      }
      move("start");
      session = candidate;
    },
    // Session-driven moves return false (ignored) for a stale session.
    started(candidate) {
      if (!isCurrent(candidate)) return false;
      move("started");
      return true;
    },
    errored(candidate) {
      if (!isCurrent(candidate)) return false;
      move("errored");
      return true;
    },
    // Returns the state the session ended from, or null for a stale session.
    ended(candidate) {
      if (!isCurrent(candidate)) return null;
      return move("ended");
    },
    abort(candidate) {
      if (!isCurrent(candidate)) return false;
      move("abort");
      return true;
    },
    stop() {
      move("stop");
    },
    abandon() {
      move("abandon");
    },
  };
}
