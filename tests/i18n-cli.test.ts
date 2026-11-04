import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSendArgs } from "../apps/cli/main.js";

test("offline CLI help accepts English explicitly without starting a service", async () => {
  const directory = mkdtempSync(join(tmpdir(), "acd-i18n-cli-"));
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("../apps/cli/main.ts", import.meta.url)),
        "--lang",
        "en",
        "--help",
      ],
      { env: { ...process.env, ACD_DATA_DIR: directory }, timeout: 10000 },
    );
    assert.match(stdout, /Open the control conversation/);
    assert.match(stdout, /acd language/);
    assert.doesNotMatch(stdout, /打开总控对话/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("CLI argument errors use the requested language while command values remain unchanged", () => {
  assert.throws(
    () => (parseSendArgs as any)(["task", "--require", "unsafe"], "en"),
    /Unknown capability/,
  );
  assert.deepEqual(
    (parseSendArgs as any)(["用户原话", "--agent", "codex"], "en"),
    { text: "用户原话", targetAgentId: "codex" },
  );
});

test("CLI changes the shared persisted language and normal commands use it", async () => {
  const { startServer } = await import("../packages/core/server.js");
  const directory = mkdtempSync(join(tmpdir(), "acd-i18n-cli-service-"));
  const app = await startServer({
    directory,
    port: 0,
    deps: {
      scan: async () => [],
      adapter: () => {
        throw Error("No live agents");
      },
      vault: { get: async () => null, set: async () => {} },
    },
  });
  const run = (...args: string[]) =>
    promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("../apps/cli/main.ts", import.meta.url)),
        ...args,
      ],
      { env: { ...process.env, ACD_DATA_DIR: directory }, timeout: 10000 },
    );
  try {
    assert.match((await run("language", "en")).stdout, /Language: English/);
    assert.equal(app.runtime.preferences().locale, "en");
    assert.match((await run("tasks")).stdout, /No tasks/);
    assert.match((await run("--lang", "zh-CN", "tasks")).stdout, /暂无任务/);
    assert.equal(app.runtime.preferences().locale, "en");
    assert.deepEqual(JSON.parse((await run("language", "--json")).stdout), {
      locale: "en",
    });
    assert.match((await run("language", "zh-CN")).stdout, /简体中文/);
    assert.match((await run("tasks")).stdout, /暂无任务/);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
