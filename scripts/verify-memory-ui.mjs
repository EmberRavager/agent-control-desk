import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { PersonalMemories } from "../packages/core/personal-memory.ts";
import { startServer } from "../packages/core/server.ts";

// Run with node --import tsx. An optional argument points to an installed jsdom.
const { JSDOM } = createRequire(import.meta.url)(process.argv[2] || "jsdom");
const directory = mkdtempSync(join(tmpdir(), "acd-memory-ui-"));
const app = await startServer({
  directory,
  skillHome: directory,
  port: 0,
  deps: {
    scan: async () => [],
    vault: { get: async () => null, set: async () => {} },
    adapter: () => {
      throw Error("No external agent should run");
    },
  },
  wechat: {
    vault: {
      get: async () => null,
      set: async () => {},
      clear: async () => {},
    },
  },
});
const dom = new JSDOM('<div id="root"></div>', {
  url: "https://acd.fixture/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
const w = dom.window;
async function api(method, path, body) {
  const response = await fetch(app.descriptor.url + path, {
    method,
    headers: {
      Authorization: "Bearer " + app.descriptor.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new w.Error(data.error);
  return data;
}
async function find(selector, predicate = () => true) {
  for (let i = 0; i < 200; i++) {
    const el = [...w.document.querySelectorAll(selector)].find(
      (el) => !el.closest("[hidden]") && predicate(el),
    );
    if (el) return el;
    await delay(10);
  }
  assert.fail("Missing UI element " + selector + " " + String(predicate));
}
async function click(label) {
  const button = await find(
    "button",
    (el) =>
      (el.getAttribute("aria-label") || el.textContent.trim()) === label &&
      !el.disabled,
  ).catch(() => assert.fail("Missing enabled button: " + label));
  button.click();
  await delay(0);
}
async function fill(selector, value) {
  const field = await find(selector);
  Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(field),
    "value",
  ).set.call(field, value);
  field.dispatchEvent(
    new w.Event(field.tagName === "SELECT" ? "change" : "input", {
      bubbles: true,
    }),
  );
  await delay(0);
}
try {
  app.runtime.store.put("agents", "test-agent", {
    id: "test-agent",
    name: "测试",
    kind: "codex",
    executable: "/unused",
    selected: true,
    available: true,
    supported: true,
    capabilities: {},
  });
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.structuredClone = structuredClone;
  w.matchMedia = () => ({ matches: false });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.acd = {
    getLocalInfo: async () => ({ dataDirectory: directory }),
    subscribe: (_receive, connected) => {
      connected(true);
      return () => {};
    },
    request: api,
  };
  const { outputFiles } = await build({
    entryPoints: ["apps/desktop/renderer.tsx"],
    bundle: true,
    write: false,
    format: "iife",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  w.eval(outputFiles[0].text);
  await click("设置");
  await click("个人记忆");
  await click("添加记忆");
  await fill('#settings-memory input[name="title"]', "将取消的草稿");
  await click("取消");
  assert.deepEqual(await api("GET", "/api/memories"), []);
  await click("添加记忆");
  await fill('#settings-memory input[name="title"]', "验收流程");
  await fill(
    '#settings-memory textarea[name="content"]',
    "先核对需求。\n再运行测试。",
  );
  await fill('#settings-memory select[name="kind"]', "workflow");
  await click("保存记忆");
  const row = () =>
    find("#settings-memory li", (el) => el.textContent.includes("验收流程"));
  assert.match((await row()).textContent, /手动添加|手动维护/);
  assert.match((await row()).textContent, /0 (个|次)独立任务/);
  const [created] = await api("GET", "/api/memories");
  assert.equal(created.kind, "workflow");
  assert.equal(created.content, "先核对需求。\n再运行测试。");

  await click("编辑 验收流程");
  await fill('#settings-memory textarea[name="content"]', "保留我的草稿。");
  await api("PUT", "/api/memories/" + created.id, {
    kind: created.kind,
    title: created.title,
    content: "另一窗口已经修改。",
    expectedRevision: created.revision,
  });
  await click("保存记忆");
  await find('#settings-memory [role="alert"]');
  await click("重新加载");
  await find("#settings-memory form", (el) =>
    el.textContent.includes("另一窗口已经修改。"),
  );
  assert.equal(
    (await find("#settings-memory textarea")).value,
    "保留我的草稿。",
  );
  await click("按最新版本继续编辑");
  await click("保存记忆");
  await find("#settings-memory li", (el) =>
    el.textContent.includes("保留我的草稿。"),
  );
  const [updated] = await api("GET", "/api/memories");
  assert.equal(updated.content, "保留我的草稿。");
  assert.ok(updated.revision > created.revision);
  await click("删除 验收流程");
  await click("取消删除");
  assert.equal((await api("GET", "/api/memories")).length, 1);
  await click("删除 验收流程");
  await click("确认删除");
  await find('#settings-memory [role="status"]', (el) =>
    el.textContent.includes("已删除"),
  );
  assert.deepEqual(await api("GET", "/api/memories"), []);
  const memories = new PersonalMemories(app.runtime.store);
  memories.rememberPreference(
    { kind: "preference", title: "汇报顺序", content: "先写结论。" },
    "test-message",
  );
  const workflow = {
    activity: "核验发布",
    steps: ["检查需求", "运行验收测试"],
  };
  memories.observeWorkflow(workflow, "first-task");
  memories.observeWorkflow(workflow, "second-task");
  await click("外观");
  await click("个人记忆");
  await find(
    "#settings-memory li",
    (el) =>
      el.textContent.includes("汇报顺序") &&
      el.textContent.includes("对话中明确要求"),
  );
  await find(
    "#settings-memory li",
    (el) =>
      el.textContent.includes("核验发布") &&
      el.textContent.includes("2 个独立任务"),
  );
  console.log(
    "PASS • 设置 → 个人记忆 → 添加流程 → 并发冲突并保留草稿 → 编辑 → 取消删除 → 确认删除（JSDOM、鉴权本机 API、临时 SQLite）",
  );
} finally {
  dom.window.close();
  await app.close();
  rmSync(directory, { recursive: true, force: true });
}
