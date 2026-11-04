import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../packages/core/server.js";
import { Runtime, type Dependencies } from "../packages/core/runtime.js";
import { Store } from "../packages/core/store.js";
import type { Task, Question } from "../packages/contracts/index.js";
const directory = () =>
  realpathSync(mkdtempSync(join(tmpdir(), "acd-receipt-")));
const vault = { get: async () => "fixture-only-key", set: async () => {} };
const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Fixture did not settle");
};
function baseStore(dir: string) {
  const store = new Store(dir);
  store.put("settings", "model", {
    providerId: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "fixture",
    hasKey: false,
  });
  return store;
}
test("concurrent retries reuse one receipt and start one task; changed payloads are rejected", async () => {
  const dir = directory();
  let routes = 0,
    starts = 0;
  const app = await startServer({
    directory: dir,
    port: 0,
    deps: {
      scan: async () => [],
      vault,
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
      route: async () => {
        routes++;
        return {
          reply: "",
          actions: [
            {
              type: "create",
              title: "Fixture",
              goal: "Read fixture",
              agentId: "agent",
              cwd: dir,
            },
          ],
        };
      },
    },
  });
  app.runtime.store.put("settings", "model", {
    providerId: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "fixture",
    hasKey: false,
  });
  app.runtime.store.put("agents", "agent", {
    id: "agent",
    name: "Fake",
    kind: "codex",
    executable: "never-launched",
    selected: true,
    available: true,
    capabilities: { steer: true, resume: true },
  });
  const headers = {
      Authorization: "Bearer " + app.descriptor.token,
      "Content-Type": "application/json",
    },
    id = randomUUID();
  const send = (text: string, clientMessageId: string = id) =>
    fetch(app.descriptor.url + "/api/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({ text, cwd: dir, clientMessageId }),
    });
  try {
    const health = await fetch(app.descriptor.url + "/api/health").then((r) =>
      r.json(),
    );
    assert.ok(health.capabilities.includes("message-idempotency"));
    const responses = await Promise.all([
      send("Read fixture"),
      send("Read fixture"),
    ]);
    assert.ok(responses.every((r) => r.status === 202));
    const receipts = await Promise.all(responses.map((r) => r.json()));
    assert.equal(receipts[0].id, id);
    assert.equal(receipts[1].id, id);
    await until(() => starts === 1);
    assert.equal(routes, 1);
    assert.equal(app.runtime.snapshot().tasks.length, 1);
    assert.equal((await send("Changed requirement")).status, 400);
    assert.equal((await send("bad id", "not-a-uuid")).status, 400);
    assert.equal(routes, 1);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("receipts remain idempotent across restart and beyond the visible history window", async () => {
  const dir = directory(),
    id = randomUUID();
  let calls = 0;
  const deps: Dependencies = {
    scan: async () => [],
    vault,
    adapter: () => {
      throw Error("must not launch");
    },
    route: async () => {
      calls++;
      return { reply: "ok", actions: [] };
    },
  };
  let store = baseStore(dir),
    runtime = new Runtime(store, deps);
  try {
    const first = runtime.receive("Original fixture", dir, undefined, id);
    await until(() => calls === 1);
    for (let index = 0; index < 205; index++)
      store.message({
        id: randomUUID(),
        role: "assistant",
        text: "Synthetic history " + index,
        taskIds: [],
        createdAt: new Date().toISOString(),
      });
    assert.equal(
      store.history().some((m) => m.id === id),
      false,
    );
    assert.equal(
      runtime.receive("Original fixture", dir, undefined, id).id,
      first.id,
    );
    assert.equal(calls, 1);
    runtime.shutdown();
    store.close();
    store = new Store(dir);
    runtime = new Runtime(store, deps);
    assert.equal(
      runtime.receive("Original fixture", dir, undefined, id).id,
      id,
    );
    assert.equal(calls, 1);
    runtime.receive("Original fixture", dir, undefined, randomUUID());
    await until(() => calls === 2);
  } finally {
    runtime.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("clarification accepts a free-form correction while native approvals retain exact choices", async () => {
  const dir = directory(),
    store = baseStore(dir);
  const routed: string[] = [];
  const runtime = new Runtime(store, {
    scan: async () => [],
    vault,
    adapter: () => {
      throw Error("must not launch");
    },
    route: async (_c, _k, _s, text) => {
      routed.push(text);
      return { reply: "", actions: [] };
    },
  });
  const q: Question & { cwd: string; sourceMessageId: string } = {
    id: "clarification",
    kind: "clarification",
    text: "Which task?",
    choices: ["task-a", "task-b"],
    resolved: false,
    cwd: dir,
    sourceMessageId: "original-message",
  };
  store.message({
    id: q.sourceMessageId,
    role: "user",
    text: "原始的项目要求",
    taskIds: [],
    createdAt: new Date().toISOString(),
  });
  for (let index = 0; index < 205; index++)
    store.message({
      id: randomUUID(),
      role: "assistant",
      text: "Synthetic intervening message",
      taskIds: [],
      createdAt: new Date().toISOString(),
    });
  store.put("questions", q.id, q);
  try {
    store.put("questions", q.id, { ...q, cwd: join(dir, "missing") });
    await assert.rejects(runtime.answer(q.id, "暂时无法发送"));
    assert.equal(store.get<Question>("questions", q.id)?.resolved, false);
    store.put("questions", q.id, q);
    await runtime.answer(q.id, "这是一项新任务，和上面的任务无关");
    await until(() => routed.length === 1);
    assert.match(routed[0], /新任务/);
    assert.match(routed[0], /原始的项目要求/);
    assert.equal(store.get<Question>("questions", q.id)?.resolved, true);
    store.put("questions", "approval", {
      id: "approval",
      kind: "approval",
      text: "Allow?",
      choices: ["accept", "decline"],
      resolved: false,
    });
    await assert.rejects(runtime.answer("approval", "随便执行"), /选项无效/);
  } finally {
    runtime.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("a queued task recovered as blocked can be cancelled without pretending it started", async () => {
  const dir = directory(),
    store = baseStore(dir);
  const now = new Date().toISOString();
  store.put("tasks", "queued", {
    id: "queued",
    title: "Not started",
    goal: "Fixture",
    cwd: dir,
    agentId: "none",
    status: "queued",
    revision: 1,
    progress: "Queued",
    createdAt: now,
    updatedAt: now,
  } satisfies Task);
  const runtime = new Runtime(store, {
    scan: async () => [],
    vault,
    adapter: () => {
      throw Error("must not launch");
    },
  });
  try {
    assert.equal(runtime.snapshot().tasks[0].status, "blocked");
    await runtime.stop("queued");
    assert.equal(runtime.snapshot().tasks[0].status, "cancelled");
  } finally {
    runtime.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
