import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeAdapter } from "../packages/core/adapters/claude.js";
import type {
  AdapterEvent,
  AgentConnection,
  RunHandle,
  Task,
} from "../packages/contracts/index.js";
const agent: AgentConnection = {
  id: "claude",
  kind: "claude",
  name: "Claude fixture",
  executable: "unused",
  selected: true,
  available: true,
  capabilities: { steer: false, resume: true },
};
const fixture = String.raw`
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');let prompt='';
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>prompt+=chunk);
process.stdin.on('end',()=>{
 send({type:'system',subtype:'init',session_id:'owned-claude'});
 send({type:'assistant',parent_tool_use_id:'child-tool',session_id:'child-session',message:{content:[{type:'text',text:'CHILD PRIVATE OUTPUT'}]}});
 send({type:'result',parent_tool_use_id:'child-tool',subtype:'success',is_error:false,result:'CHILD FALSE END'});
 send({type:'assistant',session_id:'owned-claude',message:{content:[{type:'thinking',thinking:'PRIVATE REASONING'},{type:'text',text:'你好\u2028world'}]}});
 if(prompt==='complete'){
  send({type:'result',subtype:'success',is_error:false,result:'你好\u2028world',session_id:'owned-claude'});process.stdout.end();
 }else if(prompt==='denied'){
  send({type:'result',subtype:'success',is_error:false,permission_denials:[{tool_name:'Write',tool_input:{secret:'PRIVATE ARG'}}]});
 }else if(prompt==='malformed-result')send({type:'result'});
 else if(prompt==='disconnect'){process.stdout.end();setInterval(()=>{},1000);}
 else if(prompt==='stop-timeout'){
  process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),500);setInterval(()=>{},1000);
 }else {setInterval(()=>{},1000);}
});
`;
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("Expected Claude event did not arrive");
}
const terminal = (events: AdapterEvent[]) =>
  events.filter((e) => ["completed", "cancelled", "failed"].includes(e.type));
async function setup(goal: string) {
  const dir = await mkdtemp(join(tmpdir(), "acd-claude-protocol-"));
  const file = join(dir, "fixture.cjs");
  await writeFile(file, fixture);
  const events: AdapterEvent[] = [];
  let handle: RunHandle | undefined;
  try {
    const task: Task = {
      id: "task",
      title: "Task",
      goal,
      agentId: "claude",
      cwd: dir,
      status: "running",
      revision: 1,
      progress: "",
      createdAt: "now",
      updatedAt: "now",
    };
    handle = await new ClaudeAdapter(
      { executable: process.execPath, args: [file] },
      80,
    ).start({ task, agent, onEvent: (e) => events.push(e) });
    return {
      events,
      handle,
      close: async () => {
        handle!.dispose();
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

test("Claude preserves Unicode and drains the main final result without child completion or reasoning", async () => {
  const f = await setup("complete");
  try {
    await until(() => terminal(f.events).length > 0);
    assert.deepEqual(
      terminal(f.events).map((e) => e.type),
      ["completed"],
    );
    assert.equal(
      f.events
        .filter((e) => e.type === "output")
        .map((e) => e.text)
        .join(""),
      "你好\u2028world\n",
    );
    assert.ok(
      f.events
        .filter((e) => e.type === "session")
        .every((e) => e.sessionId === "owned-claude"),
    );
    assert.doesNotMatch(JSON.stringify(f.events), /CHILD|PRIVATE/);
  } finally {
    await f.close();
  }
});
test("Claude denies ambiguous success, permission denial and EOF without an explicit result", async () => {
  for (const goal of ["denied", "malformed-result", "disconnect"]) {
    const f = await setup(goal);
    try {
      await until(() => terminal(f.events).length > 0);
      assert.deepEqual(
        terminal(f.events).map((e) => e.type),
        ["failed"],
      );
      assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE ARG/);
    } finally {
      await f.close();
    }
  }
});
test("Claude stop waits for process exit, and ignored termination becomes uncertain", async () => {
  for (const goal of ["wait", "stop-timeout"]) {
    const f = await setup(goal);
    try {
      await until(() => f.events.some((e) => e.type === "output"));
      assert.equal(terminal(f.events).length, 0);
      await f.handle.stop();
      assert.equal(
        terminal(f.events).at(-1)?.type,
        goal === "wait" ? "cancelled" : "failed",
      );
      await assert.rejects(() => f.handle.stop(), /没有/);
    } finally {
      await f.close();
    }
  }
});
