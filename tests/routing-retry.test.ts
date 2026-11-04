import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/core/store.js";
import { Runtime, type Dependencies } from "../packages/core/runtime.js";
import { startServer } from "../packages/core/server.js";

const model = {
  providerId: "ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "fixture",
  hasKey: false,
};
const deps = (route: Dependencies["route"]): Dependencies => ({
  scan: async () => [],
  vault: { get: async () => null, set: async () => {} },
  route,
  adapter: () => {
    throw Error("No execution expected");
  },
});
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Retry fixture did not settle");
}
function fixture(route: Dependencies["route"]) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "acd-routing-retry-")),
  );
  const store = new Store(directory);
  store.put("settings", "model", model);
  const runtime = new Runtime(store, deps(route));
  return {
    directory,
    store,
    runtime,
    close() {
      runtime.shutdown();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("failed understanding retries the original message once, while transport resends remain idempotent", async () => {
  let calls = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const x = fixture(async () => {
    if (++calls === 1) throw Error("Synthetic unavailable");
    await gate;
    return { reply: "你好", actions: [] };
  });
  try {
    const id = randomUUID();
    x.runtime.receive("你好", x.directory, undefined, id);
    await until(() => x.store.getMessage(id)?.routing?.status === "failed");
    assert.equal(x.store.getMessage(id)?.routing?.retryable, true);
    x.runtime.receive("你好", x.directory, undefined, id);
    assert.equal(calls, 1, "network retry must not rerun understanding");
    const first = x.runtime.retryRouting(id),
      second = x.runtime.retryRouting(id);
    assert.equal(first.id, id);
    assert.equal(second.id, id);
    assert.equal(calls, 2);
    assert.equal(x.store.getMessage(id)?.routing?.status, "pending");
    release();
    await until(() => x.store.getMessage(id)?.routing?.status === "completed");
    assert.equal(
      x.runtime.snapshot().messages.filter((m) => m.role === "user").length,
      1,
    );
    assert.equal(x.runtime.snapshot().tasks.length, 0);
    assert.equal(x.runtime.retryRouting(id).routing?.status, "completed");
    assert.equal(x.store.getMessage(id)?.routing?.attempt, 1);
    assert.equal(
      calls,
      2,
      "a lost retry response must not trigger another interpretation after completion",
    );
  } finally {
    release();
    x.close();
  }
});

test("an interrupted pre-action request survives restart and requires an explicit retry", async () => {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "acd-retry-restart-")),
  );
  const id = randomUUID();
  let store = new Store(directory);
  store.put("settings", "model", model);
  store.message({
    id,
    role: "user",
    text: "继续讨论",
    taskIds: [],
    createdAt: new Date().toISOString(),
    request: { cwd: directory },
    routing: { status: "pending", actions: [] },
  });
  store.close();
  store = new Store(directory);
  let calls = 0;
  const runtime = new Runtime(
    store,
    deps(async () => {
      calls++;
      return { reply: "继续讨论", actions: [] };
    }),
  );
  try {
    assert.equal(calls, 0);
    assert.equal(store.getMessage(id)?.routing?.status, "interrupted");
    assert.equal(store.getMessage(id)?.routing?.retryable, true);
    runtime.retryRouting(id);
    await until(() => store.getMessage(id)?.routing?.status === "completed");
    assert.equal(calls, 1);
    assert.equal(
      runtime.snapshot().messages.filter((m) => m.role === "user").length,
      1,
    );
  } finally {
    runtime.shutdown();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("applied decisions, legacy failures, assistant messages and missing scope cannot be replayed", async () => {
  let calls = 0;
  const x = fixture(async () => {
    calls++;
    return {
      reply: "",
      actions: [{ type: "clarify", text: "请指定目标", taskIds: [] }],
    };
  });
  try {
    const original = x.runtime.receive("那个", x.directory);
    await until(
      () => x.store.getMessage(original.id)?.routing?.status === "completed",
    );
    assert.throws(
      () => x.runtime.retryRouting(original.id),
      /不能安全重新判断/,
    );
    for (const data of [
      {
        role: "user" as const,
        routing: { status: "failed" as const, actions: [] },
      },
      {
        role: "assistant" as const,
        routing: { status: "failed" as const, actions: [], retryable: true },
      },
      {
        role: "user" as const,
        routing: { status: "failed" as const, actions: [], retryable: true },
      },
    ]) {
      const id = randomUUID();
      x.store.message({
        id,
        text: "Legacy fixture",
        taskIds: [],
        createdAt: new Date().toISOString(),
        ...data,
      });
      assert.throws(() => x.runtime.retryRouting(id));
    }
    assert.equal(calls, 1);
    assert.equal(x.runtime.snapshot().questions.length, 1);
  } finally {
    x.close();
  }
});

test("an inaccessible directory or missing original target prevents a retry before another model request", async () => {
  let calls = 0;
  const x = fixture(async () => {
    calls++;
    throw Error("Synthetic failure");
  });
  try {
    const original = x.runtime.receive("只读检查", x.directory);
    await until(
      () => x.store.getMessage(original.id)?.routing?.retryable === true,
    );
    const message = x.store.getMessage(original.id)!;
    x.store.message({
      ...message,
      request: { cwd: join(x.directory, "missing-directory") },
    });
    assert.throws(() => x.runtime.retryRouting(original.id), /原工作目录/);
    x.store.message({
      ...message,
      request: { cwd: x.directory, targetTaskId: "missing-target" },
    });
    assert.throws(() => x.runtime.retryRouting(original.id), /原目标任务/);
    assert.equal(calls, 1);
  } finally {
    x.close();
  }
});

test("retry API and CLI share authentication, strict payloads and in-flight deduplication", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "acd-retry-api-")));
  let calls = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const app = await startServer({
    directory,
    port: 0,
    deps: deps(async () => {
      if (++calls === 1) throw Error("Synthetic unavailable");
      await gate;
      return { reply: "恢复成功", actions: [] };
    }),
  });
  app.runtime.store.put("settings", "model", model);
  const original = app.runtime.receive("你好", directory);
  const path = `/api/messages/${original.id}/retry`;
  const headers = {
    Authorization: "Bearer " + app.descriptor.token,
    "Content-Type": "application/json",
  };
  const post = (body: unknown = {}, auth = true) =>
    fetch(app.descriptor.url + path, {
      method: "POST",
      headers: auth ? headers : { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    await until(
      () =>
        app.runtime.store.getMessage(original.id)?.routing?.status === "failed",
    );
    assert.equal((await post({}, false)).status, 401);
    assert.equal((await post({ text: "replacement" })).status, 400);
    const first = await post();
    assert.equal(first.status, 202);
    const duplicate = await post();
    assert.equal(duplicate.status, 202);
    assert.equal(calls, 2);
    const cli = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL("../apps/cli/acd.mjs", import.meta.url)),
        "retry",
        original.id,
        "--json",
      ],
      { env: { ...process.env, ACD_DATA_DIR: directory }, timeout: 10000 },
    );
    assert.equal(JSON.parse(cli.stdout).id, original.id);
    assert.equal(calls, 2);
    release();
    await until(
      () =>
        app.runtime.store.getMessage(original.id)?.routing?.status ===
        "completed",
    );
    assert.equal((await post()).status, 202);
    assert.equal(calls, 2);
    assert.equal(
      app.runtime.snapshot().messages.filter((m) => m.role === "user").length,
      1,
    );
  } finally {
    release();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
