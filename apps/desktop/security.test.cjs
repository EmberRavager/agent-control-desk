const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
function harness(overrides = {}) {
  const descriptor = {
    url: "http://127.0.0.1:4317",
    token: "f".repeat(64),
    protocol: 1,
    pid: 1234,
    ...overrides,
  };
  const context = {
    __dirname,
    process: { platform: "linux", env: {} },
    URL,
    AbortSignal,
    fetch: async () => ({
      ok: true,
      json: async () => ({ protocol: 1, pid: 1234 }),
    }),
    require(name) {
      if (name === "electron")
        return { app: { requestSingleInstanceLock: () => false, quit() {} } };
      if (name === "node:fs/promises")
        return { readFile: async () => JSON.stringify(descriptor) };
      if (name === "node:child_process")
        return {
          spawn: () => {
            throw Error("Unexpected daemon spawn");
          },
        };
      if (name === "node:os") return { homedir: () => "/mock-home" };
      return require(name);
    },
  };
  vm.runInNewContext(
    source +
      "\nthis.api = { startDaemon, readDescriptor, trusted, request, rendererUrl, setWindow: value => { window = value; } };",
    context,
  );
  return context;
}
test("descriptor accepts only an explicit loopback origin and matching service process", async () => {
  const valid = harness();
  assert.equal((await valid.api.readDescriptor()).pid, 1234);
  for (const url of [
    "http://127.0.0.1:4317/other",
    "http://127.0.0.1:4317/?next=1",
    "http://127.0.0.1:4317/#fragment",
    "https://127.0.0.1:4317",
    "http://localhost:4317",
  ]) {
    await assert.rejects(harness({ url }).api.readDescriptor(), /描述无效/);
  }
  await assert.rejects(
    harness({ pid: 5678 }).api.readDescriptor(),
    /进程身份不匹配/,
  );
  await assert.rejects(harness({ pid: 1 }).api.readDescriptor(), /描述无效/);
});
test("IPC accepts only the packaged main frame, rejecting an iframe or changed document", () => {
  const context = harness();
  const frame = { url: context.api.rendererUrl };
  const contents = { mainFrame: frame };
  context.api.setWindow({ webContents: contents });
  assert.doesNotThrow(() =>
    context.api.trusted({ sender: contents, senderFrame: frame }),
  );
  assert.throws(
    () =>
      context.api.trusted({
        sender: contents,
        senderFrame: { url: "https://untrusted.example" },
      }),
    /拒绝/,
  );
  frame.url = "https://untrusted.example";
  assert.throws(
    () => context.api.trusted({ sender: contents, senderFrame: frame }),
    /拒绝/,
  );
});

test("new operations stop with an upgrade hint before posting to an older daemon", async () => {
  const context = harness();
  const calls = [];
  context.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options?.method });
    return { ok: true, json: async () => ({ protocol: 1, pid: 1234 }) };
  };
  await assert.rejects(
    context.api.request("POST", "/api/messages", {
      clientMessageId: "fixture-id",
      text: "Do work",
    }),
    /后台版本较旧/,
  );
  await assert.rejects(
    context.api.request("POST", "/api/model/models", {}),
    /后台版本较旧/,
  );
  await assert.rejects(
    context.api.request("GET", "/api/wechat"),
    /后台版本较旧/,
  );
  await assert.rejects(
    context.api.request("GET", "/api/notifications"),
    /后台版本较旧/,
  );
  await assert.rejects(
    context.api.request("POST", "/api/skills/fixture/translate", {}),
    /后台版本较旧/,
  );
  await assert.rejects(
    context.api.request("POST", "/api/observations/refresh", {}),
    /后台版本较旧/,
  );
  await assert.rejects(
    context.api.request(
      "POST",
      "/api/observations/native-" + "a".repeat(24) + "/analyze",
      {},
    ),
    /后台版本较旧/,
  );
  await assert.rejects(
    context.api.request(
      "POST",
      "/api/messages/00000000-0000-4000-8000-000000000001/retry",
      {},
    ),
    /后台版本较旧/,
  );
  assert.equal(
    calls.some((call) => call.method === "POST"),
    false,
  );
});

test("preload presents cross-realm IPC errors as actionable messages", async () => {
  let bridge;
  const context = {
    require(name) {
      assert.equal(name, "electron");
      return {
        contextBridge: {
          exposeInMainWorld(_name, value) {
            bridge = value;
          },
        },
        ipcRenderer: {
          invoke: async () => {
            throw new Error(
              "Error invoking remote method 'acd:request': Error: 请先配置总控模型",
            );
          },
        },
      };
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8"),
    context,
  );
  await assert.rejects(
    bridge.request("GET", "/api/state"),
    (error) => error.message === "请先配置总控模型",
  );
});

test("a deliberately stopped daemon is not silently relaunched by background reconnection", async () => {
  const context = harness();
  await context.api.startDaemon();
  context.fetch = async () => {
    throw Error("offline");
  };
  await assert.rejects(context.api.startDaemon(), /本地后台未运行/);
});

test("scheduled operations require the schedule capability and exact IPC routes", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const older = harness();
  await assert.rejects(
    older.api.request("POST", "/api/schedules", {}),
    /后台版本较旧/,
  );
  await assert.rejects(
    older.api.request("GET", "/api/schedules"),
    /后台版本较旧/,
  );
  const current = harness();
  const requests = [];
  current.fetch = async (url, options) => {
    requests.push({
      path: new URL(url).pathname,
      method: options?.method || "GET",
    });
    return {
      ok: true,
      json: async () => ({
        protocol: 1,
        pid: 1234,
        capabilities: ["schedules"],
      }),
    };
  };
  for (const [method, resource] of [
    ["GET", "/api/schedules"],
    ["GET", `/api/schedules/${id}/runs`],
    ["POST", "/api/schedules"],
    ["PUT", `/api/schedules/${id}`],
    ["POST", `/api/schedules/${id}/pause`],
    ["POST", `/api/schedules/${id}/resume`],
    ["POST", `/api/schedules/${id}/delete`],
  ])
    await assert.doesNotReject(
      current.api.request(method, resource, method === "GET" ? undefined : {}),
    );
  for (const [method, resource] of [
    ["POST", `/api/schedules/${id}/run`],
    ["PUT", "/api/schedules"],
    ["GET", `/api/schedules/${id}/runs?all=1`],
    ["POST", "/api/schedules/../../shutdown"],
  ])
    await assert.rejects(current.api.request(method, resource, {}), /不支持/);
  assert.equal(
    requests.filter((item) => item.path.startsWith("/api/schedules")).length,
    7,
  );
});

test("allocation requests cannot silently lose their constraints on older daemons", async () => {
  const context = harness();
  const calls = [];
  context.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options?.method });
    return {
      ok: true,
      json: async () => ({
        protocol: 1,
        pid: 1234,
        capabilities: ["message-idempotency"],
      }),
    };
  };
  for (const body of [
    { targetAgentId: "codex" },
    { requiredCapabilities: ["steer"] },
  ]) {
    await assert.rejects(
      context.api.request("POST", "/api/messages", { text: "工作", ...body }),
      /后台版本较旧/,
    );
  }
  await assert.rejects(
    context.api.request("GET", "/api/allocation"),
    /后台版本较旧/,
  );
  await assert.rejects(
    context.api.request("PUT", "/api/allocation", { agentId: null }),
    /后台版本较旧/,
  );
  assert.equal(
    calls.some((call) => ["POST", "PUT"].includes(call.method)),
    false,
  );
});

test("a single-preference daemon cannot read or save desktop rankings", async () => {
  const context = harness();
  const paths = [];
  context.fetch = async (url) => {
    paths.push(new URL(url).pathname);
    return {
      ok: true,
      json: async () => ({
        protocol: 1,
        pid: 1234,
        capabilities: ["agent-allocation"],
      }),
    };
  };
  await assert.rejects(
    context.api.request("GET", "/api/allocation"),
    /后台版本较旧/,
  );
  await assert.rejects(
    context.api.request("PUT", "/api/allocation", {
      agentIds: ["pi", "codex"],
    }),
    /后台版本较旧/,
  );
  assert.ok(!paths.includes("/api/allocation"));
});

test("allocation operations pass through the restricted bridge to capable daemons", async () => {
  const context = harness();
  const calls = [];
  context.fetch = async (url, options) => {
    calls.push({
      url: String(url),
      method: options?.method,
      body: options?.body,
    });
    return {
      ok: true,
      json: async () => ({
        protocol: 1,
        pid: 1234,
        capabilities: [
          "agent-allocation",
          "allocation-priority",
          "message-idempotency",
        ],
      }),
    };
  };
  await context.api.request("GET", "/api/allocation");
  await context.api.request("PUT", "/api/allocation", {
    agentIds: ["pi", "codex"],
  });
  assert.deepEqual(JSON.parse(calls.at(-1).body).agentIds, ["pi", "codex"]);
  await context.api.request("POST", "/api/messages", {
    text: "工作",
    clientMessageId: "fixture-id",
    targetAgentId: "codex",
    requiredCapabilities: ["steer"],
  });
  assert.equal(
    calls.filter((call) => ["POST", "PUT"].includes(call.method)).length,
    2,
  );
  assert.equal(JSON.parse(calls.at(-1).body).targetAgentId, "codex");
});

test("language preferences reject legacy services and accept only the explicit locale route", async () => {
  const legacy = harness();
  await assert.rejects(
    legacy.api.request("PUT", "/api/preferences", { locale: "en" }),
    /版本较旧/,
  );
  const supported = harness();
  const calls = [];
  supported.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return {
      ok: true,
      json: async () =>
        String(url).endsWith("/api/health")
          ? { protocol: 1, pid: 1234, capabilities: ["i18n"] }
          : { locale: "en" },
    };
  };
  const value = await supported.api.request("PUT", "/api/preferences", {
    locale: "en",
  });
  assert.equal(value.locale, "en");
  assert.equal(calls.at(-1).options.body, '{"locale":"en"}');
  await assert.rejects(
    supported.api.request("PUT", "/api/preferences/arbitrary", {
      locale: "en",
    }),
    /Unsupported client operation/,
  );
});

test("personal memory CRUD requires the declared capability and exact UUID routes", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const routes = [
    ["GET", "/api/memories"],
    ["POST", "/api/memories"],
    ["PUT", "/api/memories/" + id],
    ["POST", "/api/memories/" + id + "/delete"],
  ];
  const older = harness();
  const current = harness();
  let sent = 0;
  current.fetch = async (url, options) => {
    if (new URL(url).pathname.startsWith("/api/memories")) {
      assert.equal(options.headers.Authorization, "Bearer " + "f".repeat(64));
      sent++;
    }
    return {
      ok: true,
      json: async () => ({
        protocol: 1,
        pid: 1234,
        capabilities: ["personal-memory"],
      }),
    };
  };
  for (const [method, resource] of routes) {
    await assert.rejects(older.api.request(method, resource), /后台版本较旧/);
    await current.api.request(method, resource);
  }
  for (const [method, resource] of [
    ["DELETE", "/api/memories/" + id],
    ["PUT", "/api/memories/" + "-".repeat(36)],
    ["GET", "/api/memories?all=1"],
    ["POST", "/api/memories/" + id + "/delete/extra"],
  ])
    await assert.rejects(current.api.request(method, resource), /不支持/);
  assert.equal(sent, routes.length);
});
