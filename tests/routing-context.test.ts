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

test("a partial list cannot resolve an ungrounded mutation and still permits an explicit selected task", async () => {
  const s = fixture(Array.from({ length: 30 }, (_, i) => task(i, "running")));
  const t = s.tasks[0],
    action = { type: "stop", taskId: t.id };
  assert.deepEqual(
    (await capture(s, "那个先停一下", [action])).decision.actions.map(
      (a) => a.type,
    ),
    ["clarify"],
  );
  assert.deepEqual(
    (await capture(s, "那个先停一下", [action], t.id)).decision.actions.map(
      (a) => a.type,
    ),
    ["stop"],
  );
});
test("non-greeting chat, an omitted title collision and a prior bulk status never export the full archive", async () => {
  const archived = Array.from({ length: 500 }, (_, i) => task(i));
  const state = fixture(archived);
  state.messages = [
    {
      id: "status-request",
      role: "user",
      text: "查看所有任务",
      taskIds: [],
      createdAt: at,
      request: { cwd },
      routing: { status: "completed", actions: ["status"] },
    },
    {
      id: "status-reply",
      role: "assistant",
      replyTo: "status-request",
      text: "PRIVATE BULK LIST",
      taskIds: [],
      createdAt: at,
    },
  ];
  const plain = await capture(state, "我们先讨论一下思路");
  assert.equal(plain.input.tasks.length, 0);
  assert.ok(!JSON.stringify(plain.input).includes("PRIVATE BULK LIST"));
  const busy = fixture(
    Array.from({ length: 45 }, (_, i) => ({
      ...task(i, "running"),
      title: `检查项目${i}`,
    })),
  );
  const missing = busy.tasks.at(-1)!;
  const r = await capture(busy, "请检查新收到的资料", [
    { type: "create", title: missing.title, goal: "检查", agentId: "codex" },
  ]);
  assert.ok(!r.input.tasks.some((x: Task) => x.id === missing.id));
  assert.deepEqual(
    r.decision.actions.map((a) => a.type),
    ["clarify"],
  );
});
test("a new project request omits another project's active work; an explicit title and global progress still resolve it", async () => {
  const foreign = { ...task(1, "running"), cwd: "/other", title: "检查发票" };
  const s = fixture([foreign]);
  assert.deepEqual(
    (await capture(s, "请检查这个项目的目录结构")).input.tasks,
    [],
  );
  assert.equal(
    (await capture(s, "检查发票的任务怎么样了")).input.tasks[0].id,
    foreign.id,
  );
  assert.equal(
    (await capture(s, "所有项目有哪些任务在跑")).input.tasks[0].id,
    foreign.id,
  );
});
test("the phrase 'selected old task' does not fill spare candidate slots with unrelated archived tasks", async () => {
  const s = fixture(Array.from({ length: 500 }, (_, i) => task(i)));
  const selected = s.tasks[220];
  const input = (
    await capture(s, "针对选中的旧任务再做一次复核", [], selected.id)
  ).input;
  assert.deepEqual(
    input.tasks.map((t: Task) => t.id),
    [selected.id],
  );
});
test("a single explicitly addressed executor survives a shortened context when the model returns only its suggestion", async () => {
  const s = fixture([]);
  s.agents = ["codex", "claude"].map((kind) => ({
    id: "local-" + kind,
    name: kind === "claude" ? "Claude Code" : "Codex",
    kind: kind as "claude" | "codex",
    executable: "/fixture",
    available: true,
    selected: true,
    capabilities: { steer: false, resume: true },
  }));
  const create = {
    type: "create",
    title: "检查说明",
    goal: "只读核验",
    agentId: "local-claude",
  };
  for (const [text, want] of [
    [
      "另建独立任务，交给 Claude Code，只读检查 LICENSE 并汇报。",
      "local-claude",
    ],
    ["不要交给 Claude Code，只读检查 LICENSE 并汇报。", undefined],
    ["比较 Claude Code 和 Codex", undefined],
  ]) {
    const r = await capture(s, text!, [create]);
    const a = r.decision.actions[0];
    assert.equal(a.type === "create" && a.requestedAgentId, want);
  }
});

test("a short follow-up keeps the latest native delivery as bounded source evidence", async () => {
  const state = fixture([]);
  state.messages = [
    {
      id: "native-report",
      role: "assistant",
      text: "Already pushed commit fixture-sha to feature/mvp.",
      taskIds: [],
      createdAt: at,
      completion: {
        id: "report",
        nativeId: "native-fixture",
        title: "打包并提交 GitHub",
        status: "ready",
        summary: "已推送 fixture-sha。",
        assessed: true,
      },
    },
  ];
  const input = (await capture(state, "github提交了吗")).input;
  assert.equal(input.recentReports.length, 1);
  assert.equal(input.recentReports[0].sourceId, "native-fixture");
  assert.match(input.recentReports[0].summary, /fixture-sha/);
  const greeting = (await capture(state, "你好")).input;
  assert.equal(greeting.recentReports.length, 0);
});

test("native report anchors exclude pending output, deduplicate sources and stay bounded", async () => {
  const state = fixture([]);
  state.messages = Array.from({ length: 20 }, (_, i) => ({
    id: "report-" + i,
    role: "assistant" as const,
    text: "PRIVATE_FULL_BODY".repeat(1000),
    taskIds: [],
    createdAt: at,
    completion: {
      id: "completion-" + i,
      nativeId: "native-" + (i % 3),
      title: "GitHub " + i,
      status: (i === 19 ? "pending" : "ready") as "pending" | "ready",
      summary: "Public evidence " + i,
      assessed: true,
    },
  }));
  const input = (await capture(state, "github提交了吗")).input;
  assert.equal(input.recentReports.length, 2);
  assert.equal(
    new Set(input.recentReports.map((r: any) => r.sourceId)).size,
    2,
  );
  assert.ok(!input.recentReports.some((r: any) => r.messageId === "report-19"));
  assert.ok(!JSON.stringify(input.recentReports).includes("PRIVATE_FULL_BODY"));
});
