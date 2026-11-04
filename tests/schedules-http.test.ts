import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../packages/core/server.js";
import type {
  AgentConnection,
  Schedule,
  ScheduleRun,
  StartRun,
} from "../packages/contracts/index.js";
import type { Dependencies } from "../packages/core/runtime.js";
const agent: AgentConnection = {
  id: "fake",
  kind: "codex",
  name: "Fake",
  executable: "/fake",
  selected: true,
  available: true,
  capabilities: { steer: true, resume: true },
};
function fixture(now: () => number, starts: StartRun[]): Dependencies {
  return {
    now,
    scan: async () => [],
    vault: { get: async () => null, set: async () => {} },
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
    route: async (_config, _key, _snapshot, _text, cwd) => ({
      reply: "",
      actions: [
        {
          type: "schedule_create",
          input: {
            name: "对话计划",
            prompt: "只读检查",
            cwd,
            agentId: agent.id,
            rule: { kind: "interval", minutes: 2 },
          },
        },
      ],
    }),
  };
}
test("authenticated schedule API validates, edits, triggers through Runtime, and survives restart without replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "acd-schedule-http-"));
  let now = Date.parse("2026-12-01T00:00:00Z");
  const starts: StartRun[] = [];
  const deps = fixture(() => now, starts);
  let app = await startServer({ directory: root, port: 0, deps });
  const request = (path: string, method = "GET", body?: unknown) =>
    fetch(app.descriptor.url + path, {
      method,
      headers: {
        Authorization: "Bearer " + app.descriptor.token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    assert.ok(app.descriptor.capabilities.includes("schedules"));
    assert.equal(
      (await fetch(app.descriptor.url + "/api/schedules")).status,
      401,
    );
    assert.equal(
      (
        await fetch(app.descriptor.url + "/api/schedules", {
          headers: { Origin: "https://outside.example" },
        })
      ).status,
      403,
    );
    app.runtime.store.put("agents", agent.id, agent);
    const input = {
      name: "检查",
      prompt: "只读检查项目",
      agentId: agent.id,
      cwd: root,
      rule: { kind: "interval", minutes: 1 },
    };
    for (const invalid of [
      { ...input, cwd: "relative" },
      { ...input, agentId: "missing" },
      { ...input, extra: true },
      { ...input, rule: { kind: "interval", minutes: 0 } },
      {
        ...input,
        rule: { kind: "daily", time: "09:00", timeZone: "unknown/zone" },
      },
      {
        ...input,
        rule: { kind: "weekly", time: "09:00", timeZone: "UTC", days: [1, 1] },
      },
      { ...input, rule: { kind: "once", at: "2026-11-30T00:00:00Z" } },
    ])
      assert.equal(
        (await request("/api/schedules", "POST", invalid)).status,
        400,
      );
    assert.equal(starts.length, 0);
    const created = await request("/api/schedules", "POST", input);
    assert.equal(created.status, 201);
    const schedule = (await created.json()) as Schedule;
    assert.equal(schedule.nextRunAt, "2026-12-01T00:01:00.000Z");
    const id = schedule.id;
    assert.equal((await request(`/api/schedules/${id}/runs`)).status, 200);
    assert.equal(
      (await request("/api/schedules/00000000-0000-4000-8000-000000000000"))
        .status,
      404,
    );
    assert.equal(
      (await request(`/api/schedules/${id}/resume`, "POST", { extra: true }))
        .status,
      400,
    );
    const snapshot = await request("/api/state").then((r) => r.json());
    assert.equal(snapshot.schedules.length, 1);
    await request(`/api/schedules/${id}/pause`, "POST", {});
    now += 60_000;
    app.runtime.schedules.tick();
    assert.equal(starts.length, 0);
    await request(`/api/schedules/${id}/resume`, "POST", {});
    assert.equal(
      app.runtime.schedules.get(id).nextRunAt,
      "2026-12-01T00:02:00.000Z",
    );
    const edited = await request(`/api/schedules/${id}`, "PUT", {
      ...input,
      prompt: "新的只读要求",
    });
    assert.equal(edited.status, 200);
    now += 60_000;
    app.runtime.schedules.tick();
    app.runtime.schedules.tick();
    assert.equal(starts.length, 1);
    assert.equal(starts[0].task.goal, "新的只读要求");
    assert.equal(starts[0].task.scheduleId, id);
    assert.ok(
      app.runtime
        .snapshot()
        .messages.some(
          (m) => m.taskIds.includes(starts[0].task.id) && m.role === "system",
        ),
    );
    const runs = (await request(`/api/schedules/${id}/runs`).then((r) =>
      r.json(),
    )) as ScheduleRun[];
    assert.equal(runs.length, 1);
    assert.equal(runs[0].taskId, starts[0].task.id);
    await app.close();
    app = await startServer({ directory: root, port: 0, deps });
    assert.equal(app.runtime.snapshot().tasks[0].status, "unknown");
    assert.equal(app.runtime.schedules.runs(id)[0].status, "unknown");
    now += 60_000;
    app.runtime.schedules.tick();
    assert.equal(starts.length, 1);
    assert.equal(app.runtime.schedules.runs(id)[0].status, "skipped");
    assert.equal(
      (await request(`/api/schedules/${id}/delete`, "POST", {})).status,
      200,
    );
    assert.equal(
      (await request("/api/schedules").then((r) => r.json())).length,
      0,
    );
    assert.equal(app.runtime.snapshot().tasks.length, 1);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("scheduled background execution needs no supervisor call and chat-created plans use the same store", async () => {
  const root = mkdtempSync(join(tmpdir(), "acd-schedule-chat-"));
  let now = Date.parse("2026-12-01T00:00:00Z");
  const starts: StartRun[] = [];
  const app = await startServer({
    directory: root,
    port: 0,
    deps: fixture(() => now, starts),
  });
  try {
    app.runtime.store.put("agents", agent.id, agent);
    app.runtime.store.put("settings", "model", {
      providerId: "ollama",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "fake",
      hasKey: false,
    });
    app.runtime.receive("每两分钟只读检查", root);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(app.runtime.schedules.list().length, 1);
    assert.equal(starts.length, 0);
    app.runtime.store.remove("settings", "model");
    now += 120_000;
    app.runtime.schedules.tick();
    assert.equal(starts.length, 1);
    assert.equal(starts[0].task.goal, "只读检查");
    starts[0].onEvent({ type: "completed", text: "Fixture result" });
    assert.equal(app.runtime.snapshot().tasks[0].status, "review");
    now += 120_000;
    app.runtime.schedules.tick();
    assert.equal(starts.length, 2);
    assert.notEqual(starts[0].task.id, starts[1].task.id);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the running daemon triggers a future one-shot without a client tick or open desktop", async () => {
  const root = mkdtempSync(join(tmpdir(), "acd-schedule-timer-"));
  const starts: StartRun[] = [];
  const app = await startServer({
    directory: root,
    port: 0,
    deps: fixture(Date.now, starts),
  });
  try {
    app.runtime.store.put("agents", agent.id, agent);
    const plan = app.runtime.schedules.create({
      name: "后台自触发",
      prompt: "只读检查",
      cwd: root,
      agentId: agent.id,
      rule: { kind: "once", at: new Date(Date.now() + 150).toISOString() },
    });
    const deadline = Date.now() + 6000;
    while (!starts.length && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(starts.length, 1);
    assert.equal(starts[0].task.scheduleId, plan.id);
    assert.equal(app.runtime.schedules.get(plan.id).status, "finished");
    assert.equal(app.runtime.schedules.runs(plan.id).length, 1);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
