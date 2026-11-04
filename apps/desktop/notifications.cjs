const { randomUUID } = require("node:crypto");

// Main-process only. Native notifications consume persisted claims, never task actions.
class DesktopNotifier {
  constructor({
    Notification,
    request,
    getWindow,
    onOpen,
    badge,
    backgroundAvailable,
  }) {
    this.Native = Notification;
    this.request = request;
    this.getWindow = getWindow;
    this.onOpen = onOpen;
    this.badge = badge;
    this.backgroundAvailable = backgroundAvailable;
    this.latest = null;
    this.timer = null;
    this.busy = false;
    this.active = new Set();
    this.lastResult = "unverified";
    this.error = undefined;
  }
  status() {
    return {
      supported: Boolean(this.Native?.isSupported()),
      backgroundAvailable: Boolean(this.backgroundAvailable?.()),
      canOpenSettings:
        process.platform === "darwin" || process.platform === "win32",
      lastResult: this.lastResult,
      ...(this.error ? { error: this.error } : {}),
    };
  }
  update(snapshot) {
    this.latest = snapshot.notifications;
    this.badge?.(this.latest?.unread || 0);
    if (!this.latest?.items.some((n) => n.desktop === "pending")) return;
    if (this.timer || this.busy) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 600);
    this.timer.unref?.();
  }
  async flush() {
    if (this.busy || !this.latest) return;
    this.busy = true;
    const feed = this.latest,
      ids = feed.items.filter((n) => n.desktop === "pending").map((n) => n.id);
    try {
      if (!ids.length) return;
      const notices = await this.request("POST", "/api/notifications/claim", {
        ids,
      });
      if (!notices.length) return;
      const claimed = notices.map((n) => n.id),
        window = this.getWindow();
      // Focused users receive the persistent inbox entry, without a duplicate OS popup.
      if (window?.isFocused() && window.isVisible()) {
        await this.settle(claimed, "suppressed");
        return;
      }
      if (!this.status().supported) {
        this.lastResult = "failed";
        this.error = "当前系统不支持桌面通知，消息仍保存在消息中心。";
        await this.settle(claimed, "failed");
        return;
      }
      const preferences = this.latest?.preferences || feed.preferences;
      const eligible = notices.filter(
        (n) => preferences.desktop && preferences[n.kind],
      );
      const suppressed = notices
        .filter((n) => !eligible.includes(n))
        .map((n) => n.id);
      if (suppressed.length) await this.settle(suppressed, "suppressed");
      if (eligible.length) await this.show(eligible, preferences);
    } catch {
      this.lastResult = "failed";
      this.error = "暂时无法提交桌面提醒，请在消息中心查看进展。";
    } finally {
      this.busy = false;
      if (
        this.latest?.items.some(
          (n) => n.desktop === "pending" && !ids.includes(n.id),
        )
      )
        this.update({ notifications: this.latest });
    }
  }
  settle(ids, outcome) {
    return this.request("POST", "/api/notifications/settle", {
      ids,
      outcome,
    }).catch(() => {});
  }
  show(notices, preferences, test = false) {
    const ids = notices.map((n) => n.id),
      one = notices.length === 1 ? notices[0] : null;
    const title = test
      ? "ACD 测试提醒"
      : one
        ? "ACD · " + one.title
        : `ACD · ${notices.length} 条新进展`;
    const body = test
      ? "提醒链路已提交，请确认系统是否显示。"
      : preferences.details && one
        ? one.body
        : "点击查看任务结果或需要你处理的事项。";
    return new Promise((resolve) => {
      let settled = false;
      const finish = async (result, detail) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.lastResult = result;
        if (result === "failed")
          this.error =
            /UNErrorDomain/.test(String(detail)) &&
            /(?:error|错误|code)[^0-9]*1(?:[^0-9]|$)/i.test(String(detail))
              ? "macOS 未允许此应用发送通知，请在系统通知设置中允许 Agent Control Desk；源码版可能显示为 Electron。"
              : "系统未能显示通知，请检查通知设置；Mac 开发版还可能受签名限制。";
        else if (result === "unverified")
          this.error =
            "系统尚未确认通知结果，请在消息中心查看；不会自动重复发送。";
        else this.error = undefined;
        if (!test) await this.settle(ids, result);
        resolve(this.status());
      };
      const timer = setTimeout(
        () => void finish("unverified"),
        test ? 10000 : 3500,
      );
      timer.unref?.();
      try {
        if (test) this.lastTestId = "acd-test-" + randomUUID();
        const n = new this.Native({
          id: test
            ? this.lastTestId
            : one
              ? "acd-" + one.id
              : "acd-summary-" + ids[0],
          groupId: "acd-tasks",
          title: limitBytes(title, 72),
          body: limitBytes(body, 160),
          silent: !preferences.sound,
        });
        this.active.add(n);
        if (this.active.size > 100)
          this.active.delete(this.active.values().next().value);
        n.once("show", () => void finish("submitted"));
        n.once("failed", (_event, detail) => {
          this.active.delete(n);
          void finish("failed", detail);
        });
        n.once("close", () => this.active.delete(n));
        n.on("click", () => {
          this.active.delete(n);
          this.onOpen(
            one && !test
              ? {
                  id: one.id,
                  kind: one.kind,
                  taskId: one.taskId,
                  questionId: one.questionId,
                  messageId: one.messageId,
                }
              : null,
          );
        });
        n.show();
      } catch {
        void finish("failed");
      }
    });
  }
  async test() {
    if (!this.status().supported) throw Error("当前系统不支持桌面通知");
    return this.show([], this.latest?.preferences || { sound: true }, true);
  }
  close() {
    clearTimeout(this.timer);
  }
}
function limitBytes(text, max) {
  let result = "",
    bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > max) break;
    result += character;
    bytes += size;
  }
  return result;
}
module.exports = { DesktopNotifier, limitBytes };
