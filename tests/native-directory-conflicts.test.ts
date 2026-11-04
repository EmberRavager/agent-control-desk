import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type {
  AgentConnection,
  AgentObservation,
  NativeSession,
  StartRun,
  Task,
} from "../packages/contracts/index.js";
import { Runtime } from "../packages/core/runtime.js";
import { Store } from "../packages/core/store.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "acd-native-directories-"));
  const project = join(root, "project");
  const child = join(project, "..nested");
  const sibling = join(root, "project-other");
  const alias = join(root, "symlink");
  mkdirSync(child, { recursive: true });
  mkdirSync(sibling);
  symlinkSync(project, alias, "dir");
  const store = new Store(join(root, "store"));
  const starts: StartRun[] = [];
  let now = Date.parse("2099-01-01T00:00:00.000Z");
  const agent: AgentConnection = {
    id: "fixture",
    kind: "codex",
    name: "Fixture",
    executable: "/not-executed",
    selected: true,
    available: true,
    capabilities: { resume: true, steer: true },
  };
  store.put("agents", agent.id, agent);
  const runtime = new Runtime(store, {
    now: () => now,
    scan: async () => [],
    vault: { get: async () => null, set: async () => {} },
    adapter: () => ({
      start: async (run) => {
        starts.push(run);
        return {
          stop: async () => {},
          steer: async () => {},
          answer: async () => {},
          dispose() {},
        };
      },
    }),
  });
  t.after(() => {
    runtime.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const session: NativeSession = {
    id: "native-external",
    agentId: agent.id,
    sessionId: "external",
    title: "External Codex",
    cwd: alias,
    status: "running",
    progress: "Fixture",
    observedAt: new Date(now).toISOString(),
  };
  return {
    project,
    child,
    sibling,
    alias,
    starts,
    session,
    runtime,
    observe(sessions: NativeSession[], options?: Partial<AgentObservation>) {
      runtime.updateObservations([
        {
          agentId: agent.id,
          source: "runtime-api",
          state: "connected",
          message: "Fixture",
          sessions,
          ...options,
        },
      ]);
    },
    task(cwd: string) {
      const task = runtime.prepareTask({
        title: "Managed task",
        goal: "Check fixture",
        agentId: agent.id,
        cwd,
      });
      runtime.dispatchPreparedTask(task);
      return task.id;
    },
    scheduled(cwd: string) {
      const at = now + 60_000;
      const schedule = runtime.schedules.create({
        name: "Fixture schedule",
        prompt: "Check fixture",
        cwd,
        agentId: agent.id,
        rule: { kind: "once", at: new Date(at).toISOString() },
      });
      now = at;
      runtime.schedules.tick();
      return runtime.schedules.runs(schedule.id)[0].taskId!;
    },
    status(id: string) {
      return store.get<Task>("tasks", id)?.status;
    },
  };
}

test("managed and scheduled work wait for observed overlapping directories and drain once in order of availability", (t) => {
  const f = fixture(t);
  const native = { ...f.session, cwd: join(f.alias, "..nested") };
  f.observe([native]);
  const parent = f.scheduled(f.project);
  const child = f.task(f.child);
  const sibling = f.task(f.sibling);
  assert.equal(f.status(parent), "queued");
  assert.equal(f.status(child), "queued");
  assert.deepEqual(
    f.starts.map((run) => run.task.id),
    [sibling],
  );
  f.observe([{ ...native, status: "waiting_input" }]);
  f.observe([], { state: "unavailable" });
  f.starts[0].onEvent({ type: "completed" });
  f.observe([{ ...native, status: "unknown" }]);
  assert.equal(f.status(parent), "queued");
  assert.equal(f.status(child), "queued");
  f.observe([{ ...native, status: "idle" }]);
  f.observe([{ ...native, status: "idle" }]);
  assert.equal(f.starts.length, 2);
  f.starts[1].onEvent({ type: "completed" });
  assert.deepEqual(
    new Set(f.starts.map((run) => run.task.id)),
    new Set([sibling, parent, child]),
  );
});

test("new work below a waiting native alias queues even if another event record could not be verified", (t) => {
  const f = fixture(t);
  f.observe([{ ...f.session, status: "waiting_input" }], {
    source: "run-events",
    state: "unavailable",
  });
  const child = f.task(f.child);
  assert.equal(f.status(child), "queued");
  f.observe([{ ...f.session, status: "failed" }]);
  assert.equal(f.status(child), "running");
});

test("an ACD-owned observation does not hold the directory after the managed run ends", (t) => {
  const f = fixture(t);
  f.task(f.project);
  f.starts[0].onEvent({
    type: "session",
    sessionId: f.session.sessionId,
    turnId: "managed-turn",
  });
  f.observe([{ ...f.session, turnId: "managed-turn" }]);
  const followup = f.task(f.project);
  assert.equal(f.status(followup), "queued");
  f.starts[0].onEvent({ type: "completed" });
  assert.equal(f.status(followup), "running");
  f.starts[1].onEvent({ type: "completed" });
  f.observe([{ ...f.session, turnId: "new-external-turn" }]);
  const later = f.task(f.project);
  assert.equal(f.status(later), "queued");
  f.observe([]);
  assert.equal(f.status(later), "running");
});

test("reconciling an unknown managed turn keeps the lock of a newer observed turn in the same thread", (t) => {
  const f = fixture(t);
  const managed = f.task(f.project);
  f.starts[0].onEvent({
    type: "session",
    sessionId: f.session.sessionId,
    turnId: "managed",
  });
  f.starts[0].onEvent({ type: "failed" });
  f.observe([{ ...f.session, turnId: "external-followup" }]);
  const waiting = f.task(f.child);
  f.runtime.reconcile(managed);
  assert.equal(f.status(waiting), "queued");
  f.observe([{ ...f.session, turnId: "external-followup", status: "idle" }]);
  assert.equal(f.status(waiting), "running");
});

test("rechecking a selected executor during polling preserves a queued task and its observed lock", async (t) => {
  const f = fixture(t);
  f.observe([f.session]);
  const waiting = f.task(f.child);
  let finish!: () => void;
  f.runtime.deps.verify = async (agent) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return agent;
  };
  const recheck = f.runtime.select([f.session.agentId]);
  f.runtime.updateObservations([]);
  finish();
  await recheck;
  assert.equal(f.status(waiting), "queued");
  f.observe([{ ...f.session, status: "idle" }]);
  assert.equal(f.status(waiting), "running");
});
