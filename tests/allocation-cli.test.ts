import test from "node:test";
import assert from "node:assert/strict";
import { parseSendArgs, request } from "../apps/cli/main.js";

test("CLI separates explicit execution choices from message text and canonicalizes requirements", () => {
  assert.deepEqual(
    parseSendArgs([
      "修复",
      "登录",
      "--agent",
      "fixture-codex",
      "--require",
      "steer,input",
      "--require",
      "input",
    ]),
    {
      text: "修复 登录",
      targetAgentId: "fixture-codex",
      requiredCapabilities: ["input", "steer"],
    },
  );
  assert.deepEqual(parseSendArgs(["--agent", "auto", "解释一下"]), {
    text: "解释一下",
  });
  assert.deepEqual(parseSendArgs(["--", "--agent", "是命令参数"]), {
    text: "--agent 是命令参数",
  });
  for (const args of [
    ["--agent"],
    ["text", "--require", "shell"],
    ["text", "--agent", "a", "--agent", "b"],
    ["text", "--unknown"],
    ["--require", "steer"],
  ]) {
    assert.throws(() => parseSendArgs(args));
  }
});

test("CLI refuses allocation operations on an old daemon before submitting a request", async () => {
  const descriptor = {
    url: "http://127.0.0.1:1",
    token: "synthetic",
    protocol: 1,
    pid: 123,
    capabilities: ["message-idempotency"],
  };
  for (const [method, path, body] of [
    ["POST", "/api/messages", { text: "test", targetAgentId: "agent" }],
    [
      "POST",
      "/api/messages",
      { text: "test", requiredCapabilities: ["steer"] },
    ],
    ["PUT", "/api/allocation", { agentId: "agent" }],
    ["GET", "/api/allocation", undefined],
  ] as const) {
    await assert.rejects(
      request(descriptor, method, path, body),
      /不支持任务分配/,
    );
  }
});
