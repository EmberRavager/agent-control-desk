import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../packages/core/runtime.js";
import { Store } from "../packages/core/store.js";
import type { StartRun, AgentConnection } from "../packages/contracts/index.js";
const settle = () => new Promise<void>((r) => setImmediate(r));
function fixture(
  t: import("node:test").TestContext,
  text: string,
  failAnswer = false,
) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "acd-followup-"))),
    store = new Store(cwd),
    runs: StartRun[] = [],
    answers: string[] = [];
  const a: AgentConnection = {
    id: "test",
    name: "Codex",
    kind: "codex",
    capabilities: { resume: true, steer: true },
    selected: true,
    available: true,
    executable: "/unused",
  };
  store.put("agents", a.id, a);
  store.message({
    id: "user",
    role: "user",
    routing: { status: "completed", actions: ["create"] },
    text,
    createdAt: "now",
    taskIds: [],
  });
  const runtime = new Runtime(store, {
    scan: async () => [],
    vault: { get: async () => null, set: async () => {} },
    adapter: () => ({
      start: async (input) => {
        runs.push(input);
        input.onEvent({
          type: "session",
          sessionId: "thread",
          turnId: "turn" + runs.length,
        });
        return {
          dispose() {},
          steer: async () => {},
          stop: async () => {},
          answer: async (_, reply) => {
            answers.push(reply);
            if (failAnswer) throw Error("Fixture delivery uncertain");
          },
        };
      },
    }),
  });
  const task = runtime.prepareTask(
    { title: "天气", goal: "查上海今天的天气", cwd, agentId: a.id },
    "user",
  );
  runtime.dispatchPreparedTask(task);
  t.after(() => {
    runtime.shutdown();
    store.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  return { runs, runtime, answers, store };
}
const ask =
  "请告诉我需要查询的城市，例如上海、北京或杭州。我会查询今天的天气，并汇报气温、降雨和出行建议。";
test("known task city answers a final question once on the existing native thread", async (t) => {
  const f = fixture(t, "问下 Codex 杭州今天天气");
  await settle();
  f.runs[0].onEvent({ type: "completed", text: ask });
  await settle();
  assert.equal(f.runs.length, 2);
  assert.equal(f.runs[1].task.sessionId, "thread");
  assert.equal(f.runs[1].task.pendingTurnText, "杭州");
  f.runs[1].onEvent({ type: "completed", text: "请问你想查哪个城市？" });
  await settle();
  assert.equal(f.runs.length, 2);
  assert.equal(f.runtime.snapshot().tasks[0].status, "waiting_input");
  assert.equal(
    f.runtime.snapshot().questions.filter((q) => !q.resolved).length,
    1,
  );
});
test("unknown city is requested from the user, ignoring the model-invented city", async (t) => {
  const f = fixture(t, "问下 Codex 今天天气");
  await settle();
  f.runs[0].onEvent({ type: "completed", text: ask });
  await settle();
  const q = f.runtime.snapshot().questions.find((q) => !q.resolved)!;
  assert.ok(q);
  assert.equal(f.runs.length, 1);
  await f.runtime.answer(q.id, "杭州");
  await settle();
  assert.equal(f.runs[1].task.pendingTurnText, "杭州");
  assert.equal(f.runs[1].task.sessionId, "thread");
  assert.equal(f.store.getMessage("answer-" + q.id)?.inReplyToQuestionId, q.id);
  assert.equal(
    f.runtime.snapshot().questions.find((item) => item.id === q.id)
      ?.answerDelivery,
    "submitted",
  );
  await assert.rejects(f.runtime.answer(q.id, "杭州"));
  assert.equal(f.runs.length, 2);
});
test("structured input can use explicit task facts, approvals always require a human", async (t) => {
  const f = fixture(t, "查询天气，城市：杭州");
  await settle();
  f.runs[0].onEvent({
    type: "question",
    input: true,
    requestId: 1,
    text: "你想查询哪个城市？",
    choices: [],
  });
  await settle();
  assert.deepEqual(f.answers, ["杭州"]);
  f.runs[0].onEvent({
    type: "question",
    requestId: 2,
    text: "你想查询哪个城市？",
    choices: ["accept", "decline"],
  });
  await settle();
  assert.deepEqual(f.answers, ["杭州"]);
  assert.equal(
    f.runtime.snapshot().questions.filter((q) => !q.resolved)[0].kind,
    "approval",
  );
});
test("ambiguous or other-task facts never auto-answer", async (t) => {
  for (const source of [
    "查询天气，城市：杭州，城市：上海",
    "问下 Codex 老家今天天气",
    "问下 Codex 办公室今天天气",
    "问下 Codex 目的地今天天气",
    "如果是杭州今天天气",
  ]) {
    const f = fixture(t, source);
    await settle();
    f.runs[0].onEvent({ type: "completed", text: ask });
    await settle();
    assert.equal(f.runs.length, 1, source);
  }
  const f = fixture(t, "问下 Codex 杭州今天天气");
  const user = f.store.getMessage("user")!;
  f.store.message({
    ...user,
    routing: { status: "completed", actions: ["create", "create"] },
  });
  await settle();
  f.runs[0].onEvent({ type: "completed", text: ask });
  await settle();
  assert.equal(f.runs.length, 1);
});
test("mixed questions and new instructions never get automatic answers", async (t) => {
  for (const question of [
    "请告诉我需要查询的城市。需要用什么语言？",
    "请告诉我需要查询的城市。我会查询今天的天气，再帮你提交订单。",
    "请告诉我需要查询的城市，例如上海？是否允许上传？",
  ]) {
    const f = fixture(t, "这次查杭州");
    await settle();
    f.runs[0].onEvent({
      type: "question",
      input: true,
      requestId: 7,
      text: question,
    });
    await settle();
    assert.deepEqual(f.answers, []);
  }
});

test("an unfinished native answer stays unknown and cannot auto-replay", async (t) => {
  const f = fixture(t, "查询天气，城市：杭州", true);
  await settle();
  const request = {
    type: "question" as const,
    input: true,
    requestId: 13,
    text: "你想查询哪个城市？",
    choices: [],
  };
  f.runs[0].onEvent(request);
  await settle();
  f.runs[0].onEvent(request);
  await settle();
  assert.deepEqual(f.answers, ["杭州"]);
  assert.equal(f.runtime.snapshot().tasks[0].status, "unknown");
  const q = f.runtime.snapshot().questions[0];
  assert.equal(q.answerDelivery, "unknown");
  assert.equal(q.resolved, true);
});
test("a confirmed ended turn keeps its question across restart without starting work", async (t) => {
  const f = fixture(t, "查询天气");
  await settle();
  f.runs[0].onEvent({ type: "completed", text: ask });
  await settle();
  f.runtime.shutdown();
  const restarted = new Runtime(f.store, f.runtime.deps);
  try {
    const q = restarted.snapshot().questions.find((q) => !q.resolved);
    assert.ok(q);
    assert.equal(restarted.snapshot().tasks[0].status, "waiting_input");
    assert.equal(f.runs.length, 1);
    await restarted.answer(q.id, "杭州");
    await settle();
    assert.equal(f.runs.length, 2);
    assert.equal(f.runs[1].task.sessionId, "thread");
  } finally {
    restarted.shutdown();
  }
});
