import test from "node:test";
import assert from "node:assert/strict";
import { validateDescriptor, parseSSE } from "../apps/cli/main.js";
import type { Snapshot } from "../packages/contracts/index.js";

test("CLI rejects incompatible or non-loopback descriptors without disclosing tokens", () => {
  const descriptor = {
    url: "http://127.0.0.1:4317",
    token: "test-only-token",
    protocol: 1,
    pid: 123,
  };
  assert.deepEqual(validateDescriptor(descriptor), descriptor);
  for (const patch of [
    { url: "https://example.com" },
    { url: "http://127.0.0.1:4317/other" },
    { url: "http://user:pass@127.0.0.1:4317" },
    { protocol: 2 },
    { pid: 0 },
    { token: "" },
    { capabilities: "invalid" },
    { capabilities: [false] },
  ]) {
    assert.throws(
      () => validateDescriptor({ ...descriptor, ...patch }),
      (error) =>
        error instanceof Error && !error.message.includes("test-only-token"),
    );
  }
});

test("CLI SSE parser accepts fragmented UTF-8 state frames and ignores keepalives", async () => {
  const snapshot = {
    tasks: [],
    agents: [],
    messages: [{ id: "m1", text: "中文消息" }],
    questions: [],
    model: null,
  } as unknown as Snapshot;
  const bytes = new TextEncoder().encode(
    ": keepalive\r\n\r\nevent: state\r\ndata: " +
      JSON.stringify(snapshot) +
      "\r\n\r\n",
  );
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 3)
        controller.enqueue(bytes.slice(i, i + 3));
      controller.close();
    },
  });
  const result = [];
  for await (const state of parseSSE(stream.getReader())) result.push(state);
  assert.deepEqual(result, [snapshot]);
});

test("acd starts from a caller directory outside the checkout, including spaces and Chinese characters", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const directory = await mkdtemp(join(tmpdir(), "acd 空格目录-"));
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL("../apps/cli/acd.mjs", import.meta.url)),
        "--help",
      ],
      { cwd: directory, timeout: 10000 },
    );
    assert.match(stdout, /acd send/);
    assert.doesNotMatch(stderr, /ERR_MODULE_NOT_FOUND/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("acd sessions reads the same native observation snapshot without inventing executable tasks", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { startServer } = await import("../packages/core/server.js");
  const directory = mkdtempSync(join(tmpdir(), "acd-cli-sessions-"));
  const session = {
    id: "native-" + "a".repeat(24),
    agentId: "fixture-codex",
    sessionId: "native-session-fixture",
    turnId: "turn-fixture",
    title: "Codex native",
    taskTitle: "检查原生任务",
    cwd: "/fixture",
    status: "running" as const,
    progress: "正在处理用户要求",
    observedAt: new Date().toISOString(),
  };
  const app = await startServer({
    directory,
    port: 0,
    nativeRead: async () => ({
      source: "run-events",
      state: "connected",
      message: "已核验当前执行",
      sessions: [session],
    }),
    deps: {
      scan: async () => [],
      vault: { get: async () => null, set: async () => {} },
      adapter: () => {
        throw Error("No execution");
      },
    },
  });
  app.runtime.store.put("agents", "fixture-codex", {
    id: "fixture-codex",
    name: "Codex",
    kind: "codex",
    selected: true,
    available: true,
    executable: "/not-executed",
    capabilities: { steer: true, resume: true },
  });
  const run = async (...args: string[]) =>
    promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL("../apps/cli/acd.mjs", import.meta.url)), ...args],
      { env: { ...process.env, ACD_DATA_DIR: directory }, timeout: 10000 },
    );
  try {
    await fetch(app.descriptor.url + "/api/observations/refresh", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + app.descriptor.token,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const json = await run("sessions", "--json");
    const observations = JSON.parse(json.stdout);
    assert.equal(observations[0].sessions[0].sessionId, session.sessionId);
    assert.equal(observations[0].sessions[0].status, "running");
    const human = await run("sessions");
    assert.match(human.stdout, /正在执行.*检查原生任务/);
    assert.equal(app.runtime.snapshot().tasks.length, 0);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
