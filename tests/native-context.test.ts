import test from "node:test";
import assert from "node:assert/strict";
import { publicNativeContext } from "../packages/core/native-context.js";
import { CodexRunEventReader } from "../packages/core/codex-live-events.js";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const record = (type: string, payload: unknown) =>
  JSON.stringify({ timestamp: "2026-11-03T08:00:00Z", type, payload });

test("task context includes public progress only, removes credential patterns, and never exposes reasoning or tool arguments", () => {
  const lines = [
    record("response_item", {
      type: "reasoning",
      summary: [{ text: "PRIVATE_REASONING" }],
    }),
    record("response_item", {
      type: "message",
      role: "assistant",
      channel: "analysis",
      content: [{ type: "output_text", text: "PRIVATE_ANALYSIS" }],
    }),
    record("response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "# AGENTS.md\nPRIVATE_CONFIG" }],
    }),
    record("response_item", {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "## My request:\n修复右侧任务页 api_key=FAKE_KEY password='FAKE_PASSWORD'",
        },
      ],
    }),
    record("response_item", {
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [
        { type: "output_text", text: "正在修复右侧任务页和 AI 摘要。" },
      ],
    }),
    record("response_item", {
      type: "function_call",
      name: "exec_command",
      arguments: "PRIVATE_COMMAND_ARGS",
    }),
    record("response_item", {
      type: "function_call_output",
      output: "PRIVATE_OUTPUT",
    }),
  ];
  const context = publicNativeContext(lines);
  assert.match(context.requests[0], /修复右侧任务页/);
  assert.match(context.updates[0], /AI 摘要/);
  assert.deepEqual(context.tools, ["exec_command"]);
  assert.ok(!JSON.stringify(context).includes("PRIVATE_"));
  assert.ok(!JSON.stringify(context).includes("FAKE_"));
});

test("context extraction stays within the current turn and rejects a changed execution identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "acd-native-context-"));
  const path = join(root, "fixture.jsonl");
  const id = "fixture-session";
  const reader = new CodexRunEventReader();
  const signal = new AbortController().signal;
  const publicMessage = (text: string) =>
    record("response_item", {
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text }],
    });
  try {
    await writeFile(
      path,
      [
        record("session_meta", { id, cwd: "/fixture" }),
        record("event_msg", { type: "task_started", turn_id: "old-turn" }),
        publicMessage("OLD_PUBLIC_PROGRESS"),
        record("event_msg", { type: "task_complete", turn_id: "old-turn" }),
        record("event_msg", { type: "task_started", turn_id: "current-turn" }),
        publicMessage("当前正在改进任务视图"),
      ].join("\n") + "\n",
    );
    await reader.read(path, id, signal);
    const context = await reader.context(path, id, "current-turn", signal);
    assert.deepEqual(context.updates, ["当前正在改进任务视图"]);
    assert.ok(!JSON.stringify(context).includes("OLD_PUBLIC_PROGRESS"));
    await appendFile(
      path,
      record("event_msg", { type: "task_started", turn_id: "new-turn" }) + "\n",
    );
    await assert.rejects(
      reader.context(path, id, "current-turn", signal),
      /新一轮执行/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("structured user replies retain their meaning without transport identifiers", () => {
  const context = publicNativeContext([
    record("event_msg", {
      type: "user_message",
      message:
        '<send_user_message_question_reply>\n[{"questionItemId":"transport-id","question":"请解锁后回复","answer":"已解锁"}]\n</send_user_message_question_reply>',
    }),
  ]);
  assert.deepEqual(context.requests, ["对“请解锁后回复”的回答：已解锁"]);
  assert.ok(!JSON.stringify(context).includes("transport-id"));
});

test("the original user goal survives amendments and a truncated execution tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "acd-native-requirement-"));
  const path = join(root, "fixture.jsonl"),
    id = "requirement-fixture";
  const reader = new CodexRunEventReader(),
    signal = new AbortController().signal;
  const original = "点击任务应先显示已有分析，运行中每30秒后台更新。";
  const amendments = [
    "切换页面保留结果",
    "不要反复调用模型",
    "完成后自动给我建议",
  ];
  try {
    await writeFile(
      path,
      [
        record("session_meta", { id, cwd: "/fixture" }),
        record("event_msg", { type: "task_started", turn_id: "turn-1" }),
        record("event_msg", { type: "user_message", message: original }),
        ...amendments.map((message) =>
          record("event_msg", { type: "user_message", message }),
        ),
        record("response_item", {
          type: "function_call_output",
          output: "PRIVATE_TOOL_OUTPUT".repeat(180000),
        }),
        record("response_item", {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [
            { type: "output_text", text: "正在运行类型检查，验证缓存。" },
          ],
        }),
      ].join("\n") + "\n",
    );
    await reader.read(path, id, signal);
    const context = await reader.context(path, id, "turn-1", signal);
    assert.equal(context.request, original);
    assert.deepEqual(context.requests, amendments);
    assert.deepEqual(context.updates, ["正在运行类型检查，验证缓存。"]);
    assert.equal(context.truncated, true);
    assert.ok(!JSON.stringify(context).includes("PRIVATE_TOOL_OUTPUT"));
    await appendFile(
      path,
      [
        record("event_msg", { type: "task_complete", turn_id: "turn-1" }),
        record("event_msg", { type: "task_started", turn_id: "turn-2" }),
        record("event_msg", {
          type: "user_message",
          message: "检查另一个独立项目",
        }),
      ].join("\n") + "\n",
    );
    const next = await reader.context(path, id, "turn-2", signal);
    assert.equal(next.request, "检查另一个独立项目");
    assert.ok(!JSON.stringify(next).includes(original));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completion evidence uses only the public final answer, never commentary, reasoning, or tool results", () => {
  const message = (phase: string, text: string) =>
    record("response_item", {
      type: "message",
      role: "assistant",
      phase,
      content: [{ type: "output_text", text }],
    });
  const context = publicNativeContext([
    message("commentary", "正在检查结果"),
    message("analysis", "PRIVATE_REASONING"),
    record("response_item", {
      type: "function_call_output",
      output: "PRIVATE_TOOL_RESULT",
    }),
    message("final_answer", "已修复自动滚动，token=FAKE_FIXTURE_TOKEN"),
    message("commentary", "等待用户核验"),
  ]);
  assert.equal(context.finalAnswer, "已修复自动滚动，token=[REDACTED]");
  assert.ok(!JSON.stringify(context).includes("PRIVATE_"));
});

test("goal wakeups retain only the user objective and do not turn runtime counters into new requirements", () => {
  const objective = "优化修复成一个可用好用的 ACD 软件";
  const envelope = (counter: number) =>
    `<codex_internal_context source="goal">\nContinue working.\n<objective>\n${objective}\n</objective>\nBudget: ${counter} tokens. PRIVATE_RUNTIME_INSTRUCTION\n</codex_internal_context>`;
  const context = publicNativeContext(
    [1, 2].map((counter) =>
      record("event_msg", { type: "user_message", message: envelope(counter) }),
    ),
  );
  assert.equal(context.request, objective);
  assert.deepEqual(context.requests, [objective]);
  assert.doesNotMatch(
    JSON.stringify(context),
    /Continue working|Budget|PRIVATE_RUNTIME|codex_internal_context/,
  );
});

test("malformed or unrelated internal envelopes do not become task goals", () => {
  const context = publicNativeContext([
    record("event_msg", {
      type: "user_message",
      message:
        '<codex_internal_context source="goal">PRIVATE_RUNTIME_NO_OBJECTIVE</codex_internal_context>',
    }),
    record("event_msg", {
      type: "user_message",
      message:
        '<codex_internal_context source="other"><objective>PRIVATE_NOT_A_GOAL</objective></codex_internal_context>',
    }),
    record("event_msg", { type: "user_message", message: "用户实际要求" }),
  ]);
  assert.equal(context.request, "用户实际要求");
  assert.doesNotMatch(JSON.stringify(context), /PRIVATE_/);
});
