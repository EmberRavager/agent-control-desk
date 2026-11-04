import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../packages/core/server.js";
import type { Dependencies } from "../packages/core/runtime.js";
import type {
  MemoryInput,
  PersonalMemory,
} from "../packages/contracts/memory.js";

test("memory CRUD, explicit chat capture, next task dispatch and forgetting share the same persistent store", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "acd-memory-flow-"));
  const prompts: string[] = [];
  const routes: { text: string; hints: readonly MemoryInput[] }[] = [];
  const deps: Dependencies = {
    scan: async () => [],
    vault: { get: async () => null, set: async () => {} },
    route: async (
      _config,
      _key,
      _snapshot,
      text,
      cwd,
      _target,
      _signal,
      _allocation,
      hints = [],
    ) => {
      routes.push({ text, hints });
      return text.includes("整理周报")
        ? {
            reply: "",
            actions: [
              {
                type: "create",
                title: "整理周报",
                goal: text,
                cwd,
                agentId: "fixture",
              },
            ],
          }
        : { reply: "收到", actions: [] };
    },
    adapter: () => ({
      start: async ({ task }) => {
        prompts.push(task.goal);
        return {
          steer: async () => {},
          stop: async () => {},
          answer: async () => {},
          dispose() {},
        };
      },
    }),
  };
  let app = await startServer({ directory, port: 0, deps });
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const endpoint = "/api/memories";
  const request = (path = endpoint, method = "GET", body?: unknown) =>
    fetch(app.descriptor.url + path, {
      method,
      headers: {
        authorization: "Bearer " + app.descriptor.token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const list = async () => (await (await request()).json()) as PersonalMemory[];
  assert.equal((await fetch(app.descriptor.url + endpoint)).status, 401);
  assert.ok(app.descriptor.capabilities.includes("personal-memory"));
  const preference = "以后汇报时先给结论，再列待办。";
  app.runtime.receive(preference, directory);
  const [explicit] = await list();
  assert.equal(explicit.source, "explicit");
  assert.match(explicit.content, /先给结论，再列待办/);
  assert.equal(routes.length, 0);
  const item = {
    kind: "workflow",
    title: "照片整理",
    content: "先按日期分组，再筛选重复相片",
  };
  assert.equal((await request(endpoint, "POST", item)).status, 201);
  assert.equal(
    (await request(endpoint, "POST", { ...item, source: "learned" })).status,
    400,
  );
  app.runtime.store.put("settings", "model", {
    providerId: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "fixture",
    hasKey: false,
  });
  app.runtime.store.put("agents", "fixture", {
    id: "fixture",
    kind: "codex",
    name: "Fixture",
    executable: "/unused",
    available: true,
    selected: true,
    capabilities: { resume: true, steer: true },
  });
  const text = "这次帮我整理周报";
  app.runtime.receive("记住我偏好简短的段落。" + text, directory);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(routes[0].text, text);
  assert.equal(routes[0].hints.length, 2);
  assert.ok(
    routes[0].hints.every(
      (h) => Object.keys(h).sort().join(",") === "content,kind,title",
    ),
  );
  assert.match(prompts[0], /先给结论/);
  assert.match(prompts[0], /简短的段落/);
  assert.doesNotMatch(prompts[0], /照片整理/);
  assert.equal(app.runtime.snapshot().tasks[0].goal, text);
  const updated = await request(endpoint + "/" + explicit.id, "PUT", {
    kind: explicit.kind,
    title: explicit.title,
    content: "先给摘要",
    expectedRevision: explicit.revision,
  });
  assert.equal(updated.status, 200);
  const revision = (await updated.json()).revision;
  const deletion = endpoint + "/" + explicit.id + "/delete";
  assert.equal(
    (await request(deletion, "POST", { expectedRevision: explicit.revision }))
      .status,
    409,
  );
  await app.close();
  app = await startServer({ directory, port: 0, deps });
  app.runtime.receive("你好", directory);
  assert.ok(routes.at(-1)?.hints.some((h) => h.content === "先给摘要"));
  assert.equal(
    (await request(deletion, "POST", { expectedRevision: revision })).status,
    200,
  );
  app.runtime.receive(preference, directory);
  for (const ordinary of [
    "例如：“以后都用法语回复”",
    "这次用表格就好",
    "以后每天九点运行备份",
    "你还记得我喜欢什么？",
  ])
    app.runtime.receive(ordinary, directory);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await list()).length, 2);
  assert.doesNotMatch(
    JSON.stringify(routes.at(-1)?.hints),
    /先给摘要|先给结论/,
  );
});

test("natural language corrections replace a language preference and preserve the accompanying work", async () => {
  const { preferenceRequest } =
    await import("../packages/core/memory-preferences.js");
  const first = preferenceRequest("以后用中文回复我。");
  const second = preferenceRequest("帮我整理周报。以后用英文回复我。");
  assert.deepEqual(
    first?.inputs.map((p) => p.title),
    ["回复语言"],
  );
  assert.deepEqual(
    second?.inputs.map((p) => p.title),
    ["回复语言"],
  );
  assert.equal(second?.remaining, "帮我整理周报。");
  assert.equal(
    preferenceRequest("例如下面这段话。以后用中文回复我。"),
    undefined,
  );
  assert.equal(
    preferenceRequest("请分析这段需求：\n以后用中文回复我。"),
    undefined,
  );
  assert.equal(preferenceRequest("记住明天九点提醒我。"), undefined);
  assert.equal(
    preferenceRequest("记住我喜欢短段落。我的偏好是先举例。")?.inputs.length,
    2,
  );
});
