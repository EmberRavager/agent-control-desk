const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { DesktopNotifier, limitBytes } = require("./notifications.cjs");
function fixture({
  focused = false,
  failed = false,
  supported = true,
  preferences = {},
  noEvent = false,
  nativeError = "private-native-error",
} = {}) {
  const records = [
      {
        id: "a".repeat(64),
        kind: "result",
        title: "结果待检查",
        body: "private-task-name /private/example",
        desktop: "pending",
        active: true,
        taskId: "task-fixture",
        sequence: 1,
      },
    ],
    shown = [],
    opened = [];
  class Native extends EventEmitter {
    static isSupported() {
      return supported;
    }
    constructor(options) {
      super();
      this.options = options;
    }
    show() {
      shown.push(this);
      if (!noEvent) this.emit(failed ? "failed" : "show", {}, nativeError);
    }
  }
  const notifier = new DesktopNotifier({
    Notification: Native,
    getWindow: () => ({ isFocused: () => focused, isVisible: () => true }),
    onOpen: (value) => opened.push(value),
    request: async (_method, path, body) => {
      if (path.endsWith("/claim"))
        return records
          .filter((n) => body.ids.includes(n.id) && n.desktop === "pending")
          .map((n) => {
            n.desktop = "claimed";
            return { ...n };
          });
      for (const n of records)
        if (body.ids.includes(n.id) && n.desktop === "claimed")
          n.desktop = body.outcome;
      return { ok: true };
    },
    backgroundAvailable: () => true,
  });
  const update = () =>
    notifier.update({
      notifications: {
        items: records,
        unread: records.length,
        preferences: {
          desktop: true,
          sound: true,
          details: false,
          attention: true,
          result: true,
          error: true,
          background: true,
          ...preferences,
        },
      },
    });
  update();
  return { notifier, records, shown, opened, update };
}
test("native reminders merge a burst, hide details by default and never resubmit claimed records", async () => {
  const x = fixture();
  try {
    x.records.push({ ...x.records[0], id: "b".repeat(64), sequence: 2 });
    await x.notifier.flush();
    assert.equal(x.shown.length, 1);
    assert.match(x.shown[0].options.title, /2 条/);
    assert.ok(!x.shown[0].options.body.includes("private"));
    assert.ok(x.records.every((n) => n.desktop === "submitted"));
    x.update();
    await x.notifier.flush();
    assert.equal(x.shown.length, 1);
  } finally {
    x.notifier.close();
  }
});
test("foreground users get inbox entries without duplicate OS notifications", async () => {
  const x = fixture({ focused: true });
  try {
    await x.notifier.flush();
    assert.equal(x.shown.length, 0);
    assert.equal(x.records[0].desktop, "suppressed");
  } finally {
    x.notifier.close();
  }
});
test("native click carries the stable task target and sound can be disabled", async () => {
  const x = fixture({ preferences: { sound: false, details: true } });
  try {
    await x.notifier.flush();
    assert.equal(x.shown[0].options.silent, true);
    assert.match(x.shown[0].options.body, /private-task-name/);
    x.shown[0].emit("click");
    assert.equal(x.opened[0].taskId, "task-fixture");
    assert.equal(x.opened[0].id, x.records[0].id);
  } finally {
    x.notifier.close();
  }
});
test("native failure preserves actionable inbox history and reports a sanitized failure", async () => {
  const x = fixture({ failed: true });
  try {
    await x.notifier.flush();
    assert.equal(x.records[0].desktop, "failed");
    assert.equal(x.notifier.status().lastResult, "failed");
    assert.ok(!x.notifier.status().error.includes("private-native-error"));
    await x.notifier.flush();
    assert.equal(x.shown.length, 1);
  } finally {
    x.notifier.close();
  }
});
test("notification byte limits preserve complete Chinese and emoji characters", () => {
  assert.equal(limitBytes("你好🙂世界", 10), "你好🙂");
  assert.ok(Buffer.byteLength(limitBytes("🙂".repeat(100), 160)) <= 160);
});

test("streaming snapshots cannot keep postponing a pending reminder", () => {
  const x = fixture();
  try {
    const timer = x.notifier.timer;
    for (let n = 0; n < 20; n++) x.update();
    assert.equal(x.notifier.timer, timer);
  } finally {
    x.notifier.close();
  }
});

test("native timeout stays unverified, preserves inbox and does not silently mark submission success", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const x = fixture({ noEvent: true });
  try {
    const pending = x.notifier.flush();
    await Promise.resolve();
    t.mock.timers.tick(3501);
    await pending;
    assert.equal(x.records[0].desktop, "unverified");
    assert.equal(x.notifier.status().lastResult, "unverified");
    x.shown[0].emit("show");
    await x.notifier.flush();
    assert.equal(x.records[0].desktop, "unverified");
    assert.equal(x.shown.length, 1);
  } finally {
    x.notifier.close();
  }
});
test("macOS permission rejection is actionable in the returned test result without leaking raw native details", async () => {
  const x = fixture({
    failed: true,
    nativeError: "未能完成操作。（UNErrorDomain错误1。）",
  });
  try {
    const result = await x.notifier.test();
    assert.match(result.error, /macOS 未允许/);
    assert.ok(!result.error.includes("UNErrorDomain"));
  } finally {
    x.notifier.close();
  }
});
