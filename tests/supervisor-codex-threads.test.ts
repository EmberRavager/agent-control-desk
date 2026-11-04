import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../packages/core/runtime.js";
import { Store } from "../packages/core/store.js";
import { CodexAdapter } from "../packages/core/adapters/codex.js";

test("two assignments open independent Codex threads; the follow-up resumes only its own thread", async () => {
  const cwd = realpathSync(
    mkdtempSync(join(tmpdir(), "acd-two-conversations-")),
  );
  const fixture = join(cwd, "protocol.cjs");
  writeFileSync(
    fixture,
    `const {randomUUID}=require('node:crypto'),fs=require('node:fs');
  const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
  let threadId,turnId=randomUUID();
  require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
   const m=JSON.parse(line);
   if(m.method==='initialize')send({id:m.id,result:{}});
   if(m.method==='thread/start'||m.method==='thread/resume'){
    threadId=m.method==='thread/resume'?m.params.threadId:randomUUID();
    fs.appendFileSync('trace',JSON.stringify([m.method,threadId])+'\\n');
    send({id:m.id,result:{thread:{id:threadId}}});
   }
   if(m.method==='turn/start'){
    fs.appendFileSync('trace',JSON.stringify([m.method,m.params.threadId,m.params.input[0].text])+'\\n');
    send({method:'turn/started',params:{threadId,turn:{id:turnId,status:'inProgress'}}});
    send({id:m.id,result:{turn:{id:turnId}}});
    send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});
   }
  });`,
  );
  const store = new Store(join(cwd, "data"));
  store.put("agents", "codex", {
    id: "codex",
    kind: "codex",
    name: "Codex",
    selected: true,
    available: true,
    executable: "/unused",
    capabilities: { steer: true, resume: true },
  });
  store.put("settings", "model", {
    providerId: "ollama",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "fixture",
    hasKey: false,
  });
  const runtime = new Runtime(store, {
    scan: async () => [],
    vault: { get: async () => null, set: async () => {} },
    adapter: () =>
      new CodexAdapter({ executable: process.execPath, args: [fixture] }),
    route: async (_config, _key, snapshot, text, dir, target) => ({
      reply: "",
      actions: target
        ? [
            {
              type: "supplement",
              taskId: target,
              text,
              expectedRevision: snapshot.tasks.find(
                (task) => task.id === target,
              )!.revision,
            },
          ]
        : ["检查 README", "检查许可证"].map((goal) => ({
            type: "create",
            title: goal,
            goal,
            agentId: "codex",
            cwd: dir,
          })),
    }),
  });
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 250; i++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Codex fixture failed to settle");
  };
  try {
    runtime.receive("让 Codex 分别检查 README 和许可证", cwd);
    await until(
      () =>
        runtime.snapshot().tasks.filter((task) => task.status === "review")
          .length === 2,
    );
    const [a, b] = runtime.snapshot().tasks;
    assert.ok(a.sessionId);
    assert.ok(b.sessionId);
    assert.notEqual(a.sessionId, b.sessionId);
    runtime.receive("只补充许可证版本", cwd, b.id);
    await until(() =>
      runtime
        .snapshot()
        .tasks.some(
          (task) =>
            task.id === b.id && task.revision === 2 && task.status === "review",
        ),
    );
    const lines = readFileSync(join(cwd, "trace"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(lines, [
      ["thread/start", a.sessionId],
      ["turn/start", a.sessionId, "检查 README"],
      ["thread/start", b.sessionId],
      ["turn/start", b.sessionId, "检查许可证"],
      ["thread/resume", b.sessionId],
      ["turn/start", b.sessionId, "只补充许可证版本"],
    ]);
  } finally {
    runtime.shutdown();
    store.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
