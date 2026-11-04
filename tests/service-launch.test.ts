import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serviceLaunch } from "../packages/core/service-launch.cjs";
const root = fileURLToPath(new URL("..", import.meta.url));
test("source host resolves tsx from the checkout instead of the caller working directory", () => {
  const launch = serviceLaunch({ root, executable: process.execPath });
  assert.equal(launch.cwd, root);
  assert.deepEqual(launch.args.slice(0, 1), ["--import"]);
  assert.ok(launch.args[1].startsWith("file:"));
  assert.equal(launch.args[2], join(root, "packages/core/server.ts"));
});
test("packaged and compiled hosts launch real JavaScript files without a TypeScript loader or ASAR cwd", () => {
  const appRoot = join(
    root,
    "fixture",
    "Agent Control Desk.app",
    "Contents",
    "Resources",
    "app.asar",
  );
  const executable = join(
    root,
    "fixture",
    "Agent Control Desk.app",
    "Contents",
    "MacOS",
    "Agent Control Desk",
  );
  const packaged = serviceLaunch({
    root: appRoot,
    executable,
    packaged: true,
  });
  assert.equal(packaged.cwd, dirname(executable));
  assert.deepEqual(packaged.args, [
    join(appRoot + ".unpacked", "dist/runtime/server.mjs"),
  ]);
  const compiled = serviceLaunch({
    root,
    executable: process.execPath,
    compiled: true,
  });
  assert.equal(compiled.cwd, root);
  assert.deepEqual(compiled.args, [join(root, "dist/runtime/server.mjs")]);
  assert.ok(!packaged.args.includes("tsx"));
});
