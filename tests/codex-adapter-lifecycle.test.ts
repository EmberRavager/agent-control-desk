import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexAdapter } from "../packages/core/adapters/codex.js";
import type {
  AdapterEvent,
  RunHandle,
  Task,
  AgentConnection,
} from "../packages/contracts/index.js";

const agent: AgentConnection = {
  id: "fixture",
  kind: "codex",
  name: "Codex fixture",
  executable: "unused",
  selected: true,
  available: true,
  capabilities: { steer: true, resume: true },
};
const fixture = String.raw`
const readline=require('node:readline');
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
const event=(method,params={})=>send({method,params:{threadId:'owned-thread',turnId:'owned-turn',...params}});
let goal=process.argv[2]||'',active=false;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='thread/start'||m.method==='thread/resume'){
  if(goal==='complete')event('turn/completed',{turn:{id:'previous-turn',status:'completed'}});
  send({id:m.id,result:{thread:{id:'owned-thread'}}});
 }
 else if(m.method==='turn/start'){
  goal=m.params.input[0].text;
  if(goal==='complete')event('turn/completed',{threadId:'other-thread',turn:{id:'foreign-turn',status:'completed'}});
  if(goal==='complete')event('item/agentMessage/delta',{threadId:'other-thread',turnId:'foreign-turn',delta:'FOREIGN OUTPUT'});
  // Legal ordering: a turn can start and emit updates before the start response is drained.
  if(!goal.startsWith('deferred')){active=true;event('turn/started',{turn:{id:'owned-turn',status:'inProgress'}});}
  event('item/agentMessage/delta',{delta:'你好\u2028world'});
  send({id:m.id,result:{turn:{id:'owned-turn'}}});if(goal.startsWith('deferred'))setTimeout(()=>{active=true;event('turn/started',{turn:{id:'owned-turn',status:'inProgress'}});},30);
  if(goal==='input'||goal==='other'||goal==='expiry'||goal==='choice'){
   send({id:'native-question',method:'item/tool/requestUserInput',params:{threadId:'owned-thread',turnId:'owned-turn',questions:[{id:'answer-id',header:'Requirement',question:'补充要求',isOther:goal==='other',options:goal==='other'||goal==='choice'?[{label:'Existing choice',description:'native option'}]:null}]}});
   if(goal==='expiry')setTimeout(()=>event('serverRequest/resolved',{requestId:'native-question'}),20);
  }else if(goal==='complete'){
   event('turn/completed',{turn:{id:'owned-turn',status:'completed'}});process.stdout.end();
  }else if(goal==='disconnect')process.stdout.end();
 }
 else if(m.id==='native-question'&&m.result){
  const actual=m.result.answers?.['answer-id']?.answers?.[0];
  if(actual!==(goal==='choice'?'Existing choice':'用户补充'))process.exit(87);
  event('turn/completed',{turn:{id:'owned-turn',status:'completed'}});
 }
 else if(m.method==='turn/steer'){if(!active)send({id:m.id,error:{code:-32600,message:'not started'}});else send({id:m.id,result:{turnId:'owned-turn'}});}
 else if(m.method==='turn/interrupt'){if(!active){send({id:m.id,error:{code:-32600,message:'no active turn to interrupt'}});return;}
  send({id:m.id,result:{}});
  if(goal!=='stop-timeout')event('turn/completed',{turn:{id:'owned-turn',status:'interrupted'}});
 }
});
`;
async function setup(goal: string, overrides: Partial<Task> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "acd-codex-contract-"));
  const file = join(dir, "fixture.cjs");
  await writeFile(file, fixture);
  const events: AdapterEvent[] = [];
  const task: Task = {
    id: "task",
    title: "Task",
    goal,
    cwd: dir,
    agentId: "fixture",
    status: "running",
    revision: 1,
    progress: "",
    createdAt: "now",
    updatedAt: "now",
    ...overrides,
  };
  let handle: RunHandle | undefined;
  try {
    handle = await new CodexAdapter(
      { executable: process.execPath, args: [file, goal] },
      1000,
      100,
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
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("Expected Codex event did not arrive");
}
const terminal = (events: AdapterEvent[]) =>
  events.filter((e) => ["completed", "cancelled", "failed"].includes(e.type));

test("Codex ignores replay and foreign turns, retains early owned output and drains the explicit final event", async () => {
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
      "你好\u2028world",
    );
    assert.equal(
      f.events.filter((e) => e.type === "session").at(-1)?.turnId,
      "owned-turn",
    );
  } finally {
    await f.close();
  }
});
test("Codex free-text and Other questions are ordinary input, not fixed approval choices", async () => {
  for (const goal of ["input", "other", "choice"]) {
    const f = await setup(goal);
    try {
      await until(() => f.events.some((e) => e.type === "question"));
      const q = f.events.find((e) => e.type === "question")!;
      assert.equal(q.input, goal === "choice" ? false : true);
      if (goal === "choice")
        await assert.rejects(
          () => f.handle.answer(q.requestId!, "用户补充"),
          /Invalid/,
        );
      await f.handle.answer(
        q.requestId!,
        goal === "choice" ? "Existing choice" : "用户补充",
      );
      await until(() => terminal(f.events).some((e) => e.type === "completed"));
    } finally {
      await f.close();
    }
  }
});
test("Codex serverRequest/resolved removes expired questions and rejects late answers", async () => {
  const f = await setup("expiry");
  try {
    await until(() => f.events.some((e) => e.type === "question_resolved"));
    await assert.rejects(
      () => f.handle.answer("native-question", "late"),
      /expired/,
    );
    assert.equal(terminal(f.events).length, 0);
  } finally {
    await f.close();
  }
});
test("Codex interrupt acceptance is not cancellation; a missing terminal response becomes uncertain", async () => {
  const f = await setup("stop-timeout");
  try {
    assert.equal(terminal(f.events).length, 0);
    await f.handle.stop();
    assert.equal(terminal(f.events).at(-1)?.type, "failed");
    assert.equal(terminal(f.events).at(-1)?.taskNotSubmitted, undefined);
  } finally {
    await f.close();
  }
});
test("Codex output EOF without a final event does not leave a task running indefinitely", async () => {
  const f = await setup("disconnect");
  try {
    await until(() => terminal(f.events).some((e) => e.type === "failed"));
    assert.equal(
      terminal(f.events).some((e) => e.type === "completed"),
      false,
    );
  } finally {
    await f.close();
  }
});

test("Codex waits for the owned turn/started before early steer and interrupt", async () => {
  for (const goal of ["deferred-stop", "deferred-steer"]) {
    const f = await setup(goal);
    try {
      if (goal === "deferred-steer") await f.handle.steer("new requirement");
      await f.handle.stop();
      assert.deepEqual(
        terminal(f.events).map((e) => e.type),
        ["cancelled"],
      );
    } finally {
      await f.close();
    }
  }
});

test("disposing Codex releases an early steer waiting for native start without emitting success", async () => {
  const f = await setup("deferred-steer");
  try {
    const pending = f.handle.steer("will be cancelled with the connection");
    f.handle.dispose();
    await assert.rejects(() => pending, /No active|disposed/);
    assert.equal(terminal(f.events).length, 0);
  } finally {
    await f.close();
  }
});

test("Codex resumes the original thread with only the new turn text", async () => {
  const f = await setup("旧目标\n补充：complete", {
    sessionId: "owned-thread",
    pendingTurnText: "complete",
  });
  try {
    await until(() => terminal(f.events).length > 0);
    assert.equal(terminal(f.events)[0].type, "completed");
  } finally {
    await f.close();
  }
});

const inquiryFixture = String.raw`
const fs=require('node:fs');
const readline=require('node:readline');
const mode=process.argv[2],log=process.argv[3];
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(log,JSON.stringify(m)+'\n');
 if(!m.method)return;
 let result={};
 if(m.method==='mcpServerStatus/list'){
  if(mode==='unsupported'){send({id:m.id,error:{message:'unsupported'}});return;}
  result={data:[{name:'fixture_server',tools:m.params.threadId&&mode!=='retained'?{}:{write_fixture:{name:'write_fixture'}},toolsError:mode==='unverified'? 'catalog failed':null}],nextCursor:mode==='repeated-page'?'again':null};
 }
 if(m.method==='thread/fork'){
  result={thread:{id:mode==='same-thread'?'original-thread':'inquiry-thread'},approvalPolicy:mode==='wrong-policy'?'on-request':'never',sandbox:{type:'readOnly',networkAccess:false}};
 }
 if(m.method==='turn/start'){
  send({method:'item/agentMessage/delta',params:{threadId:'original-thread',turnId:'original-turn',delta:'PARENT OUTPUT'}});
  result={turn:{id:'inquiry-turn'}};
  send({id:m.id,result});
  send({method:'turn/started',params:{threadId:'inquiry-thread',turn:{id:'inquiry-turn'}}});
  send({id:'denied-approval',method:'item/fileChange/requestApproval',params:{threadId:'inquiry-thread',turnId:'inquiry-turn'}});
  send({id:'denied-tool',method:'item/tool/call',params:{threadId:'inquiry-thread',turnId:'inquiry-turn',tool:'write_fixture'}});
  send({method:'item/agentMessage/delta',params:{threadId:'inquiry-thread',turnId:'inquiry-turn',delta:'Commit confirmed: fixture-sha'}});
  setTimeout(()=>send({method:'turn/completed',params:{threadId:'inquiry-thread',turn:{id:'inquiry-turn',status:'completed'}}}),30);
  return;
 }
 if(m.id!==undefined)send({id:m.id,result});
});`;
test("Codex inquiry forks the original thread, gates inherited tools, and asks only the new question", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acd-codex-inquiry-"));
  const script = join(dir, "fixture.cjs"),
    log = join(dir, "requests.jsonl");
  await writeFile(script, inquiryFixture);
  const events: AdapterEvent[] = [];
  const task: Task = {
    id: "inquiry",
    title: "Verify",
    goal: "OLD MUTATING GOAL",
    pendingTurnText: "OLD EXTRA COMMAND",
    agentId: agent.id,
    cwd: dir,
    status: "running",
    revision: 1,
    progress: "",
    createdAt: "now",
    updatedAt: "now",
    inquiry: {
      sourceId: "native-original",
      sessionId: "original-thread",
      question: "Was the commit pushed?",
      turnId: "original-turn",
    },
  };
  let handle: RunHandle | undefined;
  try {
    handle = await new CodexAdapter(
      { executable: process.execPath, args: [script, "isolated", log] },
      500,
      100,
    ).start({ task, agent, onEvent: (e) => events.push(e) });
    await until(() => terminal(events).length > 0);
    const requests = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const fork = requests.find((m) => m.method === "thread/fork"),
      turn = requests.find((m) => m.method === "turn/start");
    assert.equal(fork.params.threadId, "original-thread");
    assert.equal(fork.params.lastTurnId, "original-turn");
    assert.equal(fork.params.ephemeral, true);
    assert.equal(fork.params.sandbox, "read-only");
    assert.equal(fork.params.approvalPolicy, "never");
    assert.equal(
      fork.params.config["mcp_servers.fixture_server.enabled"],
      false,
    );
    assert.equal(fork.params.config["features.shell_tool"], false);
    assert.equal(fork.params.config["features.apps"], false);
    assert.equal(fork.params.config["features.plugins"], false);
    assert.equal(fork.params.config["features.multi_agent"], false);
    assert.equal(turn.params.threadId, "inquiry-thread");
    assert.equal(turn.params.approvalPolicy, "never");
    assert.deepEqual(turn.params.sandboxPolicy, {
      type: "readOnly",
      networkAccess: false,
    });
    assert.ok(turn.params.input[0].text.includes("Was the commit pushed?"));
    assert.ok(!JSON.stringify(turn.params).includes("OLD"));
    assert.equal(
      requests.filter((m) => m.method === "mcpServerStatus/list").length,
      2,
    );
    assert.ok(
      !requests.some((m) =>
        ["thread/start", "thread/resume"].includes(m.method),
      ),
    );
    assert.equal(
      requests.find((m) => m.id === "denied-approval")?.result?.decision,
      "decline",
    );
    assert.ok(requests.find((m) => m.id === "denied-tool")?.error);
    assert.ok(!events.some((e) => e.type === "question"));
    assert.equal(
      events
        .filter((e) => e.type === "output")
        .map((e) => e.text)
        .join(""),
      "Commit confirmed: fixture-sha",
    );
    assert.deepEqual(
      terminal(events).map((e) => e.type),
      ["completed"],
    );
  } finally {
    handle?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
test("Codex inquiry fails before any turn when isolation is unsupported, tools remain, or the fork reuses the parent", async () => {
  for (const mode of [
    "unsupported",
    "retained",
    "same-thread",
    "unverified",
    "repeated-page",
    "wrong-policy",
  ]) {
    const dir = await mkdtemp(join(tmpdir(), "acd-codex-inquiry-gate-"));
    const script = join(dir, "fixture.cjs"),
      log = join(dir, "requests.jsonl");
    await writeFile(script, inquiryFixture);
    try {
      const task: Task = {
        id: "q",
        title: "Verify",
        goal: "Verify",
        agentId: agent.id,
        cwd: dir,
        status: "running",
        revision: 1,
        progress: "",
        createdAt: "now",
        updatedAt: "now",
        inquiry: {
          sourceId: "native-original",
          sessionId: "original-thread",
          question: "Was the commit pushed?",
        },
      };
      await assert.rejects(
        new CodexAdapter(
          { executable: process.execPath, args: [script, mode, log] },
          100,
          100,
        ).start({ task, agent, onEvent() {} }),
      );
      const requests = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.ok(!requests.some((m) => m.method === "turn/start"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
