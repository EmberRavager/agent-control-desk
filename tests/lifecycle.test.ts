import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../packages/core/runtime.js";
import { Store } from "../packages/core/store.js";
import type {
  AgentConnection,
  AdapterEvent,
  RunHandle,
  StartRun,
  Task,
} from "../packages/contracts/index.js";
const agent: AgentConnection = {
  id: "a",
  kind: "codex",
  name: "Fake",
  executable: "/fixture",
  selected: true,
  available: true,
  capabilities: { steer: true, resume: true },
};
const vault = { get: async () => "test-key", set: async () => {} };
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("Lifecycle did not settle");
};
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "acd-life-")));
  const store = new Store(dir);
  store.put("agents", "a", agent);
  store.put("settings", "model", {
    baseUrl: "https://example.invalid/v1",
    model: "fake",
    hasKey: true,
  });
  return { dir, store };
}
test("supplement received during adapter connection is delivered after the handle is ready", async () => {
  const { dir, store } = fixture();
  let resolve!: (h: RunHandle) => void,
    started = false;
  const steers: string[] = [];
  const runtime = new Runtime(store, {
    scan: async () => [],
    vault,
    adapter: () => ({
      start: () => {
        started = true;
        return new Promise((r) => (resolve = r));
      },
    }),
    route: async (_c, _k, s, text) => ({
      reply: "",
      actions: s.tasks.length
        ? [
            {
              type: "supplement",
              taskId: s.tasks[0].id,
              text,
              expectedRevision: s.tasks[0].revision,
            },
          ]
        : [
            {
              type: "create",
              title: "Task",
              goal: text,
              agentId: "a",
              cwd: dir,
            },
          ],
    }),
  });
  try {
    runtime.receive("create", dir);
    await until(() => started);
    runtime.receive("new requirement", dir);
    await until(() => runtime.snapshot().tasks[0].revision === 2);
    assert.equal(runtime.snapshot().tasks[0].status, "running");
    resolve({
      steer: async (text) => {
        steers.push(text);
      },
      stop: async () => {},
      answer: async () => {},
      dispose() {},
    });
    await until(() => steers.length === 1);
    assert.equal(steers[0], "new requirement");
  } finally {
    runtime.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("unknown resource stays reserved until explicit user-confirmed reconciliation", async () => {
  const { dir, store } = fixture();
  const old: Task = {
    id: "old",
    title: "Original",
    goal: "Original",
    agentId: "a",
    cwd: dir,
    status: "running",
    revision: 1,
    progress: "",
    createdAt: "now",
    updatedAt: "now",
  };
  store.put("tasks", "old", old);
  let starts = 0;
  const runtime = new Runtime(store, {
    scan: async () => [],
    vault,
    adapter: () => ({
      start: async () => {
        starts++;
        return {
          steer: async () => {},
          stop: async () => {},
          answer: async () => {},
          dispose() {},
        };
      },
    }),
    route: async () => ({
      reply: "",
      actions: [
        { type: "create", title: "New", goal: "New", agentId: "a", cwd: dir },
      ],
    }),
  });
  try {
    assert.equal(
      runtime.snapshot().tasks.find((t) => t.id === "old")?.status,
      "unknown",
    );
    runtime.receive("New", dir);
    await until(() => runtime.snapshot().tasks.length === 2);
    assert.equal(starts, 0);
    runtime.reconcile("old");
    await until(() => starts === 1);
    const reconciled = runtime.snapshot().tasks.find((t) => t.id === "old")!;
    assert.equal(reconciled.status, "cancelled");
    assert.match(reconciled.progress, /用户已确认/);
  } finally {
    runtime.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("late stop and answer errors preserve authoritative terminal events", async () => {
  for (const operation of ["stop", "answer"] as const) {
    const { dir, store } = fixture();
    let emit: ((event: AdapterEvent) => void) | undefined;
    const runtime = new Runtime(store, {
      scan: async () => [],
      vault,
      route: async () => ({
        reply: "",
        actions: [
          {
            type: "create",
            title: "Race",
            goal: "Race",
            cwd: dir,
            agentId: "a",
          },
        ],
      }),
      adapter: () => ({
        start: async ({ onEvent }) => {
          emit = onEvent;
          return {
            steer: async () => {},
            dispose() {},
            stop: async () => {
              onEvent({ type: "cancelled" });
              throw Error("late stop transport failure");
            },
            answer: async () => {
              onEvent({ type: "completed" });
              throw Error("late answer transport failure");
            },
          };
        },
      }),
    });
    try {
      runtime.receive("Race", dir);
      await until(() => !!emit);
      const task = runtime.snapshot().tasks[0];
      if (operation === "stop") {
        await runtime.stop(task.id);
        assert.equal(runtime.snapshot().tasks[0].status, "cancelled");
      } else {
        emit!({
          type: "question",
          requestId: "q",
          text: "Confirm",
          choices: ["accept"],
        });
        await runtime.answer(
          runtime.snapshot().questions.find((q) => !q.resolved)!.id,
          "accept",
        );
        assert.equal(runtime.snapshot().tasks[0].status, "review");
      }
      assert.ok(runtime.snapshot().questions.every((q) => q.resolved));
    } finally {
      runtime.shutdown();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("native input accepts text; concurrent questions stay pending until all resolve", async () => {
  const { dir, store } = fixture();
  let emit: ((event: AdapterEvent) => void) | undefined;
  const answers: string[] = [];
  const runtime = new Runtime(store, {
    scan: async () => [],
    vault,
    route: async () => ({
      reply: "",
      actions: [
        {
          type: "create",
          title: "Input",
          goal: "Input",
          cwd: dir,
          agentId: "a",
        },
      ],
    }),
    adapter: () => ({
      start: async ({ onEvent }) => {
        emit = onEvent;
        return {
          steer: async () => {},
          stop: async () => {},
          dispose() {},
          answer: async (_id, text) => {
            answers.push(text);
          },
        };
      },
    }),
  });
  try {
    runtime.receive("Input", dir);
    await until(() => !!emit);
    emit!({
      type: "question",
      requestId: "input",
      input: true,
      text: "Requirement",
      choices: [],
    });
    emit!({
      type: "question",
      requestId: "permission",
      text: "Confirm",
      choices: ["option-1"],
      choiceLabels: { "option-1": "允许这次操作" },
    });
    const qs = runtime.snapshot().questions;
    const input = qs.find((q) => q.nativeRequestId === "input")!;
    const permission = qs.find((q) => q.nativeRequestId === "permission")!;
    assert.equal(input.kind, "input");
    assert.equal(permission.choiceLabels?.["option-1"], "允许这次操作");
    await runtime.answer(input.id, "用户补充的任意文本");
    assert.deepEqual(answers, ["用户补充的任意文本"]);
    assert.equal(runtime.snapshot().tasks[0].status, "waiting_input");
    emit!({ type: "question_resolved", requestId: "permission" });
    assert.equal(runtime.snapshot().tasks[0].status, "running");
    await assert.rejects(
      () => runtime.answer(permission.id, "option-1"),
      /失效/,
    );
    emit!({
      type: "question",
      requestId: "empty",
      text: "No valid approval",
      choices: [],
    });
    await assert.rejects(
      () =>
        runtime.answer(
          runtime
            .snapshot()
            .questions.find((q) => q.nativeRequestId === "empty")!.id,
          "invented",
        ),
      /无效/,
    );
    emit!({ type: "completed" });
    assert.ok(runtime.snapshot().questions.every((q) => q.resolved));
  } finally {
    runtime.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a proven pre-submission failure releases the directory; uncertain loss keeps it reserved", async () => {
  for (const taskNotSubmitted of [true, false]) {
    const { dir, store } = fixture();
    const starts: ((event: AdapterEvent) => void)[] = [];
    let n = 0;
    const runtime = new Runtime(store, {
      scan: async () => [],
      vault,
      route: async () => ({
        reply: "",
        actions: [
          {
            type: "create",
            title: "Work " + ++n,
            goal: "Independent " + n,
            cwd: dir,
            agentId: "a",
          },
        ],
      }),
      adapter: () => ({
        start: async ({ onEvent }) => {
          starts.push(onEvent);
          return {
            steer: async () => {},
            stop: async () => {},
            answer: async () => {},
            dispose() {},
          };
        },
      }),
    });
    try {
      runtime.receive("First", dir);
      await until(() => starts.length === 1);
      starts[0]({ type: "failed", taskNotSubmitted });
      assert.equal(
        runtime.snapshot().tasks[0].status,
        taskNotSubmitted ? "failed" : "unknown",
      );
      runtime.receive("独立新任务 Second", dir);
      await until(() => runtime.snapshot().tasks.length === 2);
      if (taskNotSubmitted) await until(() => starts.length === 2);
      else {
        assert.equal(starts.length, 1);
        assert.equal(
          runtime.snapshot().tasks.find((t) => t.title === "Work 2")?.status,
          "queued",
        );
      }
    } finally {
      runtime.shutdown();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("supplement-triggered stop retains the confirmed end even if its request later rejects", async () => {
  const { dir, store } = fixture();
  let emit: ((event: AdapterEvent) => void) | undefined;
  const runtime = new Runtime(store, {
    scan: async () => [],
    vault,
    route: async (_c, _k, s, text) => ({
      reply: "",
      actions: s.tasks.length
        ? [
            {
              type: "supplement",
              taskId: s.tasks[0].id,
              text,
              expectedRevision: s.tasks[0].revision,
            },
          ]
        : [
            {
              type: "create",
              title: "Work",
              goal: "Work",
              cwd: dir,
              agentId: "a",
            },
          ],
    }),
    adapter: () => ({
      start: async ({ onEvent }) => {
        emit = onEvent;
        return {
          steer: async () => {},
          answer: async () => {},
          dispose() {},
          stop: async () => {
            onEvent({ type: "cancelled" });
            throw Error("late stop failure");
          },
        };
      },
    }),
  });
  try {
    runtime.receive("start", dir);
    await until(() => !!emit);
    emit!({
      type: "question",
      requestId: "old-approval",
      text: "Confirm",
      choices: ["accept"],
    });
    runtime.receive("用户更新了要求", dir);
    await until(() =>
      runtime
        .snapshot()
        .messages.some(
          (m) => m.role === "assistant" && m.text.includes("待旧轮次停止确认"),
        ),
    );
    assert.equal(runtime.snapshot().tasks[0].status, "cancelled");
    assert.match(runtime.snapshot().tasks[0].goal, /用户更新了要求/);
    assert.ok(runtime.snapshot().questions.every((q) => q.resolved));
  } finally {
    runtime.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop during adapter connection is retained and sent once the handle arrives", async () => {
  const { dir, store } = fixture();
  let resolve!: (handle: RunHandle) => void;
  let emit: ((event: AdapterEvent) => void) | undefined,
    stops = 0;
  const runtime = new Runtime(store, {
    scan: async () => [],
    vault,
    route: async () => ({
      reply: "",
      actions: [
        {
          type: "create",
          title: "Connect",
          goal: "Connect",
          cwd: dir,
          agentId: "a",
        },
      ],
    }),
    adapter: () => ({
      start: ({ onEvent }) => {
        emit = onEvent;
        return new Promise((r) => (resolve = r));
      },
    }),
  });
  try {
    runtime.receive("start", dir);
    await until(() => !!emit);
    const id = runtime.snapshot().tasks[0].id;
    await runtime.stop(id);
    assert.equal(runtime.snapshot().tasks[0].status, "stopping");
    emit!({
      type: "question",
      requestId: "late-approval",
      text: "Late approval",
      choices: ["accept"],
    });
    assert.equal(runtime.snapshot().tasks[0].status, "stopping");
    assert.equal(
      runtime.snapshot().questions.some((q) => !q.resolved),
      false,
    );
    resolve({
      steer: async () => {},
      answer: async () => {},
      dispose() {},
      stop: async () => {
        stops++;
        emit!({ type: "cancelled" });
      },
    });
    await until(() => runtime.snapshot().tasks[0].status === "cancelled");
    assert.equal(stops, 1);
  } finally {
    runtime.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
