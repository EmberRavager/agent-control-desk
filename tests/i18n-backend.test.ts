import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime, type Dependencies } from "../packages/core/runtime.js";
import { Store } from "../packages/core/store.js";
import { startServer } from "../packages/core/server.js";
const deps: Dependencies = {
  scan: async () => [],
  adapter: () => {
    throw Error("No live agents in this test");
  },
  vault: { get: async () => null, set: async () => {} },
};
test("locale defaults to Chinese, persists per data directory and publishes preferences", () => {
  const a = mkdtempSync(join(tmpdir(), "acd-locale-a-"));
  const b = mkdtempSync(join(tmpdir(), "acd-locale-b-"));
  let store = new Store(a);
  let runtime = new Runtime(store, deps);
  const otherStore = new Store(b);
  const other = new Runtime(otherStore, deps);
  try {
    assert.deepEqual(runtime.preferences(), { locale: "zh-CN" });
    let published = false;
    runtime.on("state", (state) => {
      published = state.preferences.locale === "en";
    });
    assert.deepEqual(runtime.configurePreferences({ locale: "en" }), {
      locale: "en",
    });
    assert.equal(published, true);
    assert.deepEqual(runtime.snapshot().preferences, { locale: "en" });
    assert.deepEqual(other.preferences(), { locale: "zh-CN" });
    runtime.shutdown();
    store.close();
    store = new Store(a);
    runtime = new Runtime(store, deps);
    assert.deepEqual(runtime.preferences(), { locale: "en" });
    assert.throws(() =>
      runtime.configurePreferences({ locale: "fr" } as never),
    );
  } finally {
    runtime.shutdown();
    other.shutdown();
    store.close();
    otherStore.close();
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});
test("new platform messages use English while user parameters and recorded history stay verbatim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acd-locale-messages-"));
  const store = new Store(dir);
  const runtime = new Runtime(store, deps);
  try {
    store.message({
      id: "history",
      role: "assistant",
      text: "原先的中文回执",
      createdAt: new Date().toISOString(),
      taskIds: [],
    });
    runtime.configurePreferences({ locale: "en" });
    runtime.receive("用户原话 English {title}", dir);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const messages = runtime.snapshot().messages;
    assert.equal(
      messages.find((m) => m.id === "history")?.text,
      "原先的中文回执",
    );
    assert.equal(
      messages.find((m) => m.role === "user")?.text,
      "用户原话 English {title}",
    );
    assert.ok(
      messages.some((m) => m.role === "assistant" && /configure/i.test(m.text)),
    );
    assert.equal(
      runtime.tr("收到，我让 {name} 处理", { name: "中文 Agent {x}" }),
      "Got it. I’ll ask 中文 Agent {x} to handle it",
    );
    assert.equal(
      runtime.snapshot().notifications?.items[0]?.title,
      "Controller needs attention",
    );
    runtime.configurePreferences({ locale: "zh-CN" });
    assert.equal(
      runtime.snapshot().messages.find((m) => /configure/i.test(m.text))?.text,
      messages.find((m) => /configure/i.test(m.text))?.text,
    );
  } finally {
    runtime.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("preferences HTTP endpoint is authenticated, advertises i18n and strictly validates locale", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acd-locale-http-"));
  const app = await startServer({ directory: dir, port: 0, deps });
  const url = app.descriptor.url;
  const headers = {
    Authorization: "Bearer " + app.descriptor.token,
    "Content-Type": "application/json",
  };
  try {
    assert.equal((await fetch(url + "/api/preferences")).status, 401);
    assert.equal(
      (
        await fetch(url + "/api/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: '{"locale":"en"}',
        })
      ).status,
      401,
    );
    assert.ok(
      (await (await fetch(url + "/api/health")).json()).capabilities.includes(
        "i18n",
      ),
    );
    assert.deepEqual(
      await (await fetch(url + "/api/preferences", { headers })).json(),
      { locale: "zh-CN" },
    );
    for (const body of [
      { locale: "fr" },
      { locale: "en-US" },
      { locale: "en", extra: true },
      {},
    ]) {
      assert.equal(
        (
          await fetch(url + "/api/preferences", {
            method: "PUT",
            headers,
            body: JSON.stringify(body),
          })
        ).status,
        400,
      );
      assert.equal(app.runtime.preferences().locale, "zh-CN");
    }
    const response = await fetch(url + "/api/preferences", {
      method: "PUT",
      headers,
      body: '{"locale":"en"}',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { locale: "en" });
    assert.deepEqual(
      await (await fetch(url + "/api/preferences", { headers })).json(),
      { locale: "en" },
    );
    assert.equal(
      (await (await fetch(url + "/missing", { headers })).json()).error,
      "Endpoint not found",
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("English allocation records preserve Agent names and stable selection fields", async () => {
  const { allocateAgent } = await import("../packages/core/allocation.js");
  const agent = {
    id: "fixture",
    kind: "codex" as const,
    name: "用户 Agent",
    executable: "/fake",
    selected: true,
    available: true,
    capabilities: { steer: true, resume: true },
  };
  const result = allocateAgent({
    agents: [agent],
    cwd: "/fixture",
    settings: { globalAgentId: null, projectAgentIds: {} },
    suggestedAgentId: agent.id,
    locale: "en",
  } as Parameters<typeof allocateAgent>[0]);
  assert.equal(result.allocation.source, "single-candidate");
  assert.match(result.allocation.reason, /Only one eligible Agent/);
  assert.match(result.allocation.reason, /用户 Agent/);
});
test("native platform progress and verification metadata use English without translating native titles", () => {
  const dir = mkdtempSync(join(tmpdir(), "acd-locale-native-"));
  const store = new Store(dir);
  const runtime = new Runtime(store, deps);
  try {
    store.put("agents", "native", {
      id: "native",
      kind: "codex",
      name: "原生 Agent",
      executable: "/fake",
      selected: true,
      available: true,
      capabilities: { steer: true, resume: true },
      verificationMessage: "程序可启动，账号和模型权限待真实执行验证。",
    });
    runtime.configurePreferences({ locale: "en" });
    runtime.updateObservations([
      {
        agentId: "native",
        state: "connected",
        source: "runtime-api",
        message: "已同步原生会话，仅供查看",
        sessions: [
          {
            id: "native-session",
            agentId: "native",
            sessionId: "session",
            title: "用户会话名字",
            cwd: dir,
            status: "running",
            progress: "Codex 正在执行",
            observedAt: new Date().toISOString(),
          },
        ],
      },
    ]);
    const state = runtime.snapshot();
    assert.equal(state.agents[0].name, "原生 Agent");
    assert.match(state.agents[0].verificationMessage!, /program can start/i);
    assert.equal(state.observations?.[0].sessions[0].title, "用户会话名字");
    assert.equal(
      state.observations?.[0].sessions[0].progress,
      "Codex is running",
    );
  } finally {
    runtime.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skill catalog translates only owned labels and warnings, keeping skill content verbatim", async () => {
  const { localizeSkillCatalog } = await import("../packages/core/skills.js");
  const source = {
    rootPath: "/用户/技能",
    agents: ["codex" as const],
    label: "Codex 本地技能目录",
    scope: "global" as const,
  };
  const original = {
    skills: [
      {
        id: "skill",
        name: "用户技能",
        description: "name 缺失或超过 64 字符",
        path: "/用户/技能/SKILL.md",
        directory: "/用户/技能",
        valid: false,
        warnings: ["name 缺失或超过 64 字符"],
        sources: [source],
      },
    ],
    roots: [source],
    warnings: ["已跳过技能目录之外的链接：/用户/路径{literal}"],
    scannedAt: null,
  };
  const localized = localizeSkillCatalog(original, "en");
  assert.equal(localized.skills[0].name, "用户技能");
  assert.equal(localized.skills[0].description, "name 缺失或超过 64 字符");
  assert.equal(
    localized.skills[0].warnings[0],
    "name is missing or exceeds 64 characters",
  );
  assert.equal(localized.roots[0].label, "Codex local skills directory");
  assert.equal(
    localized.warnings[0],
    "Skipped a link outside the skills directory: /用户/路径{literal}",
  );
  assert.equal(original.roots[0].label, "Codex 本地技能目录");
});
test("known platform errors are localized and unknown provider errors are never exposed", () => {
  const dir = mkdtempSync(join(tmpdir(), "acd-locale-errors-"));
  const store = new Store(dir);
  const runtime = new Runtime(store, deps);
  try {
    runtime.configurePreferences({ locale: "en" });
    assert.equal(
      runtime.userError(new Error("技能目录已变更，请重新扫描")),
      "Skills directory changed. Scan again",
    );
    assert.equal(
      runtime.userError(
        new Error("provider accidentally returned fake-sensitive-key"),
      ),
      "Action failed",
    );
    assert.equal(
      runtime.userError(
        new Error(
          "The selected Agent cannot accept this task: 用户 Agent. No other Agent was assigned.",
        ),
      ),
      "The selected Agent cannot accept this task: 用户 Agent. No other Agent was assigned.",
    );
  } finally {
    runtime.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native adapter localizes owned progress and labels while preserving question text, output, and option IDs", async () => {
  const { PiAdapter } = await import("../packages/core/adapters/pi.js");
  const { writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "acd-locale-adapter-"));
  const file = join(dir, "fake-pi.cjs");
  writeFileSync(
    file,
    String.raw`
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
require('node:readline').createInterface({input:process.stdin}).on('line', (line) => {
 const m = JSON.parse(line);
 const reply = (data={}) => send({type:'response',id:m.id,command:m.type,success:true,data});
 if(m.type==='get_state') reply({sessionId:'12345678-1234-1234-1234-123456789abc',model:{id:'fixture'},isStreaming:false,isCompacting:false});
 else if(m.type==='prompt') {
   reply({disposition:'started'}); send({type:'agent_start'});
   send({type:'auto_retry_start'});
   send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Pi 正在重试原生模型请求。'}});
   send({type:'extension_ui_request',id:'native-request',method:'confirm',title:'原生问题文字'});
 } else if(m.type==='steer') { reply(); send({type:'auto_retry_start'}); }
 else reply();
});
`,
  );
  let locale: "en" | "zh-CN" = "en";
  const events: import("../packages/contracts/index.js").AdapterEvent[] = [];
  let handle: import("../packages/contracts/index.js").RunHandle | undefined;
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 100; i++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("Fake native event did not arrive");
  };
  try {
    const adapter = new PiAdapter(
      { executable: process.execPath, args: [file] },
      1000,
      500,
      () => locale,
    );
    handle = await adapter.start({
      agent: {
        id: "fake",
        kind: "pi",
        name: "假Agent",
        executable: "/fake",
        selected: true,
        available: true,
        capabilities: { steer: true, resume: true },
      },
      task: {
        id: "task",
        title: "用户标题",
        goal: "用户要求",
        agentId: "fake",
        cwd: dir,
        status: "running",
        revision: 1,
        progress: "",
        createdAt: "now",
        updatedAt: "now",
      },
      onEvent: (event) => events.push(event),
    });
    await until(() => events.some((event) => event.type === "question"));
    assert.ok(
      events.some(
        (event) =>
          event.type === "progress" &&
          event.text === "Pi is retrying the native model request.",
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "output" && event.text === "Pi 正在重试原生模型请求。",
      ),
    );
    const question = events.find((event) => event.type === "question")!;
    assert.equal(question.text, "原生问题文字");
    assert.deepEqual(question.choices, ["accept", "decline", "cancel"]);
    assert.deepEqual(question.choiceLabels, {
      accept: "Confirm",
      decline: "Decline",
      cancel: "Cancel",
    });
    locale = "zh-CN";
    await handle.steer("用户追加原文");
    await until(() =>
      events.some(
        (event) =>
          event.type === "progress" &&
          event.text === "Pi 正在重试原生模型请求。",
      ),
    );
  } finally {
    handle?.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
