import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AgentConnection,
  AllocationDecision,
} from "../packages/contracts/index.js";

const agent: AgentConnection = {
  id: "codex",
  name: "Codex",
  kind: "codex",
  executable: "/fixture/codex",
  selected: true,
  available: true,
  supported: true,
  capabilities: { steer: true, resume: true, approval: true, input: true },
};
async function components() {
  const modulePath = "../apps/desktop/AllocationControls.js";
  const module = await import(modulePath).catch(() => ({}));
  assert.equal(
    typeof module.AllocationControls,
    "function",
    "allocation controls are available",
  );
  return module;
}
test("the composer keeps an unavailable selection visible instead of switching to automatic", async () => {
  const { AllocationControls } = await components();
  const html = renderToStaticMarkup(
    React.createElement(AllocationControls, {
      agents: [
        agent,
        { ...agent, id: "claude", name: "Claude", selected: false },
      ],
      targetAgentId: "removed",
      requiredCapabilities: ["steer"],
      locked: false,
      onAgentChange() {},
      onCapabilitiesChange() {},
    }),
  );
  assert.match(html, /aria-label="新任务执行者"/);
  assert.match(html, /value="removed" selected=""/);
  assert.match(html, /已不可用/);
  assert.doesNotMatch(html, /value="claude"/);
  assert.match(html, /执行中追加/);
});
test("task supplements and question answers disable allocation without claiming to reassign", async () => {
  const { AllocationControls } = await components();
  const html = renderToStaticMarkup(
    React.createElement(AllocationControls, {
      agents: [agent],
      targetAgentId: "codex",
      requiredCapabilities: [],
      locked: true,
      onAgentChange() {},
      onCapabilitiesChange() {},
    }),
  );
  assert.match(html, /disabled=""/);
  assert.match(html, /沿用原任务执行者/);
});
test("allocation details show the recorded reason and explicit protocol requirements", async () => {
  const { AllocationReason } = await components();
  const allocation: AllocationDecision = {
    policyVersion: 1,
    source: "explicit",
    reason: "按本次指定，交给 Codex。",
    requiredCapabilities: ["steer", "approval"],
    excluded: [],
  };
  const html = renderToStaticMarkup(
    React.createElement(AllocationReason, { allocation }),
  );
  assert.match(html, /按本次指定，交给 Codex/);
  assert.match(html, /执行中追加/);
  assert.match(html, /授权交互/);
});
