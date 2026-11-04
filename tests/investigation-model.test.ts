import test from "node:test";
import assert from "node:assert/strict";
import { route } from "../packages/core/model.js";
import type { Snapshot } from "../packages/contracts/index.js";
import type { InvestigationContext } from "../packages/contracts/investigation.js";

const snapshot: Snapshot = {
  tasks: [],
  agents: [],
  questions: [],
  messages: [],
  model: null,
};
const config = {
  providerId: "ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "fixture",
  hasKey: false,
};
const history: InvestigationContext = {
  stage: "history",
  history: {
    query: "github提交了吗",
    entries: [
      {
        sourceId: "native-fixture",
        kind: "native",
        match: "content",
        title: "发布桌面端",
        cwd: "/fixture",
        agentId: "codex",
        messageIds: ["report"],
        excerpts: ["安装包已生成，提交结果尚未记录。"],
        truncated: false,
      },
    ],
    hasMore: false,
  },
};
async function capture(
  actions: unknown[],
  investigation?: InvestigationContext,
  reply = "",
  selectedTaskId?: string,
) {
  const original = globalThis.fetch;
  let body: any;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({
      choices: [{ message: { content: JSON.stringify({ reply, actions }) } }],
    });
  };
  try {
    const decision = await route(
      config,
      "",
      snapshot,
      "github提交了吗",
      "/fixture",
      selectedTaskId,
      undefined,
      undefined,
      [],
      investigation,
    );
    return {
      decision,
      context: JSON.parse(body.messages[1].content),
      prompt: body.messages[0].content,
    };
  } finally {
    globalThis.fetch = original;
  }
}
test("insufficient facts can request bounded local history without creating work", async () => {
  const action = { type: "history", query: "github提交了吗" };
  const r = await capture([action]);
  assert.deepEqual(r.decision, { reply: "", actions: [action] });
  assert.match(r.prompt, /history/);
  assert.match(r.prompt, /ask_agent/);
});
test("history evidence is passed into the second decision and permits a sourced inquiry", async () => {
  const action = {
    type: "ask_agent",
    sourceId: "native-fixture",
    question: "请确认原任务是否已提交并推送，并提供提交号和分支。",
  };
  const r = await capture([action], history);
  assert.deepEqual(r.context.investigation, history);
  assert.deepEqual(r.decision.actions, [action]);
  assert.equal(
    r.context.investigation.history.entries[0].sourceId,
    "native-fixture",
  );
});
test("investigation actions cannot share a turn with mutations", async () => {
  const r = await capture([
    { type: "history", query: "提交情况" },
    { type: "create", title: "提交", goal: "git push", agentId: "codex" },
  ]);
  assert.deepEqual(
    r.decision.actions.map((a) => a.type),
    ["clarify"],
  );
});
test("an inquiry cannot select an executor outside the retrieved evidence", async () => {
  const r = await capture(
    [{ type: "ask_agent", sourceId: "invented", question: "提交了吗？" }],
    history,
  );
  assert.deepEqual(
    r.decision.actions.map((a) => a.type),
    ["clarify"],
  );
});
test("conversation-only history cannot be turned into an arbitrary agent inquiry", async () => {
  const r = await capture(
    [{ type: "ask_agent", sourceId: "conversation", question: "提交了吗？" }],
    {
      stage: "history",
      history: {
        query: "提交了吗",
        entries: [
          {
            ...history.history.entries[0],
            sourceId: "conversation",
            kind: "conversation",
            agentId: undefined,
          },
        ],
        hasMore: false,
      },
    },
  );
  assert.deepEqual(
    r.decision.actions.map((a) => a.type),
    ["clarify"],
  );
});
test("a direct inquiry before history remains available for runtime's history-first enforcement", async () => {
  const action = {
    type: "ask_agent",
    sourceId: "native-fixture",
    question: "提交了吗？",
  };
  assert.deepEqual((await capture([action])).decision.actions, [action]);
});
test("sufficient retrieved facts can produce an answer without another action", async () => {
  const r = await capture(
    [],
    history,
    "历史记录仅确认安装包已生成，提交结果仍需核实。",
  );
  assert.equal(
    r.decision.reply,
    "历史记录仅确认安装包已生成，提交结果仍需核实。",
  );
});

test("a recently active source alone does not authorize choosing that executor", async () => {
  const r = await capture(
    [{ type: "ask_agent", sourceId: "native-fixture", question: "提交了吗？" }],
    {
      stage: "history",
      history: {
        ...history.history,
        entries: [{ ...history.history.entries[0], match: "recent" }],
      },
    },
  );
  assert.deepEqual(
    r.decision.actions.map((action) => action.type),
    ["clarify"],
  );
});

test("retrieved history cannot turn a factual follow-up into a new work request", async () => {
  const r = await capture(
    [
      {
        type: "create",
        title: "提交 GitHub",
        goal: "重新提交并推送",
        agentId: "codex",
      },
    ],
    history,
  );
  assert.deepEqual(
    r.decision.actions.map((action) => action.type),
    ["clarify"],
  );
});

test("explicit task scope rejects a different history or inquiry source", async () => {
  for (const type of ["history", "ask_agent"]) {
    const result = await capture(
      type === "history"
        ? [{ type, query: "GitHub", sourceId: "other" }]
        : [{ type, question: "Verify the push", sourceId: "other" }],
      undefined,
      "",
      "selected-task",
    );
    assert.deepEqual(
      result.decision.actions.map((action) => action.type),
      ["clarify"],
    );
  }
});
