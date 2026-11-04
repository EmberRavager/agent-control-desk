import test from "node:test";
import assert from "node:assert/strict";
import {
  conversationMessages,
  latestNativeReports,
} from "../packages/contracts/completion.js";
import type { Message } from "../packages/contracts/index.js";
test("every ready result is visible in the supervisor and the sidebar groups native sessions", () => {
  const messages: Message[] = [
    { id: "u", role: "user", text: "要求", taskIds: [], createdAt: "1" },
    ...["old", "new"].map((id) => ({
      id,
      role: "assistant" as const,
      text: id,
      taskIds: [],
      createdAt: id,
      completion: {
        id,
        title: "任务",
        status: "ready" as const,
        nativeId: "native-a",
      },
    })),
    {
      id: "owned",
      role: "assistant",
      text: "独立任务",
      taskIds: ["task"],
      createdAt: "4",
      completion: { id: "owned", title: "独立", status: "ready" },
    },
  ];
  assert.deepEqual(
    conversationMessages(messages).map((m) => m.id),
    ["u", "old", "new", "owned"],
  );
  assert.deepEqual(
    latestNativeReports(messages).map((m) => m.id),
    ["new"],
  );
  assert.equal(messages.length, 4);
});

test("a direct outcome replaces only its own assessment in the supervisor conversation", () => {
  const base: Message = {
    id: "old",
    role: "assistant",
    text: "Earlier summary",
    taskIds: ["task"],
    createdAt: "1",
  };
  const earlier: Message = {
    ...base,
    completion: {
      id: "first",
      title: "First attempt",
      status: "ready",
      taskRevision: 1,
    },
  };
  const outcome: Message = {
    ...base,
    id: "answer",
    text: "The answer",
    taskOutcome: { revision: 2 },
  };
  const assessment: Message = {
    ...base,
    id: "report",
    completion: {
      id: "second",
      title: "Second attempt",
      status: "ready",
      taskRevision: 2,
    },
  };
  const other: Message = { ...assessment, id: "other", taskIds: ["different"] };
  assert.deepEqual(
    conversationMessages([earlier, outcome, assessment, other]).map(
      (m) => m.id,
    ),
    ["old", "answer", "other"],
  );
});

test("assessed work has one verified-status summary while a direct answer preserves the executor's original text", () => {
  const base: Message = {
    id: "result",
    role: "assistant",
    text: "Original result and source",
    taskIds: ["t"],
    taskOutcome: { revision: 3 },
    createdAt: "1",
  };
  const assessment: Message = {
    id: "assessment",
    role: "assistant",
    text: "Summary and suggestions",
    taskIds: ["t"],
    createdAt: "2",
    completion: {
      id: "r",
      title: "Task",
      status: "ready",
      assessed: true,
      taskRevision: 3,
      summary: "Summary",
      suggestions: ["Hidden from chat"],
    },
  };
  const task = {
    id: "t",
    title: "Check",
    goal: "Check it",
    agentId: "codex",
    cwd: "/fixture",
    revision: 3,
    status: "review" as const,
    progress: "Ready",
    createdAt: "1",
    updatedAt: "1",
  };
  const state = { tasks: [task], agents: [] };
  const work = conversationMessages([base, assessment], state);
  assert.equal(work.length, 1);
  assert.match(work[0].text, /总控判定已交付/);
  assert.match(work[0].text, /Summary/);
  assert.ok(!work[0].text.includes("Hidden from chat"));
  assert.equal(
    conversationMessages([base, assessment], {
      ...state,
      tasks: [{ ...task, responseKind: "answer" }],
    })[0].text,
    base.text,
  );
});
