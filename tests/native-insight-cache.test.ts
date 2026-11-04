import test from "node:test";
import assert from "node:assert/strict";
import {
  loadNativeInsight,
  nativeInsightFresh,
  type NativeInsightCache,
} from "../apps/desktop/native-insight-cache.js";
import type { NativeInsight } from "../packages/contracts/index.js";
const insight = (time: number, text: string): NativeInsight => ({
  title: "检查任务",
  summary: text,
  goal: "核验展示",
  currentStep: text,
  blocker: "",
  nextStep: "",
  generatedAt: new Date(time).toISOString(),
  model: "fixture",
  basis: "metadata",
});

test("navigation reuses fresh analysis, stale refresh preserves its result and shares one request", async (t) => {
  let time = 1_000_000;
  t.mock.method(Date, "now", () => time);
  const cache: NativeInsightCache = new Map();
  let calls = 0;
  const load = async () => {
    calls++;
    return insight(time, `进展${calls}`);
  };
  await loadNativeInsight(cache, "task-a", load);
  time += 29_999;
  await loadNativeInsight(cache, "task-a", load);
  assert.equal(calls, 1);
  assert.equal(nativeInsightFresh(cache.get("task-a")), true);
  time += 2;
  let release!: (value: NativeInsight) => void;
  const pending = loadNativeInsight(cache, "task-a", () => {
    calls++;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const again = loadNativeInsight(cache, "task-a", load);
  assert.equal(pending, again);
  await Promise.resolve();
  assert.equal(calls, 2);
  assert.equal(cache.get("task-a")?.value?.summary, "进展1");
  release(insight(time, "进展2"));
  await pending;
  assert.equal(cache.get("task-a")?.value?.summary, "进展2");
  await loadNativeInsight(cache, "task-a", load, true);
  assert.equal(calls, 3, "manual refresh bypasses a fresh result");
});

test("a failed refresh retains the last analysis and clears its in-flight request", async () => {
  const cache: NativeInsightCache = new Map();
  const value = insight(Date.now(), "可继续查看的进展");
  await loadNativeInsight(cache, "task", async () => value);
  await assert.rejects(
    loadNativeInsight(
      cache,
      "task",
      async () => {
        throw Error("fixture failure");
      },
      true,
    ),
    /fixture failure/,
  );
  assert.equal(cache.get("task")?.value, value);
  assert.equal(cache.get("task")?.error, "fixture failure");
  assert.equal(cache.get("task")?.pending, undefined);
});

test("invalidating a model's cache prevents a late response from replacing new analysis", async () => {
  const cache: NativeInsightCache = new Map();
  let release!: (value: NativeInsight) => void;
  const old = loadNativeInsight(
    cache,
    "task",
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  cache.clear();
  const current = insight(Date.now(), "新模型结果");
  await loadNativeInsight(cache, "task", async () => current);
  release(insight(Date.now(), "旧模型的迟到结果"));
  await assert.rejects(old, /模型配置已更新/);
  assert.equal(cache.get("task")?.value, current);
});
