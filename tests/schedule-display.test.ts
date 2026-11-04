import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Schedules, { scheduleRuleLabel } from "../apps/desktop/Schedules.js";
import type { Schedule } from "../packages/contracts/index.js";

test("the schedule list shows the stored timezone and next trigger without implying execution success", () => {
  const record: Schedule = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "每周项目报告",
    prompt: "检查本项目变更并汇报，不要修改文件。",
    cwd: "/fixture/project",
    agentId: "fake",
    rule: {
      kind: "weekly",
      time: "09:30",
      timeZone: "Asia/Shanghai",
      days: [5, 1],
    },
    status: "active",
    nextRunAt: "2030-01-07T01:30:00.000Z",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    lastRun: {
      id: "run-1",
      scheduleId: "00000000-0000-4000-8000-000000000001",
      scheduledFor: "2030-01-04T01:30:00.000Z",
      recordedAt: "2030-01-04T01:30:00.100Z",
      status: "dispatched",
      detail: "已创建任务",
      taskId: "task-1",
    },
  };
  const result = renderToStaticMarkup(
    React.createElement(Schedules, {
      schedules: [record],
      agents: [],
      tasks: [],
      projectPath: "",
      connected: true,
      request: async () => {
        throw Error("static render must not call service");
      },
      pickDirectory: async () => null,
      onOpenTask() {},
      onBack() {},
      onMenu() {},
    }),
  );
  assert.match(result, /每周项目报告/);
  assert.match(result, /周一、周五 09:30 · Asia\/Shanghai/);
  assert.match(result, /下次执行/);
  assert.match(result, /2030-01-07T01:30:00.000Z/);
  assert.match(result, /最近触发 · 已分配/);
  assert.doesNotMatch(result, /最近触发 · 已完成/);
  assert.equal(
    scheduleRuleLabel({ kind: "interval", minutes: 90 }),
    "每 90 分钟",
  );
});
