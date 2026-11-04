import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../packages/core/server.js";

test("ordinary startup uses the real routing and execution environment", async () => {
  const directory = mkdtempSync(join(tmpdir(), "acd-live-environment-"));
  const app = await startServer({ directory, port: 0 });
  try {
    const health = await fetch(app.descriptor.url + "/api/health").then(
      (response) => response.json(),
    );
    assert.equal(health.environment, "live");
    assert.equal(app.runtime.snapshot().environment, "live");
    assert.equal(app.runtime.deps.route, undefined);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dependency-injected acceptance backends identify themselves as test environments", async () => {
  const directory = mkdtempSync(join(tmpdir(), "acd-test-environment-"));
  const app = await startServer({
    directory,
    port: 0,
    deps: {
      scan: async () => [],
      vault: { get: async () => null, set: async () => {} },
      route: async () => ({ reply: "Fixture only", actions: [] }),
      adapter: () => {
        throw Error("must not execute");
      },
    },
  });
  try {
    const health = await fetch(app.descriptor.url + "/api/health").then(
      (response) => response.json(),
    );
    assert.equal(health.environment, "test");
    assert.equal(app.runtime.snapshot().environment, "test");
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
