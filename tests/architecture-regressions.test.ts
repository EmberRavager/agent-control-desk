import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/core/store.js";
import { Runtime, type Dependencies } from "../packages/core/runtime.js";
import { claimNotices } from "../packages/core/notifications.js";
import type {
  AgentConnection,
  Message,
  Snapshot,
  StartRun,
  Task,
} from "../packages/contracts/index.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "acd-architecture-check-"));
  let store = new Store(join(root, "data"));
  const starts: StartRun[] = [];
  const agent: AgentConnection = {
    id: "fixture",
    kind: "codex",
    name: "Fixture",
    executable: "/not-executed",
    selected: true,
    available: true,
    capabilities: { resume: true, steer: true },
  };
  const deps: Dependencies = {
    scan: async () => [],
    vault: { get: async () => null, set: async () => {} },
    adapter: () => ({
      start: async (run) => {
        starts.push(run);
        return {
          steer: async () => {},
          stop: async () => {},
          answer: async () => {},
          dispose() {},
        };
      },
    }),
  };
  store.put("agents", agent.id, agent);
  let runtime = new Runtime(store, deps);
  t.after(() => {
    runtime.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    starts,
    get store() {
      return store;
    },
    get runtime() {
      return runtime;
    },
    restart() {
      runtime.shutdown();
      store.close();
      store = new Store(join(root, "data"));
      runtime = new Runtime(store, deps);
    },
    task(cwd: string) {
      return runtime.prepareTask({
        title: "Fixture",
        goal: "Read-only fixture",
        agentId: agent.id,
        cwd,
      });
    },
  };
}
for (const reverse of [false, true]) {
  test(`a ..-prefixed child directory shares the parent execution lock (${reverse ? "child first" : "parent first"})`, async (t) => {
    const f = fixture(t);
    const parent = join(f.root, "workspace"),
      child = join(parent, "..nested");
    mkdirSync(child, { recursive: true });
    const first = f.task(reverse ? child : parent),
      second = f.task(reverse ? parent : child);
    f.runtime.dispatchPreparedTask(first);
    await new Promise((resolve) => setImmediate(resolve));
    f.runtime.dispatchPreparedTask(second);
    assert.equal(f.store.get<Task>("tasks", second.id)?.status, "queued");
    assert.equal(f.starts.length, 1);
    f.starts[0].onEvent({ type: "completed", text: "Fixture complete" });
    assert.equal(f.starts.length, 2);
    assert.equal(f.store.get<Task>("tasks", second.id)?.status, "running");
  });
}
test("sibling directories remain eligible for parallel execution", (t) => {
  const f = fixture(t);
  const a = join(f.root, "work"),
    b = join(f.root, "work-other");
  mkdirSync(a);
  mkdirSync(b);
  f.runtime.dispatchPreparedTask(f.task(a));
  f.runtime.dispatchPreparedTask(f.task(b));
  assert.equal(f.starts.length, 2);
});
const report = (id: string): Message => ({
  id,
  role: "assistant",
  text: id,
  taskIds: [],
  createdAt: "2026-11-04T00:00:00.000Z",
  completion: {
    id,
    title: "Fixture",
    status: "ready",
    nativeId: "native-fixture",
  },
});
test("superseded report notices stay suppressed after all reports leave the conversation window and after restart", (t) => {
  const f = fixture(t);
  for (const id of ["report-old", "report-latest"]) {
    f.store.message(report(id));
    f.runtime.publish();
  }
  for (let i = 0; i < 205; i++)
    f.store.message({
      id: "filler-" + i,
      role: "system",
      text: "Fixture",
      taskIds: [],
      createdAt: "2026-11-04T00:01:00.000Z",
    });
  f.runtime.publish();
  assert.ok(!f.runtime.snapshot().messages.some((m) => m.completion));
  const check = () => {
    const snapshot = f.runtime.snapshot(),
      feed = snapshot.notifications!;
    assert.equal(feed.unread, 1);
    assert.equal(
      feed.items.find((n) => n.messageId === "report-old")?.superseded,
      true,
    );
    assert.equal(
      feed.items.find((n) => n.messageId === "report-old")?.active,
      false,
    );
  };
  check();
  f.restart();
  check();
  // Revising an old report must not make it the newest report again.
  f.store.message({
    ...report("report-old"),
    text: "Updated old fixture result",
  });
  f.runtime.publish();
  check();
  const snapshot = f.runtime.snapshot();
  const claimed = claimNotices(
    f.store,
    snapshot,
    snapshot.notifications!.items.map((n) => n.id),
  );
  assert.deepEqual(
    claimed.map((n) => n.messageId),
    ["report-latest"],
  );
});
test("a state publication reads base entity collections once and includes newly projected notices", (t) => {
  const f = fixture(t);
  const task = f.task(f.root);
  task.status = "review";
  f.store.put("tasks", task.id, task);
  const counts = new Map<string, number>(),
    list = f.store.list.bind(f.store);
  f.store.list = <T>(kind: string): T[] => {
    counts.set(kind, (counts.get(kind) || 0) + 1);
    return list<T>(kind);
  };
  let emitted: Snapshot | undefined;
  f.runtime.once("state", (state: Snapshot) => {
    emitted = state;
  });
  f.runtime.publish();
  assert.ok(
    emitted?.notifications?.items.some((notice) => notice.taskId === task.id),
  );
  for (const kind of ["agents", "tasks", "questions", "schedules"])
    assert.equal(
      counts.get(kind),
      1,
      `Repeated ${kind} scan during one publication`,
    );
});

test("a queued directory redirected to another project is blocked before the adapter starts", async (t) => {
  const f = fixture(t);
  const parent = join(f.root, "workspace"),
    a = join(parent, "a"),
    b = join(parent, "b");
  mkdirSync(a, { recursive: true });
  mkdirSync(b);
  const holding = f.task(parent),
    redirected = f.task(b),
    valid = f.task(a);
  f.runtime.dispatchPreparedTask(holding);
  await new Promise((resolve) => setImmediate(resolve));
  f.runtime.dispatchPreparedTask(redirected);
  f.runtime.dispatchPreparedTask(valid);
  assert.equal(f.store.get<Task>("tasks", redirected.id)?.status, "queued");
  renameSync(b, join(parent, "b-old"));
  symlinkSync(a, b, "dir");
  f.starts[0].onEvent({ type: "completed", text: "Fixture complete" });
  assert.equal(f.store.get<Task>("tasks", redirected.id)?.status, "blocked");
  assert.equal(f.store.get<Task>("tasks", valid.id)?.status, "running");
  assert.deepEqual(
    f.starts.map((run) => run.task.id),
    [holding.id, valid.id],
  );
});
