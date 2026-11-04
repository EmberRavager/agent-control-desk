import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentConnection,
  AllocationSettings,
  StartRun,
} from "../packages/contracts/index.js";
import {
  allocateAgent,
  effectiveCapabilities,
} from "../packages/core/allocation.js";
import { Runtime, type Dependencies } from "../packages/core/runtime.js";
import { Store } from "../packages/core/store.js";
import { startServer } from "../packages/core/server.js";

const agent = (
  id: string,
  kind: AgentConnection["kind"] = "codex",
): AgentConnection => ({
  id,
  kind,
  name: id,
  executable: "/fixture/" + id,
  selected: true,
  available: true,
  supported: true,
  capabilities: { steer: ["codex", "pi"].includes(kind), resume: true },
});
const agents = [agent("codex"), agent("claude", "claude"), agent("pi", "pi")];
const defaults: AllocationSettings = {
  globalAgentId: null,
  projectAgentIds: {},
};
const model = {
  providerId: "ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "fixture",
  hasKey: false,
};
const noVault = { get: async () => null, set: async () => {} };
async function until(check: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Allocation fixture did not settle");
}
function fixture(route: Dependencies["route"]) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "acd-allocation-test-")),
  );
  const store = new Store(directory);
  for (const a of agents) store.put("agents", a.id, a);
  store.put("settings", "model", model);
  const starts: StartRun[] = [];
  const runtime = new Runtime(store, {
    scan: async () => [],
    vault: noVault,
    route,
    adapter: () => ({
      start: async (run) => {
        starts.push(run);
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
    starts,
    close() {
      runtime.shutdown();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("allocation priority is explicit, project default, global default, sole candidate, model suggestion", () => {
  const settings = {
    globalAgentId: "codex",
    projectAgentIds: { "/fixture": "claude" },
  };
  const choose = (
    overrides: Partial<Parameters<typeof allocateAgent>[0]> = {},
  ) =>
    allocateAgent({
      agents,
      cwd: "/fixture",
      settings,
      suggestedAgentId: "pi",
      ...overrides,
    });
  assert.equal(
    choose({ request: { targetAgentId: "pi" } }).allocation.source,
    "explicit",
  );
  assert.equal(choose().agent.id, "claude");
  assert.equal(choose({ cwd: "/other" }).allocation.source, "global-default");
  assert.equal(
    choose({ settings: defaults, agents: [agents[2]] }).allocation.source,
    "single-candidate",
  );
  assert.equal(choose({ settings: defaults }).allocation.source, "model");
  assert.equal(choose({ settings: defaults }).agent.id, "pi");
});

test("hard capability constraints exclude defaults; explicit mismatches never silently switch", () => {
  const input = {
    agents,
    cwd: "/fixture",
    settings: { globalAgentId: "claude", projectAgentIds: {} },
    suggestedAgentId: "codex",
    requiredCapabilities: ["steer" as const],
  };
  const result = allocateAgent(input);
  assert.equal(result.agent.id, "codex");
  assert.match(result.allocation.reason, /全局默认 Agent未采用/);
  assert.deepEqual(result.allocation.excluded, [
    { agentId: "claude", reason: "不支持执行中追加" },
  ]);
  assert.throws(
    () => allocateAgent({ ...input, request: { targetAgentId: "claude" } }),
    /未改派/,
  );
  assert.throws(
    () => allocateAgent({ ...input, agents: [agents[1]] }),
    /没有满足/,
  );
  assert.throws(
    () => allocateAgent({ ...input, request: { targetAgentId: "missing" } }),
    /未改派/,
  );
  assert.throws(
    () =>
      allocateAgent({
        ...input,
        agents: agents.map((a) => ({ ...a, available: false })),
        request: { targetAgentId: "codex" },
      }),
    /未改派/,
  );
});

test("candidate ordering does not change a valid model choice, unknown suggestions do not start arbitrary candidates", () => {
  for (const list of [
    agents,
    [...agents].reverse(),
    [agents[1], agents[2], agents[0]],
  ]) {
    assert.equal(
      allocateAgent({
        agents: list,
        cwd: "/fixture",
        settings: defaults,
        suggestedAgentId: "pi",
      }).agent.id,
      "pi",
    );
    assert.throws(
      () =>
        allocateAgent({
          agents: list,
          cwd: "/fixture",
          settings: defaults,
          suggestedAgentId: "missing",
        }),
      /未给出符合要求/,
    );
  }
});

test("protocol capability defaults describe the existing adapters without promising unsupported interactions", () => {
  assert.deepEqual(effectiveCapabilities(agent("c", "claude")), {
    steer: false,
    resume: true,
    approval: false,
    input: false,
  });
  assert.equal(effectiveCapabilities(agent("o", "opencode")).approval, true);
  assert.equal(effectiveCapabilities(agent("o", "opencode")).input, false);
  assert.equal(effectiveCapabilities(agent("p", "pi")).input, true);
  assert.equal(
    effectiveCapabilities({ ...agent("p", "pi"), supported: false }).input,
    false,
  );
});

test("runtime binds explicit selection, persists its reason, and keeps supplements on the original executor", async () => {
  const x = fixture(async (_c, _k, snapshot, text, cwd) => ({
    reply: "",
    actions:
      text === "continue"
        ? [
            {
              type: "supplement",
              taskId: snapshot.tasks[0].id,
              expectedRevision: snapshot.tasks[0].revision,
              text: "continue",
            },
          ]
        : [{ type: "create", title: text, goal: text, cwd, agentId: "claude" }],
  }));
  try {
    x.runtime.receive("new", x.directory, undefined, undefined, undefined, {
      targetAgentId: "codex",
      requiredCapabilities: ["steer"],
    });
    await until(() => x.starts.length === 1);
    const task = x.runtime.snapshot().tasks[0];
    assert.equal(task.agentId, "codex");
    assert.equal(task.allocation?.source, "explicit");
    assert.match(task.allocation?.reason || "", /按本次指定/);
    const next = x.runtime.receive(
      "continue",
      x.directory,
      task.id,
      undefined,
      undefined,
      { targetAgentId: "pi" },
    );
    await until(
      () => x.store.getMessage(next.id)?.routing?.status === "completed",
    );
    assert.equal(x.runtime.snapshot().tasks[0].agentId, "codex");
    assert.equal(x.starts.length, 1);
  } finally {
    x.close();
  }
});

test("natural-language explicit executor outranks defaults and a structured selection outranks model extraction", async () => {
  const x = fixture(async (_c, _k, _s, text, cwd) => ({
    reply: "",
    actions: [
      {
        type: "create",
        title: text,
        goal: text,
        cwd,
        agentId: "pi",
        requestedAgentId: "claude",
      },
    ],
  }));
  try {
    x.runtime.configureAllocation({ agentId: "codex" });
    x.runtime.receive("use claude", x.directory);
    await until(() => x.starts.length === 1);
    assert.equal(x.starts[0].task.agentId, "claude");
    x.starts[0].onEvent({ type: "completed" });
    x.runtime.receive(
      "UI overrides",
      x.directory,
      undefined,
      undefined,
      undefined,
      { targetAgentId: "pi" },
    );
    await until(() => x.starts.length === 2);
    assert.equal(x.starts[1].task.agentId, "pi");
  } finally {
    x.close();
  }
});

test("execution checks the selected executor again after directory wait without changing UNKNOWN recovery", async () => {
  const x = fixture(async (_c, _k, _s, text, cwd) => ({
    reply: "",
    actions: [
      {
        type: "create",
        title: text,
        goal: text,
        cwd,
        agentId: text === "first" ? "codex" : "pi",
      },
    ],
  }));
  try {
    x.runtime.receive("first", x.directory);
    await until(() => x.starts.length === 1);
    x.runtime.receive("second", x.directory);
    await until(() => x.runtime.snapshot().tasks.length === 2);
    x.store.put("agents", "pi", { ...agents[2], available: false });
    x.starts[0].onEvent({ type: "completed" });
    await until(() =>
      x.runtime
        .snapshot()
        .tasks.some((t) => t.title === "second" && t.status === "blocked"),
    );
    assert.equal(x.starts.length, 1);
    assert.equal(
      x.runtime.snapshot().tasks.find((t) => t.title === "second")?.agentId,
      "pi",
    );
  } finally {
    x.close();
  }
});

test("retry, clarification and idempotency preserve normalized execution constraints", async () => {
  let calls = 0;
  const seen: unknown[] = [];
  const x = fixture(
    async (_c, _k, _s, _text, _cwd, _target, _signal, options) => {
      seen.push(options);
      if (++calls === 1) throw Error("synthetic model failure");
      return calls === 2
        ? {
            reply: "",
            actions: [{ type: "clarify", text: "which task?", taskIds: [] }],
          }
        : { reply: "accepted", actions: [] };
    },
  );
  try {
    const id = randomUUID(),
      options = {
        targetAgentId: "pi",
        requiredCapabilities: [
          "input" as const,
          "steer" as const,
          "input" as const,
        ],
      };
    x.runtime.receive(
      "ambiguous",
      x.directory,
      undefined,
      id,
      undefined,
      options,
    );
    await until(() => x.store.getMessage(id)?.routing?.status === "failed");
    assert.equal(
      x.runtime.receive("ambiguous", x.directory, undefined, id, undefined, {
        targetAgentId: "pi",
        requiredCapabilities: ["steer", "input"],
      }).id,
      id,
    );
    assert.equal(calls, 1);
    assert.throws(
      () =>
        x.runtime.receive("ambiguous", x.directory, undefined, id, undefined, {
          targetAgentId: "codex",
        }),
      /编号/,
    );
    x.runtime.retryRouting(id);
    await until(() => x.runtime.snapshot().questions.length === 1);
    await x.runtime.answer(x.runtime.snapshot().questions[0].id, "new task");
    await until(() => calls === 3);
    assert.deepEqual(
      seen,
      Array.from({ length: 3 }, () => ({
        targetAgentId: "pi",
        requiredCapabilities: ["input", "steer"],
      })),
    );
    const latest = x.runtime
      .snapshot()
      .messages.filter((m) => m.role === "user")
      .at(-1)!;
    assert.equal(latest.request?.targetAgentId, "pi");
    assert.deepEqual(latest.request?.requiredCapabilities, ["input", "steer"]);
  } finally {
    x.close();
  }
});

test("invalid explicit and model executors never start a task", async () => {
  const x = fixture(async (_c, _k, _s, text, cwd) => ({
    reply: "",
    actions: [
      { type: "create", title: text, goal: text, cwd, agentId: "missing" },
    ],
  }));
  try {
    for (const options of [
      { targetAgentId: "missing" },
      { targetAgentId: "claude", requiredCapabilities: ["steer" as const] },
      {},
    ]) {
      const m = x.runtime.receive(
        "new",
        x.directory,
        undefined,
        undefined,
        undefined,
        options,
      );
      await until(() =>
        x.runtime
          .snapshot()
          .messages.some((reply) => reply.replyTo === m.id && reply.attention),
      );
    }
    assert.equal(x.starts.length, 0);
    assert.equal(x.runtime.snapshot().tasks.length, 0);
  } finally {
    x.close();
  }
});

test("allocation HTTP settings validate, canonicalize paths, persist and support clearing", async () => {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "acd-allocation-http-")),
  );
  const project = join(directory, "project");
  mkdirSync(project);
  const app = await startServer({
    directory,
    port: 0,
    deps: {
      scan: async () => agents,
      vault: noVault,
      adapter: () => {
        throw Error("no execution");
      },
    },
  });
  const headers = {
    Authorization: "Bearer " + app.descriptor.token,
    "Content-Type": "application/json",
  };
  const put = (body: unknown) =>
    fetch(app.descriptor.url + "/api/allocation", {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });
  try {
    for (const a of agents) app.runtime.store.put("agents", a.id, a);
    assert.ok(app.descriptor.capabilities?.includes("agent-allocation"));
    assert.equal(
      (await fetch(app.descriptor.url + "/api/allocation")).status,
      401,
    );
    assert.equal((await put({ agentId: "missing" })).status, 400);
    assert.equal(
      (await put({ agentId: "codex", projectPath: "." })).status,
      400,
    );
    assert.equal(
      (await put({ agentId: "codex", projectPath: join(directory, "missing") }))
        .status,
      400,
    );
    assert.equal((await put({ agentId: "codex", extra: true })).status, 400);
    assert.equal((await put({ agentId: "codex" })).status, 200);
    const result = await put({
      agentId: "pi",
      projectPath: join(project, "."),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), {
      globalAgentId: "codex",
      projectAgentIds: { [realpathSync(project)]: "pi" },
    });
    const saved = app.runtime.snapshot().allocationSettings;
    assert.deepEqual(
      await (
        await fetch(app.descriptor.url + "/api/allocation", { headers })
      ).json(),
      saved,
    );
    const invalid = await fetch(app.descriptor.url + "/api/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: "x",
        cwd: project,
        requiredCapabilities: ["unknown"],
      }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await app.close();
  }
  const store = new Store(directory);
  const runtime = new Runtime(store, {
    scan: async () => [],
    vault: noVault,
    adapter: () => {
      throw Error("no execution");
    },
  });
  try {
    assert.equal(runtime.allocationSettings().globalAgentId, "codex");
    assert.equal(runtime.allocationSettings().projectAgentIds[project], "pi");
    rmSync(project, { recursive: true });
    runtime.configureAllocation({ agentId: null, projectPath: project });
    runtime.configureAllocation({ agentId: null });
    assert.deepEqual(runtime.allocationSettings(), defaults);
  } finally {
    runtime.shutdown();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("immediate-task allocation options cannot be silently ignored by a scheduled creation", async () => {
  const x = fixture(async (_config, _key, _snapshot, _text, cwd) => ({
    reply: "",
    actions: [
      {
        type: "schedule_create",
        input: {
          name: "synthetic",
          prompt: "检查",
          cwd,
          agentId: "claude",
          rule: { kind: "interval", minutes: 60 },
        },
      },
    ],
  }));
  try {
    const message = x.runtime.receive(
      "以后执行",
      x.directory,
      undefined,
      undefined,
      undefined,
      { targetAgentId: "codex", requiredCapabilities: ["steer"] },
    );
    await until(
      () => x.store.getMessage(message.id)?.routing?.status === "completed",
    );
    assert.equal(x.runtime.schedules.list().length, 0);
    assert.equal(x.starts.length, 0);
    assert.ok(
      x.runtime
        .snapshot()
        .messages.some(
          (item) =>
            item.attention && item.text.includes("定时任务”页面选择执行者"),
        ),
    );
    assert.equal(
      x.store.getMessage(message.id)?.request?.targetAgentId,
      "codex",
    );
  } finally {
    x.close();
  }
});
