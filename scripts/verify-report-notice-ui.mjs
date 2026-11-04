import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { startServer } from "../packages/core/server.ts";

// Run with node --import tsx. An optional argument points to an installed jsdom.
const { JSDOM } = createRequire(import.meta.url)(process.argv[2] || "jsdom");
const directory = mkdtempSync(join(tmpdir(), "acd-report-ui-"));
const app = await startServer({
  directory,
  port: 0,
  deps: {
    scan: async () => [],
    vault: { get: async () => null, set: async () => {} },
    adapter: () => {
      throw Error("No agent should run");
    },
  },
});
const dom = new JSDOM('<div id="root"></div>', {
  url: "https://acd.fixture/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
try {
  const now = new Date().toISOString();
  const message = { role: "assistant", taskIds: [], createdAt: now };
  const summary = "历史报告完整结果。".repeat(250) + "原文结尾";
  app.runtime.store.message({
    ...message,
    id: "older",
    text: summary,
    completion: {
      id: "older",
      title: "第一份交付",
      nativeId: "native-fixture",
      status: "ready",
      summary,
      suggestions: ["只在原报告出现的建议"],
    },
  });
  for (let i = 0; i < 205; i++)
    app.runtime.store.message({
      ...message,
      id: "filler-" + i,
      text: "fixture",
    });
  app.runtime.store.message({
    ...message,
    id: "newer",
    text: "最新报告",
    completion: {
      id: "newer",
      title: "后续交付",
      nativeId: "native-fixture",
      status: "ready",
      summary: "最新报告",
    },
  });
  app.runtime.publish();
  assert.ok(!app.runtime.snapshot().messages.some((m) => m.id === "older"));

  const w = dom.window;
  w.structuredClone = structuredClone;
  w.matchMedia = () => ({ matches: false });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  const paths = [];
  w.acd = {
    getLocalInfo: async () => ({ dataDirectory: directory }),
    subscribe: (_receive, connected) => {
      connected(true);
      return () => {};
    },
    request: async (method, path, body) => {
      paths.push(path);
      const response = await fetch(app.descriptor.url + path, {
        method,
        headers: {
          Authorization: "Bearer " + app.descriptor.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      assert.ok(response.ok, path);
      return response.json();
    },
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
  async function find(selector, predicate = () => true) {
    for (let n = 0; n < 200; n++) {
      const element = [...w.document.querySelectorAll(selector)].find(
        predicate,
      );
      if (element) return element;
      await delay(10);
    }
    assert.fail("Missing UI element " + selector);
  }
  (await find("button.notice-entry")).click();
  (
    await find(".notice-row", (button) =>
      button.textContent.includes("历史报告完整结果"),
    )
  ).click();
  const report = await find(
    'dialog[open][aria-label="历史报告"] .completion-report',
  );
  assert.equal(
    report.querySelector(".completion-summary").textContent,
    summary,
  );
  assert.equal(report.querySelector("li").textContent, "只在原报告出现的建议");
  assert.ok(
    paths.some((path) =>
      /^\/api\/notifications\/[a-f0-9]{64}\/report$/.test(path),
    ),
  );
  console.log(
    "PASS • 消息中心 → 被 205 条消息挤出的原报告全文及建议（JSDOM、本机 API、临时数据库）",
  );
} finally {
  dom.window.close();
  await app.close();
  rmSync(directory, { recursive: true, force: true });
}
