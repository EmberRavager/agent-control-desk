import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("English desktop language context translates platform text and preserves interpolated content", async () => {
  const path = "../apps/desktop/i18n.js";
  const module = await import(path).catch(() => ({}));
  assert.equal(
    typeof module.I18nProvider,
    "function",
    "desktop locale provider exists",
  );
  function Probe() {
    const { t } = module.useI18n();
    return React.createElement(
      "div",
      null,
      t("总控对话"),
      "|",
      t("回复{title}", { title: "中文任务" }),
    );
  }
  const html = renderToStaticMarkup(
    React.createElement(
      module.I18nProvider,
      { locale: "en" },
      React.createElement(Probe),
    ),
  );
  assert.match(html, /Supervisor chat/);
  assert.match(html, /Reply to 中文任务/);
});
test("language saves only after backend confirmation, reopens within its profile, and preserves old language on failure", async () => {
  const path = "../apps/desktop/i18n.js";
  const m = await import(path).catch(() => ({}));
  assert.equal(
    typeof m.saveLocalePreference,
    "function",
    "confirmed locale save is available",
  );
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) || null,
    setItem: (k: string, v: string) => data.set(k, v),
  };
  assert.equal(m.readLocale(storage, "profile-a"), "zh-CN");
  await assert.rejects(
    m.saveLocalePreference(
      async () => {
        throw Error("offline");
      },
      "en",
      storage,
      "profile-a",
    ),
  );
  assert.equal(m.readLocale(storage, "profile-a"), "zh-CN");
  await m.saveLocalePreference(
    async (method: string, path: string, body: unknown) => {
      assert.equal(method, "PUT");
      assert.equal(path, "/api/preferences");
      assert.deepEqual(body, { locale: "en" });
      return { locale: "en" };
    },
    "en",
    storage,
    "profile-a",
  );
  assert.equal(m.readLocale(storage, "profile-a"), "en");
  assert.equal(m.readLocale(storage, "profile-b"), "zh-CN");
  await assert.rejects(
    m.saveLocalePreference(
      async () => ({ ok: true }),
      "zh-CN",
      storage,
      "profile-a",
    ),
  );
  assert.equal(m.readLocale(storage, "profile-a"), "en");
});

async function desktopBundle() {
  const { build } = await import("esbuild");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join, resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const directory = await mkdtemp(join(resolve("."), ".i18n-desktop-test-"));
  try {
    const result = await build({
      stdin: {
        contents:
          'export {App} from "./apps/desktop/renderer.tsx"; export {I18nProvider} from "./apps/desktop/i18n.tsx";export {ComposerDrafts} from "./apps/desktop/composer-drafts.ts"; export {default as Settings} from "./apps/desktop/Settings.tsx";',
        resolveDir: resolve("."),
      },
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      loader: { ".css": "empty" },
      write: false,
    });
    const file = join(directory, "desktop.mjs");
    await writeFile(file, result.outputFiles[0].contents);
    return await import(pathToFileURL(file).href);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test("English main navigation, connection state and draft storage errors render without translating the user draft", async () => {
  const { App, I18nProvider, ComposerDrafts } = await desktopBundle();
  const drafts = new ComposerDrafts();
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(App, { drafts }),
    ),
  );
  assert.match(html, /Supervisor chat/);
  assert.match(html, /Schedules/);
  assert.match(html, /Settings/);
  assert.match(html, /Connecting to the local service/);
  assert.match(html, /Could not access local draft storage/);
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const good = new ComposerDrafts(storage, "fixture");
  good.saveComposer({ text: "用户原文 总控对话", cwd: "/fixture/中文" });
  const draftHtml = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(App, { drafts: good }),
    ),
  );
  assert.match(draftHtml, /用户原文 总控对话/);
  assert.match(draftHtml, /\/fixture\/中文/);
});

test("English settings expose a bilingual language selector and explain the scope of future replies", async () => {
  const { Settings, I18nProvider } = await desktopBundle();
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(Settings, {
        agents: [],
        active: true,
        ready: false,
        connected: false,
        config: null,
        theme: "light",
        returnLabel: "Supervisor",
        saveLocale: async () => {},
        saveNotices: async () => {},
        getNoticeStatus: async () => ({}),
        testNotice: async () => ({}),
        openNoticeSettings: async () => {},
        request: async () => ({}),
        pickDirectory: async () => null,
        onTheme() {},
        save: async () => {},
        loadModels: async () => ({}),
        getLocalInfo: async () => ({ dataDirectory: "/fixture" }),
        openDataDirectory: async () => {},
        onBack() {},
        onOpenSidebar() {},
      }),
    ),
  );
  assert.match(html, /Interface and AI response language/);
  assert.match(html, /<option value="zh-CN">简体中文<\/option>/);
  assert.match(html, /<option value="en" selected="">English<\/option>/);
  assert.match(html, /Save language/);
  assert.match(html, /Existing conversations and task text remain unchanged/);
  assert.match(html, /Back to Supervisor/);
});
