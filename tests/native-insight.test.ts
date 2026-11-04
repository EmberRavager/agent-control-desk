import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../packages/core/server.js";
import type { NativeSession } from "../packages/contracts/index.js";

test("native insight is authenticated, read-only, coalesced in flight, and cached per model and execution", async () => {
  let calls = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = createServer(async (req, res) => {
    calls++;
    let raw = "";
    req.setEncoding("utf8");
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.match(
      body.messages[0].content,
      /只读任务观察员|只读任务观察|只读任务/,
    );
    const input = JSON.parse(body.messages[1].content);
    assert.equal(input.session.status, "running");
    assert.deepEqual(input.requirements, { original: "", amendments: [] });
    assert.deepEqual(input.execution.publicUpdates, []);
    await gate;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "检查当前项目",
                summary: "正在检查当前项目。",
                goal: "检查项目",
                currentStep: "核验现有状态",
                blocker: "",
                nextStep: "汇报检查结果",
              }),
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const directory = mkdtempSync(join(tmpdir(), "acd-native-insight-"));
  const id = "native-" + "a".repeat(24);
  const session: NativeSession = {
    id,
    agentId: "fixture-codex",
    sessionId: "fixture-thread",
    turnId: "turn-1",
    title: "Fixture",
    cwd: "/fixture",
    status: "running",
    progress: "Running",
    observedAt: new Date().toISOString(),
  };
  const app = await startServer({
    directory,
    port: 0,
    nativeRead: async () => ({
      source: "runtime-api",
      state: "connected",
      message: "Connected",
      sessions: [session],
    }),
    deps: {
      scan: async () => [],
      vault: { get: async () => null, set: async () => {} },
      adapter: () => {
        throw Error("No native execution");
      },
    },
  });
  app.runtime.store.put("agents", "fixture-codex", {
    id: "fixture-codex",
    kind: "codex",
    name: "Codex",
    selected: true,
    available: true,
    executable: "/not-executed",
    capabilities: { steer: true, resume: true },
  });
  const headers = {
    Authorization: "Bearer " + app.descriptor.token,
    "Content-Type": "application/json",
  };
  const post = (path: string, body: unknown = {}) =>
    fetch(app.descriptor.url + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  try {
    await app.runtime.configure({
      providerId: "ollama",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "fixture",
    });
    await post("/api/observations/refresh");
    for (let n = 0; n < 100 && calls === 0; n++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      calls,
      1,
      "new active work is analyzed before opening its detail page",
    );
    const path = `/api/observations/${id}/analyze`;
    assert.equal(
      (
        await fetch(app.descriptor.url + path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
    assert.equal((await post(path, { content: "arbitrary" })).status, 400);
    assert.equal(
      (await post("/api/observations/native-" + "b".repeat(24) + "/analyze"))
        .status,
      404,
    );
    const first = post(path),
      second = post(path);
    assert.equal(calls, 1);
    release();
    const responses = await Promise.all([first, second]);
    for (const response of responses) {
      assert.equal(response.status, 200);
      const value = await response.json();
      assert.equal(value.title, "用户目标待同步");
      assert.equal(value.goal, "");
      assert.deepEqual(value.requirements, []);
      assert.equal(value.basis, "metadata");
    }
    assert.equal(
      app.runtime.snapshot().observations?.[0].sessions[0].taskTitle,
      undefined,
      "metadata-only analysis must not freeze a guessed task title",
    );
    await post("/api/observations/refresh");
    assert.equal((await post(path)).status, 200);
    assert.equal(calls, 1);
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + 31000;
      assert.equal((await post(path)).status, 200);
      assert.equal(
        calls,
        1,
        "unchanged public input must not consume model inference after cache expiry",
      );
    } finally {
      Date.now = originalNow;
    }
    assert.equal((await post(path, { force: true })).status, 200);
    assert.equal(calls, 2);
    await app.runtime.configure({
      providerId: "ollama",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "fixture-new",
    });
    assert.equal((await post(path)).status, 200);
    assert.equal(calls, 3);
    assert.equal(app.runtime.snapshot().tasks.length, 0);
    assert.equal(app.runtime.snapshot().messages.length, 0);
  } finally {
    release();
    await app.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
