import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanAgents,
  verifyAgent,
  createAdapter,
} from "../packages/core/agents.js";
import type { AgentConnection } from "../packages/contracts/index.js";

async function directory() {
  return mkdtemp(join(tmpdir(), "acd-discovery-"));
}
async function executable(path: string, source: string) {
  await writeFile(path, "#!/usr/bin/env node\n" + source);
  await chmod(path, 0o755);
}
const agent = (path: string): AgentConnection => ({
  id: "fake",
  kind: "codex",
  name: "Fake Codex",
  executable: path,
  selected: false,
  available: true,
  supported: true,
  verification: "discovered",
  capabilities: { steer: true, resume: true },
});

test(
  "discovery lists supported and unsupported agents without executing them",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await directory();
    try {
      for (const name of ["codex", "claude", "opencode", "pi", "dsh"])
        await executable(
          join(dir, name),
          "throw Error('Discovery must never execute this program')",
        );
      await symlink(join(dir, "dsh"), join(dir, "deepseek-harness"));
      const found = await scanAgents([dir, dir]);
      assert.equal(found.length, 5);
      assert.equal(new Set(found.map((a) => a.kind)).size, 5);
      assert.ok(found.every((a) => !a.selected));
      for (const a of found) {
        if (["codex", "claude", "opencode", "pi"].includes(a.kind)) {
          assert.equal(a.supported, true);
          assert.equal(a.verification, "discovered");
          assert.match(a.verificationMessage!, /尚未验证/);
        } else {
          assert.equal(a.supported, false);
          assert.equal(a.available, false);
          assert.equal(a.verification, "unsupported");
          assert.match(a.verificationMessage!, /适配尚未接入/);
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "selected program version check reports startup only, never account readiness",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await directory();
    const file = join(dir, "fake-codex");
    try {
      await executable(
        file,
        "if(process.argv[2]!=='--version')process.exit(93);console.log('fake-codex 0.0.0');",
      );
      const verified = await verifyAgent(agent(file));
      assert.equal(verified.verification, "verified");
      assert.equal(verified.available, true);
      assert.match(
        verified.verificationMessage!,
        /账号和模型权限待真实执行验证/,
      );
      await executable(file, "process.exit(2)");
      const failed = await verifyAgent(agent(file));
      assert.equal(failed.verification, "failed");
      assert.equal(failed.available, false);
      await executable(
        file,
        "process.stdout.write('x'.repeat(20000));setInterval(()=>{},1000)",
      );
      const excessive = await verifyAgent(agent(file));
      assert.equal(excessive.available, false);
      assert.match(excessive.verificationMessage!, /输出异常/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "selected program check has a bounded timeout",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await directory();
    const file = join(dir, "fake-codex");
    try {
      await executable(file, "setInterval(()=>{},1000)");
      const before = Date.now();
      const result = await verifyAgent(agent(file));
      assert.equal(result.verification, "failed");
      assert.match(result.verificationMessage!, /超时/);
      assert.ok(Date.now() - before < 5000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("unsupported agents are never launched or accidentally routed to Claude", async () => {
  const unsupported: AgentConnection = {
    ...agent("/does/not/exist"),
    kind: "deepseek-harness",
    supported: false,
    available: false,
  };
  const checked = await verifyAgent(unsupported);
  assert.equal(checked.verification, "unsupported");
  for (const kind of ["openclaw", "hermes", "deepseek-harness"] as const)
    assert.throws(() => createAdapter(kind), /适配尚未接入/);
});

test(
  "OpenClaw and Hermes discovery remains passive and manual unknown programs stay unsupported",
  { skip: process.platform === "win32" },
  async () => {
    const { agentFromPath } = await import("../packages/core/agents.js");
    const directory = await mkdtemp(join(tmpdir(), "acd-extra-"));
    try {
      for (const name of ["openclaw", "hermes", "my-agent"]) {
        const file = join(directory, name);
        await writeFile(file, "#!/bin/sh\nexit 99\n");
        await chmod(file, 0o755);
      }
      const discovered = await scanAgents([directory]);
      assert.deepEqual(discovered.map((a) => a.kind).sort(), [
        "hermes",
        "openclaw",
      ]);
      assert.ok(discovered.every((a) => a.supported === false && !a.selected));
      const manual = await agentFromPath(join(directory, "my-agent"));
      assert.equal(manual.kind, "custom");
      assert.equal(manual.discoverySource, "manual");
      assert.equal(manual.available, false);
      assert.equal(manual.verification, "unsupported");
      await assert.rejects(() => agentFromPath("relative/path"), /绝对路径/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Pi readiness rejects versions without the validated settled lifecycle",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await directory(),
      file = join(dir, "pi");
    try {
      await executable(file, "console.log('0.70.0')");
      const input = { ...agent(file), kind: "pi" as const };
      assert.equal((await verifyAgent(input)).available, false);
      await executable(file, "console.log('0.84.3')");
      assert.equal((await verifyAgent(input)).available, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
