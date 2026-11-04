import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { startServer } from "../packages/core/server.js";
import type { AgentConnection } from "../packages/contracts/index.js";

test("CLI default settings and pinned sends reach the same local allocation runtime", async () => {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "acd-cli-allocation-")),
  );
  const started: string[] = [];
  const app = await startServer({
    directory,
    port: 0,
    nativeRead: async () => ({
      source: "run-events",
      state: "unavailable",
      message: "synthetic",
      sessions: [],
    }),
    deps: {
      scan: async () => [],
      vault: { get: async () => null, set: async () => {} },
      route: async (_config, _key, _snapshot, text, cwd) => ({
        reply: "",
        actions: [
          {
            type: "create",
            title: "synthetic",
            goal: text,
            agentId: "fixture-claude",
            cwd,
          },
        ],
      }),
      adapter: () => ({
        start: async ({ task }) => {
          started.push(task.agentId);
          return {
            steer: async () => {},
            stop: async () => {},
            answer: async () => {},
            dispose() {},
          };
        },
      }),
    },
  });
  const run = async (...args: string[]) =>
    promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL("../apps/cli/acd.mjs", import.meta.url)), ...args],
      {
        cwd: directory,
        env: { ...process.env, ACD_DATA_DIR: directory },
        timeout: 10000,
      },
    );
  try {
    app.runtime.store.put("settings", "model", {
      providerId: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "unused",
      hasKey: false,
    });
    for (const [id, kind] of [
      ["fixture-codex", "codex"],
      ["fixture-claude", "claude"],
    ] as const) {
      const agent: AgentConnection = {
        id,
        kind,
        name: kind,
        executable: "/never-run",
        selected: true,
        available: true,
        supported: true,
        capabilities: { steer: kind === "codex", resume: true },
      };
      app.runtime.store.put("agents", id, agent);
    }
    const configured = JSON.parse(
      (
        await run(
          "agents",
          "default",
          "fixture-claude",
          "--project",
          directory,
          "--json",
        )
      ).stdout,
    );
    assert.equal(configured.projectAgentIds[directory], "fixture-claude");
    const projectOrder = ["fixture-codex", "fixture-claude"];
    const ranked = JSON.parse(
      (
        await run(
          "agents",
          "default",
          ...projectOrder,
          "--project",
          directory,
          "--json",
        )
      ).stdout,
    );
    assert.deepEqual(ranked.projectAgentOrders[directory], projectOrder);
    const globalOrder = ["fixture-claude", "fixture-codex"];
    await run("agents", "default", ...globalOrder);
    const saved = JSON.parse((await run("agents", "default", "--json")).stdout);
    assert.deepEqual(saved.globalAgentOrder, globalOrder);
    assert.deepEqual(saved.projectAgentOrders[directory], projectOrder);
    await assert.rejects(
      run("agents", "default", "none", "fixture-codex"),
      /用法/,
    );
    const receipt = JSON.parse(
      (
        await run(
          "send",
          "检查合成项目",
          "--agent",
          "fixture-codex",
          "--require",
          "steer",
          "--json",
        )
      ).stdout,
    );
    assert.equal(receipt.request.targetAgentId, "fixture-codex");
    assert.deepEqual(receipt.request.requiredCapabilities, ["steer"]);
    for (let i = 0; i < 100 && !started.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(started, ["fixture-codex"]);
    const task = app.runtime.snapshot().tasks[0];
    assert.equal(task.allocation?.source, "explicit");
    assert.match(task.allocation!.reason, /本次指定/);
    const cleared = JSON.parse(
      (await run("agents", "default", "none", "--project", directory, "--json"))
        .stdout,
    );
    assert.deepEqual(cleared.projectAgentIds, {});
    assert.deepEqual(cleared.projectAgentOrders ?? {}, {});
    assert.deepEqual(cleared.globalAgentOrder, globalOrder);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
