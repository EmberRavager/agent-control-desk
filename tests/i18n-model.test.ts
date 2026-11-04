import test from "node:test";
import assert from "node:assert/strict";
import {
  route,
  translateSkill,
  analyzeNativeSession,
  summarizeCompletion,
} from "../packages/core/model.js";

test("AI requests use the selected language while preserving protocol and user data", async () => {
  const original = globalThis.fetch;
  const bodies: any[] = [];
  const results = [
    { reply: "Hello", actions: [] },
    { description: "Description", content: "Content" },
    {
      title: "Task",
      summary: "Summary",
      goal: "",
      currentStep: "",
      blocker: "",
      nextStep: "",
    },
    {
      outcome: "delivered",
      objective: "Deliver file",
      evidenceLine: 1,
      summary: "File delivered",
      suggestions: ["Review"],
    },
  ];
  globalThis.fetch = (async (_url, options) => {
    bodies.push(JSON.parse(options!.body as string));
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(results.shift()) } }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const config = {
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "fixture",
    hasKey: false,
  };
  try {
    await route(
      config,
      "",
      {
        agents: [],
        tasks: [],
        messages: [],
        questions: [],
        model: null,
        preferences: { locale: "en" },
      },
      "用户原话",
      "/tmp",
    );
    await (translateSkill as any)(
      config,
      "",
      {
        skill: { name: "中文", description: "用途" },
        content: "保留原话",
        truncated: false,
      },
      "en",
    );
    const insight = await (analyzeNativeSession as any)(
      config,
      "",
      { title: "原生名称", status: "idle" },
      { request: "", requests: [], updates: [], tools: [] },
      "en",
    );
    assert.equal(insight.title, "User goal not synced");
    const assessment = await (summarizeCompletion as any)(
      config,
      "",
      {
        title: "交付",
        requirements: ["用户要求"],
        result: "原始证据",
        progress: "",
      },
      undefined,
      "en",
    );
    assert.equal(assessment.evidence, "原始证据");
    for (const body of bodies)
      assert.match(
        body.messages[0].content,
        /Write all generated natural-language text in English/,
      );
    assert.match(bodies[0].messages[1].content, /用户原话/);
    assert.match(bodies[1].messages[0].content, /translate.*English/i);
  } finally {
    globalThis.fetch = original;
  }
});

test("completion display translates its platform wrapper without changing report content", async () => {
  const { resultText, conversationMessages } =
    await import("../packages/contracts/completion.js");
  const message = {
    id: "report",
    role: "assistant" as const,
    text: "历史原文",
    taskIds: [],
    createdAt: "now",
    completion: {
      id: "report",
      title: "用户任务",
      status: "ready" as const,
      assessed: true,
      summary: "Agent 原始结论",
    },
  };
  assert.equal(
    resultText(message, undefined, "执行者", "en"),
    "执行者 returned the result for “用户任务”; the supervisor assessed it as delivered.\nAgent 原始结论",
  );
  assert.match(
    conversationMessages([message], undefined, "en")[0].text,
    /returned the result/,
  );
  assert.equal(message.text, "历史原文");
});
