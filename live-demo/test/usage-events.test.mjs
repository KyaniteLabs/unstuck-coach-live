import assert from "node:assert/strict";
import test from "node:test";

import {
  COACH_REQUEST_STATE,
  COACH_REQUEST_TERMINAL_STATES,
  ERROR_EVENTS,
  FUNNEL_MILESTONES,
  IllegalTransitionError,
  TRACKED_EVENTS,
  USAGE_EVENT,
  USAGE_STATUS,
  canTransitionCoachRequest,
  createCoachRequestLifecycle,
  deriveUsageStatus,
  isUsageLogType,
  rejectionEventForStatus,
  summarizeSessions,
} from "../lib/usage-events.mjs";

const S = COACH_REQUEST_STATE;
const MOVES = ["start", "reply", "reject", "fail"];
const MOVE_TARGET = { start: S.STARTED, reply: S.REPLIED, reject: S.REJECTED, fail: S.FAILED };

// The full legal-transition table, written out by hand. Any new state or move
// must be added here, or the exhaustiveness checks below fail.
const EXPECTED = {
  [S.RECEIVED]: { start: true, reply: false, reject: true, fail: true },
  [S.STARTED]: { start: false, reply: true, reject: true, fail: true },
  [S.REPLIED]: { start: false, reply: false, reject: false, fail: false },
  [S.REJECTED]: { start: false, reply: false, reject: false, fail: false },
  [S.FAILED]: { start: false, reply: false, reject: false, fail: false },
};

// Paths that reach each state from a fresh lifecycle.
const PATH_TO = {
  [S.RECEIVED]: [],
  [S.STARTED]: ["start"],
  [S.REPLIED]: ["start", "reply"],
  [S.REJECTED]: ["reject"],
  [S.FAILED]: ["fail"],
};

function lifecycleIn(state) {
  const lifecycle = createCoachRequestLifecycle();
  for (const move of PATH_TO[state]) lifecycle[move](429);
  assert.equal(lifecycle.state, state);
  return lifecycle;
}

test("coach request table covers every state exactly", () => {
  assert.deepEqual(Object.keys(EXPECTED).sort(), Object.values(S).sort());
  assert.deepEqual(Object.keys(PATH_TO).sort(), Object.values(S).sort());
  for (const state of Object.values(S)) {
    assert.deepEqual(Object.keys(EXPECTED[state]).sort(), [...MOVES].sort(), state);
  }
});

test("coach request: every legal transition succeeds, every illegal one is refused", () => {
  for (const state of Object.values(S)) {
    for (const move of MOVES) {
      const lifecycle = lifecycleIn(state);
      assert.equal(canTransitionCoachRequest(state, MOVE_TARGET[move]), EXPECTED[state][move], `${state}.${move}`);
      if (EXPECTED[state][move]) {
        lifecycle[move](400);
        assert.equal(lifecycle.state, MOVE_TARGET[move]);
      } else {
        assert.throws(() => lifecycle[move](400), IllegalTransitionError, `${state}.${move}`);
        assert.equal(lifecycle.state, state, "refused move leaves state unchanged");
      }
    }
  }
});

test("coach request: terminal states are exactly the ones with no exits", () => {
  for (const state of Object.values(S)) {
    const hasExit = MOVES.some((move) => EXPECTED[state][move]);
    assert.equal(COACH_REQUEST_TERMINAL_STATES.includes(state), !hasExit, state);
    assert.equal(lifecycleIn(state).isTerminal, !hasExit, state);
  }
});

test("coach request moves map to the persisted usage event names", () => {
  assert.equal(createCoachRequestLifecycle().start(), "chat_started");
  const replied = createCoachRequestLifecycle();
  replied.start();
  assert.equal(replied.reply(), "llm_reply_ok");
  assert.equal(createCoachRequestLifecycle().reject(429), "rate_limited");
  assert.equal(createCoachRequestLifecycle().reject(400), "request_rejected");
  assert.equal(createCoachRequestLifecycle().reject(413), "request_rejected");
  assert.equal(createCoachRequestLifecycle().fail(), "llm_error");
  assert.equal(rejectionEventForStatus(429), USAGE_EVENT.RATE_LIMITED);
  assert.equal(rejectionEventForStatus(403), USAGE_EVENT.REQUEST_REJECTED);
});

test("usage event vocabulary is byte-compatible with existing logs", () => {
  assert.deepEqual(TRACKED_EVENTS, [
    "view_landing",
    "view_chat",
    "chat_started",
    "llm_reply_ok",
    "llm_error",
    "rate_limited",
    "request_rejected",
  ]);
  assert.deepEqual([...ERROR_EVENTS].sort(), ["llm_error", "rate_limited", "request_rejected"]);
  for (const event of [...ERROR_EVENTS, ...FUNNEL_MILESTONES]) {
    assert.ok(TRACKED_EVENTS.includes(event), event);
  }
  // Every tracked event is either an error or a funnel milestone (none is dead).
  for (const event of TRACKED_EVENTS) {
    assert.ok(ERROR_EVENTS.includes(event) || FUNNEL_MILESTONES.includes(event), event);
  }
});

test("legacy usage log type is still read", () => {
  assert.equal(isUsageLogType("unstuck_usage"), true);
  assert.equal(isUsageLogType("unstuck_usage_log"), true);
  assert.equal(isUsageLogType("something_else"), false);
  assert.equal(isUsageLogType(undefined), false);
});

test("deriveUsageStatus table", () => {
  assert.deepEqual(Object.values(USAGE_STATUS).sort(), ["active", "quiet", "showing errors/rate limiting"]);
  assert.equal(deriveUsageStatus({ totalEvents: 0, totalErrors: 0 }), "quiet");
  assert.equal(deriveUsageStatus({ totalEvents: 3, totalErrors: 0 }), "active");
  assert.equal(deriveUsageStatus({ totalEvents: 3, totalErrors: 1 }), "showing errors/rate limiting");
  // Legacy aggregates may carry errors without per-event counts.
  assert.equal(deriveUsageStatus({ totalEvents: 0, totalErrors: 2 }), "showing errors/rate limiting");
});

test("summarizeSessions counts funnel milestones per session", () => {
  const metrics = summarizeSessions([
    { sessionId: "a", event: "view_landing" },
    { sessionId: "a", event: "view_chat" },
    { sessionId: "a", event: "chat_started" },
    { sessionId: "a", event: "llm_reply_ok" },
    { sessionId: "b", event: "view_chat" },
    { sessionId: "b", event: "chat_started" },
    { sessionId: "b", event: "rate_limited" },
    { sessionId: "c", event: "request_rejected" },
    { event: "view_landing" }, // no key: ignored
  ]);
  assert.deepEqual(metrics, {
    sessionsTotal: 3,
    withLanding: 1,
    withChat: 2,
    withStarted: 2,
    withReply: 1,
    landingToChat: 1,
    chatToStarted: 2,
    startedToReply: 1,
  });
});

// Seeded PRNG so failures are reproducible.
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("property: random move sequences keep one outcome per request", () => {
  for (let seed = 1; seed <= 500; seed += 1) {
    const random = mulberry32(seed);
    const lifecycle = createCoachRequestLifecycle();
    let model = S.RECEIVED;
    const outcomes = [];
    for (let step = 0; step < 8; step += 1) {
      const move = MOVES[Math.floor(random() * MOVES.length)];
      const status = random() < 0.5 ? 429 : 400;
      const legal = EXPECTED[model][move];
      if (legal) {
        const event = lifecycle[move](status);
        model = MOVE_TARGET[move];
        if (ERROR_EVENTS.includes(event) || event === USAGE_EVENT.LLM_REPLY_OK) outcomes.push(event);
      } else {
        assert.throws(() => lifecycle[move](status), IllegalTransitionError, `seed ${seed}`);
      }
      // Invariants after every step.
      assert.equal(lifecycle.state, model, `seed ${seed}`);
      assert.ok(outcomes.length <= 1, `seed ${seed}: more than one outcome`);
      assert.equal(lifecycle.isTerminal, outcomes.length === 1, `seed ${seed}`);
    }
  }
});
