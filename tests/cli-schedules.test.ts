import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readScheduleInput, request } from "../apps/cli/main.js";
import type {
  Schedule,
  ScheduleInput,
  ScheduleRun,
} from "../packages/contracts/index.js";

const payload = {
  name: "检查启动指南",
  prompt: "只分析 README；保留 `命令` 和 $(literal) 原文。",
  agentId: "fixture-agent",
  rule: { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" },
};

test("CLI schedule file validates rules and defaults to the caller directory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "acd-schedule-input-"));
  const file = join(directory, "schedule.json");
  try {
    writeFileSync(file, JSON.stringify(payload));
    const result = await readScheduleInput(file, directory);
    assert.equal(result.cwd, directory);
    assert.equal(result.prompt, payload.prompt);
    for (const value of [
      { ...payload, cwd: "relative" },
      {
        ...payload,
        rule: { kind: "daily", time: "25:00", timeZone: "Asia/Shanghai" },
      },
      {
        ...payload,
        rule: {
          kind: "weekly",
          time: "09:00",
          timeZone: "invalid/timezone",
          days: [1],
        },
      },
      {
        ...payload,
        rule: { kind: "weekly", time: "09:00", timeZone: "UTC", days: [1, 1] },
      },
      { ...payload, rule: { kind: "interval", minutes: 0 } },
      { ...payload, rule: { kind: "once", at: "2030-01-01T09:00:00" } },
      { ...payload, unexpected: true },
      null,
      [],
    ]) {
      writeFileSync(file, JSON.stringify(value));
      await assert.rejects(() => readScheduleInput(file, directory));
    }
    writeFileSync(file, "{broken");
    await assert.rejects(() => readScheduleInput(file, directory), /合法 JSON/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI refuses schedule requests to an older daemon before submitting an action", async () => {
  await assert.rejects(
    () =>
      request(
        {
          url: "http://127.0.0.1:9",
          token: "fixture-only",
          protocol: 1,
          pid: 1,
          capabilities: [],
        },
        "POST",
        "/api/schedules",
        payload,
      ),
    /尚无定时任务能力/,
  );
});

test("schedule CLI manages one persistent plan through the authenticated API", async () => {
  const root = mkdtempSync(join(tmpdir(), "acd-cli-schedule-"));
  const directory = join(root, "调用目录 中文 空格");
  const data = join(root, "fake-data");
  mkdirSync(directory);
  mkdirSync(data);
  const calls: { method: string; path: string; body: unknown }[] = [];
  let item: Schedule | undefined;
  const runs: ScheduleRun[] = [];
  const token = "fixture-local-client";
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer " + token) {
      res.writeHead(401).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    const body = text ? JSON.parse(text) : undefined;
    const path = req.url || "";
    let result: unknown;
    if (path === "/api/health") result = { protocol: 1 };
    else if (path === "/api/state")
      result = {
        agents: [],
        tasks: [],
        messages: [],
        questions: [],
        model: null,
      };
    else {
      calls.push({ method: req.method!, path, body });
      if (path === "/api/schedules" && req.method === "GET")
        result = item ? [item] : [];
      else if (path === "/api/schedules" && req.method === "POST") {
        item = {
          ...(body as ScheduleInput),
          id: "fixture-plan",
          status: "active",
          nextRunAt: "2030-01-01T01:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
        result = item;
      } else if (
        path === "/api/schedules/fixture-plan" &&
        req.method === "PUT" &&
        item
      ) {
        item = { ...item, ...body };
        result = item;
      } else if (path === "/api/schedules/fixture-plan/pause" && item)
        result = item = { ...item, status: "paused", nextRunAt: null };
      else if (path === "/api/schedules/fixture-plan/resume" && item)
        result = item = {
          ...item,
          status: "active",
          nextRunAt: "2030-01-01T01:00:00.000Z",
        };
      else if (path === "/api/schedules/fixture-plan/runs") result = runs;
      else if (path === "/api/schedules/fixture-plan/delete") {
        item = undefined;
        result = { ok: true };
      } else {
        res
          .writeHead(404, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "fixture missing" }));
        return;
      }
    }
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  writeFileSync(
    join(data, "runtime.json"),
    JSON.stringify({
      url: "http://127.0.0.1:" + address.port,
      protocol: 1,
      token,
      pid: process.pid,
      capabilities: ["schedules"],
    }),
  );
  const file = join(directory, "定时计划.json");
  writeFileSync(file, JSON.stringify(payload));
  const run = (...args: string[]) =>
    promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL("../apps/cli/acd.mjs", import.meta.url)), ...args],
      { cwd: directory, env: { ACD_DATA_DIR: data }, timeout: 15000 },
    );
  try {
    const help = await run("schedules", "--help");
    assert.match(help.stdout, /agentId/);
    assert.match(help.stdout, /单次时间必须包含时区偏移/);
    const empty = await run("schedules", "--json");
    assert.deepEqual(JSON.parse(empty.stdout), []);
    const created = JSON.parse(
      (await run("schedules", "create", "--file", "定时计划.json", "--json"))
        .stdout,
    );
    assert.equal(created.cwd, realpathSync(directory));
    assert.equal(created.prompt, payload.prompt);
    assert.equal(created.id, "fixture-plan");
    const shown = await run("schedules", "show", created.id);
    assert.match(shown.stdout, /检查启动指南/);
    assert.match(shown.stdout, /fixture-agent/);
    assert.match(shown.stdout, /Asia\/Shanghai/);
    assert.equal(
      JSON.parse((await run("schedules", "pause", created.id, "--json")).stdout)
        .status,
      "paused",
    );
    assert.equal(
      JSON.parse(
        (await run("schedules", "resume", created.id, "--json")).stdout,
      ).status,
      "active",
    );
    const updated = {
      ...payload,
      prompt: "更新后的要求",
      rule: { kind: "interval", minutes: 60 },
    };
    writeFileSync(file, JSON.stringify(updated));
    assert.equal(
      JSON.parse(
        (await run("schedules", "update", created.id, "--file", file, "--json"))
          .stdout,
      ).prompt,
      updated.prompt,
    );
    runs.push({
      id: "fixture-run",
      scheduleId: created.id,
      scheduledFor: "2030-01-01T01:00:00.000Z",
      recordedAt: "2030-01-01T01:00:00.000Z",
      status: "dispatched",
      detail: "已创建任务",
      taskId: "fixture-task",
    });
    const history = await run("schedules", "runs", created.id);
    assert.match(history.stdout, /fixture-task/);
    assert.deepEqual(
      JSON.parse((await run("schedules", "runs", created.id, "--json")).stdout),
      runs,
    );
    assert.deepEqual(
      JSON.parse(
        (await run("schedules", "delete", created.id, "--json")).stdout,
      ),
      { ok: true },
    );
    assert.deepEqual(
      JSON.parse((await run("schedules", "list", "--json")).stdout),
      [],
    );
    const mutationCalls = calls.filter((call) => call.method !== "GET");
    assert.deepEqual(
      mutationCalls.map((call) => [call.method, call.path]),
      [
        ["POST", "/api/schedules"],
        ["POST", "/api/schedules/fixture-plan/pause"],
        ["POST", "/api/schedules/fixture-plan/resume"],
        ["PUT", "/api/schedules/fixture-plan"],
        ["POST", "/api/schedules/fixture-plan/delete"],
      ],
    );
    await assert.rejects(() =>
      run("schedules", "create", "--file", file, "unexpected"),
    );
    assert.equal(
      calls.filter((call) => call.method !== "GET").length,
      mutationCalls.length,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
