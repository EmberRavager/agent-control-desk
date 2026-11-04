import test from "node:test";
import assert from "node:assert/strict";
import { route } from "../packages/core/model.js";
import type { Snapshot, Task } from "../packages/contracts/index.js";

const config = {
  providerId: "ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "fixture",
  hasKey: false,
};
const cwd = "/demo";
const at = "2026-11-04T00:00:00Z";
function task(n: number, status: Task["status"] = "completed"): Task {
  return {
    id: `acd-task-${String(n).padStart(5, "0")}`,
    title: `归档事项 ${n}`,
    goal: "甲".repeat(1000),
    status,
    revision: 2,
    agentId: "codex",
    cwd,
    progress: "done",
    createdAt: at,
    updatedAt: at,
  };
}
const fixture = (tasks: Task[]): Snapshot => ({
  tasks,
  questions: [],
  agents: [],
  model: null,
  messages: [],
});
async function capture(
  s: Snapshot,
  text: string,
  actions: unknown[] = [],
  selected?: string,
) {
  const original = globalThis.fetch;
  let input: any,
    bytes = 0;
  globalThis.fetch = async (_url, init) => {
    const content = JSON.parse(String(init?.body)).messages[1].content;
    bytes = Buffer.byteLength(content);
    input = JSON.parse(content);
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              reply: actions.length ? "" : "你好",
              actions,
            }),
          },
        },
      ],
    });
  };
  try {
    const decision = await route(config, "", s, text, cwd, selected);
    return { input, bytes, decision };
  } finally {
    globalThis.fetch = original;
  }
}
test("a greeting sends no archived tasks or their IDs even after 5000 tasks", async () => {
  const results = [];
  for (const count of [0, 500, 5000]) {
    const s = fixture(Array.from({ length: count }, (_, i) => task(i)));
    const r = await capture(s, "你好");
    results.push(r);
  }
  console.log(
    "routing greeting user-context bytes (0/500/5000)",
    results.map((r) => r.bytes),
  );
  for (const r of results) {
    assert.equal(r.input.tasks.length, 0);
    assert.equal(JSON.stringify(r.input).includes("acd-task-"), false);
    assert.ok(r.bytes < 2048);
  }
});
test("an old selected, explicitly named, or recently referenced task can still be resumed without unrelated history", async () => {
  const old = { ...task(1), title: "杭州仓库存对账", cwd: "/old-project" };
  const s = fixture([
    old,
    ...Array.from({ length: 80 }, (_, i) => task(20 + i, "running")),
  ]);
  s.messages = [
    {
      id: "context",
      role: "assistant",
      text: "上一项已完成",
      taskIds: [old.id],
      createdAt: at,
    },
  ];
  for (const [msg, selected] of [
    ["再补一个要求", old.id],
    ["继续杭州仓库存对账", undefined],
    [`继续 ${old.id}`, undefined],
    ["刚才那个再加一项", undefined],
  ]) {
    const r = await capture(
      s,
      msg!,
      [{ type: "supplement", taskId: old.id, text: "复核" }],
      selected,
    );
    assert.ok(r.input.tasks.some((t: Task) => t.id === old.id));
    assert.ok(r.input.tasks.length <= 16);
    assert.deepEqual(r.decision.actions, [
      { type: "supplement", taskId: old.id, text: "复核", expectedRevision: 2 },
    ]);
  }
});
test("read-only history lookup retrieves old matching work and omits unrelated preferences, reports and plan bodies", async () => {
  const old = { ...task(1), title: "上海门店库存核对", cwd: "/old-project" };
  const unrelated = task(2);
  const s = fixture([
    old,
    unrelated,
    ...Array.from({ length: 100 }, (_, i) => task(10 + i)),
  ]);
  s.messages = [
    {
      id: "private-report",
      role: "assistant",
      text: "UNRELATED_REPORT",
      taskIds: [unrelated.id],
      createdAt: at,
      completion: { id: "r", title: "结果", status: "ready" },
    },
  ];
  s.allocationSettings = {
    globalAgentId: "codex",
    projectAgentIds: { [cwd]: "codex", "/SECRET-OTHER-PROJECT": "pi" },
  };
  s.schedules = Array.from({ length: 50 }, (_, i) => ({
    id: `plan-${i}`,
    name: `历史计划 ${i}`,
    prompt: "UNRELATED_PLAN_BODY",
    agentId: "codex",
    cwd,
    rule: { kind: "interval", minutes: 60 },
    status: "finished",
    nextRunAt: null,
    createdAt: at,
    updatedAt: at,
  }));
  const r = await capture(s, "查一下以前的库存任务进度", [
    { type: "status", taskIds: [old.id] },
  ]);
  assert.ok(r.input.tasks.some((t: Task) => t.id === old.id));
  assert.ok(r.input.tasks.length <= 16);
  assert.doesNotMatch(
    JSON.stringify(r.input),
    /SECRET-OTHER-PROJECT|UNRELATED_REPORT|UNRELATED_PLAN_BODY/,
  );
});
test("a partial candidate set cannot silently apply a bulk stop or a mutation for a hidden ID", async () => {
  const s = fixture(Array.from({ length: 50 }, (_, i) => task(i, "running")));
  const peek = await capture(s, "停止所有正在运行的任务");
  const visible = peek.input.tasks[0].id;
  const hidden = s.tasks.find(
    (t) => !peek.input.tasks.some((x: Task) => x.id === t.id),
  );
  assert.ok(hidden);
  const result = await capture(s, "停止所有正在运行的任务", [
    { type: "stop", taskId: visible },
  ]);
  assert.deepEqual(
    result.decision.actions.map((a) => a.type),
    ["clarify"],
  );
  await assert.rejects(
    capture(s, "暂停刚才那个", [{ type: "stop", taskId: hidden.id }]),
    /不存在|上下文/,
  );
});
