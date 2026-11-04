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
test("new messages expose allocation through one optional non-submitting control", async () => {
  const { AllocationControls } = await components();
  const html = renderToStaticMarkup(
    React.createElement(AllocationControls, {
      agents: [agent],
      targetAgentId: "",
      requiredCapabilities: [],
      locked: false,
      onAgentChange() {},
      onCapabilitiesChange() {},
    }),
  );
  const panel = html.match(/<[^<>]+\bpopover="auto"[^<>]*>/i);
  assert.ok(
    panel,
    "advanced settings live in an initially closed native popover",
  );
  const outside = html.slice(0, panel.index);
  const triggers = outside.match(/<button\b[^>]*>/g) || [];
  assert.equal(triggers.length, 1);
  const trigger = triggers[0];
  assert.match(trigger, /type="button"/);
  assert.match(trigger, /aria-label="[^"]*本次发送选项[^"]*"/);
  assert.doesNotMatch(outside, /<select|<fieldset|必需能力/);
  const target = trigger.match(/\bpopovertarget="([^"]+)"/i)?.[1];
  assert.ok(target);
  assert.ok(panel[0].includes('id="' + target + '"'));
  const contents = html.slice(panel.index);
  assert.match(contents, /<select/);
  assert.match(contents, /必需能力/);
});
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
test("task supplements and question answers omit inapplicable allocation controls", async () => {
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
  assert.equal(html, "");
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
