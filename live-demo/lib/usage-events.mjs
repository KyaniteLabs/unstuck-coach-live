// Single source of truth for the usage-event vocabulary written by
// live-demo/server.mjs and read by live-demo/scripts/usage-summary.mjs.
//
// The persisted log format is unchanged: each line is
//   {"type":"unstuck_usage","event":"<one of USAGE_EVENT>", ...}
// and the all-time aggregate JSON keeps the same keys and values.

export const USAGE_LOG_TYPE = "unstuck_usage";
// Older log lines used this type; readers must keep accepting it.
export const LEGACY_USAGE_LOG_TYPES = Object.freeze([`${USAGE_LOG_TYPE}_log`]);

export const USAGE_EVENT = Object.freeze({
  VIEW_LANDING: "view_landing",
  VIEW_CHAT: "view_chat",
  CHAT_STARTED: "chat_started",
  LLM_REPLY_OK: "llm_reply_ok",
  LLM_ERROR: "llm_error",
  RATE_LIMITED: "rate_limited",
  REQUEST_REJECTED: "request_rejected",
});

export const TRACKED_EVENTS = Object.freeze(Object.values(USAGE_EVENT));

export const ERROR_EVENTS = Object.freeze([
  USAGE_EVENT.LLM_ERROR,
  USAGE_EVENT.RATE_LIMITED,
  USAGE_EVENT.REQUEST_REJECTED,
]);

export function isUsageLogType(type) {
  return type === USAGE_LOG_TYPE || LEGACY_USAGE_LOG_TYPES.includes(type);
}

export function isErrorEvent(event) {
  return ERROR_EVENTS.includes(event);
}

// ---------------------------------------------------------------------------
// Coach request lifecycle (one per HTTP request handled by the live server).
//
//   received ──start()──► started ──reply()──► replied   (llm_reply_ok)
//      │                     │
//      ├──reject(status)─────┼──reject(status)──► rejected (rate_limited | request_rejected)
//      └──fail()─────────────┴──fail()──────────► failed   (llm_error)
//
// replied / rejected / failed are terminal: a request reports exactly one
// outcome, and a reply is only legal after the chat was started.
// ---------------------------------------------------------------------------

export const COACH_REQUEST_STATE = Object.freeze({
  RECEIVED: "received",
  STARTED: "started",
  REPLIED: "replied",
  REJECTED: "rejected",
  FAILED: "failed",
});

export const COACH_REQUEST_TERMINAL_STATES = Object.freeze([
  COACH_REQUEST_STATE.REPLIED,
  COACH_REQUEST_STATE.REJECTED,
  COACH_REQUEST_STATE.FAILED,
]);

const COACH_REQUEST_TRANSITIONS = Object.freeze({
  [COACH_REQUEST_STATE.RECEIVED]: Object.freeze([
    COACH_REQUEST_STATE.STARTED,
    COACH_REQUEST_STATE.REJECTED,
    COACH_REQUEST_STATE.FAILED,
  ]),
  [COACH_REQUEST_STATE.STARTED]: Object.freeze([
    COACH_REQUEST_STATE.REPLIED,
    COACH_REQUEST_STATE.REJECTED,
    COACH_REQUEST_STATE.FAILED,
  ]),
  [COACH_REQUEST_STATE.REPLIED]: Object.freeze([]),
  [COACH_REQUEST_STATE.REJECTED]: Object.freeze([]),
  [COACH_REQUEST_STATE.FAILED]: Object.freeze([]),
});

export function canTransitionCoachRequest(from, to) {
  return Boolean(COACH_REQUEST_TRANSITIONS[from]?.includes(to));
}

export class IllegalTransitionError extends Error {
  constructor(machine, from, to) {
    super(`illegal ${machine} transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
  }
}

// Usage event emitted when a request is rejected with this HTTP status.
export function rejectionEventForStatus(status) {
  return status === 429 ? USAGE_EVENT.RATE_LIMITED : USAGE_EVENT.REQUEST_REJECTED;
}

export function createCoachRequestLifecycle() {
  let state = COACH_REQUEST_STATE.RECEIVED;

  function move(to) {
    if (!canTransitionCoachRequest(state, to)) {
      throw new IllegalTransitionError("coach request", state, to);
    }
    state = to;
  }

  return {
    get state() {
      return state;
    },
    get isTerminal() {
      return COACH_REQUEST_TERMINAL_STATES.includes(state);
    },
    // Each transition returns the usage event name to log for that move.
    start() {
      move(COACH_REQUEST_STATE.STARTED);
      return USAGE_EVENT.CHAT_STARTED;
    },
    reply() {
      move(COACH_REQUEST_STATE.REPLIED);
      return USAGE_EVENT.LLM_REPLY_OK;
    },
    reject(status) {
      move(COACH_REQUEST_STATE.REJECTED);
      return rejectionEventForStatus(status);
    },
    fail() {
      move(COACH_REQUEST_STATE.FAILED);
      return USAGE_EVENT.LLM_ERROR;
    },
  };
}

// ---------------------------------------------------------------------------
// Summary health status (derived, never stored on its own).
//
//   quiet   : no traffic at all
//   active  : traffic, no error events
//   errors  : at least one error event
// ---------------------------------------------------------------------------

export const USAGE_STATUS = Object.freeze({
  QUIET: "quiet",
  ACTIVE: "active",
  ERRORS: "showing errors/rate limiting",
});

export function deriveUsageStatus({ totalEvents, totalErrors }) {
  if (Number(totalErrors) > 0) return USAGE_STATUS.ERRORS;
  if (Number(totalEvents) > 0) return USAGE_STATUS.ACTIVE;
  return USAGE_STATUS.QUIET;
}

// ---------------------------------------------------------------------------
// Session funnel: the furthest-reaching milestones a session hit. Milestones
// are not exclusive (a session can view landing and chat), so a session holds
// the SET of milestones reached, keyed by these event names.
// ---------------------------------------------------------------------------

export const FUNNEL_MILESTONES = Object.freeze([
  USAGE_EVENT.VIEW_LANDING,
  USAGE_EVENT.VIEW_CHAT,
  USAGE_EVENT.CHAT_STARTED,
  USAGE_EVENT.LLM_REPLY_OK,
]);

export function summarizeSessions(events) {
  const sessions = new Map();
  for (const event of events) {
    const key = event.sessionId || event.requestId || event.status;
    if (!key) {
      continue;
    }
    const reached = sessions.get(key) || new Set();
    if (FUNNEL_MILESTONES.includes(event.event)) {
      reached.add(event.event);
    }
    sessions.set(key, reached);
  }

  const count = (...milestones) =>
    [...sessions.values()].filter((reached) => milestones.every((m) => reached.has(m))).length;

  return {
    sessionsTotal: sessions.size,
    withLanding: count(USAGE_EVENT.VIEW_LANDING),
    withChat: count(USAGE_EVENT.VIEW_CHAT),
    withStarted: count(USAGE_EVENT.CHAT_STARTED),
    withReply: count(USAGE_EVENT.LLM_REPLY_OK),
    landingToChat: count(USAGE_EVENT.VIEW_LANDING, USAGE_EVENT.VIEW_CHAT),
    chatToStarted: count(USAGE_EVENT.VIEW_CHAT, USAGE_EVENT.CHAT_STARTED),
    startedToReply: count(USAGE_EVENT.CHAT_STARTED, USAGE_EVENT.LLM_REPLY_OK),
  };
}
