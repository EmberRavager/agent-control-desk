import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const config = require("../electron-builder.cjs");
const { Arch } = require("electron-builder");
const { checkTarget } = require("../scripts/check-package-target.cjs");
test("desktop package includes only runtime and UI assets and keeps native dependencies on real paths", () => {
  assert.equal(config.extraMetadata.main, "apps/desktop/main.cjs");
  assert.equal(config.appId, "io.github.emberravager.agentcontroldesk");
  assert.equal(config.publish, null);
  assert.equal(config.asar, true);
  assert.equal(config.allowMissingDependencies, false);
  assert.ok(config.files.includes("dist/runtime/**"));
  assert.ok(config.asarUnpack.includes("dist/runtime/**"));
  assert.ok(config.asarUnpack.includes("node_modules/**"));
  assert.ok(!config.files.includes("**/*"));
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
});
test("desktop package refuses a mismatched native target instead of shipping host-only keyring binaries", () => {
  const other = process.platform === "win32" ? "darwin" : "win32";
  assert.throws(
    () =>
      checkTarget({ electronPlatformName: other, arch: Arch[process.arch] }),
    /目标系统/,
  );
  assert.throws(
    () =>
      checkTarget({
        electronPlatformName: process.platform,
        arch: Arch[process.arch === "arm64" ? "x64" : "arm64"],
      }),
    /目标系统/,
  );
  if (["darwin", "win32"].includes(process.platform))
    assert.doesNotThrow(() =>
      checkTarget({
        electronPlatformName: process.platform,
        arch: Arch[process.arch],
      }),
    );
});
