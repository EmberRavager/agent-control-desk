import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { realpathSync, statSync } from "node:fs";
import {
  scheduleInputSchema,
  type Schedule,
  type ScheduleInput,
  type ScheduleRule,
  type ScheduleRun,
} from "../contracts/schedules.js";
import type { Task } from "../contracts/index.js";
import type { Runtime } from "./runtime.js";

// Timers are wake-ups only. The durable nextRunAt is the authority, including
// after sleep, clock changes and service restarts.
const GRACE_MS = 60_000;
const terminal = new Set(["review", "completed", "failed", "cancelled"]);
function parts(at: number, timeZone: string) {
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (name: string) =>
    Number(values.find((part) => part.type === name)!.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}
function wallTime(
  date: { year: number; month: number; day: number },
  time: string,
  timeZone: string,
) {
  const [hour, minute] = time.split(":").map(Number);
  const wall = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const matches = new Set<number>();
  // Inspect offsets on both sides of a DST transition. Nonexistent local
  // times have no match; repeated local times use only the first occurrence.
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = wall + hours * 3_600_000;
    const p = parts(sample, timeZone);
    const offset =
      Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - sample;
    const candidate = wall - offset;
    const local = parts(candidate, timeZone);
    if (
      local.year === date.year &&
      local.month === date.month &&
      local.day === date.day &&
      local.hour === hour &&
      local.minute === minute
    )
      matches.add(candidate);
  }
  return matches.size ? Math.min(...matches) : null;
}
export function nextScheduleTime(
  rule: ScheduleRule,
  after: number,
  anchor?: number,
): string | null {
  if (rule.kind === "once")
    return Date.parse(rule.at) > after ? new Date(rule.at).toISOString() : null;
  if (rule.kind === "interval") {
    const period = rule.minutes * 60_000;
    const base = anchor ?? after;
    return new Date(
      base + Math.max(1, Math.floor((after - base) / period) + 1) * period,
    ).toISOString();
  }
  const today = parts(after, rule.timeZone);
  for (let days = 0; days <= 15; days++) {
    const day = new Date(
      Date.UTC(today.year, today.month - 1, today.day + days),
    );
    if (rule.kind === "weekly" && !rule.days.includes(day.getUTCDay()))
      continue;
    const at = wallTime(
      {
        year: day.getUTCFullYear(),
        month: day.getUTCMonth() + 1,
        day: day.getUTCDate(),
      },
      rule.time,
      rule.timeZone,
    );
    if (at !== null && at > after) return new Date(at).toISOString();
  }
  throw Error("无法计算下次执行时间，请修改时间规则");
}

export class Schedules {
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private ticking = false;
  constructor(
    private runtime: Runtime,
    private now: () => number = Date.now,
  ) {
    // Runtime has already marked interrupted executions unknown/blocked.
    for (const run of this.runtime.store.list<ScheduleRun>("schedule-runs")) {
      if (run.status !== "dispatched" || !run.taskId) continue;
      const task = this.runtime.store.get<Task>("tasks", run.taskId);
      if (!task || ["unknown", "blocked"].includes(task.status)) {
        run.status = "unknown";
        run.detail = this.runtime.tr(
          "后台已重启，本轮需核对原任务；未自动重跑。",
        );
        this.runtime.store.put("schedule-runs", run.id, run);
        const schedule = this.getOptional(run.scheduleId);
        if (schedule?.lastRun?.id === run.id)
          this.runtime.store.put("schedules", schedule.id, {
            ...schedule,
            lastRun: run,
          });
      }
    }
  }
  private getOptional(id: string) {
    return this.runtime.store.get<Schedule>("schedules", id);
  }
  get(id: string) {
    const value = this.getOptional(id);
    if (!value) throw Error(this.runtime.tr("定时任务不存在"));
    return value;
  }
  list() {
    return this.runtime.store.list<Schedule>("schedules");
  }
  runs(id: string) {
    this.get(id);
    return this.runtime.store
      .list<ScheduleRun>("schedule-runs")
      .filter((run) => run.scheduleId === id)
      .slice(-30)
      .reverse();
  }
  private validate(input: ScheduleInput) {
    const value = scheduleInputSchema.parse(input);
    if (!isAbsolute(value.cwd))
      throw Error(this.runtime.tr("工作目录必须为绝对路径"));
    value.cwd = realpathSync(value.cwd);
    if (!statSync(value.cwd).isDirectory())
      throw Error(this.runtime.tr("工作目录不存在"));
    const agent = this.runtime.store
      .list<{
        id: string;
        selected: boolean;
        available: boolean;
        supported?: boolean;
      }>("agents")
      .find(
        (agent) =>
          agent.id === value.agentId &&
          agent.selected &&
          agent.available &&
          agent.supported !== false,
      );
    if (!agent) throw Error(this.runtime.tr("请选择已接入且可执行的 Agent"));
    return value;
  }
  create(input: ScheduleInput) {
    this.checkOpen();
    const value = this.validate(input);
    const now = this.now();
    const nextRunAt = nextScheduleTime(value.rule, now);
    if (!nextRunAt) throw Error(this.runtime.tr("单次执行时间必须在未来"));
    const schedule: Schedule = {
      ...value,
      id: randomUUID(),
      status: "active",
      nextRunAt,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
    this.runtime.store.put("schedules", schedule.id, schedule);
    this.runtime.publish();
    return schedule;
  }
  update(id: string, input: ScheduleInput) {
    this.checkOpen();
    const before = this.get(id);
    const value = this.validate(input);
    const changed = JSON.stringify(value.rule) !== JSON.stringify(before.rule);
    const nextRunAt =
      changed || before.status === "finished"
        ? nextScheduleTime(value.rule, this.now())
        : before.nextRunAt;
    if (!nextRunAt) throw Error(this.runtime.tr("请设置未来的单次执行时间"));
    const schedule: Schedule = {
      ...before,
      ...value,
      nextRunAt,
      status: before.status === "finished" ? "active" : before.status,
      updatedAt: this.updated(before),
    };
    this.runtime.store.put("schedules", id, schedule);
    this.runtime.publish();
    return schedule;
  }
  control(
    id: string,
    operation: "pause" | "resume" | "delete",
    expectedUpdatedAt?: string,
  ) {
    this.checkOpen();
    const before = this.get(id);
    if (expectedUpdatedAt && before.updatedAt !== expectedUpdatedAt)
      throw Error(this.runtime.tr("定时任务已更新，请依据最新计划重新确认"));
    if (operation === "delete") {
      this.runtime.store.remove("schedules", id);
      this.runtime.publish();
      return { ok: true as const };
    }
    if (operation === "pause" && before.status === "finished")
      throw Error(this.runtime.tr("此单次计划已结束，请编辑后重新启用"));
    if (
      (operation === "pause" && before.status === "paused") ||
      (operation === "resume" && before.status === "active")
    )
      return before;
    const nextRunAt =
      operation === "resume"
        ? nextScheduleTime(before.rule, this.now())
        : before.nextRunAt;
    if (operation === "resume" && !nextRunAt)
      throw Error(this.runtime.tr("单次时间已过，请编辑后重新启用"));
    const schedule: Schedule = {
      ...before,
      nextRunAt,
      status: operation === "pause" ? "paused" : "active",
      updatedAt: this.updated(before),
    };
    this.runtime.store.put("schedules", id, schedule);
    this.runtime.publish();
    return schedule;
  }
  private updated(before: Schedule) {
    return new Date(
      Math.max(this.now(), Date.parse(before.updatedAt) + 1),
    ).toISOString();
  }
  private checkOpen() {
    if (this.closed) throw Error(this.runtime.tr("服务正在退出"));
  }
  start() {
    if (this.closed || this.timer) return;
    // An overdue occurrence at startup is recorded, never replayed.
    this.tick(true);
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch {
        /* Persistent due records remain for the next wake-up. */
      }
    }, 1000);
    this.timer.unref();
  }
  tick(recovering = false) {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const schedule of this.list()) {
        if (
          schedule.status !== "active" ||
          !schedule.nextRunAt ||
          Date.parse(schedule.nextRunAt) > now
        )
          continue;
        try {
          this.fire(schedule, now, recovering);
        } catch {
          /* Keep this occurrence due; one failed claim must not block other plans. */
        }
      }
    } finally {
      this.ticking = false;
    }
  }
  private fire(schedule: Schedule, now: number, recovering: boolean) {
    const scheduledFor = schedule.nextRunAt!;
    const run: ScheduleRun = {
      id: randomUUID(),
      scheduleId: schedule.id,
      scheduledFor,
      recordedAt: new Date(now).toISOString(),
      status: "dispatched",
      detail: this.runtime.tr("已交给任务队列；执行结果以关联任务为准。"),
    };
    let task: Task | undefined;
    const tasks = this.runtime.store.list<Task>("tasks");
    if (recovering || now - Date.parse(scheduledFor) > GRACE_MS) {
      run.status = "missed";
      run.detail = this.runtime.tr(
        "后台离线或唤醒延迟，错过的时间不补跑；周期计划已移到下次。",
      );
    } else if (
      tasks.some(
        (task) => task.scheduleId === schedule.id && !terminal.has(task.status),
      )
    ) {
      run.status = "skipped";
      run.detail = this.runtime.tr(
        "此计划上一轮仍在运行、排队或待核对，本轮已跳过。",
      );
    } else {
      try {
        task = this.runtime.prepareTask({
          title: schedule.name,
          goal: schedule.prompt,
          agentId: schedule.agentId,
          cwd: schedule.cwd,
        });
        task.scheduleId = schedule.id;
        task.scheduleRunId = run.id;
        run.taskId = task.id;
      } catch {
        run.status = "failed";
        run.detail = this.runtime.tr(
          "工作目录或执行 Agent 当前不可用，本轮未启动；请检查计划设置。",
        );
      }
    }
    const nextRunAt = nextScheduleTime(
      schedule.rule,
      now,
      Date.parse(scheduledFor),
    );
    const updated: Schedule = {
      ...schedule,
      nextRunAt,
      status: nextRunAt ? "active" : "finished",
      lastRun: run,
      updatedAt: this.updated(schedule),
    };
    // No executor or JSONL writes occur inside this transaction. A crash after
    // commit leaves a durable queued task, recovered as blocked, never replayed.
    this.runtime.store.transaction(() => {
      const latest = this.getOptional(schedule.id);
      if (
        !latest ||
        latest.status !== "active" ||
        latest.nextRunAt !== scheduledFor ||
        latest.updatedAt !== schedule.updatedAt
      )
        throw Error(this.runtime.tr("计划已更新"));
      this.runtime.store.put("schedules", schedule.id, updated);
      this.runtime.store.put("schedule-runs", run.id, run);
      if (task) this.runtime.store.put("tasks", task.id, task);
    });
    if (task)
      this.runtime.dispatchPreparedTask(
        task,
        this.runtime.tr("定时触发「{v0}」，结果将在此对话汇报。", {
          v0: schedule.name,
        }),
      );
    else if (run.status === "failed")
      this.runtime.reportScheduleFailure(schedule.name, run.detail);
    else this.runtime.publish();
  }
  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
