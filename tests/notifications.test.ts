import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../packages/core/server.js";
import type {
  Notice,
  NoticeFeed,
} from "../packages/contracts/notifications.js";
import type { Message, Task, StartRun } from "../packages/contracts/index.js";
import { createHash } from "node:crypto";
const wait = async (fn: () => boolean) => {
  for (let n = 0; n < 100; n++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("Notice fixture did not settle");
};
async function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "acd-notice-"))),
    runs: StartRun[] = [];
  const app = await startServer({
    directory,
    port: 0,
    deps: {
      scan: async () => [],
      vault: { get: async () => null, set: async () => {} },
      report: async (_config, _key, input) => ({
        outcome: "delivered",
        objective: input.title,
        evidence: "Fixture result",
        summary: "Fixture result",
        suggestions: ["Inspect fixture"],
      }),
      route: async (_c, _k, _s, text, cwd) => ({
        reply: "",
        actions: [
          { type: "create", title: text, goal: text, agentId: "fake", cwd },
        ],
      }),
      adapter: () => ({
        start: async (input) => {
          runs.push(input);
          return {
            steer: async () => {},
            stop: async () => input.onEvent({ type: "cancelled" }),
            answer: async () =>
              input.onEvent({ type: "completed", text: "Fixture result" }),
            dispose() {},
          };
        },
      }),
    },
  });
  app.runtime.store.put("settings", "model", {
    providerId: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "fixture",
    hasKey: false,
  });
  app.runtime.store.put("agents", "fake", {
    id: "fake",
    kind: "codex",
    name: "Fake",
    executable: "/not-used",
    selected: true,
    available: true,
    capabilities: { steer: true, resume: true },
  });
  const headers = {
    Authorization: "Bearer " + app.descriptor.token,
    "Content-Type": "application/json",
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(app.descriptor.url + path, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, value: await res.json() };
  };
  return {
    app,
    directory,
    runs,
    call,
    async close() {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
function seedTask(id: string, cwd: string): Task {
  const time = new Date().toISOString();
  return {
    id,
    title: "Task " + id,
    goal: "Fixture",
    agentId: "fake",
    cwd,
    status: "review",
    revision: 1,
    progress: "待检查",
    createdAt: time,
    updatedAt: time,
  };
}
test("key lifecycle notifications persist once; streamed progress does not spam and stale approvals are not claimed", async () => {
  const x = await fixture();
  try {
    x.app.runtime.receive("检查示例", x.directory);
    await wait(() => x.runs.length === 1);
    const run = x.runs[0];
    for (let n = 0; n < 20; n++)
      run.onEvent({ type: "progress", text: "chunk-" + n });
    assert.equal(x.app.runtime.snapshot().notifications!.items.length, 0);
    run.onEvent({
      type: "question",
      requestId: 1,
      text: "允许读取？",
      choices: ["accept", "decline"],
    });
    const q = x.app.runtime.snapshot().questions[0];
    let feed = x.app.runtime.snapshot().notifications!;
    assert.equal(feed.items.length, 1);
    assert.equal(feed.items[0].questionId, q.id);
    for (let n = 0; n < 5; n++) x.app.runtime.publish();
    assert.equal(x.app.runtime.snapshot().notifications!.items.length, 1);
    await x.app.runtime.answer(q.id, "accept");
    await wait(() =>
      x.app.runtime
        .snapshot()
        .notifications!.items.some((n) => n.kind === "result"),
    );
    feed = x.app.runtime.snapshot().notifications!;
    assert.equal(feed.items.length, 2);
    assert.equal(feed.items.find((n) => n.questionId === q.id)!.active, false);
    const response = await x.call("POST", "/api/notifications/claim", {
      ids: feed.items.map((n) => n.id),
    });
    assert.equal(response.status, 200);
    assert.equal(response.value.length, 1);
    assert.equal(response.value[0].kind, "result");
    await x.call("POST", "/api/notifications/settle", {
      ids: [response.value[0].id],
      outcome: "submitted",
    });
    assert.equal(
      (
        await x.call("POST", "/api/notifications/claim", {
          ids: feed.items.map((n) => n.id),
        })
      ).value.length,
      0,
    );
  } finally {
    await x.close();
  }
});
test("concurrent desktop claims select one sender and read-all stops at its original sequence watermark", async () => {
  const x = await fixture();
  try {
    x.app.runtime.store.put("tasks", "first", seedTask("first", x.directory));
    x.app.runtime.publish();
    const first = x.app.runtime.snapshot().notifications!.items[0];
    const claims = await Promise.all([
      x.call("POST", "/api/notifications/claim", { ids: [first.id] }),
      x.call("POST", "/api/notifications/claim", { ids: [first.id] }),
    ]);
    assert.equal(
      claims.reduce((n, r) => n + r.value.length, 0),
      1,
    );
    x.app.runtime.store.put("notifications", first.id, {
      ...first,
      createdAt: "2099-01-01T00:00:00.000Z",
    });
    x.app.runtime.store.put("tasks", "second", seedTask("second", x.directory));
    x.app.runtime.publish();
    const latest = x.app.runtime.snapshot().notifications!.items[0];
    assert.ok(latest.sequence > first.sequence);
    await x.call("POST", "/api/notifications/read", { throughId: first.id });
    const feed = (await x.call("GET", "/api/notifications"))
      .value as NoticeFeed;
    assert.equal(feed.unread, 1);
    assert.ok(feed.items.find((n) => n.id === first.id)!.readAt);
    assert.equal(feed.items.find((n) => n.id === latest.id)!.readAt, undefined);
  } finally {
    await x.close();
  }
});
test("notice preferences and read state require auth; disable suppresses popups without deleting inbox history", async () => {
  const x = await fixture();
  try {
    assert.equal(
      (await fetch(x.app.descriptor.url + "/api/notifications")).status,
      401,
    );
    x.app.runtime.store.put("tasks", "failed", {
      ...seedTask("failed", x.directory),
      status: "failed",
    });
    x.app.runtime.publish();
    const feed = x.app.runtime.snapshot().notifications!;
    const settings = {
      ...feed.preferences,
      desktop: false,
      sound: false,
      details: false,
    };
    assert.equal(
      (await x.call("PUT", "/api/notifications/preferences", settings)).status,
      200,
    );
    assert.equal(
      (
        await x.call("PUT", "/api/notifications/preferences", {
          ...settings,
          grantPermissions: true,
        })
      ).status,
      400,
    );
    const claimed = await x.call("POST", "/api/notifications/claim", {
      ids: feed.items.map((n) => n.id),
    });
    assert.equal(claimed.value.length, 0);
    assert.equal(x.app.runtime.snapshot().notifications!.unread, 1);
    assert.equal(
      x.app.runtime.snapshot().notifications!.items[0].desktop,
      "suppressed",
    );
  } finally {
    await x.close();
  }
});
test("routing failures with no task remain actionable notices linked to the original conversation message", async () => {
  const x = await fixture();
  try {
    x.app.runtime.store.put("settings", "model", null);
    x.app.runtime.receive("这条尚未执行", x.directory);
    await wait(() => x.app.runtime.snapshot().notifications!.items.length > 0);
    const n = x.app.runtime.snapshot().notifications!.items[0];
    assert.equal(n.kind, "error");
    assert.ok(n.messageId);
    assert.ok(
      x.app.runtime
        .snapshot()
        .messages.some((m) => m.id === n.messageId && m.attention),
    );
    assert.equal(x.runs.length, 0);
  } finally {
    await x.close();
  }
});
test("paginated notice history has stable cursors while new notices arrive", async () => {
  const x = await fixture();
  try {
    for (let n = 0; n < 65; n++)
      x.app.runtime.store.put(
        "tasks",
        "task-" + n,
        seedTask("task-" + n, x.directory),
      );
    x.app.runtime.publish();
    const first = (await x.call("GET", "/api/notifications"))
      .value as NoticeFeed;
    assert.equal(first.items.length, 50);
    assert.equal(first.hasMore, true);
    x.app.runtime.store.put("tasks", "new", seedTask("new", x.directory));
    x.app.runtime.publish();
    const second = (
      await x.call("GET", "/api/notifications?before=" + first.items.at(-1)!.id)
    ).value as NoticeFeed;
    assert.equal(second.items.length, 15);
    assert.equal(second.hasMore, false);
    assert.equal(
      new Set([...first.items, ...second.items].map((n) => n.id)).size,
      65,
    );
  } finally {
    await x.close();
  }
});
test("restart keeps read state and claimed notices without replaying the old lifecycle transition", async () => {
  const x = await fixture();
  try {
    x.app.runtime.store.put(
      "tasks",
      "persistent",
      seedTask("persistent", x.directory),
    );
    x.app.runtime.publish();
    const n = x.app.runtime.snapshot().notifications!.items[0];
    await x.call("POST", "/api/notifications/claim", { ids: [n.id] });
    await x.call("POST", "/api/notifications/read", { ids: [n.id] });
    await x.app.close();
    const next = await startServer({
      directory: x.directory,
      port: 0,
      deps: {
        scan: async () => [],
        vault: { get: async () => null, set: async () => {} },
        adapter: () => {
          throw Error("must not start");
        },
      },
    });
    try {
      const feed = next.runtime.snapshot().notifications!;
      assert.equal(feed.items.length, 1);
      assert.equal(feed.items[0].id, n.id);
      assert.equal(feed.items[0].desktop, "claimed");
      assert.equal(feed.unread, 0);
    } finally {
      await next.close();
    }
  } finally {
    await x.close();
  }
});

test("unverified system outcomes persist without being reclaimed as another popup", async () => {
  const x = await fixture();
  try {
    x.app.runtime.store.put(
      "tasks",
      "uncertain-notice",
      seedTask("uncertain-notice", x.directory),
    );
    x.app.runtime.publish();
    const n = x.app.runtime.snapshot().notifications!.items[0];
    await x.call("POST", "/api/notifications/claim", { ids: [n.id] });
    assert.equal(
      (
        await x.call("POST", "/api/notifications/settle", {
          ids: [n.id],
          outcome: "unverified",
        })
      ).status,
      200,
    );
    assert.equal(
      x.app.runtime.snapshot().notifications!.items[0].desktop,
      "unverified",
    );
    assert.equal(
      (await x.call("POST", "/api/notifications/claim", { ids: [n.id] })).value
        .length,
      0,
    );
  } finally {
    await x.close();
  }
});

test("older native reports stay in history but stop contributing unread or duplicate desktop popups", async () => {
  const x = await fixture();
  try {
    for (let i = 1; i <= 2; i++) {
      x.app.runtime.store.message({
        id: "report-" + i,
        role: "assistant",
        text: "报告" + i,
        taskIds: [],
        createdAt: new Date().toISOString(),
        completion: {
          id: String(i),
          title: "原生会话",
          nativeId: "native-same",
          status: "ready",
          summary: "完成",
          suggestions: [],
        },
      });
      x.app.runtime.publish();
    }
    const feed = x.app.runtime.snapshot().notifications!;
    assert.equal(feed.items.length, 2);
    assert.equal(feed.unread, 1);
    assert.equal(
      feed.items.find((n) => n.messageId === "report-1")!.superseded,
      true,
    );
    assert.equal(
      feed.items.find((n) => n.messageId === "report-1")!.active,
      false,
    );
    const claimed = await x.call("POST", "/api/notifications/claim", {
      ids: feed.items.map((n) => n.id),
    });
    assert.equal(claimed.value.length, 1);
    assert.equal(claimed.value[0].messageId, "report-2");
  } finally {
    await x.close();
  }
});

test("ready report updates its historical notice and opens the original full report outside chat", async () => {
  const x = await fixture();
  try {
    const pending: Message = {
      id: "archived-report",
      role: "assistant",
      taskIds: [],
      createdAt: new Date().toISOString(),
      text: "pending",
      completion: {
        id: "original",
        status: "pending",
        title: "Original",
        nativeId: "native-fixture",
      },
    };
    const id = createHash("sha256").update("completion:original").digest("hex");
    x.app.runtime.store.message(pending);
    // A previous app version already issued and the user read this placeholder.
    x.app.runtime.store.put("notifications", id, {
      id,
      messageId: pending.id,
      title: "pending",
      kind: "result",
      body: "pending",
      sequence: 42,
      readAt: pending.createdAt,
      createdAt: pending.createdAt,
      desktop: "submitted",
    });
    for (let n = 0; n < 205; n++)
      x.app.runtime.store.message({
        ...pending,
        id: "filler-" + n,
        completion: undefined,
      });
    const summary = "full-original-".repeat(200) + "original-tail";
    x.app.runtime.store.message({
      ...pending,
      text: summary,
      completion: {
        ...pending.completion!,
        status: "ready",
        summary,
        suggestions: ["original-suggestion"],
      },
    });
    x.app.runtime.store.message({
      ...pending,
      id: "newer",
      text: "newer",
      completion: { ...pending.completion!, id: "newer", status: "ready" },
    });
    x.app.runtime.publish();
    const snapshot = x.app.runtime.snapshot();
    assert.equal(
      snapshot.messages.some((m) => m.id === pending.id),
      false,
    );
    const notice = snapshot.notifications!.items.find((n) => n.id === id)!;
    assert.equal(notice.body, summary.slice(0, 1800));
    assert.equal(notice.desktop, "submitted");
    assert.equal(notice.readAt, pending.createdAt);
    assert.equal(notice.sequence, 42);
    assert.equal(notice.superseded, true);
    const path = "/api/notifications/" + id + "/report";
    assert.equal((await fetch(x.app.descriptor.url + path)).status, 401);
    const detail = await x.call("GET", path);
    assert.equal(detail.status, 200);
    assert.equal(detail.value.summary, summary);
    assert.deepEqual(detail.value.suggestions, ["original-suggestion"]);
    const newer = snapshot.notifications!.items.find(
      (n) => n.messageId === "newer",
    )!;
    assert.equal(
      (await x.call("GET", "/api/notifications/" + newer.id + "/report")).value
        .summary,
      "newer",
    );
    x.app.runtime.store.put("native-executions", "native-fixture", {
      id: "native-fixture",
      ignored: true,
    });
    assert.equal((await x.call("GET", path)).status, 404);
  } finally {
    await x.close();
  }
});
