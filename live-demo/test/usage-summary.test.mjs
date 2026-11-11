import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = new URL("../scripts/usage-summary.mjs", import.meta.url).pathname;

function runSummary(input, args = []) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function line(event, extra = {}) {
  return JSON.stringify({ type: "unstuck_usage", event, timestamp: "2026-01-01T00:00:00.000Z", ...extra });
}

test("all-time status is quiet when there has never been any traffic", () => {
  const dir = mkdtempSync(join(tmpdir(), "unstuck-usage-"));
  const summary = runSummary("", ["--aggregate-file", join(dir, "aggregate.json")]);
  assert.equal(summary.status, "quiet");
  assert.equal(summary.allTime.status, "quiet", "window and all-time status must agree on an empty log");
});

test("window and all-time status are derived the same way", () => {
  const dir = mkdtempSync(join(tmpdir(), "unstuck-usage-"));
  const aggregateFile = join(dir, "aggregate.json");

  const active = runSummary(`${line("view_landing", { sessionId: "s" })}\n`, ["--aggregate-file", aggregateFile]);
  assert.equal(active.status, "active");
  assert.equal(active.allTime.status, "active");

  const errored = runSummary(`${line("llm_error", { sessionId: "s" })}\n`, ["--aggregate-file", aggregateFile]);
  assert.equal(errored.status, "showing errors/rate limiting");
  assert.equal(errored.allTime.status, "showing errors/rate limiting");

  const quietWindow = runSummary("", ["--aggregate-file", aggregateFile]);
  assert.equal(quietWindow.status, "quiet");
  assert.equal(quietWindow.allTime.status, "showing errors/rate limiting");
});

test("legacy log type lines and the persisted aggregate format are still supported", () => {
  const dir = mkdtempSync(join(tmpdir(), "unstuck-usage-"));
  const aggregateFile = join(dir, "aggregate.json");
  writeFileSync(
    aggregateFile,
    JSON.stringify({
      version: 1,
      firstSeen: "2025-01-01T00:00:00.000Z",
      lastSeen: "2025-01-02T00:00:00.000Z",
      events: { view_chat: 2, rate_limited: 1 },
      providerModel: {},
      errorReasons: { "rate limit exceeded": 1 },
      totalErrors: 1,
      latencySamples: [10],
    }),
  );

  const input = [
    JSON.stringify({ type: "unstuck_usage_log", event: "chat_started", sessionId: "s", timestamp: "2026-01-01T00:00:00.000Z" }),
    line("llm_reply_ok", { sessionId: "s", provider: "p", model: "m", totalLatencyMs: 5, modelLatencyMs: 4 }),
    line("rate_limited", { sessionId: "t", reason: "rate limit exceeded" }),
  ].join("\n");
  const summary = runSummary(input, ["--aggregate-file", aggregateFile]);

  assert.equal(summary.events.chat_started, 1);
  assert.equal(summary.session.chatStartToReply.count, 1);
  assert.equal(summary.errors.totalErrors, 1);
  assert.equal(summary.allTime.errors.totalErrors, 2);

  const persisted = JSON.parse(readFileSync(aggregateFile, "utf8"));
  assert.deepEqual(Object.keys(persisted), [
    "version",
    "firstSeen",
    "lastSeen",
    "events",
    "providerModel",
    "errorReasons",
    "totalErrors",
    "latencySamples",
  ]);
  assert.deepEqual(persisted.events, { chat_started: 1, llm_reply_ok: 1, rate_limited: 2, view_chat: 2 });
  assert.deepEqual(persisted.errorReasons, { "rate limit exceeded": 2 });
  assert.equal(persisted.totalErrors, 2);
});
