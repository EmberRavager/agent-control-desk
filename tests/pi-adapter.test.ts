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
import { PiAdapter } from "../packages/core/adapters/pi.js";

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
  kind: "pi",
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
const readline=require('node:readline');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const response=(m,data)=>send({type:'response',id:m.id,command:m.type,success:true,data});
let scenario=process.argv[2]||'',answered=0;
const message=reason=>({role:'assistant',content:[{type:'text',text:'完成结果'}],stopReason:reason});
const settled=reason=>{send({type:'message_end',message:message(reason)});send({type:'agent_settled'});};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.type==='get_state') {
  // Startup events are not a completion of the not-yet-submitted task.
  send({type:'agent_settled'});
  response(m,{sessionId:'12345678-1234-1234-1234-123456789abc',model:scenario==='no-model'?null:{id:'fixture'},isStreaming:false,isCompacting:false});
 } else if(m.type==='prompt') {
  scenario=m.message;
  if(scenario==='rejected') {send({type:'response',id:m.id,command:'prompt',success:false,error:'fixture rejection'});return;}
  response(m,{disposition:'started'});
  send({type:'agent_start'});send({type:'message_start',message:{role:'assistant'}});
  send({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'PRIVATE REASONING'}});
  send({type:'tool_execution_start',toolName:'read',args:{secret:'PRIVATE TOOL ARGS'}});
  const delta=Buffer.from(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'你好\u2028world'}})+'\n');
  // Split inside the multibyte Chinese character as real pipes may do.
  const split=delta.indexOf(Buffer.from('你'))+1;
  process.stdout.write(delta.subarray(0,split));process.stdout.write(delta.subarray(split));
  if(scenario==='retry') {
   send({type:'agent_end',messages:[message('error')],willRetry:true});
   send({type:'auto_retry_start'});
   setTimeout(()=>{send({type:'message_start',message:{role:'assistant'}});settled('stop');process.stdout.end();},60);
  } else if(scenario==='dialogs') {
   send({type:'extension_ui_request',id:'confirm',method:'confirm',title:'Allow fixture?'});
  } else if(scenario==='expiry') send({type:'extension_ui_request',id:'expires',method:'input',title:'Answer',timeout:20});
  else if(scenario==='disconnect') process.stdout.end();
  else if(scenario==='complete') {settled('stop');process.stdout.end();}
 } else if(m.type==='steer') {response(m,{});send({type:'notify_test_ignored'});send({type:'extension_ui_request',id:'steered',method:'notify',message:m.message});}
 else if(m.type==='abort') {if(scenario!=='timeout') {settled('aborted');response(m,{});}}
 else if(m.type==='extension_ui_response') {
  if(scenario==='expiry') {if(m.id!=='expires'||m.cancelled!==true)process.exit(90);settled('stop');}
  else if(m.id==='confirm') {
   if(m.confirmed!==true)process.exit(91);
   send({type:'extension_ui_request',id:'select',method:'select',title:'Choose',options:['first native value','second native value']});
  } else if(m.id==='select') {
   if(m.value!=='second native value')process.exit(92);
   send({type:'extension_ui_request',id:'input',method:'input',title:'Describe requirement'});
  } else if(m.id==='input') {
   if(m.value!=='free text 用户补充')process.exit(93);settled('stop');
  }
 }
});
`;
async function setup(goal: string, stopTimeout = 200) {
  const dir = await mkdtemp(join(tmpdir(), "acd-pi-"));
  const file = join(dir, "native.cjs");
  await writeFile(file, fixture);
  const events: AdapterEvent[] = [];
  let handle: RunHandle | undefined;
  try {
    handle = await new PiAdapter(
      { executable: process.execPath, args: [file, goal] },
      2000,
      stopTimeout,
    ).start({
      task: makeTask(dir, goal),
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
test("Pi ignores startup settled, preserves fragmented Unicode and waits through retry to agent_settled", async () => {
  const f = await setup("retry");
  try {
    await until(() => f.events.some((e) => e.text?.includes("重试")));
    assert.ok(!ended(f.events), "agent_end before retry is not completion");
    await until(() => ended(f.events));
    assert.equal(f.events.at(-1)?.type, "completed");
    assert.equal(
      f.events.find((e) => e.type === "session")?.sessionId,
      "12345678-1234-1234-1234-123456789abc",
    );
    assert.match(
      f.events
        .filter((e) => e.type === "output")
        .map((e) => e.text)
        .join(""),
      /你好\u2028world/,
    );
    assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE/);
  } finally {
    await f.close();
  }
});
test("Pi maps confirm/select and free text to native extension responses", async () => {
  const f = await setup("dialogs");
  try {
    await until(() => f.events.some((e) => e.requestId === "confirm"));
    await assert.rejects(() => f.handle.answer("confirm", "yes"), /无效/);
    await f.handle.answer("confirm", "accept");
    await until(() => f.events.some((e) => e.requestId === "select"));
    const select = f.events.find((e) => e.requestId === "select")!;
    assert.equal(select.choiceLabels?.["option-2"], "second native value");
    await f.handle.answer("select", "option-2");
    await until(() => f.events.some((e) => e.requestId === "input"));
    assert.equal(f.events.find((e) => e.requestId === "input")?.input, true);
    await f.handle.answer("input", "free text 用户补充");
    await until(() => ended(f.events));
    assert.equal(f.events.at(-1)?.type, "completed");
    await assert.rejects(() => f.handle.answer("input", "again"), /失效/);
  } finally {
    await f.close();
  }
});
test("Pi expires extension requests and removes stale native answers", async () => {
  const f = await setup("expiry");
  try {
    await until(() => f.events.some((e) => e.type === "question_resolved"));
    await assert.rejects(() => f.handle.answer("expires", "late"), /失效/);
    await until(() => ended(f.events));
    assert.equal(f.events.at(-1)?.type, "completed");
  } finally {
    await f.close();
  }
});
test("Pi prompt receipt stays running; steer and settled-before-abort-response are safe", async () => {
  const f = await setup("wait");
  try {
    assert.ok(!ended(f.events));
    await f.handle.steer("new requirement");
    await until(() => f.events.some((e) => e.text === "new requirement"));
    await f.handle.stop();
    assert.equal(f.events.at(-1)?.type, "cancelled");
  } finally {
    await f.close();
  }
});
test("Pi distinguishes pre-submission rejection from uncertain execution loss", async () => {
  for (const goal of [
    "no-model",
    "rejected",
    "disconnect",
    "timeout",
    "complete",
  ]) {
    const f = await setup(goal);
    try {
      if (goal === "timeout") await f.handle.stop();
      await until(() => ended(f.events));
      assert.equal(
        f.events.at(-1)?.type,
        goal === "complete" ? "completed" : "failed",
      );
      assert.equal(
        f.events.at(-1)?.taskNotSubmitted,
        ["no-model", "rejected"].includes(goal) ? true : undefined,
      );
    } finally {
      await f.close();
    }
  }
});
