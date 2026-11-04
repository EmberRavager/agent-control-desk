import { conversationMessages } from "../packages/contracts/completion.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  WeChatClient,
  wechatBase,
  type WeChatLogin,
  type Incoming,
} from "../packages/core/wechat/client.js";
import { startServer } from "../packages/core/server.js";
import type { Message, StartRun } from "../packages/contracts/index.js";
const until = async (fn: () => boolean) => {
  for (let n = 0; n < 150; n++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("WeChat fixture did not settle");
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
function fixture() {
  let saved: WeChatLogin | null = null,
    gets = 0,
    clears = 0,
    failSends = false,
    includeServerId = true,
    omitEmptyList = false,
    failQr = false,
    expired = false,
    requireCode = false;
  const calls: { path: string; body: any; headers: Headers }[] = [],
    sent: any[] = [];
  let batches: Incoming[][] = [],
    wake: (() => void) | undefined;
  const vault = {
    get: async () => {
      gets++;
      return saved;
    },
    set: async (value: WeChatLogin) => {
      saved = structuredClone(value);
    },
    clear: async () => {
      clears++;
      saved = null;
    },
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      path = url.pathname.split("/").pop()!,
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body, headers: new Headers(init?.headers) });
    if (path === "get_bot_qrcode" && failQr) throw Error("fixture outage");
    if (path === "get_bot_qrcode")
      return json({
        qrcode: "fixture-qr",
        qrcode_img_content: "https://weixin.qq.com/fixture-scan",
      });
    if (
      path === "get_qrcode_status" &&
      requireCode &&
      url.searchParams.get("verify_code") !== "012345"
    )
      return json({ status: "need_verifycode" });
    if (path === "get_qrcode_status")
      return json({
        status: "confirmed",
        bot_token: "WECHAT_FIXTURE_TOKEN",
        ilink_bot_id: "fixture-bot",
        ilink_user_id: "fixture-owner-private",
        baseurl: "https://ilinkai.weixin.qq.com",
      });
    if (path === "getupdates") {
      if (expired) return json({ ret: -14, errmsg: "secret-response-body" });
      if (!batches.length)
        await new Promise<void>((resolve, reject) => {
          const signal = init!.signal!;
          const done = () => {
            wake = undefined;
            signal.removeEventListener("abort", abort);
            resolve();
          };
          const abort = () => {
            wake = undefined;
            signal.removeEventListener("abort", abort);
            reject(Error("fixture cancelled"));
          };
          wake = done;
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      const messages = batches.shift() || [];
      return json({
        ret: 0,
        ...(messages.length || !omitEmptyList ? { msgs: messages } : {}),
        get_updates_buf: "cursor-" + calls.length,
      });
    }
    if (path === "notifystart" || path === "notifystop")
      return json({ ret: 0 });
    if (path === "sendmessage") {
      sent.push(body);
      if (failSends) throw Error("WECHAT_FIXTURE_TOKEN network error");
      return json({
        ret: 0,
        ...(includeServerId ? { message_id: String(sent.length) } : {}),
      });
    }
    throw Error("Unexpected fixture request");
  };
  return {
    vault,
    client: new WeChatClient(fetcher),
    calls,
    sent,
    get saved() {
      return saved;
    },
    get gets() {
      return gets;
    },
    get clears() {
      return clears;
    },
    push(...messages: Incoming[]) {
      batches.push(messages);
      wake?.();
    },
    failQr() {
      failQr = true;
    },
    omitEmptyList() {
      omitEmptyList = true;
    },
    omitServerId() {
      includeServerId = false;
    },
    fail(value: boolean) {
      failSends = value;
    },
    requirePhoneCode() {
      requireCode = true;
    },
    expire() {
      expired = true;
      wake?.();
    },
  };
}
const ownerMessage = (id: number, text: string): Incoming => ({
  message_id: id,
  from_user_id: "fixture-owner-private",
  to_user_id: "fixture-bot",
  message_type: 1,
  message_state: 2,
  context_token: "WECHAT_FIXTURE_CONTEXT",
  item_list: [{ type: 1, text_item: { text } }],
});
async function appFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "acd-wechat-"))),
    f = fixture(),
    runs: StartRun[] = [];
  const app = await startServer({
    directory,
    port: 0,
    wechat: { vault: f.vault, client: f.client },
    deps: {
      scan: async () => [],
      vault: {
        get: async () => {
          throw Error("No supervisor credential access");
        },
        set: async () => {},
      },
      route: async (_c, _key, _s, text, cwd) => ({
        reply: "",
        actions: [
          { type: "create", title: text, goal: text, cwd, agentId: "fake" },
        ],
      }),
      adapter: () => ({
        start: async (input) => {
          runs.push(input);
          return {
            steer: async () => {},
            stop: async () => input.onEvent({ type: "cancelled" }),
            answer: async () =>
              input.onEvent({ type: "completed", text: "模拟授权后完成" }),
            dispose() {},
          };
        },
      }),
    },
  });
  app.runtime.store.put("settings", "model", {
    providerId: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "fixture",
    hasKey: false,
  });
  app.runtime.store.put("agents", "fake", {
    id: "fake",
    kind: "codex",
    name: "Fixture",
    executable: "/not-executed",
    selected: true,
    available: true,
    capabilities: { steer: true, resume: true },
  });
  const headers = {
    Authorization: "Bearer " + app.descriptor.token,
    "Content-Type": "application/json",
  };
  return {
    app,
    f,
    runs,
    directory,
    headers,
    async close() {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test("WeChat client uses Tencent QR POST, authenticated send context, and bounded safe HTTPS origins", async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  await f.client.qr(signal);
  assert.deepEqual(f.calls[0].body, { local_token_list: [] });
  assert.equal(f.calls[0].headers.get("Authorization"), null);
  await f.client.send(
    {
      token: "fixture-key",
      baseUrl: wechatBase(),
      ownerId: "owner",
      botId: "bot",
      contextToken: "context",
    },
    "client-id",
    "你好",
    signal,
  );
  assert.equal(f.sent[0].msg.context_token, "context");
  assert.equal(f.sent[0].msg.item_list[0].text_item.text, "你好");
  assert.equal(
    f.calls.at(-1)!.headers.get("Authorization"),
    "Bearer fixture-key",
  );
  assert.equal(f.sent[0].base_info.bot_agent, "AgentControlDesk/0.1.0");
  for (const url of [
    "http://ilinkai.weixin.qq.com",
    "https://weixin.qq.com.attacker.example",
    "https://user:pass@ilinkai.weixin.qq.com",
    "https://ilinkai.weixin.qq.com/path",
    "https://ilinkai.weixin.qq.com?key=secret",
  ])
    assert.throws(() => wechatBase(url));
});
test("WeChat parser preserves fragmented Chinese, rejects oversized bodies and never echoes remote errors", async () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ qrcode: "q", qrcode_img_content: "中文二维码" }),
  );
  const client = new WeChatClient(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes)
              controller.enqueue(new Uint8Array([byte]));
            controller.close();
          },
        }),
      ),
  );
  assert.equal(
    (await client.qr(new AbortController().signal)).qrcode_img_content,
    "中文二维码",
  );
  const big = new WeChatClient(
    async () => new Response("x".repeat(1024 * 1024 + 1)),
  );
  await assert.rejects(big.qr(new AbortController().signal), /上限/);
  const bad = new WeChatClient(async () =>
    json({ ret: -14, errmsg: "private-token-body" }),
  );
  await assert.rejects(
    bad.qr(new AbortController().signal),
    (error) =>
      error instanceof Error && !error.message.includes("private-token-body"),
  );
});
test("WeChat API requires local auth, unconfigured startup never reads credentials, login exposes no secrets", async () => {
  const x = await appFixture();
  try {
    assert.equal(x.f.gets, 0);
    assert.equal(
      (await fetch(x.app.descriptor.url + "/api/wechat")).status,
      401,
    );
    assert.equal(
      (
        await fetch(x.app.descriptor.url + "/api/wechat", {
          headers: { ...x.headers, Origin: "https://outside.example" },
        })
      ).status,
      403,
    );
    const response = await fetch(x.app.descriptor.url + "/api/wechat/login", {
      method: "POST",
      headers: x.headers,
      body: JSON.stringify({ cwd: x.directory, notifications: true }),
    });
    assert.equal(response.status, 200);
    await until(() => Boolean(x.f.saved));
    const status = await fetch(x.app.descriptor.url + "/api/wechat", {
      headers: x.headers,
    }).then((r) => r.text());
    assert.ok(!status.includes("WECHAT_FIXTURE_TOKEN"));
    assert.ok(!status.includes("fixture-owner-private"));
    assert.ok(
      !readFileSync(join(x.directory, "state.sqlite")).includes(
        Buffer.from("WECHAT_FIXTURE_TOKEN"),
      ),
    );
    await x.app.wechat.disconnect();
    assert.equal(x.f.clears, 1);
    assert.equal(x.app.wechat.status().state, "disconnected");
  } finally {
    await x.close();
  }
});
test("only the paired private sender controls shared tasks; duplicate input, groups and other users never start work", async () => {
  const x = await appFixture();
  try {
    await x.app.wechat.begin(x.directory, true);
    await until(() => Boolean(x.f.saved));
    const own = ownerMessage(1, "只检查示例项目");
    x.f.push(
      { ...own, message_id: 2, from_user_id: "stranger" },
      { ...own, message_id: 3, group_id: "group" },
      own,
      own,
    );
    await until(() => x.runs.length === 1 && x.f.sent.length > 0);
    assert.equal(x.runs[0].task.cwd, x.directory);
    assert.equal(
      x.app.runtime.snapshot().messages.filter((m) => m.role === "user").length,
      1,
    );
    assert.equal(x.f.saved!.contextToken, "WECHAT_FIXTURE_CONTEXT");
    const id = x.runs[0].task.id;
    x.runs[0].onEvent({ type: "completed", text: "合成项目已检查" });
    await until(() => x.app.runtime.snapshot().tasks[0].status === "review");
    x.f.push(ownerMessage(4, "/完成 " + id));
    await until(() => x.app.runtime.snapshot().tasks[0].status === "completed");
    x.f.push(ownerMessage(5, "/状态"));
    await until(() =>
      x.f.sent.some((m) =>
        m.msg.item_list[0].text_item.text.includes("已完成"),
      ),
    );
    assert.equal(x.runs.length, 1);
    assert.ok(
      !readFileSync(join(x.directory, "conversation.jsonl"), "utf8").includes(
        "WECHAT_FIXTURE_CONTEXT",
      ),
    );
  } finally {
    await x.close();
  }
});
test("WeChat answers exact native approvals and stop uses the existing task lifecycle", async () => {
  const x = await appFixture();
  try {
    await x.app.wechat.begin(x.directory, true);
    await until(() => Boolean(x.f.saved));
    x.f.push(ownerMessage(10, "等待批准"));
    await until(() => x.runs.length === 1);
    const run = x.runs[0];
    run.onEvent({
      type: "question",
      text: "允许读取示例文件？",
      requestId: 7,
      choices: ["accept", "decline"],
    });
    await until(() => x.app.runtime.snapshot().questions.length === 1);
    const q = x.app.runtime.snapshot().questions[0];
    x.f.push(ownerMessage(11, "/回答 " + q.id + " 随便执行"));
    await until(
      () =>
        x.app.runtime.store.list<{ state: string }>("wechat-inbox").length >= 2,
    );
    assert.equal(x.app.runtime.snapshot().questions[0].resolved, false);
    x.f.push(ownerMessage(12, "/回答 " + q.id + " accept"));
    await until(() => x.app.runtime.snapshot().tasks[0].status === "review");
    x.f.push(ownerMessage(13, "另一项等待任务"));
    await until(() => x.runs.length === 2);
    x.f.push(ownerMessage(14, "/停止 " + x.runs[1].task.id));
    await until(() => x.app.runtime.snapshot().tasks[1].status === "cancelled");
  } finally {
    await x.close();
  }
});
test("uncertain WeChat sends are retained and never automatically replayed across pause and resume", async () => {
  const x = await appFixture();
  try {
    await x.app.wechat.begin(x.directory, false);
    await until(() => Boolean(x.f.saved));
    x.f.fail(true);
    x.f.push(ownerMessage(20, "/帮助"));
    await until(() => x.app.wechat.status().uncertainDeliveries === 1);
    const before = x.f.sent.length;
    assert.equal(before, 1);
    await x.app.wechat.setPaused();
    x.f.fail(false);
    await x.app.wechat.resume();
    x.f.push(ownerMessage(21, "/状态"));
    await until(() => x.f.sent.length === 2);
    assert.equal(x.app.wechat.status().uncertainDeliveries, 1);
    assert.equal(
      x.f.sent.filter((m) =>
        m.msg.item_list[0].text_item.text.includes("直接发文字"),
      ).length,
      1,
    );
  } finally {
    await x.close();
  }
});
test("interrupted inbound operations are marked unknown on restart and not executed twice", async () => {
  const x = await appFixture();
  try {
    await x.app.wechat.begin(x.directory, false);
    await until(() => Boolean(x.f.saved));
    await x.app.wechat.setPaused();
    const cfg = x.app.runtime.store.get<{ binding: string }>(
      "settings",
      "wechat",
    )!;
    const id =
      cfg.binding + ":in:" + createHash("sha256").update("30").digest("hex");
    x.app.runtime.store.put("wechat-inbox", id, { id, state: "processing" });
    await x.app.wechat.init();
    await x.app.wechat.resume();
    x.f.push(ownerMessage(30, "不要重放这项任务"));
    x.f.push(ownerMessage(31, "/状态"));
    await until(() => x.f.sent.length > 0);
    assert.equal(x.runs.length, 0);
    assert.equal(
      x.app.runtime.store.get<{ state: string }>("wechat-inbox", id)!.state,
      "unknown",
    );
  } finally {
    await x.close();
  }
});

test("oversized inbound batches pause before any work or cursor advance", async () => {
  const x = await appFixture();
  try {
    await x.app.wechat.begin(x.directory, true);
    await until(() => Boolean(x.f.saved));
    x.f.push(
      ...Array.from({ length: 101 }, (_, n) =>
        ownerMessage(100 + n, "不要批量执行"),
      ),
    );
    await until(() => x.app.wechat.status().state === "error");
    assert.equal(x.runs.length, 0);
    assert.match(x.app.wechat.status().error!, /100/);
    assert.equal(x.app.runtime.store.list("wechat-cursor").length, 0);
  } finally {
    await x.close();
  }
});

test("expired sessions stop polling and require explicit reauthentication", async () => {
  const x = await appFixture();
  try {
    x.f.expire();
    await x.app.wechat.begin(x.directory, true);
    await until(() => x.app.wechat.status().state === "expired");
    const count = x.f.calls.filter((c) => c.path === "getupdates").length;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(
      x.f.calls.filter((c) => c.path === "getupdates").length,
      count,
    );
    assert.ok(!x.app.wechat.status().error?.includes("secret-response-body"));
  } finally {
    await x.close();
  }
});

test("phone verification stays pending until the user supplies the exact code", async () => {
  const x = await appFixture();
  try {
    x.f.requirePhoneCode();
    await x.app.wechat.begin(x.directory, true);
    await until(() => x.app.wechat.status().state === "need_code");
    assert.equal(x.f.saved, null);
    assert.throws(() => x.app.wechat.verify("not-code"), /验证码/);
    x.app.wechat.verify("012345");
    await until(() => Boolean(x.f.saved));
    assert.equal(x.f.saved!.ownerId, "fixture-owner-private");
    assert.ok(!JSON.stringify(x.app.wechat.status()).includes("012345"));
  } finally {
    await x.close();
  }
});

test("WeChat presets a private workspace, creates it on first use, and preserves a chosen directory", async () => {
  const x = await appFixture();
  try {
    const initial = await fetch(x.app.descriptor.url + "/api/wechat", {
      headers: x.headers,
    }).then((response) => response.json());
    const workspace = join(x.directory, "workspace");
    assert.equal(initial.cwd, workspace);
    assert.equal(existsSync(workspace), false);
    assert.equal(x.f.gets, 0);
    const response = await fetch(x.app.descriptor.url + "/api/wechat/login", {
      method: "POST",
      headers: x.headers,
      body: JSON.stringify({ cwd: initial.cwd, notifications: true }),
    });
    assert.equal(response.status, 200);
    await until(() => Boolean(x.f.saved));
    assert.ok(statSync(workspace).isDirectory());
    assert.equal(x.app.wechat.status().cwd, realpathSync(workspace));
    assert.equal(
      x.app.runtime.store.get<{ cwd: string }>("settings", "wechat")?.cwd,
      realpathSync(workspace),
    );
    await x.app.wechat.configure(x.directory, false);
    assert.equal(x.app.wechat.status().cwd, x.directory);
    await x.app.wechat.disconnect();
    assert.equal(x.app.wechat.status().cwd, x.directory);
  } finally {
    await x.close();
  }
});

test("local completion reports and recommendations never enter the generic WeChat reply sync", async () => {
  const x = await appFixture();
  try {
    await x.app.wechat.begin(x.directory, true);
    await until(() => Boolean(x.f.saved));
    x.f.push(ownerMessage(1, "/状态"));
    await until(() => x.f.sent.length > 0);
    x.app.runtime.store.message({
      id: "fixture-completion",
      role: "assistant",
      text: "PRIVATE_LOCAL_REPORT_BODY",
      taskIds: [],
      createdAt: new Date().toISOString(),
      completion: {
        id: "a".repeat(64),
        title: "合成任务",
        status: "ready",
        summary: "PRIVATE_LOCAL_REPORT_BODY",
        suggestions: ["PRIVATE_LOCAL_ADVICE"],
      },
    });
    x.app.runtime.store.message({
      id: "fixture-safe-reply",
      role: "assistant",
      text: "PUBLIC_SYNC_MARKER",
      taskIds: [],
      createdAt: new Date().toISOString(),
    });
    x.app.runtime.publish();
    await until(() =>
      x.f.sent.some((m) => JSON.stringify(m).includes("PUBLIC_SYNC_MARKER")),
    );
    assert.ok(!JSON.stringify(x.f.sent).includes("PRIVATE_LOCAL_"));
  } finally {
    await x.close();
  }
});

test("explicit WeChat test requires an inbound context and reports actual submission without enabling private feedback", async () => {
  const x = await appFixture();
  try {
    await x.app.wechat.begin(x.directory, false);
    await until(() => Boolean(x.f.saved));
    x.f.push();
    await until(() => x.app.wechat.status().state === "connected");
    await assert.rejects(x.app.wechat.testMessage(), /先在微信发送/);
    x.f.push(ownerMessage(91, "/帮助"));
    await until(() => x.f.sent.length === 1);
    const response = await fetch(x.app.descriptor.url + "/api/wechat/test", {
      method: "POST",
      headers: x.headers,
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.equal(x.f.sent.length, 2);
    assert.match(x.f.sent[1].msg.item_list[0].text_item.text, /ACD 测试消息/);
    assert.equal(x.app.wechat.status().notifications, false);
    assert.ok(x.app.wechat.status().lastReceivedAt);
    assert.ok(x.app.wechat.status().lastSubmittedAt);
    assert.equal(x.runs.length, 0);
    assert.equal(x.app.wechat.status().lastSubmissionHasMessageId, true);
    x.f.omitServerId();
    await assert.rejects(x.app.wechat.testMessage(), /未返回消息编号/);
    assert.equal(x.app.wechat.status().lastSubmissionHasMessageId, false);
    x.f.fail(true);
    await assert.rejects(x.app.wechat.testMessage(), /待核对/);
    assert.equal(x.app.wechat.status().uncertainDeliveries, 1);
    assert.equal(x.f.sent.length, 4);
  } finally {
    await x.close();
  }
});

test("turning off desktop forwarding still replies to concurrent WeChat requests and keeps desktop replies private", async () => {
  const x = await appFixture();
  x.app.runtime.deps.route = async (_c, _k, _s, text) => {
    if (text === "微信提问") await new Promise((r) => setTimeout(r, 30));
    return { reply: "答复：" + text, actions: [] };
  };
  try {
    await x.app.wechat.begin(x.directory, false);
    await until(() => Boolean(x.f.saved));
    x.f.push(ownerMessage(110, "微信提问"));
    await until(() =>
      x.app.runtime.snapshot().messages.some((m) => m.role === "user"),
    );
    x.app.runtime.receive("桌面私密问题", x.directory);
    await until(() =>
      x.f.sent.some((m) =>
        m.msg.item_list[0].text_item.text.includes("答复：微信提问"),
      ),
    );
    assert.ok(
      !x.f.sent.some((m) =>
        m.msg.item_list[0].text_item.text.includes("桌面私密问题"),
      ),
    );
    const reply = x.app.runtime
      .snapshot()
      .messages.find((m) => m.text === "答复：微信提问")!;
    assert.equal(
      x.app.runtime.store.getMessage(reply.replyTo!)!.text,
      "微信提问",
    );
    assert.equal(x.app.wechat.status().notifications, false);
  } finally {
    await x.close();
  }
});
test("WeChat-origin task results return with desktop forwarding off", async () => {
  const x = await appFixture();
  try {
    await x.app.wechat.begin(x.directory, false);
    await until(() => Boolean(x.f.saved));
    x.f.push(ownerMessage(111, "只做微信测试任务"));
    await until(() => x.runs.length === 1);
    assert.ok(x.runs[0].task.sourceMessageId);
    x.runs[0].onEvent({ type: "completed", text: "微信测试任务的产出" });
    await until(() =>
      x.f.sent.some((m) =>
        m.msg.item_list[0].text_item.text.includes("微信测试任务的产出"),
      ),
    );
    assert.equal(x.app.wechat.status().notifications, false);
  } finally {
    await x.close();
  }
});
test("Tencent success response without ret is accepted, explicit errors remain failures", async () => {
  const login = {
    token: "fixture",
    baseUrl: wechatBase(),
    ownerId: "fixture",
    botId: "fixture",
    contextToken: "fixture",
  };
  await new WeChatClient(async () => json({ errcode: 0 })).send(
    login,
    "fixture",
    "test",
    new AbortController().signal,
  );
  await assert.rejects(
    new WeChatClient(async () => json({ errcode: 123 })).send(
      login,
      "fixture",
      "test",
      new AbortController().signal,
    ),
  );
});

test("completion report forwarding is opt-in, future-only, and deduplicates ready updates", async () => {
  const x = await appFixture();
  const message = (id: string) => ({
    id,
    role: "assistant" as const,
    text: "结果摘要与建议：" + id,
    taskIds: [],
    createdAt: new Date().toISOString(),
    completion: {
      id,
      title: "测试报告",
      status: "ready" as const,
      summary: "测试摘要 " + id,
      assessed: true,
      agentName: "Codex",
      nativeId: "fixture-thread",
      suggestions: ["检查产物"],
    },
  });
  try {
    await x.app.wechat.begin(x.directory, false);
    await until(() => Boolean(x.f.saved));
    x.f.push(ownerMessage(121, "/帮助"));
    await until(() => x.f.sent.length === 1);
    x.app.runtime.store.message(message("past-report"));
    x.app.runtime.publish();
    await x.app.wechat.configure(x.directory, false, true);
    x.app.runtime.publish();
    assert.equal(x.f.sent.length, 1);
    x.app.runtime.store.message(message("new-report"));
    x.app.runtime.publish();
    await until(() =>
      x.f.sent.some((m) =>
        m.msg.item_list[0].text_item.text.includes("new-report"),
      ),
    );
    const snapshot = x.app.runtime.snapshot();
    const visible = conversationMessages(snapshot.messages, snapshot).find(
      (m) => m.id === "new-report",
    );
    assert.equal(
      visible?.text,
      "Codex 已返回「测试报告」的结果，总控判定已交付。\n测试摘要 new-report",
    );
    assert.ok(
      x.f.sent.some((m) => m.msg.item_list[0].text_item.text === visible?.text),
    );
    for (let n = 0; n < 5; n++) x.app.runtime.publish();
    assert.equal(
      x.f.sent.filter((m) =>
        m.msg.item_list[0].text_item.text.includes("new-report"),
      ).length,
      1,
    );
    assert.ok(
      !x.f.sent.some((m) =>
        m.msg.item_list[0].text_item.text.includes("past-report"),
      ),
    );
  } finally {
    await x.close();
  }
});

test("uint64 message identifiers retain exact distinct values without rewriting text fields", async () => {
  const client = new WeChatClient(
    async () =>
      new Response(
        '{"ret":0,"msgs":[{"message_id":18446744073709551001},{"message_id":18446744073709551002}],"note":"message_id: 18446744073709551003"}',
      ),
  );
  const data = await client.updates(
    {
      token: "fixture",
      baseUrl: wechatBase(),
      ownerId: "fixture",
      botId: "fixture",
    },
    "",
    new AbortController().signal,
  );
  assert.equal(data.msgs[0].message_id, "18446744073709551001");
  assert.equal(data.msgs[1].message_id, "18446744073709551002");
  assert.equal(data.note, "message_id: 18446744073709551003");
});
test("channel resume registers with Tencent and explicit report lookup returns one current report", async () => {
  const x = await appFixture();
  try {
    await x.app.wechat.begin(x.directory, false);
    await until(() => x.f.calls.some((c) => c.path === "notifystart"));
    x.app.runtime.store.message({
      id: "report-lookup",
      role: "assistant",
      text: "最新报告与建议",
      taskIds: [],
      createdAt: new Date().toISOString(),
      completion: {
        id: "lookup",
        title: "测试报告",
        status: "ready",
        summary: "完成",
        suggestions: ["检查"],
      },
    });
    x.f.push(ownerMessage(131, "/报告"));
    await until(() =>
      x.f.sent.some(
        (m) => m.msg.item_list[0].text_item.text === "最新报告与建议",
      ),
    );
    await x.app.wechat.setPaused();
    assert.ok(x.f.calls.some((c) => c.path === "notifystop"));
    await x.app.wechat.resume();
    await until(
      () => x.f.calls.filter((c) => c.path === "notifystart").length === 2,
    );
  } finally {
    await x.close();
  }
});

function publishReport(x: Awaited<ReturnType<typeof appFixture>>, id: string) {
  x.app.runtime.store.message({
    id,
    role: "assistant",
    text: id,
    taskIds: [],
    createdAt: new Date().toISOString(),
    completion: {
      id,
      title: id,
      status: "ready",
      summary: id,
      suggestions: [],
    },
  });
  x.app.runtime.publish();
}
test("a report completed during pause survives resume exactly once", async () => {
  const x = await appFixture();
  try {
    await x.app.wechat.begin(x.directory, false, true);
    await until(() => Boolean(x.f.saved));
    x.f.push(ownerMessage(201, "/帮助"));
    await until(() => x.f.sent.length === 1);
    await x.app.wechat.setPaused();
    publishReport(x, "paused-result");
    assert.equal(x.f.sent.length, 1);
    await x.app.wechat.resume();
    x.f.push();
    await until(() =>
      x.f.sent.some(
        (m) => m.msg.item_list[0].text_item.text === "paused-result",
      ),
    );
    await x.app.wechat.setPaused();
    await x.app.wechat.resume();
    x.f.push(ownerMessage(202, "/帮助"));
    await until(() => x.f.sent.length >= 3);
    assert.equal(
      x.f.sent.filter(
        (m) => m.msg.item_list[0].text_item.text === "paused-result",
      ).length,
      1,
    );
  } finally {
    await x.close();
  }
});
test("a pending report that ages out before opt-in is delivered once when ready, including after restart", async () => {
  const x = await appFixture();
  const pending: Message = {
    id: "archived-report",
    role: "assistant",
    createdAt: new Date().toISOString(),
    text: "pending",
    taskIds: [],
    completion: { id: "archived", title: "Archived", status: "pending" },
  };
  try {
    await x.app.wechat.begin(x.directory, false);
    await until(() => Boolean(x.f.saved));
    publishReport(x, "past-before-opt-in");
    x.app.runtime.store.message(pending);
    for (let n = 0; n < 205; n++)
      x.app.runtime.store.message({
        ...pending,
        id: "filler-" + n,
        role: "user",
        completion: undefined,
      });
    assert.ok(!x.app.runtime.snapshot().messages.some((m) => m.completion));
    await x.app.wechat.configure(x.directory, false, true);
    // Persist the result without publishing. The process dies before projection.
    x.app.runtime.store.message({
      ...pending,
      text: "delivered-after-window",
      completion: { ...pending.completion!, status: "ready" },
    });
    await x.app.close();
    const next = await startServer({
      directory: x.directory,
      port: 0,
      deps: x.app.runtime.deps,
      wechat: { vault: x.f.vault, client: x.f.client },
    });
    try {
      x.f.push(ownerMessage(301, "/帮助"));
      await until(() =>
        x.f.sent.some((m) =>
          m.msg.item_list[0].text_item.text.includes("直接发文字"),
        ),
      );
      for (let n = 0; n < 3; n++) next.runtime.publish();
      await next.wechat.setPaused();
      assert.deepEqual(
        x.f.sent
          .map((m) => m.msg.item_list[0].text_item.text)
          .filter((t) => !t.includes("直接发文字")),
        ["delivered-after-window"],
      );
      await next.wechat.resume();
      x.f.push(ownerMessage(302, "/报告"));
      await until(() => x.f.sent.length >= 3);
      assert.equal(
        x.f.sent.at(-1).msg.item_list[0].text_item.text,
        "delivered-after-window",
      );
    } finally {
      await next.close();
    }
  } finally {
    await x.close();
  }
});
test("disabling then reenabling report forwarding revokes unsent items even before first inbound", async () => {
  const x = await appFixture();
  try {
    await x.app.wechat.begin(x.directory, false, true);
    await until(() => Boolean(x.f.saved));
    publishReport(x, "revoked-report");
    await x.app.wechat.configure(x.directory, false, false);
    await x.app.wechat.configure(x.directory, false, true);
    x.f.push(ownerMessage(203, "/帮助"));
    await until(() =>
      x.f.sent.some((m) =>
        m.msg.item_list[0].text_item.text.includes("直接发文字"),
      ),
    );
    assert.ok(
      !x.f.sent.some(
        (m) => m.msg.item_list[0].text_item.text === "revoked-report",
      ),
    );
  } finally {
    await x.close();
  }
});
test("upgrade of a legacy report subscriber does not forward unobserved old history or hidden native reports", async () => {
  const x = await appFixture();
  try {
    await x.app.wechat.begin(x.directory, false);
    await until(() => Boolean(x.f.saved));
    publishReport(x, "older-than-legacy-window");
    const store = x.app.runtime.store;
    const seed = store.getMessage("older-than-legacy-window")!;
    for (let n = 0; n < 205; n++)
      store.message({ ...seed, completion: undefined, id: "filler-" + n });
    store.message({
      ...seed,
      id: "internal-report",
      completion: {
        ...seed.completion!,
        id: "internal",
        nativeId: "native-internal",
      },
    });
    store.put("native-executions", "native-internal", {
      id: "native-internal",
      ignored: true,
    });
    // Old versions stored individual observed keys but no durable ready cursor.
    const config = store.get<{ binding: string }>("settings", "wechat")!;
    store.message({
      ...seed,
      id: "visible-history",
      text: "visible-history",
      completion: {
        ...seed.completion!,
        id: "visible-history",
      },
    });
    const pendingId = config.binding + ":completion:authorized-before-upgrade";
    store.put("wechat-outbox", pendingId, {
      id: pendingId,
      binding: config.binding,
      text: "authorized-before-upgrade",
      scope: "report",
      state: "pending",
      createdAt: seed.createdAt,
    });
    store.put("settings", "wechat", { ...config, completionReports: true });
    store.remove("wechat-report-cursors", config.binding);
    await x.app.close();
    const next = await startServer({
      directory: x.directory,
      port: 0,
      deps: x.app.runtime.deps,
      wechat: { vault: x.f.vault, client: x.f.client },
    });
    try {
      x.f.push(ownerMessage(310, "/帮助"));
      await until(() => x.f.sent.length > 0);
      next.runtime.store.message({
        ...seed,
        id: "fresh",
        text: "fresh",
        completion: { ...seed.completion!, id: "fresh" },
      });
      next.runtime.publish();
      await until(() =>
        x.f.sent.some((m) => m.msg.item_list[0].text_item.text === "fresh"),
      );
      await next.wechat.setPaused();
      assert.deepEqual(
        x.f.sent
          .map((m) => m.msg.item_list[0].text_item.text)
          .filter((body) => !body.includes("直接发文字"))
          .sort(),
        ["authorized-before-upgrade", "fresh"],
      );
    } finally {
      await next.close();
    }
  } finally {
    await x.close();
  }
});
test("duplicate inbound replay does not replace the latest context in the vault", async () => {
  const x = await appFixture();
  try {
    await x.app.wechat.begin(x.directory, false);
    await until(() => Boolean(x.f.saved));
    const old = { ...ownerMessage(204, "/帮助"), context_token: "first" };
    const fresh = { ...ownerMessage(205, "/帮助"), context_token: "second" };
    x.f.push(old, fresh, old);
    await until(() => x.f.sent.length === 2);
    assert.equal(x.f.saved?.contextToken, "second");
    assert.equal(x.f.sent[0].msg.context_token, "first");
    assert.equal(x.f.sent[1].msg.context_token, "second");
  } finally {
    await x.close();
  }
});
test("failed re-pairing preserves previously authorized binding, directory and subscriptions", async () => {
  const x = await appFixture();
  try {
    await x.app.wechat.begin(x.directory, false, true);
    await until(() => Boolean(x.f.saved));
    const original = x.f.saved;
    x.f.failQr();
    await assert.rejects(x.app.wechat.begin(x.directory, true, false));
    await x.app.wechat.resume();
    assert.equal(x.app.wechat.status().notifications, false);
    assert.equal(x.app.wechat.status().completionReports, true);
    assert.deepEqual(x.f.saved, original);
    x.f.push(ownerMessage(206, "/帮助"));
    await until(() => x.f.sent.length === 1);
  } finally {
    await x.close();
  }
});
test("expired polling prevents subsequent outbound requests", async () => {
  const x = await appFixture();
  try {
    await x.app.wechat.begin(x.directory, false, true);
    await until(() => Boolean(x.f.saved));
    x.f.push(ownerMessage(207, "/帮助"));
    await until(() => x.f.sent.length === 1);
    x.f.expire();
    await until(() => x.app.wechat.status().state === "expired");
    publishReport(x, "expired-session-report");
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(x.f.sent.length, 1);
  } finally {
    await x.close();
  }
});

test("a slow reply uses its originating WeChat turn after a newer request finishes", async () => {
  const x = await appFixture();
  let release!: () => void;
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  x.app.runtime.deps.route = async (_cfg, _key, _snap, text) => {
    if (text === "first") await first;
    return { reply: "answer " + text, actions: [] };
  };
  try {
    await x.app.wechat.begin(x.directory, false);
    await until(() => Boolean(x.f.saved));
    x.f.push(
      { ...ownerMessage(220, "first"), context_token: "ctx-A" },
      { ...ownerMessage(221, "second"), context_token: "ctx-B" },
    );
    const reply = (text: string) =>
      x.f.sent.find(
        (m) => m.msg.item_list[0].text_item.text === "ACD：answer " + text,
      );
    await until(() => Boolean(reply("second")));
    release();
    await until(() => Boolean(reply("first")));
    assert.equal(reply("first").msg.context_token, "ctx-A");
    assert.equal(reply("second").msg.context_token, "ctx-B");
  } finally {
    release();
    await x.close();
  }
});
test("a saved credential from a different pairing cannot resume the previous binding", async () => {
  const x = await appFixture();
  try {
    await x.app.wechat.begin(x.directory, false);
    await until(() => Boolean(x.f.saved));
    await x.app.wechat.setPaused();
    await x.f.vault.set({ ...x.f.saved!, binding: "mismatched-binding" });
    await assert.rejects(x.app.wechat.resume(), /重新扫码/);
    assert.equal(x.f.sent.length, 0);
  } finally {
    await x.close();
  }
});

test("a successful empty poll without msgs keeps the connection ready for outbound reports", async () => {
  const x = await appFixture();
  try {
    await x.app.wechat.begin(x.directory, false, true);
    await until(() => Boolean(x.f.saved));
    x.f.push(ownerMessage(250, "/帮助"));
    await until(() => x.f.sent.length === 1);
    await x.app.wechat.setPaused();
    publishReport(x, "empty-poll-report");
    x.f.omitEmptyList();
    await x.app.wechat.resume();
    x.f.push();
    await until(() => x.f.sent.length === 2);
    assert.equal(x.app.wechat.status().state, "connected");
    assert.equal(
      x.f.sent[1].msg.item_list[0].text_item.text,
      "empty-poll-report",
    );
  } finally {
    await x.close();
  }
});
