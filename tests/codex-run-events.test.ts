import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCodexRunEvent,
  type CodexRunEvents,
} from "../packages/core/codex-run-events.js";
const id = "synthetic-session";
const record = (type: string, payload: unknown) =>
  JSON.stringify({ type, timestamp: "2026-11-03T08:00:00.000Z", payload });
const meta = () =>
  applyCodexRunEvent(
    record("session_meta", {
      id,
      cwd: "/fixture/project",
      instructions: "FAKE_PRIVATE_TEXT",
    }),
    id,
  )!;

test("rollout projection keeps runtime metadata and discards conversation and tool bodies", () => {
  let state: CodexRunEvents | undefined = meta();
  state = applyCodexRunEvent(
    record("event_msg", { type: "task_started", turn_id: "turn-1" }),
    id,
    state,
  );
  state = applyCodexRunEvent(
    record("response_item", {
      type: "message",
      content: "FAKE_PRIVATE_MESSAGE",
    }),
    id,
    state,
  );
  state = applyCodexRunEvent(
    record("event_msg", {
      type: "agent_reasoning",
      text: "FAKE_PRIVATE_REASONING",
    }),
    id,
    state,
  );
  state = applyCodexRunEvent(
    record("event_msg", {
      type: "exec_command_begin",
      command: "FAKE_PRIVATE_COMMAND",
    }),
    id,
    state,
  );
  assert.equal(state?.status, "running");
  assert.equal(state?.progress, "Codex 正在执行命令");
  assert.equal(state?.cwd, "/fixture/project");
  state = applyCodexRunEvent(
    record("event_msg", { type: "__proto__" }),
    id,
    state,
  );
  assert.equal(typeof state?.progress, "string");
  assert.ok(!JSON.stringify(state).includes("FAKE_PRIVATE"));
});

test("terminal events apply only to the current turn and malformed tails do not invent completion", () => {
  let state = applyCodexRunEvent(
    record("event_msg", { type: "task_started", turn_id: "turn-2" }),
    id,
    meta(),
  );
  state = applyCodexRunEvent(
    record("event_msg", { type: "task_complete", turn_id: "turn-1" }),
    id,
    state,
  );
  assert.equal(state?.status, "running");
  state = applyCodexRunEvent('{"type":"event_msg","payload":', id, state);
  assert.equal(state?.status, "running");
  state = applyCodexRunEvent(
    record("event_msg", {
      type: "turn_aborted",
      turn_id: "turn-2",
      reason: "FAKE_PRIVATE_REASON",
    }),
    id,
    state,
  );
  assert.equal(state?.status, "idle");
  assert.equal(state?.progress, "本轮已中止");
});

test("a record must identify the permitted session before any runtime state is accepted", () => {
  assert.equal(
    applyCodexRunEvent(record("event_msg", { type: "task_started" }), id),
    undefined,
  );
  assert.equal(meta().status, "unknown");
  assert.throws(
    () =>
      applyCodexRunEvent(record("session_meta", { id: "another-session" }), id),
    /编号不一致/,
  );
  let state = applyCodexRunEvent(
    record("event_msg", { type: "task_started", turn_id: "turn-3" }),
    id,
    meta(),
  );
  state = applyCodexRunEvent(
    record("event_msg", {
      type: "task_complete",
      turn_id: "turn-3",
      last_agent_message: "FAKE_PRIVATE_RESULT",
    }),
    id,
    state,
  );
  assert.equal(state?.status, "idle");
  assert.ok(!JSON.stringify(state).includes("FAKE_PRIVATE"));
});

test("forked records ignore inherited parent turns even when copied records have new write timestamps", () => {
  const at = (time: string) => {
    const hex = Date.parse(time).toString(16).padStart(12, "0");
    return hex.slice(0, 8) + "-" + hex.slice(8) + "-7000-8000-000000000001";
  };
  const event = (timestamp: string, type: string, payload: unknown) =>
    JSON.stringify({ timestamp, type, payload });
  const copiedAt = "2026-11-03T09:00:00Z";
  const childTurn = at("2026-11-03T09:00:01Z");
  let state = applyCodexRunEvent(
    event(copiedAt, "session_meta", {
      id,
      cwd: "/fixture/child",
      timestamp: copiedAt,
      forked_from_id: "parent",
    }),
    id,
  );
  state = applyCodexRunEvent(
    event(copiedAt, "session_meta", {
      id: "parent",
      timestamp: "2026-11-03T08:00:00Z",
      cwd: "/fixture/parent",
    }),
    id,
    state,
  );
  state = applyCodexRunEvent(
    event(copiedAt, "event_msg", {
      type: "task_started",
      turn_id: at("2026-11-03T08:59:00Z"),
    }),
    id,
    state,
  );
  assert.equal(state?.status, "unknown");
  assert.equal(state?.cwd, "/fixture/child");
  state = applyCodexRunEvent(
    event("2026-11-03T09:00:01Z", "event_msg", {
      type: "task_started",
      turn_id: childTurn,
    }),
    id,
    state,
  );
  assert.equal(state?.status, "running");
  assert.equal(state?.turnId, childTurn);
  state = applyCodexRunEvent(
    event("2026-11-03T09:00:02Z", "event_msg", {
      type: "task_complete",
      turn_id: childTurn,
    }),
    id,
    state,
  );
  assert.equal(state?.status, "idle");
});
