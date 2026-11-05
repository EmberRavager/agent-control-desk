import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime, type Dependencies } from "../packages/core/runtime.js";
import { Store } from "../packages/core/store.js";
import type {
  Task,
  StartRun,
  AdapterEvent,
} from "../packages/contracts/index.js";
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 150; i++) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Investigation did not settle");
};
function fixture(
  route: Dependencies["route"],
  native = false,
  nativeContext?: Dependencies["nativeContext"],
) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "acd-investigation-")),
  );
  const store = new Store(directory);
  store.put("settings", "model", {
    providerId: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "fake",
    hasKey: false,
  });
  store.put("agents", "codex", {
    id: "codex",
    kind: "codex",
    name: "Codex",
    executable: "/fixture",
    selected: true,
    available: true,
    capabilities: { resume: true, steer: true },
  });
  const old: Task = {
    id: "original",
    title: "Upload code",
    goal: "Previously authorized work",
    agentId: "codex",
    cwd: directory,
    status: "completed",
    revision: 1,
    progress: "Earlier execution ended",
    result: "GitHub commit abc123 exists, push outcome is unknown.",
    sessionId: "original-thread",
    turnId: "original-turn",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (!native) store.put("tasks", old.id, old);
  else {
    store.put("native-executions", "native-original", {
      session: {
        id: "native-original",
        sessionId: "native-thread",
        turnId: "native-turn",
        agentId: "codex",
        title: "Upload code",
        cwd: directory,
        status: "idle",
        progress: "Earlier execution ended",
        observedAt: new Date().toISOString(),
      },
    });
    store.message({
      id: "native-report",
      role: "assistant",
      text: "GitHub commit exists but push outcome is unknown.",
      taskIds: [],
      createdAt: new Date().toISOString(),
      completion: {
        id: "report",
        status: "ready",
        nativeId: "native-original",
        turnId: "native-turn",
        title: "Upload code",
        agentName: "Codex",
        assessed: false,
      },
    });
  }
  const runs: StartRun[] = [];
  const runtime = new Runtime(store, {
    scan: async () => [],
    vault: { get: async () => null, set: async () => {} },
    route,
    nativeContext,
    adapter: () => ({
      start: async (input) => {
        runs.push(input);
        input.onEvent({
          type: "session",
          sessionId: "isolated-inquiry",
          turnId: "inquiry-turn",
        });
        return {
          steer: async () => {},
          stop: async () => {},
          answer: async () => {},
          dispose() {},
        };
      },
    }),
  });
  return {
    directory,
    store,
    runtime,
    runs,
    old,
    close() {
      runtime.shutdown();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test("history evidence can answer a short follow-up without starting an agent", async () => {
  let calls = 0;
  const f = fixture(
    async (
      _c,
      _k,
      _s,
      _text,
      _cwd,
      _target,
      _signal,
      _allocation,
      _memories,
      context,
    ) => {
      calls++;
      if (!context)
        return {
          reply: "",
          actions: [
            { type: "history", query: "GitHub push", sourceId: "original" },
          ],
        };
      assert.ok(
        context.history.entries[0].excerpts.some((e) => e.includes("abc123")),
      );
      return {
        reply: "Commit abc123 exists; push remains unconfirmed.",
        actions: [],
      };
    },
  );
  try {
    const m = f.runtime.receive("GitHub push?", f.directory);
    await until(
      () => f.store.getMessage(m.id)?.routing?.status === "completed",
    );
    assert.equal(calls, 2);
    assert.equal(f.runs.length, 0);
    assert.deepEqual(f.store.getMessage(m.id)?.routing?.actions, ["history"]);
    assert.ok(
      f.runtime
        .snapshot()
        .messages.some((x) => x.replyTo === m.id && x.text.includes("abc123")),
    );
  } finally {
    f.close();
  }
});
test("missing history evidence creates a correlated inquiry in a fork of the original executor", async () => {
  const f = fixture(
    async (
      _c,
      _k,
      _s,
      _text,
      _cwd,
      _target,
      _signal,
      _allocation,
      _memories,
      context,
    ) =>
      context
        ? {
            reply: "",
            actions: [
              {
                type: "ask_agent",
                sourceId: "original",
                question: "Was the commit pushed?",
              },
            ],
          }
        : {
            reply: "",
            actions: [
              { type: "history", query: "GitHub push", sourceId: "original" },
            ],
          },
  );
  try {
    const m = f.runtime.receive("Was it pushed?", f.directory);
    await until(() => f.runs.length === 1);
    const task = f.runs[0].task;
    assert.equal(task.responseKind, "answer");
    assert.equal(task.sourceMessageId, m.id);
    assert.equal(task.inquiry?.sessionId, "original-thread");
    assert.equal(task.inquiry?.sourceId, "original");
    assert.ok(!task.inquiry?.question.includes(f.old.goal));
    f.runs[0].onEvent({
      type: "completed",
      text: "The push cannot be confirmed from the conversation.",
    });
    await until(
      () =>
        f.runtime.snapshot().tasks.find((t) => t.id === task.id)?.status ===
        "completed",
    );
    assert.equal(f.store.get<Task>("tasks", "original")?.status, "completed");
    assert.ok(
      f.runtime
        .snapshot()
        .messages.some((item) => item.taskOutcome && item.replyTo === m.id),
    );
  } finally {
    f.close();
  }
});
test("an initial ask still reads history first and resolves archived native sources by stable ID", async () => {
  let calls = 0;
  const f = fixture(
    async (
      _c,
      _k,
      _s,
      _text,
      _cwd,
      _target,
      _signal,
      _allocation,
      _memories,
      context,
    ) => {
      calls++;
      if (context) {
        assert.equal(context.history.entries[0].agentId, "codex");
        assert.equal(context.history.entries[0].cwd, f.directory);
      }
      return {
        reply: "",
        actions: [
          {
            type: "ask_agent",
            sourceId: "native-original",
            question: "Was the push confirmed?",
          },
        ],
      };
    },
    true,
  );
  try {
    f.runtime.receive("GitHub push?", f.directory);
    await until(() => f.runs.length === 1);
    assert.equal(calls, 2);
    assert.equal(f.runs[0].task.inquiry?.sessionId, "native-thread");
  } finally {
    f.close();
  }
});
test("history lookup is bounded and cannot restart old work", async () => {
  for (const type of ["history", "create"] as const) {
    let calls = 0;
    const f = fixture(
      async (
        _c,
        _k,
        _s,
        _text,
        _cwd,
        _target,
        _signal,
        _allocation,
        _memories,
        context,
      ) => {
        calls++;
        if (!context || type === "history")
          return { reply: "", actions: [{ type: "history", query: "GitHub" }] };
        return {
          reply: "",
          actions: [
            {
              type: "create",
              title: "Repeat",
              goal: "Repeat the push",
              agentId: "codex",
              cwd: f.directory,
            },
          ],
        };
      },
    );
    try {
      const m = f.runtime.receive("GitHub push?", f.directory);
      await until(
        () => f.store.getMessage(m.id)?.routing?.status === "completed",
      );
      assert.equal(calls, 2);
      assert.equal(f.runs.length, 0);
      assert.equal(f.runtime.snapshot().tasks.length, 1);
    } finally {
      f.close();
    }
  }
});
test("conversation-only, recent-only and invented inquiry targets do not execute", async () => {
  for (const sourceId of ["invented", "user-message"]) {
    const f = fixture(
      async (
        _c,
        _k,
        _s,
        _text,
        _cwd,
        _target,
        _signal,
        _allocation,
        _memories,
        context,
      ) =>
        context
          ? {
              reply: "",
              actions: [{ type: "ask_agent", sourceId, question: "Confirm?" }],
            }
          : { reply: "", actions: [{ type: "history", query: "GitHub" }] },
    );
    f.store.message({
      id: "user-message",
      role: "user",
      text: "GitHub topic",
      taskIds: [],
      createdAt: new Date().toISOString(),
    });
    try {
      const m = f.runtime.receive("GitHub?", f.directory);
      await until(
        () => f.store.getMessage(m.id)?.routing?.status === "completed",
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(f.runs.length, 0);
    } finally {
      f.close();
    }
  }
});
test("recent-only history requires clarification and never guesses an executor", async () => {
  const f = fixture(
    async (
      _c,
      _k,
      _s,
      _text,
      _cwd,
      _target,
      _signal,
      _allocation,
      _memories,
      context,
    ) =>
      context
        ? {
            reply: "",
            actions: [
              {
                type: "ask_agent",
                sourceId: "original",
                question: "Check this?",
              },
            ],
          }
        : {
            reply: "",
            actions: [
              { type: "history", query: "a-topic-absent-from-history" },
            ],
          },
  );
  try {
    const m = f.runtime.receive("Check that?", f.directory);
    await until(
      () => f.store.getMessage(m.id)?.routing?.status === "completed",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(f.runs.length, 0);
  } finally {
    f.close();
  }
});
test("associated public native context is consulted before the second routing decision", async () => {
  let reads = 0;
  const f = fixture(
    async (
      _c,
      _k,
      _s,
      _text,
      _cwd,
      _target,
      _signal,
      _allocation,
      _memories,
      context,
    ) => {
      if (!context)
        return {
          reply: "",
          actions: [
            { type: "history", query: "GitHub", sourceId: "native-original" },
          ],
        };
      assert.ok(
        context.history.entries[0].excerpts.some((text) =>
          text.includes("Public source evidence"),
        ),
      );
      return { reply: "Confirmed public evidence.", actions: [] };
    },
    true,
    async (sessionId, turnId) => {
      reads++;
      assert.equal(sessionId, "native-thread");
      assert.equal(turnId, "native-turn");
      return {
        request: "Original request",
        requests: [],
        updates: ["Public source evidence"],
        tools: [],
        truncated: false,
      };
    },
  );
  try {
    const m = f.runtime.receive("GitHub?", f.directory);
    await until(
      () => f.store.getMessage(m.id)?.routing?.status === "completed",
    );
    assert.equal(reads, 1);
    assert.equal(f.runs.length, 0);
  } finally {
    f.close();
  }
});
test("selected task scope cannot be overridden by model history or inquiry source IDs", async () => {
  for (const first of ["history", "ask_agent"] as const) {
    const f = fixture(
      async (
        _c,
        _k,
        _s,
        _text,
        _cwd,
        _target,
        _signal,
        _allocation,
        _memories,
        context,
      ) => {
        if (!context)
          return {
            reply: "",
            actions:
              first === "history"
                ? [{ type: "history", query: "GitHub", sourceId: "other" }]
                : [
                    {
                      type: "ask_agent",
                      question: "Confirm the push",
                      sourceId: "other",
                    },
                  ],
          };
        return {
          reply: "",
          actions: [
            {
              type: "ask_agent",
              question: "Confirm the push",
              sourceId: "other",
            },
          ],
        };
      },
    );
    f.store.put("tasks", "other", {
      ...f.old,
      id: "other",
      sessionId: "other-thread",
    });
    try {
      const m = f.runtime.receive("GitHub提交了吗", f.directory, "original");
      await until(
        () => f.store.getMessage(m.id)?.routing?.status === "completed",
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(f.runs.length, 0);
    } finally {
      f.close();
    }
  }
});

test("a factual clarification from an inquiry preserves the original question when answered", async () => {
  const f = fixture(
    async (
      _c,
      _k,
      _s,
      _text,
      _cwd,
      _target,
      _signal,
      _allocation,
      _memories,
      context,
    ) =>
      context
        ? {
            reply: "",
            actions: [
              {
                type: "ask_agent",
                sourceId: "original",
                question: "Was this pushed?",
              },
            ],
          }
        : {
            reply: "",
            actions: [
              { type: "history", query: "GitHub", sourceId: "original" },
            ],
          },
  );
  try {
    f.runtime.receive("Was it pushed?", f.directory);
    await until(() => f.runs.length === 1);
    const question = f.runs[0].task.inquiry!.question;
    f.runs[0].onEvent({ type: "completed", text: "请告诉我目标分支？" });
    await until(() => f.runtime.snapshot().questions.some((q) => !q.resolved));
    const q = f.runtime.snapshot().questions.find((q) => !q.resolved)!;
    await f.runtime.answer(q.id, "main");
    await until(() => f.runs.length === 2);
    assert.ok(f.runs[1].task.inquiry!.question.startsWith(question));
    assert.ok(f.runs[1].task.inquiry!.question.endsWith("main"));
    assert.equal(f.runs[1].task.inquiry!.sessionId, "original-thread");
  } finally {
    f.close();
  }
});

test("on-demand history finds reports older than the recent 200-message window", async () => {
  let evidence: string[] = [];
  const f = fixture(
    async (
      _c,
      _k,
      snapshot,
      _text,
      _cwd,
      _target,
      _signal,
      _allocation,
      _memories,
      context,
    ) => {
      assert.ok(snapshot.messages.length <= 200);
      assert.ok(
        !snapshot.messages.some((message) => message.id === "native-report"),
      );
      if (!context)
        return {
          reply: "",
          actions: [
            { type: "history", query: "GitHub", sourceId: "native-original" },
          ],
        };
      evidence = context.history.entries.flatMap((entry) => entry.excerpts);
      return { reply: "Original historical record found.", actions: [] };
    },
    true,
  );
  try {
    for (let i = 0; i < 205; i++)
      f.store.message({
        id: "later-" + i,
        role: "user",
        text: "Unrelated later message " + i,
        taskIds: [],
        createdAt: new Date().toISOString(),
      });
    assert.equal(f.runtime.snapshot().messages.length, 200);
    const m = f.runtime.receive("GitHub提交了吗", f.directory);
    await until(
      () => f.store.getMessage(m.id)?.routing?.status === "completed",
    );
    assert.ok(evidence.some((text) => text.includes("GitHub commit exists")));
    assert.equal(f.runs.length, 0);
    assert.ok(f.runtime.snapshot().messages.length <= 200);
  } finally {
    f.close();
  }
});

test("full-index history keeps withheld and excluded native reports private", async () => {
  let serialized = "";
  const f = fixture(
    async (
      _c,
      _k,
      _snapshot,
      _text,
      _cwd,
      _target,
      _signal,
      _allocation,
      _memories,
      context,
    ) => {
      if (!context)
        return { reply: "", actions: [{ type: "history", query: "GitHub" }] };
      serialized = JSON.stringify(context.history);
      return { reply: "Visible historical evidence checked.", actions: [] };
    },
    true,
  );
  try {
    f.runtime.updateObservations([
      {
        agentId: "codex",
        state: "connected",
        message: "Fixture metadata",
        sessions: [],
        excludedSessionIds: ["native-guardian"],
      },
    ]);
    for (const [id, status, nativeId, marker] of [
      ["withheld", "withheld", "native-withheld", "FAKE_WITHHELD_BODY"],
      ["guardian", "ready", "native-guardian", "FAKE_GUARDIAN_BODY"],
    ] as const)
      f.store.message({
        id,
        role: "assistant",
        text: "GitHub " + marker,
        taskIds: [],
        createdAt: new Date().toISOString(),
        completion: { id, title: "GitHub delivery", status, nativeId },
      });
    for (let i = 0; i < 205; i++)
      f.store.message({
        id: "noise-" + i,
        role: "user",
        text: "Unrelated later message " + i,
        taskIds: [],
        createdAt: new Date().toISOString(),
      });
    const m = f.runtime.receive("GitHub提交了吗", f.directory);
    await until(
      () => f.store.getMessage(m.id)?.routing?.status === "completed",
    );
    assert.match(serialized, /GitHub commit exists/);
    assert.doesNotMatch(serialized, /FAKE_WITHHELD_BODY|FAKE_GUARDIAN_BODY/);
    assert.equal(f.runs.length, 0);
  } finally {
    f.close();
  }
});
