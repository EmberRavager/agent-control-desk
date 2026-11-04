import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime, type Dependencies } from "../packages/core/runtime.js";
import { Store } from "../packages/core/store.js";
import { nextScheduleTime } from "../packages/core/schedules.js";
import type {
  AgentConnection,
  ScheduleInput,
  ScheduleRun,
  StartRun,
  Task,
  TaskStatus,
} from "../packages/contracts/index.js";

const agent: AgentConnection = {
  id: "schedule-fixture-agent",
  kind: "codex",
  name: "Schedule Fixture Agent",
  executable: "/fixture/never-executed",
  selected: true,
  available: true,
  capabilities: { steer: true, resume: true },
};
const iso = (at: number) => new Date(at).toISOString();
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "acd-schedules-unit-"));
  const project = join(directory, "project");
  mkdirSync(project);
  const clock = { value: Date.parse("2099-01-01T00:00:00.000Z") };
  const starts: StartRun[] = [];
  let stops = 0;
  const deps: Dependencies = {
    now: () => clock.value,
    scan: async () => [],
    vault: { get: async () => null, set: async () => {} },
    adapter: () => ({
      start: async (input) => {
        starts.push(input);
        return {
          steer: async () => {},
          stop: async () => {
            stops++;
          },
          answer: async () => {},
          dispose() {},
        };
      },
    }),
  };
  let store = new Store(join(directory, "data"));
  store.put("agents", agent.id, agent);
  let runtime = new Runtime(store, deps);
  t.after(async () => {
    runtime.shutdown();
    await settle();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    project,
    clock,
    starts,
    get stops() {
      return stops;
    },
    get store() {
      return store;
    },
    get runtime() {
      return runtime;
    },
    input(overrides: Partial<ScheduleInput> = {}): ScheduleInput {
      return {
        name: "Fixture recurring check",
        prompt: "Inspect fixture project and report the result",
        agentId: agent.id,
        cwd: project,
        rule: { kind: "interval", minutes: 5 },
        ...overrides,
      };
    },
    async restart() {
      runtime.shutdown();
      await settle();
      store.close();
      store = new Store(join(directory, "data"));
      runtime = new Runtime(store, deps);
    },
  };
}

test("one-shot occurrence dispatches exactly once and keeps its task and durable run linked", async (t) => {
  const f = fixture(t);
  const at = iso(f.clock.value + 60_000);
  const schedule = f.runtime.schedules.create(
    f.input({ rule: { kind: "once", at } }),
  );
  f.clock.value += 59_999;
  f.runtime.schedules.tick();
  assert.equal(f.starts.length, 0);
  f.clock.value++;
  f.runtime.schedules.tick();
  f.runtime.schedules.tick();
  await settle();
  assert.equal(f.starts.length, 1);
  const task = f.runtime.snapshot().tasks[0];
  const run = f.runtime.schedules.runs(schedule.id)[0];
  assert.equal(task.scheduleId, schedule.id);
  assert.equal(task.scheduleRunId, run.id);
  assert.equal(run.taskId, task.id);
  assert.equal(run.scheduledFor, at);
  assert.equal(run.status, "dispatched");
  assert.equal(f.runtime.schedules.get(schedule.id).status, "finished");
  assert.equal(f.runtime.schedules.get(schedule.id).nextRunAt, null);
  assert.ok(
    f.runtime
      .snapshot()
      .messages.some((message) => message.taskIds.includes(task.id)),
  );
  f.clock.value += 86_400_000;
  f.runtime.schedules.tick();
  assert.equal(f.starts.length, 1);
  assert.equal(f.runtime.schedules.runs(schedule.id).length, 1);
});

test("intervals advance from their durable anchor instead of drifting with a late wake-up", async (t) => {
  const f = fixture(t);
  const initial = f.clock.value;
  const schedule = f.runtime.schedules.create(f.input());
  assert.equal(schedule.nextRunAt, iso(initial + 5 * 60_000));
  f.clock.value = initial + 5 * 60_000 + 30_000;
  f.runtime.schedules.tick();
  await settle();
  assert.equal(
    f.runtime.schedules.get(schedule.id).nextRunAt,
    iso(initial + 10 * 60_000),
  );
  f.starts[0].onEvent({ type: "completed", text: "Fixture complete" });
  f.clock.value = initial + 10 * 60_000 + 30_000;
  f.runtime.schedules.tick();
  await settle();
  assert.equal(f.starts.length, 2);
  assert.equal(
    f.runtime.schedules.get(schedule.id).nextRunAt,
    iso(initial + 15 * 60_000),
  );
});

test("daily and weekly rules retain their named timezone, including the local date boundary", () => {
  assert.equal(
    nextScheduleTime(
      { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" },
      Date.parse("2099-01-01T00:00:00Z"),
    ),
    "2099-01-01T01:00:00.000Z",
  );
  assert.equal(
    nextScheduleTime(
      { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" },
      Date.parse("2099-01-01T01:00:00Z"),
    ),
    "2099-01-02T01:00:00.000Z",
  );
  assert.equal(
    nextScheduleTime(
      {
        kind: "weekly",
        time: "00:30",
        timeZone: "Asia/Shanghai",
        days: [1, 5],
      },
      Date.parse("2099-01-01T18:00:00Z"),
    ),
    "2099-01-04T16:30:00.000Z",
  );
  assert.equal(
    nextScheduleTime(
      { kind: "weekly", time: "09:00", timeZone: "UTC", days: [0] },
      Date.parse("2099-01-01T00:00:00Z"),
    ),
    "2099-01-04T09:00:00.000Z",
  );
});

test("DST gaps skip nonexistent wall times and repeated times run only on the first occurrence", () => {
  const gap = {
    kind: "daily" as const,
    time: "02:30",
    timeZone: "America/New_York",
  };
  assert.equal(
    nextScheduleTime(gap, Date.parse("2099-03-08T05:00:00Z")),
    "2099-03-09T06:30:00.000Z",
  );
  assert.equal(
    nextScheduleTime(
      { ...gap, kind: "weekly", days: [0] },
      Date.parse("2099-03-08T05:00:00Z"),
    ),
    "2099-03-15T06:30:00.000Z",
  );
  const fold = {
    kind: "daily" as const,
    time: "01:30",
    timeZone: "America/New_York",
  };
  const first = nextScheduleTime(fold, Date.parse("2099-11-01T04:00:00Z"));
  assert.equal(first, "2099-11-01T05:30:00.000Z");
  assert.equal(
    nextScheduleTime(fold, Date.parse(first!)),
    "2099-11-02T06:30:00.000Z",
  );
  assert.equal(
    nextScheduleTime(fold, Date.parse("2099-11-01T06:00:00Z")),
    "2099-11-02T06:30:00.000Z",
  );
});

test("pause, edit, resume and deletion persist without stopping an already dispatched task", async (t) => {
  const f = fixture(t);
  const schedule = f.runtime.schedules.create(f.input());
  const paused = f.runtime.schedules.control(schedule.id, "pause");
  assert.ok("status" in paused && paused.status === "paused");
  assert.throws(
    () =>
      f.runtime.schedules.control(schedule.id, "resume", schedule.updatedAt),
    /已更新/,
  );
  f.clock.value += 8 * 60_000;
  f.runtime.schedules.tick();
  assert.equal(f.starts.length, 0);
  const edited = f.runtime.schedules.update(
    schedule.id,
    f.input({
      name: "Updated fixture check",
      prompt: "Report the updated goal",
      rule: { kind: "interval", minutes: 2 },
    }),
  );
  assert.equal(edited.status, "paused");
  assert.equal(edited.nextRunAt, iso(f.clock.value + 2 * 60_000));
  const resumed = f.runtime.schedules.control(schedule.id, "resume");
  assert.ok("status" in resumed && resumed.status === "active");
  f.clock.value += 2 * 60_000;
  f.runtime.schedules.tick();
  await settle();
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].task.title, "Updated fixture check");
  assert.equal(f.starts[0].task.goal, "Report the updated goal");
  const taskId = f.starts[0].task.id;
  f.runtime.schedules.control(schedule.id, "pause");
  assert.equal(f.stops, 0);
  f.runtime.schedules.control(schedule.id, "delete");
  assert.equal(f.runtime.schedules.list().length, 0);
  assert.equal(f.store.get<Task>("tasks", taskId)?.status, "running");
  assert.equal(f.stops, 0);
  assert.throws(() => f.runtime.schedules.get(schedule.id), /不存在/);
  await f.restart();
  assert.equal(f.runtime.schedules.list().length, 0);
  assert.equal(f.store.get<Task>("tasks", taskId)?.status, "unknown");
});

test("past one-shot plans cannot be silently resumed, and editing an ended plan enables its new future occurrence", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      f.runtime.schedules.create(
        f.input({
          rule: { kind: "once", at: iso(f.clock.value) },
        }),
      ),
    /未来/,
  );
  const schedule = f.runtime.schedules.create(
    f.input({
      rule: { kind: "once", at: iso(f.clock.value + 60_000) },
    }),
  );
  f.runtime.schedules.control(schedule.id, "pause");
  f.clock.value += 120_000;
  assert.throws(
    () => f.runtime.schedules.control(schedule.id, "resume"),
    /单次时间已过/,
  );
  const future = iso(f.clock.value + 60_000);
  f.runtime.schedules.update(
    schedule.id,
    f.input({ rule: { kind: "once", at: future } }),
  );
  f.runtime.schedules.control(schedule.id, "resume");
  f.clock.value += 120_001;
  f.runtime.schedules.tick();
  assert.equal(f.runtime.schedules.get(schedule.id).status, "finished");
  assert.equal(f.runtime.schedules.runs(schedule.id)[0].status, "missed");
  const edited = f.runtime.schedules.update(
    schedule.id,
    f.input({
      rule: { kind: "once", at: iso(f.clock.value + 60_000) },
    }),
  );
  assert.equal(edited.status, "active");
});

test("every nonterminal previous occurrence prevents overlap, while review is eligible for a new cycle", async (t) => {
  for (const status of [
    "queued",
    "running",
    "waiting_input",
    "blocked",
    "stopping",
    "unknown",
    "review",
  ] satisfies TaskStatus[]) {
    await t.test(status, async (sub) => {
      const f = fixture(sub);
      const schedule = f.runtime.schedules.create(f.input());
      const prior = f.runtime.prepareTask({
        title: "Previous occurrence",
        goal: "fixture",
        agentId: agent.id,
        cwd: f.project,
      });
      f.store.put("tasks", prior.id, {
        ...prior,
        status,
        scheduleId: schedule.id,
      });
      f.clock.value += 5 * 60_000;
      f.runtime.schedules.tick();
      await settle();
      assert.equal(f.starts.length, status === "review" ? 1 : 0);
      assert.equal(
        f.runtime.schedules.runs(schedule.id)[0].status,
        status === "review" ? "dispatched" : "skipped",
      );
      assert.equal(
        f.runtime.schedules.get(schedule.id).nextRunAt,
        iso(f.clock.value + 5 * 60_000),
      );
    });
  }
});

test("restarting preserves an unknown original run and never automatically retries it", async (t) => {
  const f = fixture(t);
  const schedule = f.runtime.schedules.create(f.input());
  f.clock.value += 5 * 60_000;
  f.runtime.schedules.tick();
  await settle();
  const originalTaskId = f.starts[0].task.id;
  await f.restart();
  assert.equal(f.store.get<Task>("tasks", originalTaskId)?.status, "unknown");
  assert.equal(f.runtime.schedules.runs(schedule.id)[0].status, "unknown");
  f.clock.value += 5 * 60_000;
  f.runtime.schedules.tick();
  assert.equal(f.starts.length, 1);
  assert.equal(f.runtime.schedules.runs(schedule.id)[0].status, "skipped");
  assert.equal(f.runtime.snapshot().tasks.length, 1);
});

test("a long offline interval creates one missed record and advances to a future anchored occurrence", (t) => {
  const f = fixture(t);
  const origin = f.clock.value;
  const schedule = f.runtime.schedules.create(f.input());
  f.clock.value += 120 * 60_000;
  f.runtime.schedules.tick();
  f.runtime.schedules.tick();
  const runs = f.runtime.schedules.runs(schedule.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "missed");
  assert.equal(runs[0].scheduledFor, iso(origin + 5 * 60_000));
  assert.equal(
    f.runtime.schedules.get(schedule.id).nextRunAt,
    iso(origin + 125 * 60_000),
  );
  assert.equal(f.starts.length, 0);
});

test("startup records even a recently overdue occurrence instead of replaying it", async (t) => {
  const f = fixture(t);
  const schedule = f.runtime.schedules.create(f.input());
  f.clock.value += 5 * 60_000 + 1;
  await f.restart();
  f.runtime.schedules.start();
  assert.equal(f.runtime.schedules.runs(schedule.id)[0].status, "missed");
  assert.equal(f.starts.length, 0);
  assert.ok(
    Date.parse(f.runtime.schedules.get(schedule.id).nextRunAt!) > f.clock.value,
  );
});

test("unavailable agents and removed directories fail only their own occurrence", async (t) => {
  const f = fixture(t);
  const badAgent: AgentConnection = { ...agent, id: "second-fixture-agent" };
  f.store.put("agents", badAgent.id, badAgent);
  const removedProject = join(f.directory, "removed-project");
  mkdirSync(removedProject);
  const badExecutor = f.runtime.schedules.create(
    f.input({ name: "Unavailable Agent", agentId: badAgent.id }),
  );
  const badDirectory = f.runtime.schedules.create(
    f.input({ name: "Removed Project", cwd: removedProject }),
  );
  const valid = f.runtime.schedules.create(f.input({ name: "Valid Schedule" }));
  f.store.put("agents", badAgent.id, { ...badAgent, selected: false });
  rmSync(removedProject, { recursive: true });
  f.clock.value += 5 * 60_000;
  f.runtime.schedules.tick();
  await settle();
  assert.equal(f.runtime.schedules.runs(badExecutor.id)[0].status, "failed");
  assert.equal(
    f.runtime
      .snapshot()
      .messages.filter(
        (message) => message.attention && message.text.includes("未启动"),
      ).length,
    2,
  );
  assert.equal(f.runtime.schedules.runs(badDirectory.id)[0].status, "failed");
  assert.equal(f.runtime.schedules.runs(valid.id)[0].status, "dispatched");
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].task.title, "Valid Schedule");
});

test("a failed transaction rolls back the task, run and deadline, preserving the due occurrence for a later tick", async (t) => {
  const f = fixture(t);
  const schedule = f.runtime.schedules.create(f.input());
  f.clock.value += 5 * 60_000;
  const put = f.store.put.bind(f.store);
  f.store.put = (kind, id, value) => {
    if (kind === "schedule-runs") throw Error("Fixture interrupted claim");
    put(kind, id, value);
  };
  assert.doesNotThrow(() => f.runtime.schedules.tick());
  assert.equal(
    f.runtime.schedules.get(schedule.id).nextRunAt,
    schedule.nextRunAt,
  );
  assert.equal(f.store.list<Task>("tasks").length, 0);
  assert.equal(f.store.list<ScheduleRun>("schedule-runs").length, 0);
  assert.equal(f.starts.length, 0);
  f.store.put = put;
  f.runtime.schedules.tick();
  await settle();
  assert.equal(f.starts.length, 1);
  assert.equal(f.runtime.schedules.runs(schedule.id).length, 1);
});

test("shutdown stops dispatching and refuses plan mutations", (t) => {
  const f = fixture(t);
  const schedule = f.runtime.schedules.create(f.input());
  f.runtime.shutdown();
  f.clock.value += 5 * 60_000;
  f.runtime.schedules.tick();
  f.runtime.schedules.start();
  assert.equal(f.starts.length, 0);
  assert.equal(f.runtime.schedules.runs(schedule.id).length, 0);
  assert.throws(() => f.runtime.schedules.create(f.input()), /服务正在退出/);
  assert.throws(
    () => f.runtime.schedules.control(schedule.id, "resume"),
    /服务正在退出/,
  );
});

test("a crash after claim but before dispatch preserves a blocked task and never replays its execution", async (t) => {
  const f = fixture(t);
  const schedule = f.runtime.schedules.create(f.input());
  f.runtime.dispatchPreparedTask = () => {
    throw Error("Fixture crash after durable claim");
  };
  f.clock.value += 5 * 60_000;
  f.runtime.schedules.tick();
  assert.equal(f.starts.length, 0);
  const run = f.runtime.schedules.runs(schedule.id)[0];
  assert.equal(run.status, "dispatched");
  assert.equal(f.store.get<Task>("tasks", run.taskId!)?.status, "queued");
  await f.restart();
  assert.equal(f.store.get<Task>("tasks", run.taskId!)?.status, "blocked");
  assert.equal(f.runtime.schedules.runs(schedule.id)[0].status, "unknown");
  f.clock.value += 5 * 60_000;
  f.runtime.schedules.tick();
  assert.equal(f.starts.length, 0);
  assert.equal(f.runtime.schedules.runs(schedule.id)[0].status, "skipped");
  assert.equal(f.runtime.snapshot().tasks.length, 1);
});

test("a failed claim remains due without preventing another plan from dispatching", async (t) => {
  const f = fixture(t);
  const failing = f.runtime.schedules.create(f.input({ name: "Failed claim" }));
  const otherProject = join(f.directory, "other-project");
  mkdirSync(otherProject);
  const healthy = f.runtime.schedules.create(
    f.input({ name: "Healthy claim", cwd: otherProject }),
  );
  const put = f.store.put.bind(f.store);
  f.store.put = (kind, id, value) => {
    if (
      kind === "schedule-runs" &&
      (value as ScheduleRun).scheduleId === failing.id
    )
      throw Error("Fixture isolated claim failure");
    put(kind, id, value);
  };
  f.clock.value += 5 * 60_000;
  f.runtime.schedules.tick();
  await settle();
  assert.equal(f.runtime.schedules.runs(failing.id).length, 0);
  assert.equal(
    f.runtime.schedules.get(failing.id).nextRunAt,
    failing.nextRunAt,
  );
  assert.equal(f.runtime.schedules.runs(healthy.id)[0].status, "dispatched");
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].task.title, "Healthy claim");
  f.store.put = put;
  f.runtime.schedules.tick();
  await settle();
  assert.equal(f.starts.length, 2);
  assert.equal(f.runtime.schedules.runs(failing.id)[0].status, "dispatched");
});
