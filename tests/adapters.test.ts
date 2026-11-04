import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanAgents } from "../packages/core/agents.js";
import { CodexAdapter } from "../packages/core/adapters/codex.js";
import type {
  AdapterEvent,
  AgentConnection,
  Task,
} from "../packages/contracts/index.js";

const task = (cwd: string, goal = "test"): Task => ({
  id: "test-task",
  title: "test",
  goal,
  agentId: "fake",
  cwd,
  status: "running",
  revision: 1,
  progress: "",
  createdAt: "now",
  updatedAt: "now",
});
const agent: AgentConnection = {
  id: "fake",
  kind: "codex",
  name: "Fake",
  executable: "not-used",
  selected: true,
  available: true,
  capabilities: { steer: true, resume: true },
};
const fixture = `
const readline = require('node:readline');
const send = msg => process.stdout.write(JSON.stringify(msg)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start'||m.method==='thread/resume')send({id:m.id,result:{thread:{id:'thread-fake'}}});
 if(m.method==='turn/start') {
  send({id:m.id,result:{turn:{id:'turn-fake'}}});send({method:'turn/started',params:{threadId:'thread-fake',turn:{id:'turn-fake',status:'inProgress'}}});
  send({method:'item/agentMessage/delta',params:{threadId:'thread-fake',turnId:'turn-fake',delta:'hello'}});
  if(m.params.input[0].text==='approval')send({id:'approval-fake',method:'item/commandExecution/requestApproval',params:{command:'test command',threadId:'thread-fake',turnId:'turn-fake'}});
 }
 if(m.method==='turn/steer')send({id:m.id,result:{turnId:m.params.expectedTurnId}});
 if(m.method==='turn/interrupt') {send({id:m.id,result:{}});send({method:'turn/completed',params:{threadId:'thread-fake',turn:{id:'turn-fake',status:'interrupted'}}});}
 if(m.id==='approval-fake'&&m.result){send({method:'turn/completed',params:{threadId:'thread-fake',turn:{id:'turn-fake',status:m.result.decision==='accept'?'completed':'interrupted'}}});}
});
`;
async function setup(source = fixture) {
  const dir = await mkdtemp(join(tmpdir(), "acd-adapter-"));
  const file = join(dir, "fake.cjs");
  await writeFile(file, source);
  return { dir, file };
}
async function eventually(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("Expected protocol event did not arrive");
}

test(
  "scanner is passive, deselects discoveries and deduplicates canonical paths",
  { skip: process.platform === "win32" },
  async () => {
    const { dir } = await setup();
    try {
      const command = join(dir, "codex");
      await writeFile(command, "#!/bin/sh\nexit 77\n");
      await chmod(command, 0o755);
      const other = join(dir, "other");
      await symlink(dir, other);
      const found = await scanAgents([dir, other]);
      assert.equal(found.length, 1);
      assert.equal(found[0].selected, false);
      assert.equal(found[0].kind, "codex");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("Codex initializes, streams, steers and stops with actual protocol acknowledgement", async () => {
  const { dir, file } = await setup();
  const events: AdapterEvent[] = [];
  let handle;
  try {
    handle = await new CodexAdapter({
      executable: process.execPath,
      args: [file],
    }).start({ task: task(dir), agent, onEvent: (e) => events.push(e) });
    await eventually(() => events.some((e) => e.type === "output"));
    assert.equal(events.find((e) => e.type === "output")?.text, "hello");
    await handle.steer("new requirement");
    assert.ok(!events.some((e) => e.type === "cancelled"));
    await handle.stop();
    await eventually(() => events.some((e) => e.type === "cancelled"));
    await assert.rejects(() => handle!.steer("late"), /No active/);
  } finally {
    handle?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex surfaces approval and rejects invalid or already-used decisions", async () => {
  const { dir, file } = await setup();
  const events: AdapterEvent[] = [];
  let handle;
  try {
    handle = await new CodexAdapter({
      executable: process.execPath,
      args: [file],
    }).start({
      task: task(dir, "approval"),
      agent,
      onEvent: (e) => events.push(e),
    });
    await eventually(() => events.some((e) => e.type === "question"));
    await assert.rejects(
      () => handle!.answer("approval-fake", "acceptForSession"),
      /Invalid/,
    );
    await handle.answer("approval-fake", "accept");
    await eventually(() => events.some((e) => e.type === "completed"));
    await assert.rejects(
      () => handle!.answer("approval-fake", "accept"),
      /expired/,
    );
  } finally {
    handle?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex handshake timeout rejects instead of leaving the task waiting forever", async () => {
  const { dir, file } = await setup("setInterval(()=>{},1000)");
  try {
    await assert.rejects(
      () =>
        new CodexAdapter(
          { executable: process.execPath, args: [file] },
          60,
        ).start({ task: task(dir), agent, onEvent: () => {} }),
      /timed out/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
