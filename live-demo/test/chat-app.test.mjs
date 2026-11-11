// Behavioral tests for live-demo/public/app.js, run against a tiny fake DOM.
import assert from "node:assert/strict";
import test from "node:test";

const APP_URL = new URL("../public/app.js", import.meta.url);
let importCounter = 0;

class FakeElement {
  constructor(name = "element") {
    this.name = name;
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.style = { setProperty() {} };
    this.children = [];
    this.textContent = "";
    this.value = "";
    this.disabled = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  dispatch(type, event = {}) {
    const fullEvent = { type, target: this, preventDefault() {}, ...event };
    for (const handler of this.listeners.get(type) || []) handler(fullEvent);
    return fullEvent;
  }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
  }
  getAttribute(key) {
    return this.attributes.get(key) ?? null;
  }
  removeAttribute(key) {
    this.attributes.delete(key);
  }
  toggleAttribute(key, force) {
    if (force) this.attributes.set(key, "");
    else this.attributes.delete(key);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  append(...children) {
    this.children.push(...children);
  }
  focus() {}
  setSelectionRange() {}
  closest() {
    return null;
  }
}

class FakeRecognition {
  static instances = [];
  constructor() {
    this.listeners = new Map();
    this.started = false;
    this.stopped = false;
    FakeRecognition.instances.push(this);
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  fire(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) handler(event);
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  abort() {
    this.stopped = true;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function loadApp(t, { fetchImpl } = {}) {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new FakeElement(selector));
    return elements.get(selector);
  };
  const form = element("#coach-form");
  const submit = new FakeElement("submit");
  form.querySelector = () => submit;
  form.requestSubmit = () => form.dispatch("submit");

  const storage = new Map();
  const fetchCalls = [];
  FakeRecognition.instances = [];

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
  };
  globalThis.document = {
    querySelector: element,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: (tag) => new FakeElement(tag),
  };
  globalThis.window = {
    setTimeout: () => 0,
    clearTimeout: () => {},
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    SpeechRecognition: FakeRecognition,
  };
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    if (url === "/api/config") return jsonResponse(200, { provider: "test", model: "test" });
    return fetchImpl(url, options);
  };
  t.after(() => {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
  });

  importCounter += 1;
  await import(`${APP_URL.href}?case=${importCounter}`);

  const message = element("#message");
  return {
    form,
    submit,
    message,
    storage,
    fetchCalls,
    voiceButton: element("#voice-button"),
    voiceStatus: element("#voice-status"),
    coachCalls: () => fetchCalls.filter((call) => call.url === "/api/coach"),
    type(text) {
      message.value = text;
      message.dispatch("input");
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a late end from a stopped voice session does not orphan the newer session", async (t) => {
  const app = await loadApp(t, { fetchImpl: async () => jsonResponse(200, { reply: "ok" }) });

  app.voiceButton.dispatch("click");
  const first = FakeRecognition.instances[0];
  first.fire("start");

  app.voiceButton.dispatch("click"); // stop the first session
  assert.equal(first.stopped, true);

  app.voiceButton.dispatch("click"); // immediately start a second session
  const second = FakeRecognition.instances[1];
  assert.ok(second, "second recognition should start");
  second.fire("start");

  first.fire("end"); // the first session's end arrives late

  app.voiceButton.dispatch("click"); // user taps Mic to stop the second session
  assert.equal(second.stopped, true, "second session must be stopped, not orphaned");
  assert.equal(FakeRecognition.instances.length, 2, "no third recognition may start");
  assert.equal(app.voiceButton.getAttribute("aria-pressed"), "false");
});

test("voice error keeps its message after the session ends", async (t) => {
  const app = await loadApp(t, { fetchImpl: async () => jsonResponse(200, { reply: "ok" }) });

  app.voiceButton.dispatch("click");
  const recognition = FakeRecognition.instances[0];
  recognition.fire("start");
  recognition.fire("error", { error: "not-allowed" });
  recognition.fire("end");

  assert.match(app.voiceStatus.textContent, /Microphone permission was blocked/);
  assert.equal(app.voiceButton.getAttribute("aria-pressed"), "false");

  app.voiceButton.dispatch("click");
  assert.equal(FakeRecognition.instances.length, 2, "Mic starts a fresh session after an error");
});

test("final words that arrive after stop are still captured", async (t) => {
  const app = await loadApp(t, { fetchImpl: async () => jsonResponse(200, { reply: "ok" }) });

  app.voiceButton.dispatch("click");
  const recognition = FakeRecognition.instances[0];
  recognition.fire("start");
  app.voiceButton.dispatch("click"); // stop
  recognition.fire("result", { results: [[{ transcript: "last words" }]] });
  recognition.fire("end");

  assert.equal(app.message.value, "last words");
});

test("a draft typed while a request is in flight survives the reply", async (t) => {
  const pending = deferred();
  const app = await loadApp(t, { fetchImpl: () => pending.promise });

  app.type("first stuck point");
  app.form.dispatch("submit");
  assert.equal(app.coachCalls().length, 1);

  app.type("a new draft written while waiting");
  pending.resolve(jsonResponse(200, { reply: "Open the doc." }));
  await settle();
  await settle();

  assert.equal(app.storage.get("unstuck_live_demo_draft"), "a new draft written while waiting");
});

test("the saved draft is cleared after a reply when the composer is empty", async (t) => {
  const pending = deferred();
  const app = await loadApp(t, { fetchImpl: () => pending.promise });

  app.type("first stuck point");
  app.form.dispatch("submit");
  pending.resolve(jsonResponse(200, { reply: "Open the doc." }));
  await settle();
  await settle();

  assert.equal(app.storage.has("unstuck_live_demo_draft"), false);
});

test("only one coach request is in flight at a time", async (t) => {
  const pending = deferred();
  const app = await loadApp(t, { fetchImpl: () => pending.promise });

  app.type("first");
  app.form.dispatch("submit");
  app.type("second");
  app.form.dispatch("submit");
  assert.equal(app.coachCalls().length, 1);
  assert.equal(app.submit.disabled, true);

  pending.resolve(jsonResponse(500, { error: "boom" }));
  await settle();
  await settle();
  assert.equal(app.submit.disabled, false);

  app.form.dispatch("submit");
  assert.equal(app.coachCalls().length, 2, "a new request is allowed after the first settles");
});
