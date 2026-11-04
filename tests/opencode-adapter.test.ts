import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AdapterEvent,
  AgentConnection,
  Task,
  RunHandle,
} from "../packages/contracts/index.js";
import { OpenCodeAdapter } from "../packages/core/adapters/opencode.js";

const makeTask = (cwd: string, goal: string, sessionId?: string): Task => ({
  id: "test-task",
  title: "test",
  goal,
  agentId: "fixture",
  cwd,
  status: "running",
  revision: 1,
  progress: "",
  createdAt: "now",
  updatedAt: "now",
  sessionId,
});
const agent: AgentConnection = {
  id: "fixture",
  kind: "opencode",
  name: "Fixture",
  executable: "unused",
  selected: true,
  available: true,
  capabilities: { steer: true, resume: true },
};
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Expected native protocol event did not arrive");
}
const ended = (events: AdapterEvent[]) =>
  events.some((e) => ["completed", "cancelled", "failed"].includes(e.type));

const fixture = String.raw`
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
let prompt, scenario='', permissionId='native-permission', session='session-created';
const update = value => send({method:'session/update',params:{sessionId:session,update:value}});
const done = reason => send({id:prompt.id,result:{stopReason:reason}});
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') {
  if(m.params.clientCapabilities.fs.readTextFile || m.params.clientCapabilities.fs.writeTextFile || m.params.clientCapabilities.terminal) process.exit(82);
  send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}});
 } else if(m.method==='session/new') send({id:m.id,result:{sessionId:session}});
 else if(m.method==='session/load') {
  session=m.params.sessionId;
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OLD REPLAY MUST NOT BE STORED'}});
  send({id:m.id,result:{}});
 } else if(m.method==='session/prompt') {
  prompt=m; scenario=m.params.prompt[0].text;
  update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'PRIVATE REASONING'}});
  update({sessionUpdate:'tool_call',toolCallId:'t',title:'Read test file',kind:'read',status:'in_progress',rawInput:{token:'PRIVATE TOOL ARGS'}});
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'你好\u2028world'}});
  if(scenario==='permission') send({id:permissionId,method:'session/request_permission',params:{sessionId:session,toolCall:{toolCallId:'t',title:'Allow fixture?'},options:[{optionId:'allow_native_42',name:'Allow',kind:'allow_once'},{optionId:'deny_native_55',name:'Deny',kind:'reject_once'}]}});
  else if(scenario==='disconnect') process.stdout.end();
  else if(scenario==='complete' || scenario==='resume') {done('end_turn');process.stdout.end();}
  else if(scenario==='length') done('max_tokens');
 } else if(m.method==='session/cancel' && scenario!=='timeout') done('cancelled');
 else if(m.id===permissionId && m.result) {
  if(m.result.outcome.outcome!=='selected' || m.result.outcome.optionId!=='allow_native_42') process.exit(83);
  done('end_turn');
 }
});
`;
async function setup(goal: string, sessionId?: string, stopTimeout = 200) {
  const dir = await mkdtemp(join(tmpdir(), "acd-acp-"));
  const file = join(dir, "native.cjs");
  await writeFile(file, fixture);
  const events: AdapterEvent[] = [];
  let handle: RunHandle | undefined;
  try {
    handle = await new OpenCodeAdapter(
      { executable: process.execPath, args: [file] },
      2000,
      stopTimeout,
    ).start({
      task: makeTask(dir, goal, sessionId),
      agent,
      onEvent: (e) => events.push(e),
    });
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
test("OpenCode negotiates ACP, excludes thoughts/replay and accepts a fast explicit end", async () => {
  for (const goal of ["complete", "resume"]) {
    const f = await setup(
      goal,
      goal === "resume" ? "owned-session" : undefined,
    );
    try {
      await until(() => ended(f.events));
      assert.equal(
        f.events.find((e) => e.type === "session")?.sessionId,
        goal === "resume" ? "owned-session" : "session-created",
      );
      assert.equal(f.events.at(-1)?.type, "completed");
      const output = f.events
        .filter((e) => e.type === "output")
        .map((e) => e.text)
        .join("");
      assert.equal(output, "你好\u2028world");
      assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE|OLD REPLAY/);
      await assert.rejects(() => f.handle.steer("extra"), /不支持/);
    } finally {
      await f.close();
    }
  }
});
test("OpenCode maps permission choices to exact native IDs and rejects stale responses", async () => {
  const f = await setup("permission");
  try {
    await until(() => f.events.some((e) => e.type === "question"));
    const q = f.events.find((e) => e.type === "question")!;
    assert.deepEqual(q.choices, ["option-1", "option-2"]);
    assert.equal(q.choiceLabels?.["option-1"], "允许这次操作");
    await assert.rejects(
      () => f.handle.answer(q.requestId!, "allow_native_42"),
      /无效/,
    );
    await f.handle.answer(q.requestId!, "option-1");
    await until(() => ended(f.events));
    assert.equal(f.events.at(-1)?.type, "completed");
    await assert.rejects(
      () => f.handle.answer(q.requestId!, "option-1"),
      /失效/,
    );
  } finally {
    await f.close();
  }
});
test("OpenCode cancellation requires a terminal response; a timeout or disconnect remains failed", async () => {
  for (const goal of ["wait", "timeout", "disconnect", "length"]) {
    const f = await setup(goal);
    try {
      await until(() => f.events.some((e) => e.type === "output"));
      if (goal === "wait" || goal === "timeout") await f.handle.stop();
      await until(() => ended(f.events));
      assert.equal(
        f.events.at(-1)?.type,
        goal === "wait" ? "cancelled" : "failed",
      );
      assert.equal(f.events.at(-1)?.taskNotSubmitted, undefined);
    } finally {
      await f.close();
    }
  }
});
test("OpenCode initialization timeout proves no task was submitted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acd-acp-timeout-"));
  let handle: RunHandle | undefined;
  try {
    const file = join(dir, "idle.cjs");
    await writeFile(file, "setInterval(()=>{},1000)");
    const events: AdapterEvent[] = [];
    handle = await new OpenCodeAdapter(
      { executable: process.execPath, args: [file] },
      100,
    ).start({
      task: makeTask(dir, "test"),
      agent,
      onEvent: (e) => events.push(e),
    });
    assert.equal(events.at(-1)?.type, "failed");
    assert.equal(events.at(-1)?.taskNotSubmitted, true);
  } finally {
    handle?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
