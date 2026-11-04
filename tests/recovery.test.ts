import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime, type Dependencies } from "../packages/core/runtime.js";
import { Store } from "../packages/core/store.js";
import type {
  AgentConnection,
  Message,
  RouteDecision,
  RunHandle,
  Task,
} from "../packages/contracts/index.js";

const agent: AgentConnection = {
  id: "fake-agent",
  kind: "codex",
  name: "Fake Codex",
  executable: "never-executed",
  selected: true,
  available: true,
  capabilities: { steer: true, resume: true },
};
const vault = { get: async () => "fake-test-key", set: async () => {} };
const handle = (overrides: Partial<RunHandle> = {}): RunHandle => ({
  steer: async () => {},
  stop: async () => {},
  answer: async () => {},
  dispose() {},
  ...overrides,
});
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "acd-recovery-"));
  const store = new Store(directory);
  store.put("agents", agent.id, agent);
  store.put("settings", "model", {
    baseUrl: "https://example.invalid/v1",
    model: "fake",
    hasKey: true,
  });
  return { directory, store };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Expected lifecycle transition did not occur");
}
function createRoute(directory: string): RouteDecision {
  return {
    reply: "",
    actions: [
      {
        type: "create",
        title: "Fake task",
        goal: "Fake task",
        agentId: agent.id,
        cwd: directory,
      },
    ],
  };
}

test("a late adapter handle is disposed after shutdown even when the store has already closed", async () => {
  const { directory, store } = setup();
  let resolveStart!: (value: RunHandle) => void;
  let disposed = 0;
  let started = false;
  let runtime: Runtime | undefined;
  let closed = false;
  try {
    runtime = new Runtime(store, {
      scan: async () => [],
      vault,
      route: async () => createRoute(directory),
      adapter: () => ({
        start: () => {
          started = true;
          return new Promise((resolve) => {
            resolveStart = resolve;
          });
        },
      }),
    });
    runtime.receive("start", directory);
    await until(() => started);
    runtime.shutdown();
    assert.equal(store.list<Task>("tasks")[0].status, "unknown");
    store.close();
    closed = true;
    resolveStart(
      handle({
        dispose() {
          disposed++;
        },
      }),
    );
    await until(() => disposed === 1);
    assert.equal(
      disposed,
      1,
      "A handle returned after shutdown must not survive",
    );
  } finally {
    if (!closed) {
      runtime?.shutdown();
      store.close();
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed native authorization is marked unknown and cannot be replayed automatically", async () => {
  const { directory, store } = setup();
  let answerCalls = 0;
  let runtime: Runtime | undefined;
  try {
    runtime = new Runtime(store, {
      scan: async () => [],
      vault,
      route: async () => createRoute(directory),
      adapter: () => ({
        start: async ({ onEvent }) => {
          onEvent({
            type: "question",
            text: "Allow this operation?",
            choices: ["accept", "decline"],
            requestId: "native-q",
          });
          return handle({
            answer: async () => {
              answerCalls++;
              throw Error("Connection lost after sending");
            },
          });
        },
      }),
    });
    runtime.receive("start", directory);
    await until(() => runtime!.snapshot().questions.length === 1);
    // Wait for the adapter start promise to settle and register its handle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const question = runtime.snapshot().questions[0];
    await assert.rejects(
      () => runtime!.answer(question.id, "accept"),
      /待确认/,
    );
    assert.equal(runtime.snapshot().tasks[0].status, "unknown");
    assert.match(runtime.snapshot().tasks[0].progress, /不自动重试/);
    await assert.rejects(() => runtime!.answer(question.id, "accept"), /失效/);
    assert.equal(
      answerCalls,
      1,
      "An uncertain authorization must not be sent twice",
    );
  } finally {
    runtime?.shutdown();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("updating requirements invalidates an old authorization before it reaches the adapter", async () => {
  const { directory, store } = setup();
  let answerCalls = 0;
  let runtime: Runtime | undefined;
  const routeDecision: Dependencies["route"] = async (
    _config,
    _key,
    snapshot,
    text,
  ) =>
    text === "start"
      ? createRoute(directory)
      : {
          reply: "",
          actions: [
            {
              type: "supplement",
              taskId: snapshot.tasks[0].id,
              text: "Only analyze",
              expectedRevision: snapshot.tasks[0].revision,
            },
          ],
        };
  try {
    runtime = new Runtime(store, {
      scan: async () => [],
      vault,
      route: routeDecision,
      adapter: () => ({
        start: async ({ onEvent }) => {
          onEvent({
            type: "question",
            text: "Allow modification?",
            choices: ["accept", "decline"],
            requestId: "old-native-q",
          });
          return handle({
            answer: async () => {
              answerCalls++;
            },
          });
        },
      }),
    });
    runtime.receive("start", directory);
    await until(() => runtime!.snapshot().questions.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const question = runtime.snapshot().questions[0],
      taskId = runtime.snapshot().tasks[0].id;
    runtime.receive("Only analyze", directory, taskId);
    await until(() => runtime!.snapshot().tasks[0].revision === 2);
    await assert.rejects(() => runtime!.answer(question.id, "accept"), /失效/);
    assert.equal(
      answerCalls,
      0,
      "Stale authorization must never reach the native process",
    );
  } finally {
    runtime?.shutdown();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a valid JSONL tail without LF is repaired before pending-log replay and later appends", () => {
  const { directory, store } = setup();
  let current: Store | undefined = store;
  const first: Message = {
    id: "m1",
    role: "user",
    text: "中文尾行 🧪",
    taskIds: [],
    createdAt: "2026-01-01T00:00:00Z",
  };
  const second: Message = {
    id: "m2",
    role: "assistant",
    text: "Second message",
    taskIds: [],
    createdAt: "2026-01-01T00:00:01Z",
  };
  try {
    current.message(first);
    const log = join(directory, "conversation.jsonl");
    const bytes = readFileSync(log);
    const persisted = JSON.parse(bytes.toString().trim());
    // Simulate a crash after durable append but before clearing the SQLite outbox,
    // with the final line terminator absent from the recovered file.
    current.db
      .prepare("INSERT INTO pending_log(event_id,data) VALUES(?,?)")
      .run(persisted.eventId, JSON.stringify(persisted));
    current.close();
    current = undefined;
    writeFileSync(log, bytes.subarray(0, -1));
    current = new Store(directory);
    current.message(second);
    current.close();
    current = undefined;
    const repaired = readFileSync(log, "utf8");
    assert.ok(repaired.endsWith("\n"));
    const rows = repaired
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].message.text, first.text);
    assert.equal(rows[1].message.id, second.id);
    current = new Store(directory);
    assert.deepEqual(
      current.history().map((m) => m.id),
      ["m1", "m2"],
    );
    assert.equal(
      current.db.prepare("SELECT count(*) AS n FROM pending_log").get()!.n,
      0,
    );
  } finally {
    current?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
