import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  appendFile,
  rm,
  mkdir,
  rename,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CodexLiveEvents,
  CodexRunEventReader,
  parseOpenCodexRecords,
} from "../packages/core/codex-live-events.js";
import type { AgentConnection } from "../packages/contracts/index.js";
const id = "01900000-0000-7000-8000-000000000001";
const agent: AgentConnection = {
  id: "fixture-codex",
  kind: "codex",
  name: "Codex",
  executable: "/not-executed",
  selected: true,
  available: true,
  capabilities: { steer: true, resume: true },
};
const line = (type: string, payload: unknown) =>
  JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\n";
const header = () =>
  line("session_meta", {
    id,
    cwd: "/fixture/project",
    private: "FAKE_PRIVATE_METADATA_BODY",
  });
const start = () =>
  line("event_msg", { type: "task_started", turn_id: "turn-1" });
const complete = () =>
  line("event_msg", {
    type: "task_complete",
    turn_id: "turn-1",
    last_agent_message: "FAKE_PRIVATE_RESULT",
  });

test("writer discovery requires a Codex process and write access, never arbitrary reader processes", () => {
  const entry = (pid: number, command: string, access: string) =>
    `p${pid}\0c${command}\0\nf10\0a${access}\0n/fixture/rollout-${id}.jsonl\0`;
  assert.deepEqual(
    parseOpenCodexRecords(
      entry(12, "codex", "u") +
        entry(13, "node", "u") +
        entry(14, "codex", "r") +
        entry(15, "ChatGPT", "w"),
    ),
    [
      { path: `/fixture/rollout-${id}.jsonl`, pid: 12 },
      { path: `/fixture/rollout-${id}.jsonl`, pid: 15 },
    ],
  );
});

test("incremental event projection waits for complete lines, skips large message bodies, and follows completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "acd-event-reader-"));
  const path = join(root, `rollout-${id}.jsonl`);
  const reader = new CodexRunEventReader();
  const signal = new AbortController().signal;
  try {
    await writeFile(
      path,
      header() +
        start() +
        line("response_item", {
          type: "message",
          content: "FAKE_PRIVATE_MESSAGE".repeat(40000),
        }),
    );
    assert.equal((await reader.read(path, id, signal)).status, "running");
    const terminal = complete();
    await appendFile(path, terminal.slice(0, -5));
    assert.equal((await reader.read(path, id, signal)).status, "running");
    await appendFile(path, terminal.slice(-5));
    const state = await reader.read(path, id, signal);
    assert.equal(state.status, "idle");
    assert.ok(!JSON.stringify(state).includes("FAKE_PRIVATE"));
    await writeFile(path, header() + start());
    assert.equal((await reader.read(path, id, signal)).status, "running");
    await appendFile(
      path,
      line("event_msg", {
        type: "task_complete",
        turn_id: "turn-1",
        last_agent_message: "x".repeat(600000),
      }),
    );
    assert.equal((await reader.read(path, id, signal)).status, "unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live event source imports confirmed active work, keeps its completion, and marks a vanished writer unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "acd-live-events-"));
  const path = join(root, `rollout-${id}.jsonl`);
  let records = [{ path, pid: 42 }];
  let alive = true;
  const source = new CodexLiveEvents(
    root,
    async () => records,
    () => alive,
  );
  const signal = new AbortController().signal;
  try {
    await writeFile(path, header() + complete());
    assert.equal((await source.read(agent, root, signal)).sessions.length, 0);
    await appendFile(path, start());
    const active = await source.read(agent, root, signal);
    assert.equal(active.state, "connected");
    assert.equal(active.source, "run-events");
    assert.equal(active.sessions[0].status, "running");
    assert.ok(!JSON.stringify(active).includes("FAKE_PRIVATE"));
    await appendFile(path, complete());
    assert.equal(
      (await source.read(agent, root, signal)).sessions[0].status,
      "idle",
    );
    await appendFile(path, start());
    assert.equal(
      (await source.read(agent, root, signal)).sessions[0].status,
      "running",
    );
    records = [];
    alive = false;
    const unknown = await source.read(agent, root, signal);
    assert.equal(unknown.state, "unavailable");
    assert.equal(unknown.sessions[0].status, "unknown");
    await rm(path);
    const missing = await source.read(agent, root, signal);
    assert.equal(missing.sessions[0].status, "unknown");
    assert.match(missing.sessions[0].progress, /记录暂时不可读/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a retained writer cannot keep stale work running, and new turn activity restores it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acd-stale-writer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-11-04T01:00:00Z"),
  });
  const path = join(root, `rollout-${id}.jsonl`);
  let writerOpen = true;
  const source = new CodexLiveEvents(
    root,
    async () => (writerOpen ? [{ path, pid: 42 }] : []),
    () => true,
  );
  const read = async () =>
    (await source.read(agent, root, new AbortController().signal)).sessions[0];
  await writeFile(path, header() + start());
  assert.equal((await read()).status, "running");
  t.mock.timers.tick(6 * 60 * 1000);
  assert.equal((await read()).status, "unknown");
  const restarted = new CodexLiveEvents(
    root,
    async () => [{ path, pid: 42 }],
    () => true,
  );
  assert.ok(
    !(
      await restarted.read(agent, root, new AbortController().signal)
    ).sessions.some((s) => s.status === "running"),
  );
  await appendFile(
    path,
    line("event_msg", { type: "agent_message", turn_id: "older-turn" }),
  );
  assert.equal((await read()).status, "unknown");
  await appendFile(
    path,
    line("event_msg", { type: "exec_command_end", turn_id: "turn-1" }),
  );
  assert.equal((await read()).status, "running");
  t.mock.timers.tick(11 * 60 * 1000);
  assert.equal((await read()).status, "unknown");
  await appendFile(path, complete());
  writerOpen = false;
  assert.equal((await read()).status, "idle");
});

test(
  "event source confines reads to the configured session root and rejects symlink escapes",
  { skip: process.platform === "win32" },
  async () => {
    const parent = await mkdtemp(join(tmpdir(), "acd-event-root-"));
    const root = join(parent, "sessions");
    await mkdir(root);
    const outside = join(parent, `rollout-${id}.jsonl`);
    const link = join(root, `rollout-${id}.jsonl`);
    try {
      await writeFile(outside, header() + start());
      await symlink(outside, link);
      const source = new CodexLiveEvents(
        root,
        async () => [
          { path: outside, pid: 42 },
          { path: link, pid: 42 },
        ],
        () => true,
      );
      const result = await source.read(
        agent,
        root,
        new AbortController().signal,
      );
      assert.equal(result.sessions.length, 0);
      assert.equal(result.state, "unavailable");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test("a short execution completed between polls is observed once, while loaded idle history stays silent", async () => {
  const root = await mkdtemp(join(tmpdir(), "acd-fast-completion-"));
  const path = join(root, `rollout-${id}.jsonl`);
  const source = new CodexLiveEvents(
    root,
    async () => [{ path, pid: 42 }],
    () => true,
  );
  const signal = new AbortController().signal;
  try {
    await writeFile(path, header() + start() + complete());
    assert.equal((await source.read(agent, root, signal)).sessions.length, 0);
    await appendFile(
      path,
      line("event_msg", { type: "task_started", turn_id: "turn-2" }) +
        line("event_msg", { type: "user_message", message: "检查短任务" }) +
        line("event_msg", { type: "task_complete", turn_id: "turn-2" }),
    );
    const ended = (await source.read(agent, root, signal)).sessions[0];
    assert.equal(ended.status, "idle");
    assert.equal(ended.completionObserved, true);
    assert.equal((await source.context(id, "turn-2")).request, "检查短任务");
    assert.equal(
      (await source.read(agent, root, signal)).sessions[0].completionObserved,
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit end remains reportable after the writer closes its file", async () => {
  const root = await mkdtemp(join(tmpdir(), "acd-ended-writer-"));
  const path = join(root, `rollout-${id}.jsonl`);
  let records = [{ path, pid: 42 }];
  const source = new CodexLiveEvents(
    root,
    async () => records,
    () => true,
  );
  const signal = new AbortController().signal;
  try {
    await writeFile(path, header() + start());
    assert.equal(
      (await source.read(agent, root, signal)).sessions[0].status,
      "running",
    );
    await appendFile(path, complete());
    records = [];
    const result = await source.read(agent, root, signal);
    assert.equal(result.state, "connected");
    assert.equal(result.sessions[0].status, "idle");
    assert.equal(result.sessions[0].completionObserved, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delayed report context keeps the completed turn's requests and public answer isolated from the next turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acd-delayed-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, `rollout-${id}.jsonl`);
  const source = new CodexLiveEvents(
    root,
    async () => [{ path, pid: 42 }],
    () => true,
  );
  const signal = new AbortController().signal;
  const user = (message: string) =>
    line("event_msg", { type: "user_message", message });
  const answer = (text: string) =>
    line("response_item", {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text }],
    });
  await writeFile(
    path,
    header() + start() + user("First objective") + user("First amendment"),
  );
  await source.read(agent, root, signal);
  await appendFile(
    path,
    line("response_item", {
      type: "function_call_output",
      output: "x".repeat(2 * 1024 * 1024),
    }) +
      answer("First delivery") +
      complete(),
  );
  assert.equal(
    (await source.read(agent, root, signal)).sessions[0].completionObserved,
    true,
  );
  await appendFile(
    path,
    answer("Between turns") +
      line("event_msg", { type: "task_started", turn_id: "turn-2" }) +
      user("Second objective") +
      answer("Second delivery"),
  );
  assert.equal(
    (await source.read(agent, root, signal)).sessions[0].turnId,
    "turn-2",
  );
  const old = await source.context(id, "turn-1");
  assert.equal(old.request, "First objective");
  assert.deepEqual(old.requests, ["First objective", "First amendment"]);
  assert.equal(old.finalAnswer, "First delivery");
  assert.deepEqual(old.updates, ["First delivery"]);
  assert.equal(old.truncated, true);
  assert.equal(
    (await source.context(id, undefined)).finalAnswer,
    "Second delivery",
  );
  await rename(path, path + ".old");
  await writeFile(
    path,
    header() +
      line("event_msg", { type: "task_started", turn_id: "replacement" }) +
      user("Replacement"),
  );
  await assert.rejects(source.context(id, "turn-1"), /新一轮执行/);
});

test("only the eight most recently completed turn ranges remain available", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acd-bounded-turns-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, `rollout-${id}.jsonl`);
  const reader = new CodexRunEventReader();
  const signal = new AbortController().signal;
  await writeFile(path, header());
  for (let i = 1; i <= 9; i++) {
    const turn_id = `turn-${i}`;
    await appendFile(
      path,
      line("event_msg", { type: "task_started", turn_id }) +
        line("event_msg", { type: "user_message", message: `Objective ${i}` }) +
        line("event_msg", { type: "task_complete", turn_id }),
    );
    await reader.read(path, id, signal);
  }
  assert.equal(
    (await reader.context(path, id, "turn-2", signal)).request,
    "Objective 2",
  );
  await assert.rejects(
    reader.context(path, id, "turn-1", signal),
    /新一轮执行/,
  );
  await assert.rejects(
    reader.context(path, "wrong-session", "turn-2", signal),
    /会话编号不一致/,
  );
});

test("internal guardian review sessions never appear as user work or public task context", async () => {
  const root = await mkdtemp(join(tmpdir(), "acd-internal-source-")),
    path = join(root, `rollout-${id}.jsonl`);
  const source = new CodexLiveEvents(
    root,
    async () => [{ path, pid: 42 }],
    () => true,
  );
  try {
    await writeFile(
      path,
      JSON.stringify({
        type: "session_meta",
        payload: {
          id,
          cwd: "/fixture",
          source: { subagent: { other: "guardian" } },
        },
      }) +
        "\n" +
        start(),
    );
    const result = await source.read(agent, root, new AbortController().signal);
    assert.equal(result.sessions.length, 0);
    assert.equal(result.excludedSessionIds?.length, 1);
    assert.equal((await source.context(id, undefined)).request, "");
    await appendFile(path, complete());
    assert.equal(
      (await source.read(agent, root, new AbortController().signal)).sessions
        .length,
      0,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
