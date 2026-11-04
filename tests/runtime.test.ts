import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/core/store.js";
import { Runtime } from "../packages/core/runtime.js";
import { startServer } from "../packages/core/server.js";
import type {
  AgentConnection,
  StartRun,
  RouteDecision,
} from "../packages/contracts/index.js";
const agent: AgentConnection = {
  id: "fake",
  kind: "codex",
  name: "Fake",
  executable: "/fake",
  selected: true,
  available: true,
  capabilities: { steer: true, resume: true },
};
const vault = {
  get: async () => "fake-test-key",
  set: async (_s: string) => {},
};
const wait = () => new Promise((r) => setTimeout(r, 20));
test("messages arrive concurrently, resources serialize execution, stale revisions cannot overwrite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acd-runtime-"));
  const store = new Store(dir);
  store.put("agents", agent.id, agent);
  store.put("settings", "model", {
    baseUrl: "http://127.0.0.1",
    model: "fake",
    hasKey: true,
  });
  const starts: StartRun[] = [];
  let release!: () => void;
  const paused = new Promise<void>((r) => (release = r));
  const runtime = new Runtime(store, {
    scan: async () => [agent],
    vault,
    adapter: () => ({
      start: async (input) => {
        starts.push(input);
        return {
          steer: async () => {},
          stop: async () => {},
          answer: async () => {},
          dispose() {},
        };
      },
    }),
    route: async (_c, _k, _s, text, cwd) => {
      if (text === "one") await paused;
      return {
        reply: "",
        actions: [
          { type: "create", title: text, goal: text, agentId: "fake", cwd },
        ],
      };
    },
  });
  try {
    runtime.receive("one", dir);
    runtime.receive("two", dir);
    await wait();
    assert.equal(starts.length, 1);
    assert.equal(starts[0].task.title, "two");
    release();
    await wait();
    assert.equal(runtime.snapshot().tasks.length, 2);
    assert.equal(starts.length, 1);
    assert.equal(
      runtime.snapshot().tasks.find((t) => t.title === "one")?.status,
      "queued",
    );
    starts[0].onEvent({ type: "completed" });
    await wait();
    assert.equal(starts.length, 2);
    assert.equal(
      runtime.snapshot().tasks.find((t) => t.title === "two")?.status,
      "review",
    );
    runtime.accept(starts[0].task.id);
    assert.equal(
      runtime.snapshot().tasks.find((t) => t.title === "two")?.status,
      "completed",
    );
  } finally {
    runtime.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("HTTP clients require auth, browser origins rejected, config never exposes key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acd-http-"));
  const app = await startServer({
    directory: dir,
    port: 0,
    deps: {
      scan: async () => [{ ...agent, selected: false }],
      vault,
      adapter: () => {
        throw Error("must not execute");
      },
    },
  });
  const headers = {
    Authorization: "Bearer " + app.descriptor.token,
    "Content-Type": "application/json",
  };
  try {
    assert.equal((await fetch(app.descriptor.url + "/api/state")).status, 401);
    assert.equal(
      (
        await fetch(app.descriptor.url + "/api/state", {
          headers: { ...headers, Origin: "https://outside.example" },
        })
      ).status,
      403,
    );
    const configured = await fetch(app.descriptor.url + "/api/model", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        baseUrl: "http://127.0.0.1:9999/v1",
        model: "fake",
        apiKey: "private-test-key",
      }),
    });
    assert.equal(configured.status, 200);
    assert.ok(!(await configured.text()).includes("private-test-key"));
    assert.ok(
      !readFileSync(join(dir, "state.sqlite")).includes(
        Buffer.from("private-test-key"),
      ),
    );
    assert.equal(
      (
        await fetch(app.descriptor.url + "/api/agents/scan", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      200,
    );
    assert.equal(app.runtime.snapshot().agents[0].selected, false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provider configuration resolves defaults and keeps keys scoped when switching services", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acd-provider-http-"));
  const keys = new Map<string, string>();
  const app = await startServer({
    directory: dir,
    port: 0,
    deps: {
      scan: async () => [],
      adapter: () => {
        throw Error("must not execute");
      },
      vault: {
        get: async (url: string) => keys.get(new URL(url).origin) || null,
        set: async (key: string, url: string) => {
          keys.set(new URL(url).origin, key);
        },
      },
    },
  });
  const configure = (body: unknown) =>
    fetch(app.descriptor.url + "/api/model", {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + app.descriptor.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    const initial = await configure({
      providerId: "deepseek",
      model: "fixture-fast",
      apiKey: "fake-deepseek-key",
    });
    assert.equal(initial.status, 200);
    const snapshot = await initial.json();
    assert.deepEqual(snapshot.model, {
      providerId: "deepseek",
      protocol: "openai-chat",
      baseUrl: "https://api.deepseek.com",
      model: "fixture-fast",
      hasKey: true,
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /fake-deepseek-key/);
    assert.equal(
      (await configure({ providerId: "deepseek", model: "fixture-pro" }))
        .status,
      200,
    );
    assert.equal(
      (await configure({ providerId: "anthropic", model: "fixture-claude" }))
        .status,
      400,
    );
    assert.equal(app.runtime.snapshot().model?.providerId, "deepseek");
    assert.equal(keys.size, 1);
    assert.equal(
      (
        await configure({
          providerId: "anthropic",
          model: "fixture-claude",
          apiKey: "fake-anthropic-key",
        })
      ).status,
      200,
    );
    assert.equal(app.runtime.snapshot().model?.protocol, "anthropic-messages");
    assert.equal(keys.get("https://api.deepseek.com"), "fake-deepseek-key");
    assert.equal(keys.get("https://api.anthropic.com"), "fake-anthropic-key");
    assert.doesNotMatch(
      JSON.stringify(app.runtime.snapshot()),
      /fake-deepseek-key|fake-anthropic-key/,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
