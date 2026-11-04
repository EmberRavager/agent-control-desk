import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../packages/core/store.js";
import { Runtime } from "../packages/core/runtime.js";
import { startServer } from "../packages/core/server.js";
import {
  CompletionReporter,
  queueCompletion,
  type CompletionJob,
  type CompletionInput,
} from "../packages/core/completion.js";
import type { StartRun, NativeSession } from "../packages/contracts/index.js";
const until = async (check: () => boolean) => {
  for (let n = 0; n < 150; n++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("Completion fixture did not settle");
};
function fixture(
  directory = realpathSync(mkdtempSync(join(tmpdir(), "acd-completion-"))),
) {
  const store = new Store(directory),
    runs: StartRun[] = [],
    inputs: CompletionInput[] = [];
  let fail = false;
  const runtime = new Runtime(store, {
    scan: async () => [],
    vault: { get: async () => null, set: async () => {} },
    route: async (_c, _k, _s, text, cwd) => ({
      reply: "",
      actions: [
        { type: "create", agentId: "fixture", title: text, goal: text, cwd },
      ],
    }),
    adapter: () => ({
      start: async (input) => {
        runs.push(input);
        return {
          steer: async () => {},
          answer: async () => {},
          stop: async () => {},
          dispose() {},
        };
      },
    }),
    report: async (_c, _k, input) => {
      inputs.push(structuredClone(input));
      if (fail) throw Error("模型暂时不可用");
      return {
        outcome: "delivered",
        objective: input.title,
        evidence: input.result.trim(),
        summary: "目标产出已就绪。",
        suggestions: ["检查结果是否符合原始要求", "确认后再开展下一步"],
      };
    },
  });
  store.put("settings", "model", {
    providerId: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "fixture",
    hasKey: false,
  });
  store.put("agents", "fixture", {
    id: "fixture",
    kind: "codex",
    name: "Codex",
    executable: "/not-executed",
    selected: true,
    available: true,
    capabilities: { steer: true, resume: true },
  });
  const reporter = new CompletionReporter(runtime, async () => ({
    request: "修复分析缓存",
    requests: ["完成后自动建议"],
    updates: [],
    tools: [],
    finalAnswer: "已完成缓存修复，测试已通过。",
    truncated: false,
  }));
  return {
    runtime,
    store,
    runs,
    inputs,
    reporter,
    directory,
    fail(value: boolean) {
      fail = value;
    },
    async close(remove = true) {
      await reporter.close();
      runtime.shutdown();
      store.close();
      if (remove) rmSync(directory, { recursive: true, force: true });
    },
  };
}
const native = (
  status: NativeSession["status"],
  turnId = "turn-1",
  endedReason?: NativeSession["endedReason"],
): NativeSession => ({
  id: "native-fixture",
  agentId: "fixture",
  sessionId: "external-thread",
  turnId,
  title: "Codex fixture",
  cwd: "/fixture",
  status,
  endedReason,
  progress: status === "idle" ? "本轮已结束" : "正在执行",
  observedAt: new Date().toISOString(),
});
function observe(x: ReturnType<typeof fixture>, session: NativeSession) {
  x.runtime.updateObservations([
    {
      agentId: "fixture",
      source: "run-events",
      state: "connected",
      message: "Connected",
      sessions: [session],
    },
  ]);
}

test("owned completion produces one durable report, automatic suggestions, and one notification", async () => {
  const x = fixture();
  x.reporter.start();
  try {
    x.runtime.receive("修复任务展示", x.directory);
    await until(() => x.runs.length === 1);
    const run = x.runs[0];
    run.onEvent({ type: "output", text: "已修复展示逻辑。" });
    run.onEvent({ type: "completed" });
    for (let n = 0; n < 10; n++) x.runtime.publish();
    await until(() =>
      x.runtime
        .snapshot()
        .messages.some((m) => m.completion?.status === "ready"),
    );
    assert.equal(x.inputs.length, 1);
    assert.match(x.inputs[0].result, /已修复展示/);
    assert.equal(
      x.runtime.snapshot().messages.filter((m) => m.completion).length,
      1,
    );
    assert.equal(
      x.runtime
        .snapshot()
        .notifications!.items.filter((n) => n.kind === "result").length,
      1,
    );
    assert.equal(x.runtime.snapshot().tasks[0].status, "review");
    assert.match(
      x.runtime.snapshot().messages.find((m) => m.completion)!.text,
      /建议/,
    );
    run.onEvent({ type: "completed" });
    x.runtime.publish();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(x.inputs.length, 1);
  } finally {
    await x.close();
  }
});

test("replayed ends and identical delivery evidence in a later turn produce one native report", async () => {
  const x = fixture();
  x.reporter.start();
  try {
    observe(x, native("idle"));
    assert.equal(x.store.list("completion-jobs").length, 0);
    observe(x, native("running"));
    observe(x, native("unknown"));
    assert.equal(x.store.list("completion-jobs").length, 0);
    observe(x, native("idle", "turn-1", "completed"));
    await until(
      () =>
        x.inputs.length === 1 &&
        x.runtime.snapshot().messages[0]?.completion?.status === "ready",
    );
    assert.equal(x.inputs[0].requirements[0], "修复分析缓存");
    assert.match(x.inputs[0].result, /测试已通过/);
    for (let n = 0; n < 5; n++)
      observe(x, native("idle", "turn-1", "completed"));
    assert.equal(x.store.list("completion-jobs").length, 1);
    observe(x, native("running", "turn-2"));
    observe(x, native("idle", "turn-2", "completed"));
    await until(() =>
      x.store
        .list<CompletionJob>("completion-jobs")
        .some((job) => job.state === "skipped"),
    );
    assert.equal(
      x.runtime.snapshot().tasks.length,
      0,
      "observed work never becomes an executable ACD task",
    );
    assert.equal(
      x.runtime
        .snapshot()
        .notifications!.items.filter((n) => n.kind === "result").length,
      1,
    );
    observe(x, native("running", "turn-3"));
    observe(x, native("idle", "turn-3", "aborted"));
    assert.equal(
      x.store.list("completion-jobs").length,
      2,
      "aborted work does not claim task completion",
    );
  } finally {
    await x.close();
  }
});

test("owned native sessions do not generate a duplicate external report", async () => {
  const x = fixture();
  x.reporter.start();
  try {
    x.runtime.receive("真实任务目标", x.directory);
    await until(() => x.runs.length === 1);
    const run = x.runs[0];
    run.onEvent({
      type: "session",
      sessionId: "external-thread",
      turnId: "turn-1",
    });
    observe(x, native("running"));
    run.onEvent({ type: "completed", text: "返回最终结果" });
    observe(x, native("idle", "turn-1", "completed"));
    await until(() => x.inputs.length === 1);
    assert.equal(x.store.list("completion-jobs").length, 1);
  } finally {
    await x.close();
  }
});

test("interrupted report checkpoints recover once, including a missing placeholder message", async () => {
  const x = fixture();
  const executionKey = "task:recovery:1",
    id = createHash("sha256").update(executionKey).digest("hex");
  x.store.put("completion-jobs", id, {
    id,
    messageId: "completion-" + id,
    executionKey,
    state: "working",
    attempts: 1,
    retryAt: 0,
    prepared: true,
    createdAt: new Date().toISOString(),
    title: "恢复结果报告",
    requirements: ["检查结果"],
    result: "返回的公开结果",
    progress: "本轮已结束",
  } satisfies CompletionJob);
  const directory = x.directory;
  await x.close(false);
  const next = fixture(directory);
  next.reporter.start();
  try {
    await until(
      () =>
        next.store.get<CompletionJob>("completion-jobs", id)?.state === "done",
    );
    assert.equal(next.inputs.length, 1);
    assert.equal(
      next.store.getMessage("completion-" + id)?.completion?.status,
      "ready",
    );
  } finally {
    await next.close(false);
  }
  const again = fixture(directory);
  again.reporter.start();
  try {
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(again.inputs.length, 0);
    assert.equal(
      again.runtime.snapshot().messages.filter((m) => m.completion).length,
      1,
    );
  } finally {
    await again.close();
  }
});

test("failed advice retries with a delay and bounded attempts; explicit retry preserves one report", async (t) => {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const x = fixture();
  x.fail(true);
  x.reporter.start();
  try {
    const job = queueCompletion(x.store, {
      executionKey: "fixture:retry",
      title: "结果检查",
      requirements: ["核对结果"],
      result: "已返回",
      progress: "结束",
    });
    x.runtime.publish();
    await until(
      () =>
        x.store.get<CompletionJob>("completion-jobs", job.id)?.attempts === 1,
    );
    assert.equal(x.inputs.length, 1);
    clock += 29000;
    x.runtime.publish();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(x.inputs.length, 1);
    clock += 2000;
    x.runtime.publish();
    await until(
      () =>
        x.store.get<CompletionJob>("completion-jobs", job.id)?.state ===
        "failed",
    );
    assert.equal(x.inputs.length, 2);
    clock += 60000;
    x.runtime.publish();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(x.inputs.length, 2);
    x.fail(false);
    x.reporter.retry(job.id);
    await until(
      () => x.runtime.snapshot().messages[0]?.completion?.status === "ready",
    );
    assert.equal(x.inputs.length, 3);
    assert.equal(x.runtime.snapshot().messages.length, 1);
    assert.equal(x.runtime.snapshot().notifications!.items.length, 1);
  } finally {
    await x.close();
  }
});

test("an explicit new terminal event can report a short native run without an intermediate active snapshot", async () => {
  const x = fixture();
  x.reporter.start();
  try {
    observe(x, {
      ...native("idle", "short-turn", "completed"),
      completionObserved: true,
    });
    await until(() => x.inputs.length === 1);
    observe(x, {
      ...native("idle", "short-turn", "completed"),
      completionObserved: true,
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(x.inputs.length, 1);
    assert.equal(x.store.list("completion-jobs").length, 1);
  } finally {
    await x.close();
  }
});

test("report retries require local authentication, a strict empty payload, and an existing durable report", async () => {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "acd-report-api-")),
  );
  let calls = 0;
  const app = await startServer({
    directory,
    port: 0,
    deps: {
      scan: async () => [],
      vault: { get: async () => null, set: async () => {} },
      report: async (_config, _key, input) => {
        calls++;
        return {
          outcome: "delivered",
          objective: input.title,
          evidence: input.result.trim(),
          summary: "返回结果",
          suggestions: ["核验要求"],
        };
      },
      adapter: () => {
        throw Error("No execution");
      },
    },
  });
  const id = "a".repeat(64),
    path = `/api/reports/${id}/retry`;
  const post = (body: unknown = {}, auth = true) =>
    fetch(app.descriptor.url + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: "Bearer " + app.descriptor.token } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post({}, false)).status, 401);
    assert.equal((await post({ unexpected: true })).status, 400);
    assert.equal((await post()).status, 400);
    const job = queueCompletion(app.runtime.store, {
      executionKey: "retry-api",
      title: "检查本地结果",
      requirements: ["核验要求"],
      result: "返回结果",
      progress: "本轮结束",
    });
    app.runtime.store.put("completion-jobs", job.id, {
      ...job,
      state: "failed",
      attempts: 2,
    });
    app.runtime.store.put("settings", "model", {
      providerId: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "fixture",
      hasKey: false,
    });
    const response = await fetch(
      app.descriptor.url + `/api/reports/${job.id}/retry`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + app.descriptor.token,
        },
        body: "{}",
      },
    );
    assert.equal(response.status, 200);
    await until(
      () =>
        app.runtime.store.getMessage(job.messageId)?.completion?.status ===
        "ready",
    );
    assert.equal(calls, 1);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native internal end without a user request and final answer stays silent and consumes no report model", async () => {
  const x = fixture();
  await x.reporter.close();
  const reporter = new CompletionReporter(x.runtime, async () => ({
    request: "",
    requests: [],
    updates: [],
    tools: [],
    truncated: false,
  }));
  reporter.start();
  try {
    observe(x, native("running", "internal-turn"));
    observe(x, native("idle", "internal-turn", "completed"));
    await until(
      () =>
        x.store.list<CompletionJob>("completion-jobs")[0]?.state === "skipped",
    );
    assert.equal(x.runtime.snapshot().messages.length, 0);
    assert.equal(x.runtime.snapshot().notifications!.unread, 0);
    assert.equal(x.inputs.length, 0);
  } finally {
    await reporter.close();
    await x.close();
  }
});

test("recognized internal native reports are hidden from conversation and notification feeds without deleting audit history", async () => {
  const x = fixture();
  x.reporter.start();
  try {
    observe(x, native("running"));
    observe(x, native("idle", "turn-1", "completed"));
    await until(
      () =>
        x.inputs.length === 1 &&
        x.runtime.snapshot().messages[0]?.completion?.status === "ready",
    );
    x.runtime.updateObservations([
      {
        agentId: "fixture",
        state: "connected",
        source: "run-events",
        message: "filtered",
        sessions: [],
        excludedSessionIds: ["native-fixture"],
      },
    ]);
    assert.equal(x.runtime.snapshot().messages.length, 0);
    assert.equal(x.runtime.snapshot().notifications!.unread, 0);
    assert.equal(x.runtime.snapshot().notifications!.items.length, 0);
    assert.equal(x.store.history().length, 1);
    const restarted = new Runtime(x.store, x.runtime.deps);
    assert.equal(restarted.snapshot().messages.length, 0);
    assert.equal(restarted.snapshot().notifications!.unread, 0);
    restarted.shutdown();
  } finally {
    await x.close();
  }
});

test("unfinished goal stays silent; a later verified delivery with its earlier objective produces one report", async () => {
  const x = fixture();
  const seen: CompletionInput[] = [];
  x.runtime.deps.report = async (_config, _key, input) => {
    seen.push(input);
    return input.result.includes("release.zip")
      ? {
          outcome: "delivered",
          objective: "交付可安装的客户端",
          evidence: "release.zip",
          summary: "已交付客户端安装包。",
          suggestions: ["安装后检查版本"],
        }
      : {
          outcome: "in_progress",
          objective: "交付可安装的客户端",
          evidence: "",
          summary: "",
          suggestions: [],
        };
  };
  const reporter = new CompletionReporter(x.runtime, async (_id, turn) => ({
    request: turn === "first" ? "交付可安装的客户端" : "继续完成",
    requests: [],
    tools: [],
    updates: [],
    truncated: false,
    finalAnswer:
      turn === "first"
        ? "正在构建，验收未完成。"
        : "已导出 release.zip，安装和启动验证通过。",
  }));
  try {
    reporter.start();
    observe(x, native("running", "first"));
    observe(x, native("idle", "first", "completed"));
    await until(() =>
      x.store
        .list<CompletionJob>("completion-jobs")
        .some((j) => j.state === "skipped"),
    );
    assert.equal(x.runtime.snapshot().messages.length, 0);
    assert.equal(x.runtime.snapshot().notifications!.unread, 0);
    observe(x, native("running", "next"));
    observe(x, native("idle", "next", "completed"));
    await until(() =>
      x.store.history().some((m) => m.completion?.status === "ready"),
    );
    assert.equal(seen[1].previous?.objective, "交付可安装的客户端");
    assert.equal(x.store.history().length, 1);
  } finally {
    await reporter.close();
    await x.close();
  }
});
test("report is not announced during assessment, and a changed task invalidates the late verdict", async () => {
  const x = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  x.runtime.deps.report = async (_c, _k, input) => {
    started = true;
    await gate;
    return {
      outcome: "delivered",
      objective: "交付文件",
      evidence: input.result,
      summary: "已交付",
      suggestions: ["核验文件"],
    };
  };
  try {
    x.reporter.start();
    x.runtime.receive("交付文件", x.directory);
    await until(() => x.runs.length === 1);
    const run = x.runs[0];
    run.onEvent({ type: "completed", text: "已交付 file.txt" });
    await until(() => started);
    assert.equal(
      x.store.history().some((m) => m.completion),
      false,
    );
    const task = x.runtime.snapshot().tasks[0];
    x.store.put("tasks", task.id, {
      ...task,
      revision: task.revision + 1,
      status: "running",
    });
    release();
    await until(
      () =>
        x.store.list<CompletionJob>("completion-jobs")[0]?.state === "skipped",
    );
    assert.equal(
      x.store.history().some((m) => m.completion?.status === "ready"),
      false,
    );
  } finally {
    release();
    await x.close();
  }
});

test("a turn with instructions but no final answer preserves the goal for a follow-up without making a report", async () => {
  const x = fixture();
  const seen: CompletionInput[] = [];
  x.runtime.deps.report = async (_c, _k, input) => {
    seen.push(input);
    return {
      outcome: "in_progress",
      objective: "交付已签名的安装包",
      summary: "签名未核对",
      evidence: "",
      suggestions: [],
    };
  };
  const reporter = new CompletionReporter(x.runtime, async (_id, turn) => ({
    request: turn === "origin" ? "交付安装包，必须验证签名" : "继续",
    requests: [],
    updates: [],
    tools: [],
    truncated: false,
    finalAnswer: turn === "origin" ? "" : "构建已经完成",
  }));
  try {
    reporter.start();
    observe(x, native("running", "origin"));
    observe(x, native("idle", "origin", "completed"));
    await until(
      () =>
        x.store.list<CompletionJob>("completion-jobs")[0]?.state === "skipped",
    );
    assert.equal(seen.length, 0);
    observe(x, native("running", "continued"));
    observe(x, native("idle", "continued", "completed"));
    await until(() => seen.length > 0);
    assert.match(JSON.stringify(seen[0].previous), /必须验证签名/);
    assert.equal(x.store.history().length, 0);
  } finally {
    await reporter.close();
    await x.close();
  }
});

test("an inconclusive assessment retains the user's raw requirements for the next turn", async () => {
  const x = fixture(),
    seen: CompletionInput[] = [];
  x.runtime.deps.report = async (_c, _k, input) => {
    seen.push(input);
    return {
      outcome: "no_delivery",
      objective: "",
      summary: "",
      evidence: "",
      suggestions: [],
    };
  };
  const reporter = new CompletionReporter(x.runtime, async (_id, turn) => ({
    request: turn === "a" ? "发到手机并确认实际收到" : "继续",
    requests: [],
    updates: [],
    tools: [],
    truncated: false,
    finalAnswer: turn === "a" ? "接口受理，手机未收到" : "正在排查",
  }));
  try {
    reporter.start();
    for (const turn of ["a", "b"]) {
      observe(x, native("running", turn));
      observe(x, native("idle", turn, "completed"));
      await until(() =>
        x.store
          .list<CompletionJob>("completion-jobs")
          .some((j) => j.native?.turnId === turn && j.state === "skipped"),
      );
    }
    assert.match(
      JSON.stringify(seen[1].previous) || "",
      /发到手机并确认实际收到/,
    );
    assert.equal(x.store.history().length, 0);
  } finally {
    await reporter.close();
    await x.close();
  }
});
