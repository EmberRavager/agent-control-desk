import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  route,
  decisionSchema,
  validateBaseUrl,
} from "../packages/core/model.js";
import type { Snapshot } from "../packages/contracts/index.js";
const snapshot: Snapshot = {
  agents: [],
  tasks: [],
  messages: [],
  questions: [],
  model: null,
};
test("model route calls the configured compatible API and validates structured decisions", async () => {
  let received: Record<string, any> = {};
  const server = createServer(async (req, res) => {
    let text = "";
    req.setEncoding("utf8");
    for await (const chunk of req) text += chunk;
    received = JSON.parse(text);
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer fake-key");
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                reply: "请指明任务",
                actions: [
                  { type: "clarify", text: "你指的是哪项任务？", taskIds: [] },
                ],
              }),
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const decision = await route(
      {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "fixture-model",
        hasKey: true,
      },
      "fake-key",
      {
        ...snapshot,
        messages: [
          {
            id: "external",
            role: "assistant",
            text: "Unrelated external report",
            taskIds: [],
            createdAt: "1",
            completion: {
              id: "ext",
              title: "external",
              status: "ready",
              nativeId: "another-session",
            },
          },
        ],
      },
      "这个先别改",
      "/fixture",
      "target-id",
    );
    assert.equal(decision.actions[0].type, "clarify");
    assert.equal(received.model, "fixture-model");
    const input = JSON.parse(received.messages[1].content);
    assert.deepEqual(input.conversation, []);
    assert.equal(input.input.targetTaskId, "target-id");
    assert.equal(input.input.text, "这个先别改");
    assert.equal(received.response_format.type, "json_object");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("model decisions reject unknown operations and malformed task targets", () => {
  assert.equal(
    decisionSchema.safeParse({
      reply: "",
      actions: [{ type: "exec", command: "arbitrary" }],
    }).success,
    false,
  );
  assert.equal(
    decisionSchema.safeParse({
      reply: "",
      actions: [{ type: "stop", taskId: 42 }],
    }).success,
    false,
  );
  for (const url of [
    "http://example.com/v1",
    "https://user:pass@example.com/v1",
    "https://example.com/v1?key=fake",
  ])
    assert.throws(() => validateBaseUrl(url));
  assert.equal(
    validateBaseUrl("https://example.com/v1/"),
    "https://example.com/v1",
  );
});

test("native Anthropic uses Messages structured JSON and preserves routing context", async () => {
  let received: Record<string, any> = {};
  const server = createServer(async (req, res) => {
    let text = "";
    req.setEncoding("utf8");
    for await (const chunk of req) text += chunk;
    received = JSON.parse(text);
    assert.equal(req.url, "/v1/messages");
    assert.equal(req.headers["x-api-key"], "fake-anthropic-key");
    assert.equal(req.headers["anthropic-version"], "2023-06-01");
    assert.equal(req.headers.authorization, undefined);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              reply: "正在查询任务",
              actions: [{ type: "status", taskIds: ["task-a"] }],
            }),
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const decision = await route(
      {
        providerId: "anthropic",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "fixture-claude",
        hasKey: true,
      },
      "fake-anthropic-key",
      snapshot,
      "查下这个任务",
      "/fixture",
      "task-a",
    );
    assert.equal(decision.actions[0].type, "status");
    assert.equal(received.model, "fixture-claude");
    assert.equal(received.max_tokens, 8192);
    assert.equal(typeof received.system, "string");
    assert.equal(received.messages.length, 1);
    assert.equal(
      JSON.parse(received.messages[0].content).input.targetTaskId,
      "task-a",
    );
    assert.equal(received.output_config.format.type, "json_schema");
    const schema = received.output_config.format.schema;
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.actions.items.anyOf.length, 8);
    assert.equal(schema.properties.actions.maxItems, undefined);
    assert.equal(
      schema.properties.actions.items.anyOf[1].properties.expectedRevision,
      undefined,
    );
    assert.equal(received.tools, undefined);
    assert.equal(received.tool_choice, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("native JSON is still checked against the full local routing contract", async () => {
  let fixture: unknown = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          reply: "",
          actions: [{ type: "stop", taskId: 42 }],
        }),
      },
    ],
  };
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(fixture));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config = {
    providerId: "anthropic",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "fixture",
    hasKey: true,
  };
  try {
    await assert.rejects(
      route(config, "fake-key", snapshot, "stop", "/fixture"),
      /任务协议/,
    );
    fixture = {
      content: [
        { type: "text", text: JSON.stringify({ reply: "", actions: [] }) },
      ],
      stop_reason: "max_tokens",
    };
    await assert.rejects(
      route(config, "fake-key", snapshot, "stop", "/fixture"),
      /完整合法 JSON/,
    );
    fixture = {
      content: [
        { type: "tool_use", name: "exec", input: { command: "arbitrary" } },
      ],
    };
    await assert.rejects(
      route(config, "fake-key", snapshot, "stop", "/fixture"),
      /完整合法 JSON/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("provider HTTP errors and malformed output never echo response secrets", async () => {
  let failHttp = true;
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (failHttp) res.statusCode = 401;
    res.end(
      failHttp ? "fake-key secret diagnostic" : "fake-key malformed JSON",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "fixture",
    hasKey: true,
  };
  try {
    await assert.rejects(
      route(config, "fake-key", snapshot, "hi", "/fixture"),
      (error: Error) => {
        assert.match(error.message, /HTTP 401/);
        assert.doesNotMatch(error.message, /fake-key|secret/);
        return true;
      },
    );
    failHttp = false;
    await assert.rejects(
      route(config, "fake-key", snapshot, "hi", "/fixture"),
      (error: Error) => {
        assert.match(error.message, /完整合法 JSON/);
        assert.doesNotMatch(error.message, /fake-key/);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("routing honours an already aborted caller signal", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    route(
      {
        baseUrl: "http://127.0.0.1:1/v1",
        model: "fixture",
        hasKey: true,
      },
      "fake-key",
      snapshot,
      "hi",
      "/fixture",
      undefined,
      controller.signal,
    ),
    (error: Error) => error.name === "AbortError",
  );
});

test("local chat omits authorization and MiniMax separates reasoning without sending unsupported JSON-mode parameters", async () => {
  let expectedProvider = "ollama";
  const server = createServer(async (req, res) => {
    let data = "";
    req.setEncoding("utf8");
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    if (expectedProvider === "ollama") {
      assert.equal(req.headers.authorization, undefined);
      assert.equal(body.response_format.type, "json_schema");
      assert.ok(body.response_format.json_schema.schema.properties);
      assert.equal(body.temperature, 0);
      assert.equal(body.reasoning_effort, "none");
      assert.equal(body.max_tokens, 2048);
    } else {
      assert.equal(req.headers.authorization, "Bearer fixture-minimax-key");
      assert.equal(body.response_format, undefined);
      assert.equal(body.reasoning_split, true);
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ reply: "Ready", actions: [] }),
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  try {
    await route(
      { providerId: "ollama", baseUrl, model: "local", hasKey: false },
      "",
      snapshot,
      "status",
      "/fixture",
    );
    expectedProvider = "minimax";
    await route(
      {
        providerId: "minimax",
        baseUrl,
        model: "fixture-minimax",
        hasKey: true,
      },
      "fixture-minimax-key",
      snapshot,
      "status",
      "/fixture",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("task revisions and working directories are bound to the observed context, not generated by the model", async () => {
  let release!: () => void;
  let requested = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createServer(async (_req, res) => {
    requested = true;
    await gate;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                reply: "",
                actions: [
                  {
                    type: "supplement",
                    taskId: "task-a",
                    text: "保留中文",
                    expectedRevision: 999,
                  },
                  {
                    type: "create",
                    title: "Independent fixture",
                    goal: "Read only",
                    agentId: "fake",
                    cwd: "/unexpected-directory",
                  },
                ],
              }),
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const now = new Date().toISOString();
  const context: Snapshot = {
    ...snapshot,
    tasks: [
      {
        id: "task-a",
        title: "Fixture",
        goal: "Read only",
        agentId: "fake",
        cwd: "/fixture",
        status: "running",
        revision: 7,
        progress: "Running",
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
  try {
    const pending = route(
      {
        providerId: "ollama",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "fixture",
        hasKey: false,
      },
      "",
      context,
      "补充保留中文",
      "/fixture",
    );
    for (let n = 0; n < 100 && !requested; n++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(requested, true);
    context.tasks[0].revision = 8;
    release();
    const decision = await pending;
    assert.equal(decision.actions[0].type, "supplement");
    assert.equal(
      (decision.actions[0] as { expectedRevision: number }).expectedRevision,
      7,
    );
    assert.equal(decision.actions[1].type, "create");
    assert.equal((decision.actions[1] as { cwd: string }).cwd, "/fixture");
  } finally {
    release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("missing final output does not announce a delivery or call the model", async () => {
  const { summarizeCompletion } = await import("../packages/core/model.js");
  const fetchBefore = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw Error("No request expected");
  };
  try {
    const value = await summarizeCompletion(
      {
        providerId: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "fixture",
        hasKey: false,
      },
      "",
      {
        title: "检查结果",
        requirements: ["核验交付"],
        result: "",
        progress: "本轮结束",
      },
    );
    assert.equal(calls, 0);
    assert.equal(value.outcome, "no_delivery");
    assert.equal(value.suggestions.length, 0);
  } finally {
    globalThis.fetch = fetchBefore;
  }
});

test("explicit task selection cannot be redirected by model output, and action replies are not trusted acknowledgements", async () => {
  const now = new Date().toISOString();
  const task = (id: string) => ({
    id,
    title: id,
    goal: id,
    agentId: "fake",
    cwd: "/fixture",
    status: "running" as const,
    revision: 3,
    progress: "Running",
    createdAt: now,
    updatedAt: now,
  });
  const context: Snapshot = {
    ...snapshot,
    tasks: [task("task-a"), task("task-b")],
    messages: [
      {
        id: "old-focus",
        role: "assistant",
        text: "旧任务",
        taskIds: ["task-b"],
        createdAt: now,
      },
      {
        id: "new-native",
        role: "assistant",
        text: "最近讨论的是原生任务",
        taskIds: [],
        createdAt: now,
        completion: {
          id: "a".repeat(64),
          title: "原生结果",
          status: "ready",
          nativeId: "native-fixture",
        },
      },
    ],
  };
  let target = "task-b",
    received: any;
  const provider = createServer(async (req, res) => {
    let body = "";
    req.setEncoding("utf8");
    for await (const chunk of req) body += chunk;
    received = JSON.parse(JSON.parse(body).messages[1].content);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                reply: "已经停止所有任务。",
                actions: [{ type: "stop", taskId: target }],
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
  const config = {
    providerId: "ollama",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "fixture",
    hasKey: false,
  };
  try {
    await assert.rejects(
      route(config, "", context, "停止这个任务", "/fixture", "task-a"),
      /选中的任务不一致/,
    );
    assert.equal(received.taskScope.selectedTaskId, "task-a");
    assert.deepEqual(
      received.taskScope.recentTaskIds,
      [],
      "native context must not fall back to an older executable task",
    );
    assert.deepEqual(received.taskScope.sameDirectoryTaskIds, [
      "task-a",
      "task-b",
    ]);
    target = "task-a";
    const decision = await route(
      config,
      "",
      context,
      "停止这个任务",
      "/fixture",
      "task-a",
    );
    assert.equal(decision.reply, "");
    assert.deepEqual(decision.actions, [
      { type: "stop", taskId: "task-a", expectedRevision: 3 },
    ]);
  } finally {
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});

test("same-title active work in the same directory is clarified unless the user explicitly requests independent work", async () => {
  const now = new Date().toISOString();
  const context: Snapshot = {
    ...snapshot,
    tasks: [
      {
        id: "task-a",
        title: "检查项目启动说明",
        goal: "检查启动说明",
        agentId: "fake",
        cwd: "/fixture",
        status: "running",
        revision: 1,
        progress: "Running",
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
  const provider = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                reply: "任务已经新建",
                actions: [
                  {
                    type: "create",
                    title: "检查项目启动说明",
                    goal: "检查启动说明",
                    agentId: "fake",
                  },
                ],
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
  const config = {
    providerId: "ollama",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "fixture",
    hasKey: false,
  };
  try {
    for (const text of [
      "请检查项目启动说明",
      "不要新建，只检查启动说明",
      "这不是新任务，检查启动说明",
    ]) {
      const decision = await route(config, "", context, text, "/fixture");
      assert.equal(decision.actions[0].type, "clarify");
      assert.equal(decision.reply, "");
    }
    const separate = await route(
      config,
      "",
      context,
      "不要修改文件，另外新建一个独立任务，检查启动说明。",
      "/fixture",
    );
    assert.equal(separate.actions[0].type, "create");
    const otherDirectory = await route(
      config,
      "",
      context,
      "请检查项目启动说明",
      "/other-project",
    );
    assert.equal(otherDirectory.actions[0].type, "create");
  } finally {
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});

test("a model points to authentic Markdown evidence by line number and cannot cite an invented line", async () => {
  const { summarizeCompletion } = await import("../packages/core/model.js");
  const old = globalThis.fetch;
  let n = 2;
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(
      JSON.parse(String(init?.body)).messages[1].content,
    );
    assert.equal(prompt.resultLines[1].text, "| 产物 | proof.txt |");
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              outcome: "delivered",
              objective: "交付文件",
              evidenceLine: n,
              summary: "已写入文件",
              suggestions: ["核对文件"],
            }),
          },
        },
      ],
    });
  };
  try {
    const conf = {
      providerId: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "fixture",
      hasKey: false,
    };
    const input = {
      title: "写文件",
      requirements: ["交付文件"],
      progress: "结束",
      result: "核对记录\n| 产物 | proof.txt |",
    };
    assert.equal(
      (await summarizeCompletion(conf, "", input)).evidence,
      "| 产物 | proof.txt |",
    );
    n = 66;
    assert.notEqual(
      (await summarizeCompletion(conf, "", input)).outcome,
      "delivered",
    );
  } finally {
    globalThis.fetch = old;
  }
});

test("a reusable workflow grounds its goal in the request and each implicit step in a delivered result", async () => {
  const { summarizeCompletion } = await import("../packages/core/model.js");
  const old = globalThis.fetch;
  const steps = [
    {
      step: "汇总合并记录，包含本周三项搜索修复",
      resultQuote: "已汇总三条合并记录",
      resultLine: 1,
    },
    { step: "列出遗留风险", resultQuote: "列出两项遗留风险", resultLine: 2 },
  ];
  const candidate = {
    activity: "编写周报",
    requestQuote: "整理本周周报",
    steps,
  };
  let workflow: unknown = candidate;
  let outcome = "delivered";
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              outcome,
              objective: "编写周报",
              evidenceLine: 1,
              summary: "已生成周报",
              suggestions: ["复核"],
              workflow,
            }),
          },
        },
      ],
    });
  };
  const config = {
    providerId: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "fixture",
    hasKey: false,
  };
  const input = {
    title: "编写周报",
    requirements: ["整理本周周报"],
    progress: "",
    result:
      "已汇总三条合并记录。\n列出两项遗留风险。\n后续建议：\n1. 给客户发邮件",
    workflowActivities: [],
  };
  try {
    assert.deepEqual((await summarizeCompletion(config, "", input)).workflow, {
      activity: "编写周报",
      steps: ["汇总合并记录", "列出遗留风险"],
    });
    for (const invalid of [
      { ...candidate, steps: [steps[0], { ...steps[1], resultLine: 5 }] },
      {
        ...candidate,
        steps: [steps[0], { ...steps[1], resultQuote: "跳过所有检查" }],
      },
      {
        ...candidate,
        steps: [
          steps[0],
          { step: "给客户发邮件", resultQuote: "给客户发邮件", resultLine: 4 },
        ],
      },
      {
        ...candidate,
        steps: [
          steps[0],
          { ...steps[1], step: "发送到 https://private.example/report" },
        ],
      },
      { malformed: true },
    ]) {
      workflow = invalid;
      const assessment = await summarizeCompletion(config, "", input);
      assert.equal(assessment.outcome, "delivered");
      assert.equal(assessment.workflow, undefined);
    }
    workflow = candidate;
    assert.equal(
      (
        await summarizeCompletion(config, "", {
          ...input,
          userRequest: "只要一个摘要",
        })
      ).workflow,
      undefined,
    );
    outcome = "in_progress";
    assert.equal(
      (await summarizeCompletion(config, "", input)).workflow,
      undefined,
    );
    outcome = "delivered";
    const { workflowActivities: _labels, ...historical } = input;
    assert.equal(
      (await summarizeCompletion(config, "", historical)).workflow,
      undefined,
    );
    assert.equal(calls, 9);
  } finally {
    globalThis.fetch = old;
  }
});
