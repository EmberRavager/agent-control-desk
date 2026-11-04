import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../apps/desktop/i18n.js";
import { AllocationControls } from "../apps/desktop/AllocationControls.js";
import ModelSettings from "../apps/desktop/ModelSettings.js";
import CompletionReport from "../apps/desktop/CompletionReport.js";
import Notifications from "../apps/desktop/Notifications.js";
import NotificationSettings from "../apps/desktop/NotificationSettings.js";
import WeChatSettings from "../apps/desktop/WeChatSettings.js";
function english(component: React.ReactNode) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, { locale: "en", children: component }),
  );
}
test("English allocation interpolates capabilities and preserves agent names", () => {
  const html = english(
    React.createElement(AllocationControls, {
      agents: [
        { id: "codex", name: "我的 Agent", selected: true, available: true },
      ],
      targetAgentId: "codex",
      requiredCapabilities: ["steer"],
      locked: false,
      onAgentChange() {},
      onCapabilitiesChange() {},
    } as any),
  );
  assert.match(html, /aria-label="New task agent"/);
  assert.match(html, /Capabilities: 1/);
  assert.match(html, /我的 Agent/);
  assert.doesNotMatch(html, /必需能力|自动分配|执行中追加/);
});
test("English forms translate labels, placeholders, metadata and accessible names", () => {
  const html = english(
    React.createElement(ModelSettings, {
      config: null,
      save: async () => {},
      loadModels: async () => ({ models: [], source: "remote" }),
    } as any),
  );
  assert.match(html, /Model provider/);
  assert.match(html, /Choose a model, or enter the full model ID/);
  assert.doesNotMatch(html, /[\u4e00-\u9fff]/);
  for (const component of [
    React.createElement(NotificationSettings, {
      active: false,
      onWechat() {},
    } as any),
    React.createElement(WeChatSettings, { active: false } as any),
  ]) {
    assert.doesNotMatch(
      english(component)
        .replace(/<code>.*?<\/code>/g, "")
        .replace(/\/(?:帮助|状态)/g, ""),
      /[\u4e00-\u9fff]/,
    );
  }
});
test("English completion state preserves generated title, body and suggestions", () => {
  const html = english(
    React.createElement(CompletionReport, {
      report: {
        status: "ready",
        title: "用户标题",
        summary: "模型原文",
        suggestions: ["用户建议"],
        assessed: true,
      },
    } as any),
  );
  assert.match(html, /AI assessed as delivered/);
  assert.match(html, /用户标题/);
  assert.match(html, /模型原文/);
  assert.match(html, /用户建议/);
  assert.match(html, /aria-label="Task results and suggestions"/);
});
test("English notifications preserve notification contents and interpolate unread count", () => {
  const html = english(
    React.createElement(Notifications, {
      feed: {
        items: [
          {
            id: "n",
            kind: "result",
            title: "用户标题",
            body: "原始正文",
            createdAt: "2026-11-04T00:00:00.000Z",
            active: true,
          },
        ],
        unread: 3,
        hasMore: false,
      },
      request: async () => {},
      onOpen() {},
      onBack() {},
      onMenu() {},
    } as any),
  );
  assert.match(html, /3 unread/);
  assert.match(html, /用户标题/);
  assert.match(html, /原始正文/);
  assert.match(html, /aria-label="Unread"/);
});

test("English schedules localize states and dates without translating schedule titles", async () => {
  const { default: Schedules, scheduleRuleLabel } =
    await import("../apps/desktop/Schedules.js");
  const record = {
    id: "s",
    name: "我的定时任务",
    prompt: "保留任务指令",
    cwd: "/fixture",
    agentId: "codex",
    rule: {
      kind: "weekly",
      days: [5, 1],
      time: "09:30",
      timeZone: "Asia/Shanghai",
    },
    status: "active",
    nextRunAt: "2030-01-07T01:30:00.000Z",
    lastRun: { status: "dispatched" },
  };
  const html = english(
    React.createElement(Schedules, {
      schedules: [record],
      agents: [],
      tasks: [],
      projectPath: "",
      connected: true,
      request: async () => {},
      pickDirectory: async () => null,
      onOpenTask() {},
      onBack() {},
      onMenu() {},
    } as any),
  );
  assert.match(html, /aria-label="Schedule management"/);
  assert.match(html, /我的定时任务/);
  assert.match(html, /Mon, Fri 09:30 · Asia\/Shanghai/);
  assert.match(html, /Next run/);
  assert.match(html, /Last trigger ·<!-- --> |Last trigger · /);
  assert.match(html, /Dispatched/);
  assert.doesNotMatch(html, /已启用|周一|下次执行|已分配/);
  assert.equal(
    scheduleRuleLabel({ kind: "interval", minutes: 90 }, "en"),
    "Every 90 minutes",
  );
  const formatted = new Date(record.nextRunAt).toLocaleString("en-US", {
    hour12: false,
  });
  assert.ok(html.includes(formatted));
});
test("English native details select only the current locale's cached analysis", async () => {
  const { default: NativeObservation } =
    await import("../apps/desktop/NativeObservation.js");
  const session = {
    id: "native",
    agentId: "codex",
    sessionId: "thread",
    title: "原生任务标题",
    taskTitle: "用户任务",
    cwd: "/fixture",
    status: "running",
    progress: "原生 Agent 原始输出",
    observedAt: "2026-11-04T00:00:00Z",
  };
  const key = (locale: string) =>
    JSON.stringify([locale, session.id, undefined, session.status, "model"]);
  const cache = new Map([
    [
      key("zh-CN"),
      {
        value: { title: "中文分析缓存", goal: "中文分析目标" },
        updatedAt: Date.now(),
        attemptedAt: Date.now(),
      },
    ],
    [
      key("en"),
      {
        value: {
          title: "English cached insight",
          goal: "English cached goal",
          currentStep: "English cached step",
          generatedAt: "2026-11-04T00:00:00Z",
        },
        updatedAt: Date.now(),
        attemptedAt: Date.now(),
      },
    ],
  ]);
  const html = english(
    React.createElement(NativeObservation, {
      agentName: "我的 Agent",
      observation: { sessions: [session] },
      sessionId: session.id,
      modelKey: "model",
      cache,
      refresh: async () => {},
      analyze: async () => {
        throw Error("SSR must not execute a model");
      },
      onSelect() {},
      onBack() {},
    } as any),
  );
  assert.match(html, /aria-label="Native session details"/);
  assert.match(html, /我的 Agent/);
  assert.match(html, /用户任务/);
  assert.match(html, /English cached goal/);
  assert.match(html, /English cached step/);
  assert.doesNotMatch(html, /中文分析目标|正在执行|重新分析|详情与来源/);
});
test("English allocation settings and skill empty states expose translated form text", async () => {
  const { default: AllocationSettings } =
    await import("../apps/desktop/AllocationSettings.js");
  const { default: Skills } = await import("../apps/desktop/Skills.js");
  const allocation = english(
    React.createElement(AllocationSettings, {
      active: false,
      agents: [
        { id: "a", name: "我的 Agent", selected: true, available: true },
      ],
      preferences: { globalAgentId: "a", projectAgentIds: {} },
      request: async () => {},
      pickDirectory: async () => null,
    } as any),
  );
  assert.match(allocation, /Save global priorities/);
  assert.match(allocation, /aria-label="Move 我的 Agent up"/);
  assert.doesNotMatch(allocation, /任务分配|全局优先级|当前不可用/);
  const skills = english(
    React.createElement(Skills, {
      request: async () => {},
      pickDirectory: async () => null,
      revealSkill: async () => {},
      projectPath: "",
      onBack() {},
    }),
  );
  assert.match(skills, /aria-label="Skill management"/);
  assert.match(skills, /placeholder="Search name, purpose or path"/);
  assert.doesNotMatch(skills, /[\u4e00-\u9fff]/);
});

test("every preset provider renders its fixed region, plan and brand copy in English", async () => {
  const { modelProviders } = await import("../packages/contracts/providers.js");
  for (const provider of modelProviders) {
    const html = english(
      React.createElement(ModelSettings, {
        config: {
          providerId: provider.id,
          baseUrl: provider.baseUrl,
          protocol: provider.protocol,
          model: provider.models[0]?.id || "fixture",
          hasKey: false,
        },
        save: async () => {},
        loadModels: async () => ({
          models: [],
          fetchedAt: "2030-01-01T00:00:00Z",
          hasMore: false,
        }),
      }),
    );
    assert.doesNotMatch(html, /[\u4e00-\u9fff]/, provider.id);
  }
});

test("pending and failed completion UI translate fallbacks and preserve raw upstream errors", () => {
  const pending = english(
    React.createElement(CompletionReport, {
      report: { status: "pending", title: "用户标题" },
    } as any),
  );
  assert.match(pending, /Preparing results and suggestions…/);
  const failed = english(
    React.createElement(CompletionReport, {
      report: { status: "failed", title: "用户标题" },
      onRetry: async () => {},
    } as any),
  );
  assert.match(failed, /Results and suggestions have not been generated yet/);
  assert.match(failed, /Retry completion assessment/);
  const upstream = english(
    React.createElement(CompletionReport, {
      report: { status: "failed", title: "用户标题", error: "服务器原始报错" },
    } as any),
  );
  assert.match(upstream, /服务器原始报错/);
});

test("concurrently added personal memory settings render English platform text", async () => {
  const { default: PersonalMemorySettings } =
    await import("../apps/desktop/PersonalMemorySettings.js");
  const html = english(
    React.createElement(PersonalMemorySettings, {
      active: false,
      request: async () => {
        throw Error("SSR must not request memory data");
      },
    }),
  );
  assert.match(html, /Personal memory/);
  assert.match(html, /aria-label="Usage preferences"/);
  assert.match(html, /aria-label="Workflows"/);
  assert.match(html, /Loading personal memory…/);
  assert.doesNotMatch(html, /[\u4e00-\u9fff]/);
});
