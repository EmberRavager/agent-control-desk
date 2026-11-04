import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startServer } from "../packages/core/server.js";
import { Store } from "../packages/core/store.js";
import { Runtime } from "../packages/core/runtime.js";
import {
  NativeObserver,
  readCodexSessions,
} from "../packages/core/native-observation.js";
import { launch } from "../packages/core/adapters/process.js";
import type {
  AgentConnection,
  NativeSession,
  Task,
} from "../packages/contracts/index.js";
const agent: AgentConnection = {
  id: "codex-fixture",
  kind: "codex",
  name: "Codex fixture",
  executable: "/not-executed",
  selected: true,
  available: true,
  capabilities: { steer: true, resume: true },
};
const session: NativeSession = {
  id: "native-fixture",
  agentId: agent.id,
  sessionId: "thread-fixture",
  title: "Existing native work",
  cwd: "/fixture/project",
  status: "running",
  progress: "Codex 正在执行",
  observedAt: new Date().toISOString(),
};
async function until(predicate: () => boolean) {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Fixture did not settle");
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "acd-native-observation-"));
  const store = new Store(directory);
  store.put("agents", agent.id, agent);
  store.put("settings", "model", {
    providerId: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "fixture",
    hasKey: false,
  });
  const runtime = new Runtime(store, {
    scan: async () => [],
    vault: { get: async () => null, set: async () => {} },
    adapter: () => {
      throw Error("No native execution allowed");
    },
    route: async () => ({
      reply: "There is no work",
      actions: [{ type: "status", taskIds: [session.id] }],
    }),
  });
  return {
    directory,
    store,
    runtime,
    close() {
      runtime.shutdown();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("Codex observation connects through proxy, paginates metadata, and never resumes or reads turns", async () => {
  const directory = mkdtempSync(join(tmpdir(), "acd-native-protocol-"));
  const script = join(directory, "native.cjs"),
    requests = join(directory, "requests.jsonl");
  writeFileSync(
    script,
    `
const fs=require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(requests)},JSON.stringify(m)+'\\n');
 if(m.method==='initialized')return;
 let result;
 if(m.method==='initialize')result={};
 else if(m.method==='thread/loaded/list')result=m.params.cursor?{data:['idle','notLoaded','systemError'],nextCursor:null}:{data:['active','waiting'],nextCursor:'page-2'};
 else if(m.method==='thread/read'){
  const id=m.params.threadId;
  result={thread:{id,name:'Native '+id,cwd:'/fixture/project',status:id==='waiting'?{type:'active',activeFlags:['waitingOnApproval']}:{type:id,activeFlags:[]},preview:'FAKE_PRIVATE_PREVIEW',turns:[{content:'FAKE_PRIVATE_TURN'}]}};
 }else process.exit(10);
 process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
});`,
  );
  try {
    const { sessions } = await readCodexSessions(
      agent,
      directory,
      new AbortController().signal,
      (executable, args, cwd) => {
        assert.equal(executable, agent.executable);
        assert.deepEqual(args, ["app-server", "proxy"]);
        return launch(process.execPath, [script], cwd);
      },
    );
    assert.deepEqual(
      sessions.map((item) => item.status),
      ["running", "waiting_input", "idle", "unknown", "failed"],
    );
    assert.equal(sessions[0].title, "Native active");
    assert.ok(!JSON.stringify(sessions).includes("FAKE_PRIVATE"));
    const operations = readFileSync(requests, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(
      operations.every((item) =>
        [
          "initialize",
          "initialized",
          "thread/loaded/list",
          "thread/read",
        ].includes(item.method),
      ),
    );
    assert.ok(
      operations
        .filter((item) => item.method === "thread/read")
        .every((item) => item.params.includeTurns === false),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing native control endpoint fails rather than spawning a new app server or leaking stderr", async () => {
  const directory = mkdtempSync(join(tmpdir(), "acd-native-missing-"));
  try {
    await assert.rejects(
      readCodexSessions(
        agent,
        directory,
        new AbortController().signal,
        (_exe, args, cwd) => {
          assert.deepEqual(args, ["app-server", "proxy"]);
          return launch(
            process.execPath,
            ["-e", "process.stderr.write('FAKE_SECRET_ERROR');process.exit(1)"],
            cwd,
          );
        },
      ),
      (error) =>
        error instanceof Error &&
        /控制端点/.test(error.message) &&
        !error.message.includes("FAKE_SECRET"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("observed sessions are queryable but never executable or persisted as ACD tasks, and disconnect marks them unknown", async () => {
  const x = fixture();
  let connected = true;
  const observer = new NativeObserver(x.runtime, async () => {
    if (!connected) throw Error("Fixture disconnected");
    return {
      source: "runtime-api",
      state: "connected",
      message: "Connected",
      sessions: [session],
    };
  });
  try {
    await observer.refresh();
    assert.equal(x.runtime.snapshot().observations?.[0].state, "connected");
    assert.equal(
      x.runtime.snapshot().observations?.[0].sessions[0].status,
      "running",
    );
    x.runtime.receive("查原生会话进度", x.directory, undefined, randomUUID());
    await until(() =>
      x.runtime
        .snapshot()
        .messages.some((message) => message.text.includes("原生会话（只读）")),
    );
    assert.equal(x.runtime.snapshot().tasks.length, 0);
    assert.equal(x.store.list("tasks").length, 0);
    assert.ok(
      !x.runtime
        .snapshot()
        .messages.some((message) => message.text === "There is no work"),
    );
    connected = false;
    await observer.refresh();
    const observed = x.runtime.snapshot().observations?.[0];
    assert.equal(observed?.state, "unavailable");
    assert.equal(observed?.sessions[0].status, "unknown");
    assert.equal(observed?.sessions[0].observedAt, session.observedAt);
  } finally {
    await observer.close();
    x.close();
  }
});

test("native observations exclude ACD-owned sessions and discard results for deselected agents", async () => {
  const x = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observer = new NativeObserver(x.runtime, async () => {
    await gate;
    return {
      source: "runtime-api",
      state: "connected",
      message: "Connected",
      sessions: [session],
    };
  });
  try {
    const now = new Date().toISOString();
    x.store.put("tasks", "owned", {
      id: "owned",
      title: "Owned",
      goal: "Fixture",
      agentId: agent.id,
      cwd: x.directory,
      status: "running",
      revision: 1,
      sessionId: session.sessionId,
      progress: "Done",
      createdAt: now,
      updatedAt: now,
    } satisfies Task);
    x.runtime.updateObservations([
      {
        agentId: agent.id,
        state: "connected",
        message: "Connected",
        sessions: [session],
      },
    ]);
    assert.equal(x.runtime.snapshot().observations?.[0].sessions.length, 0);
    const owned = x.store.get<Task>("tasks", "owned")!;
    x.store.put("tasks", "owned", { ...owned, status: "completed" });
    assert.equal(x.runtime.snapshot().observations?.[0].sessions.length, 1);
    const pending = observer.refresh();
    assert.equal(observer.refresh(), pending);
    x.store.put("agents", agent.id, { ...agent, selected: false });
    release();
    await pending;
    assert.equal(x.runtime.snapshot().observations?.length || 0, 0);
  } finally {
    release();
    await observer.close();
    x.close();
  }
});

test("native refresh API is authenticated, read-only, and advertises its capability", async () => {
  const directory = mkdtempSync(join(tmpdir(), "acd-native-http-"));
  let reads = 0;
  const app = await startServer({
    directory,
    port: 0,
    nativeRead: async () => {
      reads++;
      return {
        source: "runtime-api",
        state: "connected",
        message: "Connected",
        sessions: [session],
      };
    },
    deps: {
      scan: async () => [],
      vault: { get: async () => null, set: async () => {} },
      adapter: () => {
        throw Error("No execution allowed");
      },
    },
  });
  app.runtime.store.put("agents", agent.id, agent);
  const headers = {
    Authorization: "Bearer " + app.descriptor.token,
    "Content-Type": "application/json",
  };
  try {
    const health = await fetch(app.descriptor.url + "/api/health").then(
      (response) => response.json(),
    );
    assert.ok(health.capabilities.includes("native-observation"));
    const resource = app.descriptor.url + "/api/observations/refresh";
    assert.equal(
      (
        await fetch(resource, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(resource, {
          method: "POST",
          headers,
          body: JSON.stringify({ command: "unexpected" }),
        })
      ).status,
      400,
    );
    const response = await fetch(resource, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.observations[0].sessions[0].status, "running");
    assert.equal(state.tasks.length, 0);
    assert.equal(state.messages.length, 0);
    assert.equal(reads, 1);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native task titles reject stale turns, model changes, and deselected agents", () => {
  const f = fixture();
  const publish = (turnId: string) =>
    f.runtime.updateObservations([
      {
        agentId: agent.id,
        state: "connected",
        message: "Connected",
        sessions: [{ ...session, turnId }],
      },
    ]);
  try {
    publish("turn-1");
    const first = f.runtime.snapshot().observations![0].sessions[0];
    const model = f.runtime.snapshot().model;
    f.runtime.updateNativeTitle(first, model, "修复任务同步");
    assert.equal(
      f.runtime.snapshot().observations![0].sessions[0].taskTitle,
      "修复任务同步",
    );
    f.runtime.updateNativeTitle(first, model, "不随步骤刷新的另一个标题");
    assert.equal(
      f.runtime.snapshot().observations![0].sessions[0].taskTitle,
      "修复任务同步",
    );
    f.runtime.updateNativeTitle(
      first,
      model,
      "根据补充要求修正标题",
      "new-user-requirements",
    );
    assert.equal(
      f.runtime.snapshot().observations![0].sessions[0].taskTitle,
      "根据补充要求修正标题",
    );
    f.runtime.updateNativeTitle(
      first,
      model,
      "不应随执行细节改变",
      "new-user-requirements",
    );
    assert.equal(
      f.runtime.snapshot().observations![0].sessions[0].taskTitle,
      "根据补充要求修正标题",
    );
    publish("turn-2");
    f.runtime.updateNativeTitle(first, model, "迟到的旧任务标题");
    assert.equal(
      f.runtime.snapshot().observations![0].sessions[0].taskTitle,
      undefined,
    );
    const second = f.runtime.snapshot().observations![0].sessions[0];
    f.store.put("settings", "model", { ...model, model: "another-model" });
    f.runtime.updateNativeTitle(second, model, "旧模型的标题");
    assert.equal(
      f.runtime.snapshot().observations![0].sessions[0].taskTitle,
      undefined,
    );
    f.store.put("agents", agent.id, { ...agent, selected: false });
    f.runtime.updateNativeTitle(
      second,
      f.runtime.snapshot().model,
      "已取消管理的标题",
    );
    assert.equal(f.runtime.snapshot().observations!.length, 0);
    assert.equal(f.runtime.snapshot().tasks.length, 0);
  } finally {
    f.close();
  }
});
