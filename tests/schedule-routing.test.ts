import test from "node:test";
import assert from "node:assert/strict";
import { route, decisionSchema } from "../packages/core/model.js";
import type {
  AgentConnection,
  ModelConfig,
  Schedule,
  Snapshot,
} from "../packages/contracts/index.js";

const agent: AgentConnection = {
  id: "fixture-agent",
  name: "Fixture Agent",
  kind: "codex",
  executable: "/fixture/agent",
  selected: true,
  available: true,
  capabilities: { steer: true, resume: true },
};
const schedule: Schedule = {
  id: "fixture-schedule",
  name: "每日检查",
  prompt: "检查项目测试并汇报",
  cwd: "/fixture/project",
  agentId: agent.id,
  rule: { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" },
  status: "active",
  nextRunAt: "2099-01-01T01:00:00.000Z",
  createdAt: "2026-11-04T00:00:00.000Z",
  updatedAt: "2026-11-04T01:00:00.000Z",
};
const snapshot: Snapshot = {
  agents: [agent],
  tasks: [],
  messages: [],
  questions: [],
  model: null,
  schedules: [schedule],
};
const config: ModelConfig = {
  baseUrl: "http://127.0.0.1:9999/v1",
  model: "fixture-model",
  hasKey: false,
};

async function withResponse(
  decision: unknown,
  check: (requests: Record<string, any>[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const requests: Record<string, any>[] = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(String(options?.body)));
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(decision) } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    await check(requests);
  } finally {
    globalThis.fetch = original;
  }
}

test("scheduled creation binds the current project and supplies clock and schedule context", async () => {
  await withResponse(
    {
      reply: "不要直接把这个当成已经执行的结果",
      actions: [
        {
          type: "schedule_create",
          name: "每日检查",
          prompt: "检查项目测试并汇报",
          agentId: agent.id,
          rule: { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" },
        },
      ],
    },
    async (requests) => {
      const decision = await route(
        config,
        "",
        snapshot,
        "每天北京时间9点检查项目测试并汇报",
        "/fixture/current",
      );
      assert.deepEqual(decision, {
        reply: "",
        actions: [
          {
            type: "schedule_create",
            input: {
              name: "每日检查",
              prompt: "检查项目测试并汇报",
              cwd: "/fixture/current",
              agentId: agent.id,
              rule: { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" },
            },
          },
        ],
      });
      const context = JSON.parse(requests[0].messages[1].content);
      assert.equal(context.input.cwd, "/fixture/current");
      assert.ok(Number.isFinite(Date.parse(context.clock.now)));
      assert.equal(typeof context.clock.timeZone, "string");
      assert.equal(context.schedules[0].id, schedule.id);
      const prompt = requests[0].messages[0].content;
      assert.match(prompt, /不立即 create/);
      assert.match(prompt, /不能唯一确定时使用 clarify/);
      assert.match(prompt, /暂停或删除计划不会停止已经触发的任务/);
    },
  );
});

test("schedule controls bind the observed update version rather than a model-generated version", async () => {
  for (const operation of ["pause", "resume", "delete"] as const) {
    await withResponse(
      {
        reply: "",
        actions: [
          {
            type: "schedule_control",
            scheduleId: schedule.id,
            operation,
            expectedUpdatedAt: "invented-version",
          },
        ],
      },
      async () => {
        const decision = await route(
          config,
          "",
          snapshot,
          "暂停每日检查计划",
          "/fixture/current",
        );
        assert.deepEqual(decision.actions, [
          {
            type: "schedule_control",
            scheduleId: schedule.id,
            operation,
            expectedUpdatedAt: schedule.updatedAt,
          },
        ]);
      },
    );
  }
});

test("scheduled actions reject unknown IDs and unavailable executors", async () => {
  for (const action of [
    { type: "schedule_control", scheduleId: "missing", operation: "pause" },
    { type: "schedule_status", scheduleIds: ["missing"] },
    {
      type: "schedule_create",
      name: "test",
      prompt: "test",
      agentId: "missing",
      rule: { kind: "interval", minutes: 30 },
    },
  ]) {
    await withResponse({ reply: "", actions: [action] }, async () => {
      await assert.rejects(
        route(config, "", snapshot, "定时任务", "/fixture"),
        /不存在的定时任务|不可用的执行 Agent/,
      );
    });
  }
  await withResponse(
    {
      reply: "",
      actions: [
        {
          type: "schedule_create",
          name: "test",
          prompt: "test",
          agentId: agent.id,
          rule: { kind: "interval", minutes: 30 },
        },
      ],
    },
    async () => {
      await assert.rejects(
        route(
          config,
          "",
          {
            ...snapshot,
            agents: [{ ...agent, selected: false }],
          },
          "定时执行",
          "/fixture",
        ),
        /不可用的执行 Agent/,
      );
    },
  );
});

test("schedule status supports all plans, validates explicit targets and keeps task commands distinct", async () => {
  for (const scheduleIds of [[], [schedule.id]]) {
    await withResponse(
      {
        reply: "",
        actions: [
          {
            type: "schedule_status",
            scheduleIds,
          },
        ],
      },
      async () => {
        const decision = await route(
          config,
          "",
          snapshot,
          "有哪些定时任务",
          "/fixture",
        );
        assert.deepEqual(decision.actions, [
          { type: "schedule_status", scheduleIds },
        ]);
      },
    );
  }
  assert.equal(
    decisionSchema.safeParse({
      reply: "",
      actions: [
        {
          type: "schedule_control",
          scheduleId: schedule.id,
          operation: "stop",
        },
      ],
    }).success,
    false,
  );
});

test("scheduled rule transport schema keeps validation local and excludes model-specified directories", () => {
  const valid = {
    type: "schedule_create",
    name: "每周检查",
    prompt: "检查测试",
    agentId: agent.id,
    rule: {
      kind: "weekly",
      time: "09:00",
      timeZone: "Asia/Shanghai",
      days: [1, 5],
    },
  };
  assert.equal(
    decisionSchema.safeParse({ reply: "", actions: [valid] }).success,
    true,
  );
  for (const rule of [
    { kind: "interval", minutes: 0 },
    { kind: "interval", minutes: 1.5 },
    { kind: "daily", time: "25:30", timeZone: "Asia/Shanghai" },
    { kind: "daily", time: "09:00", timeZone: "not-a-time-zone" },
    { kind: "weekly", time: "09:00", timeZone: "UTC", days: [1, 1] },
    { kind: "once", at: "2099-01-01T09:00:00" },
  ])
    assert.equal(
      decisionSchema.safeParse({
        reply: "",
        actions: [{ ...valid, rule }],
      }).success,
      false,
    );
  assert.equal(
    decisionSchema.safeParse({
      reply: "",
      actions: [{ ...valid, cwd: "/model-chosen-directory" }],
    }).success,
    false,
  );
});
