import test from "node:test";
import assert from "node:assert/strict";
import type { Message, Snapshot, Task } from "../packages/contracts/index.js";
import { lookupHistory } from "../packages/core/history.js";

const at = "2026-11-04T00:00:00Z";
const task = (id: string, cwd = "/fixture/a"): Task => ({
  id,
  cwd,
  title: "提交项目",
  goal: "准备项目",
  agentId: "codex",
  status: "completed",
  revision: 1,
  progress: "已结束",
  result: "GitHub push 已完成，commit fixture-sha",
  createdAt: at,
  updatedAt: at,
});
const snapshot = (tasks: Task[] = [], messages: Message[] = []): Snapshot => ({
  tasks,
  messages,
  agents: [],
  questions: [],
  model: null,
});
const report = (id: string, sourceId: string, text: string): Message => ({
  id,
  role: "assistant",
  text,
  taskIds: [],
  createdAt: at,
  completion: {
    id,
    nativeId: sourceId,
    title: "项目交付",
    status: "ready",
    assessed: true,
    summary: text,
  },
});

test("a short factual follow-up retrieves an old native report without history keywords", () => {
  const s = snapshot(
    [],
    [
      report(
        "old-report",
        "native-old",
        "GitHub 已推送，commit fixture-old-sha",
      ),
      ...Array.from({ length: 60 }, (_, i): Message => ({
        id: "recent-" + i,
        role: "user",
        text: "普通讨论 " + i,
        taskIds: [],
        createdAt: "2026-11-04T01:00:00Z",
      })),
    ],
  );
  const result = lookupHistory(s, "github提交了吗", "/fixture/other");
  assert.equal(result.entries[0].sourceId, "native-old");
  assert.equal(result.entries[0].kind, "native");
  assert.equal(result.entries[0].match, "content");
  assert.ok(
    result.entries[0].excerpts.some((text) => text.includes("fixture-old-sha")),
  );
  assert.deepEqual(result.entries[0].messageIds, ["old-report"]);
});

test("same-name tasks remain separate across projects and explicit source bounds the lookup", () => {
  const s = snapshot([task("task-a"), task("task-b", "/fixture/b")]);
  const found = lookupHistory(s, "GitHub 提交了吗", "/fixture/b");
  assert.deepEqual(
    found.entries.map((entry) => entry.sourceId),
    ["task-b", "task-a"],
  );
  assert.equal(found.entries[0].cwd, "/fixture/b");
  const exact = lookupHistory(s, "GitHub 提交了吗", "/fixture/b", "task-a");
  assert.deepEqual(
    exact.entries.map((entry) => entry.sourceId),
    ["task-a"],
  );
  assert.deepEqual(
    lookupHistory(s, "GitHub", "/fixture/b", "missing").entries,
    [],
  );
});

test("history keeps unconfirmed task status and omits withheld or unfinished reports", () => {
  const s = snapshot(
    [
      {
        ...task("task-unknown"),
        status: "unknown",
        result: "push 结果未知，请核对",
      },
    ],
    [
      {
        ...report("hidden", "native-hidden", "HIDDEN"),
        completion: {
          id: "hidden",
          nativeId: "native-hidden",
          title: "hidden",
          status: "withheld",
        },
      },
      {
        ...report("pending", "native-pending", "PENDING"),
        completion: {
          id: "pending",
          nativeId: "native-pending",
          title: "pending",
          status: "pending",
        },
      },
    ],
  );
  const result = lookupHistory(s, "push结果", "/fixture/a");
  assert.equal(result.entries[0].status, "unknown");
  assert.ok(
    result.entries[0].excerpts.some((text) => text.includes("结果未知")),
  );
  assert.doesNotMatch(JSON.stringify(result), /HIDDEN|PENDING/);
});

test("history redacts credentials and bounds source count, excerpt size and total payload", () => {
  const secret = "ghp_" + "a".repeat(28);
  const s = snapshot(
    Array.from({ length: 15 }, (_, i) => ({
      ...task("task-" + i),
      result:
        "GitHub " + secret + " password=fixture-secret " + "公".repeat(12000),
    })),
  );
  const result = lookupHistory(s, "github", "/fixture/a");
  assert.ok(result.entries.length <= 5);
  assert.ok(result.hasMore);
  assert.ok(result.entries.some((entry) => entry.truncated));
  assert.ok(JSON.stringify(result).length <= 8000);
  assert.doesNotMatch(
    JSON.stringify(result),
    new RegExp(secret + "|fixture-secret"),
  );
  assert.match(JSON.stringify(result), /REDACTED/);
});

test("unmatched lookups expose a small recent source set without claiming a match", () => {
  const s = snapshot([
    task("old"),
    { ...task("new"), updatedAt: "2026-11-04T02:00:00Z" },
  ]);
  const result = lookupHistory(s, "不相关的需求", "/fixture/a");
  assert.equal(result.entries[0].sourceId, "new");
  assert.ok(result.entries.every((entry) => entry.match === "recent"));
  assert.ok(result.entries.length <= 5);
  assert.equal(result.query, "不相关的需求");
  assert.deepEqual(
    lookupHistory(snapshot(), "GitHub", "/fixture/a").entries,
    [],
  );
});

test("an archived native report never infers an execution identity from the agent display name", () => {
  const s = snapshot(
    [],
    [
      {
        ...report("report", "native-archived", "GitHub 结果待核对"),
        completion: {
          id: "report",
          nativeId: "native-archived",
          title: "历史提交",
          status: "ready",
          assessed: false,
          agentName: "Codex",
        },
      },
    ],
  );
  s.agents = [
    {
      id: "codex-new",
      name: "Codex",
      kind: "codex",
      executable: "/fixture",
      selected: true,
      available: true,
      capabilities: { steer: true, resume: true },
    },
  ];
  const result = lookupHistory(s, "GitHub", "/fixture/a");
  assert.equal(result.entries[0].sourceId, "native-archived");
  assert.equal(result.entries[0].agentId, undefined);
  assert.equal(result.entries[0].status, "reported-unconfirmed");
});
