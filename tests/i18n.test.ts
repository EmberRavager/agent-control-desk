import test from "node:test";
import assert from "node:assert/strict";

const modulePath = "../packages/i18n/index.cjs";
async function api() {
  const mod = await import(modulePath).catch(() => ({}));
  assert.equal(
    typeof mod.translate,
    "function",
    "a shared locale-aware translator must exist",
  );
  return mod;
}
test("locale selection is explicit, defaults to Chinese, and never changes other callers", async () => {
  const { normalizeLocale, translate } = await api();
  assert.equal(normalizeLocale(undefined), "zh-CN");
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(translate("en", "设置"), "Settings");
  assert.equal(translate("zh-CN", "设置"), "设置");
  assert.equal(translate("en", "设置"), "Settings");
});
test("translation interpolates values once and preserves user text without translating it", async () => {
  const { translate } = await api();
  const text = "设置 {other} 用户原话";
  assert.equal(
    translate("en", "已创建任务：{title}", { title: text }),
    "Task created: " + text,
  );
  assert.equal(
    translate("en", "A user message not in the catalog"),
    "A user message not in the catalog",
  );
});
test("English catalog entries retain the same interpolation fields as their source", async () => {
  const { englishMessages } = await api();
  assert.ok(Object.keys(englishMessages).length > 0);
  const fields = (s: string) =>
    [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
  for (const [source, translation] of Object.entries(englishMessages)) {
    assert.equal(typeof translation, "string", source);
    assert.deepEqual(fields(source), fields(translation as string), source);
  }
});
