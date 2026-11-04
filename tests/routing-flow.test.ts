import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/core/store.js";
import { Runtime, type Dependencies } from "../packages/core/runtime.js";
import type { AgentConnection, Task } from "../packages/contracts/index.js";

const until = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Routing fixture did not settle");
};
function fixture(route?: Dependencies["route"]) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "acd-routing-flow-")),
  );
  const store = new Store(directory);
  store.put("settings", "model", {
    providerId: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "fixture",
    hasKey: false,
  });
  let starts = 0;
  const runtime = new Runtime(store, {
    scan: async () => [],
    vault: { get: async () => null, set: async () => {} },
    route,
    adapter: () => ({
      start: async () => {
        starts++;
        return {
          steer: async () => {},
          stop: async () => {},
          answer: async () => {},
          dispose() {},
        };
      },
    }),
  });
  return {
    directory,
    store,
    runtime,
    get starts() {
      return starts;
    },
    close() {
      runtime.shutdown();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("a model chat decision updates its receipt and never creates or starts a task", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const x = fixture(async () => {
    await gate;
    return { reply: "你好，请告诉我需要什么帮助。", actions: [] };
  });
  try {
    const message = x.runtime.receive(
      "你好",
      x.directory,
      undefined,
      randomUUID(),
    );
    assert.equal(x.store.getMessage(message.id)?.routing?.status, "pending");
    release();
    await until(
      () => x.store.getMessage(message.id)?.routing?.status === "completed",
    );
    assert.deepEqual(x.store.getMessage(message.id)?.routing?.actions, []);
    assert.equal(x.runtime.snapshot().tasks.length, 0);
    assert.equal(x.starts, 0);
    assert.ok(
      x.runtime
        .snapshot()
        .messages.some(
          (item) => item.role === "assistant" && item.text.startsWith("你好"),
        ),
    );
  } finally {
    x.close();
  }
});

test("real routing failures remain failures rather than falling back to task creation", async () => {
  const x = fixture(async () => {
    throw new DOMException("Fixture timeout", "TimeoutError");
  });
  try {
    const message = x.runtime.receive(
      "请解释项目分析方法",
      x.directory,
      undefined,
      randomUUID(),
    );
    await until(
      () => x.store.getMessage(message.id)?.routing?.status === "failed",
    );
    assert.equal(x.runtime.snapshot().tasks.length, 0);
    assert.equal(x.starts, 0);
    assert.ok(
      x.runtime
        .snapshot()
        .messages.some((item) => item.text.includes("请求超时")),
    );
  } finally {
    x.close();
  }
});

test("a stale task decision cannot be followed by a false success reply", async () => {
  const x = fixture(async () => ({
    reply: "所有要求都已更新完成。",
    actions: [
      {
        type: "supplement",
        taskId: "existing",
        text: "保留中文",
        expectedRevision: 1,
      },
    ],
  }));
  const now = new Date().toISOString();
  x.store.put("tasks", "existing", {
    id: "existing",
    title: "Existing",
    goal: "Original",
    agentId: "unused",
    cwd: x.directory,
    status: "review",
    revision: 2,
    progress: "Review",
    createdAt: now,
    updatedAt: now,
  } satisfies Task);
  try {
    const message = x.runtime.receive(
      "补充要求",
      x.directory,
      undefined,
      randomUUID(),
    );
    await until(
      () => x.store.getMessage(message.id)?.routing?.status === "completed",
    );
    await until(() =>
      x.runtime.snapshot().messages.some((item) => item.attention),
    );
    assert.equal(x.store.get<Task>("tasks", "existing")?.revision, 2);
    assert.ok(
      !x.runtime
        .snapshot()
        .messages.some((item) => item.text === "所有要求都已更新完成。"),
    );
    assert.equal(x.starts, 0);
  } finally {
    x.close();
  }
});

test("restart records interrupted understanding beyond the visible history without rerouting", () => {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "acd-interrupted-routing-")),
  );
  let store = new Store(directory);
  const id = randomUUID();
  store.message({
    id,
    role: "user",
    text: "Pending fixture",
    taskIds: [],
    createdAt: new Date().toISOString(),
    routing: { status: "pending", actions: [] },
  });
  for (let n = 0; n < 205; n++)
    store.message({
      id: randomUUID(),
      role: "assistant",
      text: "Fixture history",
      taskIds: [],
      createdAt: new Date().toISOString(),
    });
  store.close();
  store = new Store(directory);
  let calls = 0;
  const runtime = new Runtime(store, {
    scan: async () => [],
    vault: { get: async () => null, set: async () => {} },
    route: async () => {
      calls++;
      return { reply: "", actions: [] };
    },
    adapter: () => {
      throw Error("must not execute");
    },
  });
  try {
    assert.equal(store.getMessage(id)?.routing?.status, "interrupted");
    assert.equal(calls, 0);
    assert.equal(runtime.snapshot().tasks.length, 0);
  } finally {
    runtime.shutdown();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("status reports ACD visibility rather than claiming native agents have no other work", async () => {
  const x = fixture(async () => ({
    reply: "Codex 没有任何正在执行的任务。",
    actions: [{ type: "status", taskIds: [] }],
  }));
  try {
    const message = x.runtime.receive(
      "看下 Codex 在做什么",
      x.directory,
      undefined,
      randomUUID(),
    );
    await until(
      () => x.store.getMessage(message.id)?.routing?.status === "completed",
    );
    await until(() =>
      x.runtime
        .snapshot()
        .messages.some((item) => item.text.includes("其他会话尚未接入观测")),
    );
    assert.ok(
      !x.runtime
        .snapshot()
        .messages.some(
          (item) => item.text === "Codex 没有任何正在执行的任务。",
        ),
    );
    assert.equal(x.starts, 0);
  } finally {
    x.close();
  }
});

test("execution acknowledgements come from the runtime rather than a model's premature success claim", async () => {
  const x = fixture(async () => ({
    reply: "所有任务都已停止并验收完成。",
    actions: [{ type: "clarify", text: "你要停止哪一项任务？", taskIds: [] }],
  }));
  try {
    x.runtime.receive("那个先停一下", x.directory);
    await until(() => x.runtime.snapshot().questions.length === 1);
    assert.equal(x.runtime.snapshot().tasks.length, 0);
    assert.ok(
      !x.runtime
        .snapshot()
        .messages.some(
          (message) => message.text === "所有任务都已停止并验收完成。",
        ),
    );
  } finally {
    x.close();
  }
});

function createRoutingFixture(
  t: TestContext,
  titles: (input: { text: string }, tasks: Task[]) => Promise<string[]>,
) {
  const x = fixture();
  t.after(() => x.close());
  x.store.put("agents", "fixture", {
    id: "fixture",
    kind: "codex",
    name: "Fixture",
    executable: "/unused",
    selected: true,
    available: true,
    capabilities: { steer: true, resume: true },
  } satisfies AgentConnection);
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      const { messages } = JSON.parse(String(init.body));
      const { input, tasks } = JSON.parse(messages.at(-1).content);
      const actions = (await titles(input, tasks)).map((title) => ({
        type: "create",
        title,
        goal: input.text,
        agentId: "fixture",
      }));
      return Response.json({
        choices: [
          { message: { content: JSON.stringify({ reply: "", actions }) } },
        ],
      });
    },
  );
  return x;
}

test("concurrent model decisions on the same empty snapshot create one task and clarify the collision", async (t) => {
  const contexts: Task[][] = [];
  let finishFirst!: () => void;
  const gate = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const x = createRoutingFixture(t, async (input, tasks) => {
    contexts.push(tasks);
    if (input.text === "检查 README，别另建") {
      await gate;
      return ["ＲＥＡＤＭＥ，检查"];
    }
    return ["readme 检查"];
  });
  const slower = x.runtime.receive("检查 README，别另建", x.directory);
  const faster = x.runtime.receive("核对 README", x.directory);
  try {
    await until(
      () => x.store.getMessage(faster.id)?.routing?.status === "completed",
    );
    assert.deepEqual(contexts, [[], []]);
    assert.equal(x.store.getMessage(slower.id)?.routing?.status, "pending");
    assert.equal(x.starts, 1);
  } finally {
    finishFirst();
  }
  await until(
    () => x.store.getMessage(slower.id)?.routing?.status === "completed",
  );
  const { tasks, questions } = x.runtime.snapshot();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].sourceMessageId, faster.id);
  assert.equal(questions.length, 1);
  assert.deepEqual(questions[0].choices, [tasks[0].id]);
  assert.equal(questions[0].sourceMessageId, slower.id);
  assert.deepEqual(x.store.getMessage(slower.id)?.routing?.actions, [
    "clarify",
  ]);
  assert.equal(x.starts, 1);
});

test("duplicate actions within one decision clarify while unrelated work and an explicitly separate task can be created", async (t) => {
  const x = createRoutingFixture(t, async (input) =>
    input.text === "检查启动和部署说明"
      ? ["启动说明", "启动说明", "部署说明"]
      : ["启动说明"],
  );
  const original = x.runtime.receive("检查启动和部署说明", x.directory);
  await until(
    () => x.store.getMessage(original.id)?.routing?.status === "completed",
  );
  const first = x.runtime.snapshot();
  assert.deepEqual(
    first.tasks.map((task) => task.title),
    ["启动说明", "部署说明"],
  );
  assert.equal(first.questions.length, 1);
  assert.deepEqual(first.questions[0].choices, [first.tasks[0].id]);
  assert.deepEqual(x.store.getMessage(original.id)?.routing?.actions, [
    "create",
    "clarify",
  ]);

  const separate = x.runtime.receive(
    "独立另开一个任务，检查启动说明",
    x.directory,
  );
  await until(
    () => x.store.getMessage(separate.id)?.routing?.status === "completed",
  );
  const final = x.runtime.snapshot();
  assert.equal(final.tasks.length, 3);
  assert.equal(final.tasks[2].sourceMessageId, separate.id);
  assert.equal(final.questions.length, 1);
  assert.equal(x.starts, 1);
});

test("a broadcast creates separately addressed tasks with honest dispatch receipts", async (t) => {
  const x = fixture(async (_config, _key, _snapshot, _text, cwd) => ({
    reply: "",
    actions: ["codex", "claude"].map((id) => ({
      type: "create" as const,
      title: "今天天气",
      goal: "杭州今天天气怎么样？",
      agentId: id,
      requestedAgentId: id,
      cwd,
      responseKind: "answer" as const,
    })),
  }));
  t.after(() => x.close());
  for (const kind of ["codex", "claude"] as const)
    x.store.put("agents", kind, {
      id: kind,
      kind,
      name: kind === "codex" ? "Codex" : "Claude",
      available: true,
      selected: true,
      supported: true,
      executable: "/not-used",
      capabilities: { steer: true, resume: true },
    } satisfies AgentConnection);
  const request = x.runtime.receive(
    "问下 Codex 和 Claude 杭州今天天气",
    x.directory,
  );
  await until(
    () => x.store.getMessage(request.id)?.routing?.status === "completed",
  );
  const state = x.runtime.snapshot();
  assert.deepEqual(
    state.tasks.map((task) => [task.agentId, task.status, task.responseKind]),
    [
      ["codex", "running", "answer"],
      ["claude", "queued", "answer"],
    ],
  );
  for (const [i, task] of state.tasks.entries()) {
    const receipt = state.messages.find(
      (message) =>
        message.replyTo === request.id && message.taskIds.includes(task.id),
    );
    assert.ok(receipt);
    assert.ok(receipt.text.includes(i === 0 ? "Codex" : "Claude"));
    assert.ok(receipt.text.includes(task.goal));
    if (i === 1) assert.match(receipt.text, /排队|等待/);
  }
  assert.equal(x.starts, 1);
});

test("a small supervisor's wrapper or premature clarification hands the named agent the original question", async (t) => {
  const x = fixture();
  t.after(() => x.close());
  x.store.put("agents", "codex", {
    id: "codex",
    kind: "codex",
    name: "Codex",
    executable: "/unused",
    selected: true,
    available: true,
    capabilities: { steer: true, resume: true },
  } satisfies AgentConnection);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              reply: "",
              actions: [
                ++calls === 1
                  ? {
                      type: "clarify",
                      taskIds: [],
                      text: "请问你是想让我去问吗？",
                    }
                  : {
                      type: "create",
                      title: "比较权限",
                      agentId: "codex",
                      goal: "使用 Codex Agent 查询今天的天气情况并汇报结果。",
                    },
              ],
            }),
          },
        },
      ],
    }),
  );
  for (const [text, goal] of [
    ["问下codex今天天气", "今天天气"],
    [
      "请问一下 Codex，比较 Codex 和 Claude 的权限，只读，不调用工具。",
      "比较 Codex 和 Claude 的权限，只读，不调用工具。",
    ],
  ]) {
    const m = x.runtime.receive(text, x.directory);
    await until(
      () => x.store.getMessage(m.id)?.routing?.status === "completed",
    );
    const task = x.runtime
      .snapshot()
      .tasks.find((task) => task.sourceMessageId === m.id);
    assert.equal(task?.goal, goal);
    assert.equal(task?.agentId, "codex");
    if (goal === "今天天气") assert.equal(task?.responseKind, "answer");
  }
});

test("ambiguous product names, negative and deferred delegations keep the supervisor's clarification", async (t) => {
  const x = fixture();
  t.after(() => x.close());
  x.store.put("agents", "codex", {
    id: "codex",
    kind: "codex",
    name: "Codex",
    executable: "/unused",
    selected: true,
    available: true,
    capabilities: { steer: true, resume: true },
  } satisfies AgentConnection);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              reply: "",
              actions: [
                { type: "clarify", taskIds: [], text: "请说明你的意思。" },
              ],
            }),
          },
        },
      ],
    }),
  );
  for (const text of [
    "不要问下 Codex 今天天气",
    "问下 Codex 的配置",
    "问下 Codex 删除旧文件",
    "问下 Codex 和 Claude 的区别",
    "问下 Codex CLI 的参数",
    "问下 Codex，今天天气，等我确认再发送。",
  ]) {
    const m = x.runtime.receive(text, x.directory);
    await until(
      () => x.store.getMessage(m.id)?.routing?.status === "completed",
    );
    assert.deepEqual(x.store.getMessage(m.id)?.routing?.actions, ["clarify"]);
  }
  assert.equal(x.starts, 0);
});
