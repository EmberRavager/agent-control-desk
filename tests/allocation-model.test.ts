import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { route, decisionSchema } from "../packages/core/model.js";
import type { Snapshot } from "../packages/contracts/index.js";

test("supervisor receives explicit allocation constraints and extracts named-agent requirements", async () => {
  let received: any;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received = JSON.parse(body);
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
                    type: "create",
                    title: "检查项目",
                    goal: "只读检查",
                    agentId: "claude",
                    requestedAgentId: "codex",
                    requiredCapabilities: ["steer"],
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
  const snapshot: Snapshot = {
    model: null,
    tasks: [],
    questions: [],
    messages: [],
    allocationSettings: {
      globalAgentId: "claude",
      projectAgentIds: { "/fixture": "claude" },
    },
    agents: ["codex", "claude"].map((id) => ({
      id,
      name: id,
      kind: id === "codex" ? "codex" : "claude",
      executable: "/not-run",
      selected: true,
      available: true,
      supported: true,
      capabilities: { steer: id === "codex", resume: true },
    })),
  };
  try {
    const decision = await route(
      {
        providerId: "custom",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "fixture",
        hasKey: true,
      },
      "fake",
      snapshot,
      "请交给 Codex，执行中我要追加要求",
      "/fixture",
      undefined,
      undefined,
      { targetAgentId: "codex", requiredCapabilities: ["steer"] },
    );
    const context = JSON.parse(received.messages[1].content);
    assert.equal(context.allocation.targetAgentId, "codex");
    assert.deepEqual(context.allocation.requiredCapabilities, ["steer"]);
    assert.equal(
      context.allocation.preferences.projectAgentIds["/fixture"],
      "claude",
    );
    assert.equal(context.agents.length, 2);
    assert.deepEqual(decision.actions[0], {
      type: "create",
      title: "检查项目",
      goal: "只读检查",
      agentId: "claude",
      requestedAgentId: "codex",
      requiredCapabilities: ["steer"],
      cwd: "/fixture",
    });
    assert.equal(decision.reply, "");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("required controls are limited to the adapted protocol vocabulary", () => {
  assert.equal(
    decisionSchema.safeParse({
      reply: "",
      actions: [
        {
          type: "create",
          title: "test",
          goal: "test",
          agentId: "a",
          requiredCapabilities: ["bypass-permissions"],
        },
      ],
    }).success,
    false,
  );
});
