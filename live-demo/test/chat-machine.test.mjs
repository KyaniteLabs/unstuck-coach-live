import assert from "node:assert/strict";
import test from "node:test";

import {
  IllegalTransitionError,
  SEND_STATE,
  VOICE_STATE,
  VOICE_TRANSITION_NAMES,
  canTransitionSend,
  canVoiceTransition,
  createSendMachine,
  createVoiceMachine,
  shouldClearSavedDraftAfterReply,
} from "../public/chat-machine.js";

// ---------------------------------------------------------------- send

test("send machine: table is exhaustive and enforced", () => {
  const expected = {
    [SEND_STATE.IDLE]: { [SEND_STATE.IDLE]: false, [SEND_STATE.SENDING]: true },
    [SEND_STATE.SENDING]: { [SEND_STATE.IDLE]: true, [SEND_STATE.SENDING]: false },
  };
  assert.deepEqual(Object.keys(expected).sort(), Object.values(SEND_STATE).sort());
  for (const from of Object.values(SEND_STATE)) {
    for (const to of Object.values(SEND_STATE)) {
      assert.equal(canTransitionSend(from, to), expected[from][to], `${from}->${to}`);
    }
  }

  const machine = createSendMachine();
  assert.equal(machine.state, SEND_STATE.IDLE);
  assert.throws(() => machine.settle(), IllegalTransitionError);
  machine.begin();
  assert.equal(machine.isSending, true);
  assert.throws(() => machine.begin(), IllegalTransitionError);
  machine.settle();
  assert.equal(machine.state, SEND_STATE.IDLE);
});

test("saved draft is only cleared after a reply when the composer is empty", () => {
  assert.equal(shouldClearSavedDraftAfterReply(""), true);
  assert.equal(shouldClearSavedDraftAfterReply("   "), true);
  assert.equal(shouldClearSavedDraftAfterReply(undefined), true);
  assert.equal(shouldClearSavedDraftAfterReply("new draft"), false);
});

// ---------------------------------------------------------------- voice

const V = VOICE_STATE;
// Hand-written table: transition name -> states it is legal from -> target.
const VOICE_EXPECTED = {
  start: { from: [V.IDLE], to: V.STARTING },
  started: { from: [V.STARTING], to: V.LISTENING },
  stop: { from: [V.STARTING, V.LISTENING, V.ERRORED], to: V.STOPPING },
  errored: { from: [V.STARTING, V.LISTENING, V.STOPPING], to: V.ERRORED },
  ended: { from: [V.STARTING, V.LISTENING, V.STOPPING, V.ERRORED], to: V.IDLE },
  abort: { from: [V.STARTING], to: V.IDLE },
  abandon: { from: [V.STOPPING], to: V.IDLE },
};

const VOICE_PATH_TO = {
  [V.IDLE]: [],
  [V.STARTING]: ["start"],
  [V.LISTENING]: ["start", "started"],
  [V.STOPPING]: ["start", "started", "stop"],
  [V.ERRORED]: ["start", "started", "errored"],
};

function apply(machine, name, session) {
  switch (name) {
    case "start":
      return machine.start(session);
    case "stop":
      return machine.stop();
    case "abandon":
      return machine.abandon();
    default:
      return machine[name](session);
  }
}

function voiceIn(state) {
  const machine = createVoiceMachine();
  const session = {};
  for (const name of VOICE_PATH_TO[state]) apply(machine, name, session);
  assert.equal(machine.state, state);
  return { machine, session: machine.session ?? session };
}

test("voice table covers every state and transition", () => {
  assert.deepEqual(Object.keys(VOICE_PATH_TO).sort(), Object.values(V).sort());
  assert.deepEqual([...VOICE_TRANSITION_NAMES].sort(), Object.keys(VOICE_EXPECTED).sort());
  // Every state is reachable and every non-idle state has a way back to idle.
  for (const state of Object.values(V)) {
    const exits = Object.values(VOICE_EXPECTED).filter((t) => t.from.includes(state));
    assert.ok(exits.length > 0, `${state} has no exit`);
  }
});

test("voice: every legal transition succeeds, every illegal one is refused", () => {
  for (const state of Object.values(V)) {
    for (const name of VOICE_TRANSITION_NAMES) {
      const legal = VOICE_EXPECTED[name].from.includes(state);
      assert.equal(canVoiceTransition(name, state), legal, `${state}.${name}`);
      const { machine, session } = voiceIn(state);
      const target = name === "start" ? {} : session;
      const sessionDriven = !["start", "stop", "abandon"].includes(name);
      if (state === V.IDLE && sessionDriven) {
        // No current session while idle: any session event is stale and ignored.
        const result = apply(machine, name, target);
        assert.ok(result === false || result === null, `${state}.${name}`);
        assert.equal(machine.state, V.IDLE);
      } else if (legal) {
        apply(machine, name, target);
        assert.equal(machine.state, VOICE_EXPECTED[name].to, `${state}.${name}`);
      } else {
        assert.throws(() => apply(machine, name, target), IllegalTransitionError, `${state}.${name}`);
        assert.equal(machine.state, state, "refused move leaves state unchanged");
      }
    }
  }
});

test("voice: events from a stale session are ignored", () => {
  const machine = createVoiceMachine();
  const old = { id: "old" };
  const fresh = { id: "fresh" };
  machine.start(old);
  machine.started(old);
  machine.stop();
  machine.abandon();
  machine.start(fresh);

  assert.equal(machine.started(old), false);
  assert.equal(machine.errored(old), false);
  assert.equal(machine.ended(old), null);
  assert.equal(machine.abort(old), false);
  assert.equal(machine.acceptsResults(old), false);
  assert.equal(machine.state, V.STARTING);
  assert.equal(machine.session, fresh);

  assert.equal(machine.started(fresh), true);
  assert.equal(machine.acceptsResults(fresh), true);
  assert.equal(machine.ended(fresh), V.LISTENING);
  assert.equal(machine.session, null);
});

test("voice: results are accepted while stopping but not after an error", () => {
  const { machine, session } = voiceIn(V.STOPPING);
  assert.equal(machine.acceptsResults(session), true);
  const errored = voiceIn(V.ERRORED);
  assert.equal(errored.machine.acceptsResults(errored.session), false);
});

test("voice: start requires a session", () => {
  assert.throws(() => createVoiceMachine().start(null), TypeError);
});

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("property: random voice event streams from several sessions keep invariants", () => {
  const SESSION_EVENTS = ["started", "errored", "ended", "abort"];
  for (let seed = 1; seed <= 500; seed += 1) {
    const random = mulberry32(seed);
    const machine = createVoiceMachine();
    const sessions = [];
    let model = { state: V.IDLE, session: null };

    for (let step = 0; step < 30; step += 1) {
      const roll = random();
      if (roll < 0.25) {
        // User taps Mic: same routing as app.js startVoiceInput.
        if (model.state === V.STOPPING) {
          machine.abandon();
          model = { state: V.IDLE, session: null };
        }
        if (model.state === V.IDLE) {
          const session = { id: sessions.length };
          sessions.push(session);
          machine.start(session);
          model = { state: V.STARTING, session };
        } else {
          machine.stop();
          model = { ...model, state: V.STOPPING };
        }
      } else if (sessions.length) {
        // A browser event from a random (possibly stale) session.
        const session = sessions[Math.floor(random() * sessions.length)];
        const name = SESSION_EVENTS[Math.floor(random() * SESSION_EVENTS.length)];
        const current = session === model.session;
        const legal = current && VOICE_EXPECTED[name].from.includes(model.state);
        if (!current) {
          const result = machine[name](session);
          assert.ok(result === false || result === null, `seed ${seed}: stale ${name} was applied`);
        } else if (legal) {
          machine[name](session);
          const to = VOICE_EXPECTED[name].to;
          model = { state: to, session: to === V.IDLE ? null : session };
        } else {
          assert.throws(() => machine[name](session), IllegalTransitionError, `seed ${seed}`);
        }
      }

      // Invariants after every step.
      assert.equal(machine.state, model.state, `seed ${seed} step ${step}`);
      assert.equal(machine.session, model.session, `seed ${seed} step ${step}`);
      assert.equal(machine.session === null, machine.state === V.IDLE, `seed ${seed}: session/idle mismatch`);
    }
  }
});
