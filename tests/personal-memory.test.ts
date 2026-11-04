import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/core/store.js";
import {
  PersonalMemories,
  safeWorkflowObservation,
} from "../packages/core/personal-memory.js";

function fixture(t: import("node:test").TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "acd-memory-"));
  let store = new Store(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    memories: new PersonalMemories(store),
    restart() {
      store.close();
      store = new Store(dir);
      return new PersonalMemories(store);
    },
    entityText() {
      return JSON.stringify(
        store.db.prepare("SELECT id,data FROM entities").all(),
      );
    },
  };
}

const preference = {
  kind: "preference" as const,
  title: "汇报格式",
  content: "先给结论，再给依据。",
};
const review = {
  activity: "代码审查",
  steps: ["核对需求范围", "检查差异内容", "检查测试结果"],
};

test("manual memories persist and stale edits/deletes cannot undo a newer edit", (t) => {
  const f = fixture(t);
  const a = f.memories.create(preference);
  const restarted = f.restart();
  assert.deepEqual(restarted.list(), [a]);
  const edited = restarted.update(
    a.id,
    { ...preference, content: "保留两句话。" },
    a.revision,
  );
  assert.ok(edited.revision > a.revision);
  assert.throws(() => restarted.update(a.id, preference, a.revision));
  assert.throws(() => restarted.remove(a.id, a.revision));
  restarted.remove(edited.id, edited.revision);
  assert.deepEqual(restarted.list(), []);
});

test("explicit evidence is idempotent and edits and deletes take precedence over automatic relearning", (t) => {
  const f = fixture(t);
  const explicit = f.memories.rememberPreference(preference, "message-A")!;
  assert.equal(explicit.source, "explicit");
  f.memories.rememberPreference(
    { ...preference, title: "关于输出" },
    "message-A",
  );
  assert.deepEqual(f.memories.list(), [explicit]);
  const edit = f.memories.update(
    explicit.id,
    { ...preference, content: "只给摘要。" },
    explicit.revision,
  );
  f.memories.rememberPreference(preference, "message-B");
  assert.deepEqual(f.memories.list(), [edit]);
  f.memories.remove(edit.id, edit.revision);
  const restarted = f.restart();
  restarted.rememberPreference(preference, "message-C");
  restarted.rememberPreference(
    { ...preference, content: edit.content },
    "message-D",
  );
  assert.deepEqual(restarted.list(), []);
  assert.ok(
    !f.entityText().includes("只给摘要") &&
      !f.entityText().includes("先给结论"),
  );
  assert.equal(restarted.create(preference).source, "manual");
});

test("only compatible ordered steps repeated in distinct tasks become a learned workflow", (t) => {
  const f = fixture(t);
  assert.equal(f.memories.observeWorkflow(review, "task-A"), undefined);
  const m = f.restart();
  assert.equal(m.observeWorkflow(review, "task-A"), undefined);
  assert.equal(
    m.observeWorkflow(
      { ...review, steps: ["检查测试结果", "检查测试结果"] },
      "task-X",
    ),
    undefined,
  );
  assert.equal(
    m.observeWorkflow(
      { ...review, steps: ["准备数据库", "备份数据"] },
      "task-B",
    ),
    undefined,
  );
  assert.equal(
    m.observeWorkflow({ activity: "整理周报", steps: review.steps }, "task-C"),
    undefined,
  );
  const learned = m.observeWorkflow(
    {
      activity: "代码审查流程",
      steps: ["阅读补充说明", ...review.steps.slice(1)],
    },
    "task-D",
  )!;
  assert.equal(learned.source, "learned");
  assert.equal(learned.evidenceCount, 2);
  assert.match(learned.content, /检查差异内容.*检查测试结果/s);
  assert.doesNotMatch(learned.content, /核对需求范围|阅读补充说明/);
  m.observeWorkflow(review, "task-D");
  assert.deepEqual(m.list(), [learned]);
  const edited = m.update(
    learned.id,
    { kind: "workflow", title: "我的审查", content: "由我决定审查顺序" },
    learned.revision,
  );
  assert.equal(edited.evidenceCount, 0);
  m.observeWorkflow(review, "task-E");
  assert.deepEqual(m.list(), [edited]);
  m.remove(edited.id, edited.revision);
  m.observeWorkflow(review, "task-F");
  m.observeWorkflow(review, "task-G");
  assert.deepEqual(m.list(), []);
  assert.doesNotMatch(
    f.entityText(),
    /阅读补充说明|检查差异内容|由我决定审查顺序/,
  );
});

test("selection scores Chinese and English workflows against task text and respects the prompt budget", (t) => {
  const { memories: m } = fixture(t);
  const pref = m.create(preference);
  const cn = m.create({
    kind: "workflow",
    title: "代码审查",
    content: "查看变更并检查测试",
  });
  const en = m.create({
    kind: "workflow",
    title: "Release notes",
    content: "Group changes by customer impact",
  });
  assert.deepEqual(
    m
      .select("帮我审查本次代码变更")
      .map((x) => x.id)
      .sort(),
    [cn.id, pref.id].sort(),
  );
  assert.deepEqual(
    m
      .select("Draft the next RELEASE note")
      .map((x) => x.id)
      .sort(),
    [en.id, pref.id].sort(),
  );
  assert.deepEqual(
    m.select("天气预报").map((x) => x.id),
    [pref.id],
  );
  for (let i = 0; i < 9; i++)
    m.create({
      ...preference,
      title: "偏好" + i,
      content: String(i).repeat(800),
    });
  const selected = m.select("发布前帮我做一次代码审查");
  assert.ok(selected.length > 0 && selected.length <= 5);
  assert.ok(JSON.stringify(selected).length <= 1800);
  assert.ok(selected.some((x) => x.id === cn.id));
});

test("automatic ingestion drops invalid, credential-bearing or oversized input without retaining candidates", (t) => {
  const f = fixture(t);
  for (const content of [
    "token=FAKE_VALUE_FOR_TEST",
    "我的密码是 FakeExample123",
    "Bearer fake-example",
    "x".repeat(2000),
  ]) {
    assert.equal(
      f.memories.rememberPreference({ ...preference, content }, "msg"),
      undefined,
    );
    assert.equal(
      f.memories.observeWorkflow(
        { activity: review.activity, steps: [content, "记录结果"] },
        "task",
      ),
      undefined,
    );
    assert.ok(!f.entityText().includes(content));
  }
  assert.throws(() => f.memories.create({ ...preference, content: " " }));
  assert.equal(
    f.memories.rememberPreference({ ...preference, kind: "workflow" }, "msg"),
    undefined,
  );
  assert.deepEqual(f.memories.list(), []);
});

test("inferred material containing identifying paths and redactions cannot enter a pending assessment or candidate label", (t) => {
  const { memories } = fixture(t);
  for (const privateStep of [
    "查阅 src/client-a/report.md",
    "查阅 C:\\Finance\\private.xlsx",
    "查阅 /private-summary",
    "咨询 fake@example.invalid",
    "访问 https://example.invalid/team",
    "读取 UUID 00000000-0000-0000-0000-000000000000",
    "收集 [REDACTED] 的数据",
  ]) {
    const item = { activity: "准备总结", steps: [privateStep, "整理结论"] };
    assert.equal(safeWorkflowObservation(item), undefined, privateStep);
    memories.observeWorkflow(item, privateStep);
  }
  assert.deepEqual(memories.workflowActivities(), []);
});

test("generic verbs alone do not retrieve a workflow for an unrelated task", (t) => {
  const { memories } = fixture(t);
  memories.create({
    kind: "workflow",
    title: "发布检查",
    content: "检查安装包，查看编译结果",
  });
  memories.create({
    kind: "workflow",
    title: "Release notes",
    content: "Check changes and prepare release information",
  });
  assert.deepEqual(memories.select("检查今天的天气"), []);
  assert.deepEqual(memories.select("Check the local weather"), []);
});

test("oversized procedures are rejected before any candidate is written", (t) => {
  const { memories } = fixture(t);
  const steps = Array.from({ length: 8 }, (_, i) =>
    (String.fromCharCode(97 + i) + "v").repeat(78),
  );
  const observation = { activity: "Test fixture", steps };
  assert.equal(safeWorkflowObservation(observation), undefined);
  memories.observeWorkflow(observation, "first");
  assert.deepEqual(memories.workflowActivities(), []);
});

test("weekly-report observations tolerate a completed-aspect marker but distinguish unmerged changes", (t) => {
  const { memories } = fixture(t);
  const report = (first: string) => ({
    activity: "生成周报",
    steps: [first, "列出未解决风险"],
  });
  assert.equal(
    memories.observeWorkflow(report("汇总已合并改动"), "task-one"),
    undefined,
  );
  assert.equal(
    memories.observeWorkflow(report("汇总未合并改动"), "task-two"),
    undefined,
  );
  const learned = memories.observeWorkflow(
    report("汇总合并改动"),
    "task-three",
  );
  assert.equal(learned?.evidenceCount, 2);
  assert.match(learned!.content, /汇总合并改动/);
});

test("sorting photos and drafting a weekly report do not share a relevant activity", (t) => {
  const { memories } = fixture(t);
  const photos = memories.create({
    kind: "workflow",
    title: "照片整理",
    content: "先按日期分组，再筛选重复相片",
  });
  const weekly = memories.create({
    kind: "workflow",
    title: "生成周报",
    content: "列出未解决风险",
  });
  assert.deepEqual(
    memories.select("这次帮我整理周报").map((m) => m.id),
    [weekly.id],
  );
  assert.deepEqual(
    memories.select("请帮我整理照片").map((m) => m.id),
    [photos.id],
  );
});
