import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ComposerDrafts } from "../apps/desktop/composer-drafts.js";
function storageFixture() {
  const entries = new Map<string, string>();
  let fail = false;
  return {
    entries,
    setFailure(value: boolean) {
      fail = value;
    },
    getItem: (key: string) => entries.get(key) || null,
    setItem: (key: string, value: string) => {
      if (fail) throw Error("Synthetic quota error");
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
}
const receipt = () => ({
  id: randomUUID(),
  text: "只检查启动说明",
  cwd: "/fixture/project",
  targetTaskId: "task-fixture",
});

test("draft, target and question scope survive a window restart without sharing another profile", () => {
  const storage = storageFixture(),
    first = new ComposerDrafts(storage, "/profile-a");
  first.saveComposer({
    text: "补充边界情况",
    cwd: "/fixture",
    targetTaskId: "task-a",
    questionId: "question-a",
  });
  const reopened = new ComposerDrafts(storage, "/profile-a");
  assert.deepEqual(reopened.read().composer, first.read().composer);
  assert.equal(
    new ComposerDrafts(storage, "/profile-b").read().composer.text,
    "",
  );
});

test("unconfirmed sends keep their identifiers while a newer draft remains editable", () => {
  const storage = storageFixture(),
    store = new ComposerDrafts(storage, "/profile-a"),
    sent = receipt();
  store.saveComposer({
    text: sent.text,
    cwd: sent.cwd,
    targetTaskId: sent.targetTaskId,
  });
  store.stageSend(sent, true);
  assert.equal(store.read().composer.text, "");
  store.saveComposer({ text: "下一条不同要求", cwd: "/other-project" });
  const reopened = new ComposerDrafts(storage, "/profile-a");
  assert.equal(reopened.read().composer.text, "下一条不同要求");
  assert.deepEqual(reopened.read().pending, [sent]);
  reopened.stageSend(sent);
  assert.equal(reopened.read().pending.length, 1);
  assert.throws(
    () => reopened.stageSend({ ...sent, text: "另一条消息" }),
    /其他内容/,
  );
  reopened.acknowledge(new Set([sent.id]));
  assert.equal(
    new ComposerDrafts(storage, "/profile-a").read().pending.length,
    0,
  );
  assert.equal(reopened.read().composer.text, "下一条不同要求");
});

test("a storage failure preserves the previous draft and prevents staging a new send", () => {
  const storage = storageFixture(),
    store = new ComposerDrafts(storage, "/profile-a"),
    sent = receipt();
  store.saveComposer({ text: "尚未发送", cwd: "/fixture" });
  storage.setFailure(true);
  assert.throws(() => store.stageSend(sent, true), /保存失败/);
  assert.equal(store.read().composer.text, "尚未发送");
  assert.equal(store.read().pending.length, 0);
  storage.setFailure(false);
  assert.equal(
    new ComposerDrafts(storage, "/profile-a").read().composer.text,
    "尚未发送",
  );
});

test("corrupt stored drafts are preserved as recovery copies before a new draft can be saved", () => {
  const storage = storageFixture(),
    store = new ComposerDrafts(storage, "/profile-a");
  const raw = "not valid JSON: synthetic user draft";
  storage.entries.set(store.key, raw);
  const reopened = new ComposerDrafts(storage, "/profile-a");
  assert.match(reopened.warning, /恢复副本/);
  assert.ok(
    [...storage.entries].some(
      ([key, value]) =>
        key.startsWith(store.key + ".recovery-") && value === raw,
    ),
  );
  reopened.saveComposer({ text: "新草稿", cwd: "/fixture" });
  assert.equal(
    new ComposerDrafts(storage, "/profile-a").read().composer.text,
    "新草稿",
  );
});

test("failed recovery cannot overwrite the original record, and missing profile scope cannot send", () => {
  const storage = storageFixture(),
    key = new ComposerDrafts(storage, "/profile-a").key;
  storage.entries.set(key, "synthetic corrupt record");
  storage.setFailure(true);
  const reopened = new ComposerDrafts(storage, "/profile-a");
  assert.throws(() => reopened.stageSend(receipt()), /无法保存/);
  assert.equal(storage.entries.get(key), "synthetic corrupt record");
  assert.throws(
    () => new ComposerDrafts(storage).stageSend(receipt()),
    /无法保存/,
  );
});

test("a long editable draft is retained but cannot become an oversized API send", () => {
  const storage = storageFixture(),
    store = new ComposerDrafts(storage, "/profile-a");
  const text = "字".repeat(20001);
  store.saveComposer({ text, cwd: "/fixture" });
  assert.equal(
    new ComposerDrafts(storage, "/profile-a").read().composer.text.length,
    20001,
  );
  assert.throws(() => store.stageSend({ ...receipt(), text }));
  assert.equal(store.read().pending.length, 0);
});

test("a failed local acknowledgement keeps the stable identifier without claiming the message was never sent", () => {
  const storage = storageFixture(),
    store = new ComposerDrafts(storage, "/profile-a"),
    sent = receipt();
  store.stageSend(sent, true);
  storage.setFailure(true);
  assert.throws(
    () => store.acknowledge(new Set([sent.id])),
    (error: Error) => {
      assert.doesNotMatch(error.message, /尚未发送|未收到/);
      return true;
    },
  );
  assert.equal(store.read().pending[0].id, sent.id);
  storage.setFailure(false);
  assert.equal(
    new ComposerDrafts(storage, "/profile-a").read().pending[0].id,
    sent.id,
  );
});

test("allocation choice and required capabilities survive draft and unconfirmed-send recovery", () => {
  const storage = storageFixture();
  const first = new ComposerDrafts(storage, "/profile-allocation");
  const allocation = {
    targetAgentId: "agent-codex",
    requiredCapabilities: ["steer", "approval"] as ("steer" | "approval")[],
  };
  first.saveComposer({
    text: "检查交互",
    cwd: "/fixture/project",
    ...allocation,
  });
  assert.deepEqual(
    new ComposerDrafts(storage, "/profile-allocation").read().composer,
    {
      text: "检查交互",
      cwd: "/fixture/project",
      ...allocation,
    },
  );
  const sent = { ...receipt(), ...allocation };
  first.stageSend(sent, true);
  const reopened = new ComposerDrafts(storage, "/profile-allocation");
  assert.deepEqual(reopened.read().pending, [sent]);
  assert.equal(reopened.read().composer.targetAgentId, undefined);
  reopened.stageSend({
    ...sent,
    requiredCapabilities: ["approval", "steer", "steer"],
  });
  assert.equal(reopened.read().pending.length, 1);
  assert.throws(
    () => reopened.stageSend({ ...sent, targetAgentId: "agent-pi" }),
    /其他内容/,
  );
  assert.throws(
    () => reopened.stageSend({ ...sent, requiredCapabilities: ["steer"] }),
    /其他内容/,
  );
});

test("legacy version-one drafts remain readable when allocation fields are absent", () => {
  const storage = storageFixture();
  const key = new ComposerDrafts(storage, "/legacy").key;
  storage.entries.set(
    key,
    JSON.stringify({
      version: 1,
      composer: { text: "旧草稿", cwd: "/fixture" },
      pending: [receipt()],
    }),
  );
  const reopened = new ComposerDrafts(storage, "/legacy");
  assert.equal(reopened.read().composer.text, "旧草稿");
  assert.equal(reopened.warning, "");
});
