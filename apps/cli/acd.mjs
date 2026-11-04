#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
const compiled = new URL("../../dist/runtime/cli.mjs", import.meta.url);
const source = new URL("./main.ts", import.meta.url);
const args = existsSync(fileURLToPath(source))
  ? ["--import", import.meta.resolve("tsx"), fileURLToPath(source)]
  : [fileURLToPath(compiled)];
const child = spawn(process.execPath, [...args, ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("error", () => {
  console.error(
    "ACD: 无法启动 CLI。请重新安装 ACD，源码开发请先安装项目依赖。",
  );
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
