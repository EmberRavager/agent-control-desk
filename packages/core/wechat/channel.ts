import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Runtime } from "../runtime.js";
import type { Snapshot, Task } from "../../contracts/index.js";
import type { WeChatStatus } from "../../contracts/wechat.js";
import {
  WeChatClient,
  WeChatApiError,
  wechatBase,
  type Incoming,
  type WeChatLogin,
  type WeChatSecret,
} from "./client.js";
type Config = {
  enabled: boolean;
  paired?: boolean;
  expired?: boolean;
  cwd: string;
  notifications: boolean;
  completionReports?: boolean;
  binding: string;
};
type DeliveryScope = "direct" | "desktop" | "report";
type Delivery = {
  scope?: DeliveryScope;
  reportMessageId?: string;
  origin?: string;
  id: string;
  binding: string;
  text: string;
  state: "pending" | "sending" | "submitted" | "unknown" | "suppressed";
  createdAt: string;
  submittedAt?: string;
  receipt?: { ret?: number; errcode?: number; hasServerMessageId: boolean };
};
const labels: Record<Task["status"], string> = {
  queued: "等待执行",
  running: "执行中",
  waiting_input: "等你处理",
  blocked: "已阻塞",
  review: "待检查",
  completed: "已完成",
  failed: "失败",
  stopping: "正在停止",
  cancelled: "已停止",
  unknown: "状态待确认",
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref();
    signal.addEventListener("abort", done, { once: true });
  });
export class WeChatChannel {
  private view: Omit<WeChatStatus, "uncertainOperations"> = {
    state: "disconnected",
    cwd: "",
    notifications: true,
    uncertainDeliveries: 0,
  };
  private readonly defaultCwd: string;
  private login?: WeChatLogin;
  private control?: AbortController;
  private worker?: Promise<void>;
  private sending?: Promise<void>;
  private flushRequested = false;
  // Turn-specific reply contexts stay in memory. The vault holds the latest
  // private conversation context for recovery and unsolicited notifications.
  private readonly contexts = new Map<string, string>();
  private closed = false;
  private mutating = false;
  private code?: string;
  private off: () => void;
  constructor(
    private readonly runtime: Runtime,
    private readonly vault: WeChatSecret,
    private readonly client = new WeChatClient(),
  ) {
    this.defaultCwd = join(realpathSync(runtime.store.directory), "workspace");
    const listener = (snapshot: Snapshot) => this.observe(snapshot);
    runtime.on("state", listener);
    this.off = () => runtime.off("state", listener);
  }
  private config() {
    return this.runtime.store.get<Config>("settings", "wechat");
  }
  private deliveryId(id: string) {
    return this.config()!.binding + ":" + id;
  }
  status(): WeChatStatus {
    const cfg = this.config();
    const deliveries = this.runtime.store
      .list<Delivery>("wechat-outbox")
      .filter((d) => d.binding === cfg?.binding);
    const lastSubmission = deliveries
      .reverse()
      .find((d) => d.state === "submitted");
    return {
      ...this.view,
      lastReceivedAt:
        this.view.lastReceivedAt ??
        (cfg &&
          this.runtime.store.get<{ at: string }>(
            "wechat-last-inbound",
            cfg.binding,
          )?.at),
      lastSubmittedAt: this.view.lastSubmittedAt ?? lastSubmission?.submittedAt,
      paired: Boolean(cfg?.paired),
      canResume: Boolean(cfg?.paired && !cfg.enabled && !cfg.expired),
      lastSubmissionHasMessageId: lastSubmission?.receipt?.hasServerMessageId,
      cwd: cfg?.cwd || this.defaultCwd,
      notifications: cfg?.notifications ?? true,
      completionReports: cfg?.completionReports ?? false,
      uncertainOperations: this.runtime.store
        .list<{ id: string; state: string }>("wechat-inbox")
        .filter(
          (item) =>
            item.id.startsWith((cfg?.binding || "none") + ":") &&
            item.state === "unknown",
        ).length,
      uncertainDeliveries: deliveries.filter((d) => d.state === "unknown")
        .length,
    };
  }
  async init() {
    const cfg = this.config();
    if (!cfg) return;
    if (cfg.paired && cfg.completionReports) this.observeReports(cfg);
    for (const d of this.runtime.store.list<Delivery>("wechat-outbox"))
      if (d.state === "sending")
        this.runtime.store.put("wechat-outbox", d.id, {
          ...d,
          state: "unknown",
        });
    for (const r of this.runtime.store.list<{ id: string; state: string }>(
      "wechat-inbox",
    ))
      if (r.state === "processing")
        this.runtime.store.put("wechat-inbox", r.id, {
          ...r,
          state: "unknown",
        });
    this.view.state = cfg.expired
      ? "expired"
      : cfg.paired
        ? "paused"
        : "disconnected";
    if (cfg.expired) this.view.error = "微信会话已失效，请重新扫码连接。";
    if (cfg.enabled && !cfg.expired)
      try {
        await this.resume();
      } catch {
        this.view = {
          ...this.view,
          state: "error",
          error: "无法恢复微信连接，请重新扫码；没有重放未确认的操作。",
        };
      }
  }
  private async mutate<T>(fn: () => Promise<T>) {
    if (this.closed) throw Error("服务正在退出");
    if (this.mutating) throw Error("微信连接正在更新，请稍后重试");
    this.mutating = true;
    try {
      return await fn();
    } finally {
      this.mutating = false;
    }
  }
  private async cancel() {
    const running = Boolean(this.control);
    this.control?.abort();
    await this.worker;
    await this.sending;
    if (running && this.login) {
      try {
        await this.client.lifecycle(
          this.login,
          "stop",
          AbortSignal.timeout(5000),
        );
      } catch {}
    }
    this.worker = undefined;
    this.control = undefined;
  }
  private workingDirectory(cwd: string): string {
    if (cwd === this.defaultCwd)
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const canonical = realpathSync(cwd);
    if (!statSync(canonical).isDirectory())
      throw Error("请选择有效的微信任务工作目录");
    return canonical;
  }
  async configure(
    cwd: string,
    notifications: boolean,
    completionReports?: boolean,
  ) {
    return this.mutate(async () => {
      const canonical = this.workingDirectory(cwd);
      const cfg = this.config();
      if (!cfg) throw Error("请先扫码连接微信");
      const next = {
        ...cfg,
        cwd: canonical,
        notifications,
        completionReports: completionReports ?? cfg.completionReports ?? false,
      };
      this.runtime.store.transaction(() => {
        this.runtime.store.put("settings", "wechat", next);
        for (const d of this.runtime.store.list<Delivery>("wechat-outbox")) {
          if (
            d.binding === cfg.binding &&
            d.state === "pending" &&
            !this.allowed(d, next)
          )
            this.runtime.store.put("wechat-outbox", d.id, {
              ...d,
              state: "suppressed",
            });
        }
        this.baseline(
          !cfg.notifications && next.notifications,
          !cfg.completionReports && next.completionReports,
        );
      });
      return this.status();
    });
  }
  async begin(cwd: string, notifications: boolean, completionReports = false) {
    return this.mutate(async () => {
      const canonical = this.workingDirectory(cwd);
      await this.cancel();
      this.code = undefined;
      const previous = this.config();
      const proposed: Config = {
        enabled: false,
        cwd: canonical,
        notifications,
        completionReports,
        binding: randomUUID(),
      };
      this.runtime.store.put(
        "settings",
        "wechat",
        previous?.paired ? { ...previous, enabled: false } : proposed,
      );
      this.login = undefined;
      const controller = new AbortController();
      this.control = controller;
      this.view = {
        state: "connecting",
        cwd: canonical,
        notifications,
        uncertainDeliveries: 0,
      };
      try {
        const qr = await this.client.qr(controller.signal);
        if (
          typeof qr.qrcode !== "string" ||
          !qr.qrcode ||
          typeof qr.qrcode_img_content !== "string" ||
          !qr.qrcode_img_content ||
          qr.qrcode.length > 8192 ||
          qr.qrcode_img_content.length > 16384
        )
          throw Error("微信未返回可用二维码");
        const expires = Date.now() + 300000;
        this.view = {
          ...this.view,
          state: "waiting_scan",
          qrContent: qr.qrcode_img_content,
          qrExpiresAt: new Date(expires).toISOString(),
        };
        this.worker = this.waitLogin(
          qr.qrcode,
          expires,
          controller,
          proposed,
        ).catch(() => {
          if (!controller.signal.aborted)
            this.view = {
              ...this.view,
              state: "error",
              qrContent: undefined,
              error: "微信登录失败，请刷新二维码重试。",
            };
        });
        return this.status();
      } catch {
        this.view = {
          ...this.view,
          state: "error",
          error: "无法获取微信二维码，请检查网络后重试。",
        };
        throw Error(this.view.error);
      }
    });
  }
  verify(code: string) {
    if (this.view.state !== "need_code" || !/^\d{4,8}$/.test(code))
      throw Error("请填写手机显示的 4 至 8 位验证码");
    this.code = code;
    return this.status();
  }
  private async waitLogin(
    qr: string,
    expires: number,
    controller: AbortController,
    cfg: Config,
  ) {
    let base = wechatBase();
    while (!controller.signal.aborted && Date.now() < expires) {
      const code = this.code;
      this.code = undefined;
      const data = await this.client.qrStatus(
        qr,
        base,
        controller.signal,
        code,
      );
      if (controller.signal.aborted) return;
      if (data.status === "confirmed") {
        if (
          ![data.bot_token, data.ilink_bot_id, data.ilink_user_id].every(
            (v) => typeof v === "string" && v.length > 0 && v.length < 16384,
          )
        )
          throw Error("微信登录结果不完整");
        const login: WeChatLogin = {
          binding: cfg.binding,
          token: data.bot_token,
          baseUrl: wechatBase(data.baseurl || base),
          botId: data.ilink_bot_id,
          ownerId: data.ilink_user_id,
        };
        await this.vault.set(login);
        this.contexts.clear();
        this.login = login;
        this.runtime.store.transaction(() => {
          this.runtime.store.put("settings", "wechat", {
            ...cfg,
            enabled: !controller.signal.aborted,
            paired: true,
          });
          this.baseline(true, true);
        });
        this.view = {
          state: "connecting",
          cwd: cfg.cwd,
          notifications: cfg.notifications,
          ownerHint: login.ownerId.slice(0, 3) + "…" + login.ownerId.slice(-3),
          uncertainDeliveries: 0,
        };
        if (!controller.signal.aborted) await this.poll(controller);
        return;
      }
      if (data.status === "expired" || data.status === "verify_code_blocked") {
        this.view = {
          ...this.view,
          state: "expired",
          qrContent: undefined,
          error: "二维码已过期或验证被锁定，请重新扫码。",
        };
        return;
      }
      if (data.status === "scaned_but_redirect") {
        if (typeof data.redirect_host !== "string")
          throw Error("微信返回的跳转地址不完整");
        base = wechatBase(
          data.redirect_host.startsWith("https://")
            ? data.redirect_host
            : "https://" + data.redirect_host,
        );
      } else if (data.status === "need_verifycode")
        this.view.state = "need_code";
      else if (data.status === "scaned") this.view.state = "scanned";
      else if (data.status === "binded_redirect") {
        this.view = {
          ...this.view,
          state: "error",
          qrContent: undefined,
          error: "该机器人已绑定，请在微信解除旧绑定后重新连接。",
        };
        return;
      }
      await pause(1000, controller.signal);
    }
    if (!controller.signal.aborted)
      this.view = {
        ...this.view,
        state: "expired",
        qrContent: undefined,
        error: "二维码已过期，请重新获取。",
      };
  }
  async testMessage() {
    return this.mutate(async () => {
      const cfg = this.config();
      if (!cfg?.paired || cfg.expired) throw Error("请先扫码连接微信");
      if (!cfg.enabled) throw Error("请先恢复微信连接，再测试回传消息");
      if (!this.login || this.view.state !== "connected")
        throw Error("正在等待微信连接，请连接成功后再测试");
      if (!this.login.contextToken)
        throw Error("请先在微信发送 /帮助，再测试回传消息");
      const event = "test:" + randomUUID();
      const id = this.deliveryId(event);
      this.queue(
        "ACD 测试消息：微信回传链路已提交。请确认手机实际收到。",
        event,
      );
      await this.flush();
      const delivery = this.runtime.store.get<Delivery>("wechat-outbox", id);
      if (delivery?.state !== "submitted")
        throw Error("测试消息提交结果待核对，请检查手机；未自动重发。");
      if (!delivery.receipt?.hasServerMessageId)
        throw Error("微信已接受测试请求，但未返回消息编号，手机送达待核对。");
      return this.status();
    });
  }
  async resume() {
    return this.mutate(async () => {
      await this.cancel();
      const cfg = this.config();
      if (!cfg?.paired || cfg.expired) throw Error("请先扫码连接微信");
      const login = await this.vault.get();
      if (
        !login?.token ||
        !login.ownerId ||
        !login.botId ||
        (login.binding !== undefined && login.binding !== cfg.binding)
      )
        throw Error("微信登录凭证不可用，请重新扫码");
      wechatBase(login.baseUrl);
      this.login = login;
      this.runtime.store.put("settings", "wechat", { ...cfg, enabled: true });
      this.view = {
        ...this.view,
        state: "connecting",
        error: undefined,
        qrContent: undefined,
        ownerHint: login.ownerId.slice(0, 3) + "…" + login.ownerId.slice(-3),
      };
      const controller = new AbortController();
      this.control = controller;
      this.worker = this.poll(controller);
      this.observe(this.runtime.snapshot());
      return this.status();
    });
  }
  async setPaused() {
    return this.mutate(async () => {
      await this.cancel();
      const cfg = this.config();
      if (cfg)
        this.runtime.store.put("settings", "wechat", {
          ...cfg,
          enabled: false,
        });
      this.view = {
        ...this.view,
        state: cfg?.expired
          ? "expired"
          : cfg?.paired
            ? "paused"
            : "disconnected",
        qrContent: undefined,
        error: undefined,
      };
      return this.status();
    });
  }
  async disconnect() {
    return this.mutate(async () => {
      await this.cancel();
      const cfg = this.config();
      if (cfg)
        this.runtime.store.put("settings", "wechat", {
          ...cfg,
          enabled: false,
          binding: randomUUID(),
          paired: false,
        });
      this.contexts.clear();
      await this.vault.clear();
      this.login = undefined;
      this.view = {
        state: "disconnected",
        cwd: cfg?.cwd || "",
        notifications: cfg?.notifications ?? true,
        completionReports: cfg?.completionReports ?? false,
        uncertainDeliveries: 0,
      };
      return this.status();
    });
  }
  private baseline(desktop: boolean, reports: boolean) {
    if (!desktop && !reports) return;
    const snapshot = this.runtime.snapshot();
    for (const m of snapshot.messages) {
      if (desktop)
        this.runtime.store.put(
          "wechat-observed",
          this.deliveryId("message:" + m.id),
          { seen: true },
        );
    }
    if (reports)
      this.runtime.store.put("wechat-report-cursors", this.config()!.binding, {
        count: this.runtime.store.readyReportCount,
      });
    if (!desktop) return;
    for (const q of snapshot.questions.filter((q) => !q.taskId && !q.resolved))
      this.runtime.store.put(
        "wechat-observed",
        this.deliveryId("question:" + q.id),
        { seen: true },
      );
    for (const task of snapshot.tasks) {
      this.runtime.store.put("wechat-observed", this.deliveryId(task.id), {
        key: this.fingerprint(task),
      });
    }
  }
  private fingerprint(t: Task) {
    return (
      t.status +
      ":" +
      t.revision +
      ":" +
      this.runtime
        .snapshot()
        .questions.filter((q) => q.taskId === t.id && !q.resolved)
        .map((q) => q.id)
        .sort()
        .join(",")
    );
  }
  private messageOrigins(binding: string) {
    const requests = new Set(
      this.runtime.store
        .list<{ id: string; messageId?: string }>("wechat-inbox")
        .filter((item) => item.id.startsWith(binding + ":") && item.messageId)
        .map((item) => item.messageId!),
    );
    return (id?: string): string | undefined => {
      const visited = new Set<string>();
      while (id && !visited.has(id)) {
        if (requests.has(id)) return id;
        visited.add(id);
        id = this.runtime.store.getMessage(id)?.replyTo;
      }
    };
  }
  private observe(snapshot: Snapshot) {
    const cfg = this.config();
    if (this.closed || !cfg?.paired) return;
    const originOf = this.messageOrigins(cfg.binding);
    for (const task of snapshot.tasks) {
      const origin = originOf(task.sourceMessageId);
      if (!cfg.notifications && !origin) continue;
      if (!origin && (task.status === "review" || task.status === "completed"))
        continue;
      const id = this.deliveryId(task.id),
        key = this.fingerprint(task),
        previous = this.runtime.store.get<{ key: string }>(
          "wechat-observed",
          id,
        );
      if (previous?.key === key) continue;
      if (
        [
          "waiting_input",
          "review",
          "completed",
          "failed",
          "unknown",
          "blocked",
          "cancelled",
        ].includes(task.status)
      )
        this.queue(
          `任务 ${task.id}\n${task.title} · ${labels[task.status]}\n${task.progress}${task.status === "review" && task.result ? "\n结果摘要：" + task.result.slice(0, 1000) : ""}` +
            this.questions(task.id),
          "task:" + task.id + ":" + key,
          origin ? "direct" : "desktop",
          origin,
        );
      this.runtime.store.put("wechat-observed", id, { key });
    }
    for (const q of snapshot.questions) {
      const event = "question:" + q.id;
      const origin = originOf(q.sourceMessageId);
      if (
        q.resolved ||
        q.taskId ||
        (!cfg.notifications && !origin) ||
        this.runtime.store.get("wechat-observed", this.deliveryId(event))
      )
        continue;
      this.queue(
        `需要补充信息\n${q.text}\n/回答 ${q.id} 你的说明`,
        event,
        origin ? "direct" : "desktop",
        origin,
      );
    }
    if (cfg.completionReports) this.observeReports(cfg);
    for (const m of snapshot.messages.filter(
      (m) =>
        m.role !== "user" &&
        !m.completion &&
        m.text &&
        !snapshot.questions.some((q) => q.text === m.text),
    )) {
      const key = this.deliveryId("message:" + m.id);
      if (this.runtime.store.get("wechat-observed", key)) continue;
      const origin = originOf(m.replyTo);
      if (!origin && (m.taskIds.length || !cfg.notifications)) continue;
      this.queue(
        "ACD：" + m.text,
        "message:" + m.id,
        origin ? "direct" : "desktop",
        origin,
      );
      this.runtime.store.put("wechat-observed", key, { seen: true });
    }
    void this.flush();
  }
  private observeReports(cfg: Config) {
    const store = this.runtime.store;
    const cursor = store.get<{ count: number }>(
      "wechat-report-cursors",
      cfg.binding,
    );
    const count = store.readyReportCount;
    if (cursor?.count === count) return;
    // A legacy binding has no proof of when its opt-in began. Its existing
    // outbox survives, but never manufacture deliveries from old history.
    const reports = cursor ? store.readyReportsAfter(cursor.count) : [];
    store.transaction(() => {
      for (const m of reports) {
        const event = "completion:" + m.completion!.id;
        const key = this.deliveryId(event);
        if (store.get("wechat-observed", key)) continue;
        this.queue(m.text, event, "report", undefined, m.id);
        store.put("wechat-observed", key, { seen: true });
      }
      store.put("wechat-report-cursors", cfg.binding, { count });
    });
  }
  private questions(taskId?: string) {
    return this.runtime
      .snapshot()
      .questions.filter((q) => !q.resolved && (!taskId || q.taskId === taskId))
      .map(
        (q) =>
          `\n问题 ${q.id}：${q.text}\n回答：/回答 ${q.id} ${q.choices.length ? q.choices.map((choice) => (q.choiceLabels?.[choice] ? `${choice}（${q.choiceLabels[choice]}）` : choice)).join(" | ") : "你的说明"}`,
      )
      .join("\n");
  }
  private allowed(d: Delivery, cfg: Config) {
    const scope = d.scope ?? this.legacyScope(d, cfg.binding);
    if (scope === "report") return Boolean(cfg.completionReports);
    return scope === "direct" || cfg.notifications;
  }
  private legacyScope(d: Delivery, binding: string): DeliveryScope {
    const [kind, id] = d.id.slice(binding.length + 1).split(":");
    if (kind === "completion") return "report";
    if (kind === "test" || kind === "reply") return "direct";
    let source: string | undefined;
    if (kind === "message") source = this.runtime.store.getMessage(id)?.replyTo;
    if (kind === "task")
      source = this.runtime
        .snapshot()
        .tasks.find((t) => t.id === id)?.sourceMessageId;
    if (kind === "question")
      source = this.runtime
        .snapshot()
        .questions.find((q) => q.id === id)?.sourceMessageId;
    return source && this.messageOrigins(binding)(source)
      ? "direct"
      : "desktop";
  }
  private queue(
    text: string,
    eventId: string,
    scope: DeliveryScope = "direct",
    origin?: string,
    reportMessageId?: string,
  ) {
    const cfg = this.config()!;
    const id = this.deliveryId(eventId);
    if (this.runtime.store.get("wechat-outbox", id)) return;
    this.runtime.store.put("wechat-outbox", id, {
      id,
      binding: cfg.binding,
      scope,
      reportMessageId,
      origin,
      text:
        Array.from(text).length > 1900
          ? Array.from(text).slice(0, 1800).join("") +
            "\n…内容较长，请在桌面查看完整记录。"
          : text,
      state: "pending",
      createdAt: new Date().toISOString(),
    } satisfies Delivery);
  }
  private flush(): Promise<void> {
    this.flushRequested = true;
    if (!this.sending) {
      this.sending = Promise.resolve().then(async () => {
        try {
          while (this.flushRequested) {
            this.flushRequested = false;
            await this.sendPending();
          }
        } finally {
          this.sending = undefined;
        }
      });
    }
    return this.sending;
  }
  private async sendPending() {
    const controller = this.control,
      login = this.login,
      cfg = this.config();
    if (
      !controller ||
      controller.signal.aborted ||
      !login?.contextToken ||
      !cfg?.enabled ||
      this.view.state !== "connected"
    )
      return;
    for (const d of this.runtime.store
      .list<Delivery>("wechat-outbox")
      .filter((d) => d.binding === cfg.binding && d.state === "pending")) {
      const current = this.config();
      if (
        controller.signal.aborted ||
        this.view.state !== "connected" ||
        !current?.enabled ||
        current.binding !== cfg.binding
      )
        return;
      if (
        this.runtime.store.get<Delivery>("wechat-outbox", d.id)?.state !==
        "pending"
      )
        continue;
      const reportPrefix = cfg.binding + ":completion:";
      const report = d.id.startsWith(reportPrefix)
        ? this.runtime.store.get<{ native?: { id: string } }>(
            "completion-jobs",
            d.id.slice(reportPrefix.length),
          )
        : undefined;
      if (
        !this.allowed(d, current) ||
        (d.reportMessageId &&
          !this.runtime.store.getReadyReport(d.reportMessageId)) ||
        (report?.native &&
          this.runtime.store.get<{ ignored?: boolean }>(
            "native-executions",
            report.native.id,
          )?.ignored)
      ) {
        this.runtime.store.put("wechat-outbox", d.id, {
          ...d,
          state: "suppressed",
        });
        continue;
      }
      this.runtime.store.put("wechat-outbox", d.id, {
        ...d,
        state: "sending",
      });
      try {
        const login = this.login!;
        const contextToken =
          (d.origin && this.contexts.get(d.origin)) || login.contextToken;
        const receipt = await this.client.send(
          { ...login, contextToken },
          hash(d.id),
          d.text,
          controller.signal,
        );
        const submittedAt = new Date().toISOString();
        this.runtime.store.put("wechat-outbox", d.id, {
          ...d,
          submittedAt,
          state: "submitted",
          receipt,
        });
        this.view.lastSubmittedAt = submittedAt;
      } catch (error) {
        this.runtime.store.put("wechat-outbox", d.id, {
          ...d,
          state: "unknown",
        });
        if (error instanceof WeChatApiError && error.expired) {
          this.expire(controller);
          return;
        }
        this.view.error =
          "部分反馈未能确认是否提交，请在微信发送 /状态 核对；没有自动重发。";
      }
    }
  }
  private expire(controller: AbortController) {
    const cfg = this.config();
    if (cfg)
      this.runtime.store.put("settings", "wechat", {
        ...cfg,
        expired: true,
        enabled: false,
      });
    this.view.state = "expired";
    this.view.error = "微信会话已失效，请重新扫码连接。";
    controller.abort();
  }
  private async poll(controller: AbortController) {
    try {
      await this.client.lifecycle(this.login!, "start", controller.signal);
      this.view.lifecycle = "registered";
    } catch {
      if (controller.signal.aborted) return;
      this.view.lifecycle = "unconfirmed";
    }
    let failures = 0;
    while (!controller.signal.aborted) {
      try {
        const cfg = this.config()!;
        const cursor =
          this.runtime.store.get<{ value: string }>(
            "wechat-cursor",
            cfg.binding,
          )?.value || "";
        const data = await this.client.updates(
          this.login!,
          cursor,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const messages = data.msgs ?? [];
        if (!Array.isArray(messages)) throw Error("微信消息列表格式无效");
        if (messages.length > 100) {
          this.runtime.store.put("settings", "wechat", {
            ...this.config()!,
            enabled: false,
          });
          this.view.state = "error";
          this.view.error =
            "单批微信消息超过 100 条，已暂停接入，本批未执行。请在桌面核对后重新连接。";
          return;
        }
        this.view.state = "connected";
        this.view.lastPollAt = new Date().toISOString();
        this.view.receivedMessages =
          (this.view.receivedMessages || 0) + messages.length;
        if (!this.status().uncertainDeliveries) this.view.error = undefined;
        failures = 0;
        for (const msg of messages) {
          if (controller.signal.aborted) return;
          await this.inbound(msg);
        }
        if (
          typeof data.get_updates_buf === "string" &&
          data.get_updates_buf.length > 0 &&
          data.get_updates_buf.length < 65536
        )
          this.runtime.store.put("wechat-cursor", cfg.binding, {
            value: data.get_updates_buf,
          });
        await this.flush();
        await pause(200, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof WeChatApiError && error.expired) {
          this.expire(controller);
          return;
        }
        this.view.state = "connecting";
        this.view.error =
          "微信连接中断，正在重连；已接收的任务继续在本机执行。";
        await pause(
          Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)),
          controller.signal,
        );
      }
    }
  }
  private async inbound(msg: Incoming) {
    const login = this.login!,
      cfg = this.config()!;
    const ignored = (reason: string) => {
      this.view.ignoredMessages = (this.view.ignoredMessages || 0) + 1;
      this.view.lastIgnoredReason = reason;
    };
    if (!msg || msg.message_type !== 1 || msg.message_state === 1) {
      ignored("不是已完成的用户消息");
      return;
    }
    if (msg.group_id) {
      ignored("当前仅支持绑定者私聊");
      return;
    }
    if (msg.from_user_id !== login.ownerId) {
      ignored("消息发送者与扫码绑定者不一致");
      return;
    }
    if (msg.to_user_id && msg.to_user_id !== login.botId) {
      ignored("消息接收者与当前绑定不一致");
      return;
    }
    const remoteId = [msg.message_id, msg.client_id, msg.seq].find((value) =>
      typeof value === "number"
        ? Number.isSafeInteger(value) && value > 0
        : typeof value === "string" &&
          value.trim().length > 0 &&
          value.length <= 256,
    );
    if (remoteId === undefined) {
      ignored("消息没有可用编号");
      return;
    }
    const id = this.deliveryId("in:" + hash(String(remoteId)));
    if (this.runtime.store.get("wechat-inbox", id)) return;
    if (
      typeof msg.context_token === "string" &&
      msg.context_token &&
      msg.context_token.length < 16384 &&
      msg.context_token !== login.contextToken
    ) {
      const next = { ...login, contextToken: msg.context_token };
      await this.vault.set(next);
      this.login = next;
    }
    let origin = id;
    this.runtime.store.put("wechat-inbox", id, { id, state: "processing" });
    this.view.lastReceivedAt = new Date().toISOString();
    this.runtime.store.put("wechat-last-inbound", cfg.binding, {
      at: this.view.lastReceivedAt,
    });
    const text = Array.isArray(msg.item_list)
      ? msg.item_list
          .slice(0, 20)
          .filter(
            (item) =>
              item?.type === 1 && typeof item.text_item?.text === "string",
          )
          .map((item) => item.text_item!.text)
          .join("\n")
          .trim()
      : "";
    let response: string;
    let reportMessageId: string | undefined;
    try {
      if (!text) response = "目前只支持文字指令。发送 /帮助 查看用法。";
      else if (text.length > 20000) response = "消息过长，请拆成几条文字消息。";
      else if (text === "/帮助")
        response =
          "直接发文字交代任务，或补充已有要求。\n/状态 查看任务和待处理问题\n/报告 查看最近完成报告与建议\n/停止 <完整任务编号>\n/完成 <完整任务编号>\n/回答 <完整问题编号> <选项或说明>\n新任务只使用本机设置的微信工作目录。";
      else if (text === "/状态" || text === "/任务") response = this.summary();
      else if (text === "/报告") {
        const report = this.runtime.store.latestReadyReport();
        reportMessageId = report?.id;
        response =
          report?.text || "暂时没有完成报告，发送 /状态 查看执行进展。";
      } else if (text.startsWith("/停止 ")) {
        await this.runtime.stop(text.slice(4).trim());
        response = "停止请求已处理。\n" + this.summary();
      } else if (text.startsWith("/完成 ")) {
        this.runtime.accept(text.slice(4).trim());
        response = "已确认交付完成。";
      } else if (text.startsWith("/回答 ")) {
        const match = text.match(/^\/回答\s+(\S+)\s+([\s\S]+)$/);
        if (!match) throw Error("格式：/回答 <问题编号> <选项或说明>");
        await this.runtime.answer(match[1], match[2].trim());
        response = "回答已提交。";
      } else if (text.startsWith("/"))
        response = "未识别这个指令，请发送 /帮助 查看用法。";
      else {
        const uuid = hash(id).slice(0, 32).split("");
        uuid[12] = "4";
        uuid[16] = "8";
        const h = uuid.join("");
        const receiptId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
        this.runtime.store.put("wechat-inbox", id, {
          id,
          state: "processing",
          messageId: receiptId,
        });
        origin = receiptId;
        this.rememberContext(origin);
        this.runtime.receive(text, cfg.cwd, undefined, receiptId);
        response = "收到，我来处理。";
      }
    } catch {
      response =
        "这次操作未能确认完成，请发送 /状态 核对，或在桌面总控查看原因。不要重复授权不确定的操作。";
    }
    this.rememberContext(origin);
    this.queue(
      response,
      "reply:" + String(remoteId),
      "direct",
      origin,
      reportMessageId,
    );
    this.runtime.store.put("wechat-inbox", id, {
      ...this.runtime.store.get<{
        id: string;
        state: string;
        messageId?: string;
      }>("wechat-inbox", id),
      id,
      state: "handled",
    });
  }
  private rememberContext(origin: string) {
    const context = this.login?.contextToken;
    if (!context) return;
    this.contexts.set(origin, context);
    if (this.contexts.size > 256)
      this.contexts.delete(this.contexts.keys().next().value!);
  }
  private summary() {
    const s = this.runtime.snapshot();
    const uncertain = this.status().uncertainOperations;
    return (
      (uncertain
        ? `有 ${uncertain} 条此前操作的结果待核对，没有自动重放。请在桌面检查任务。\n\n`
        : "") +
      this.questions() +
      "\n" +
      (s.tasks.length
        ? s.tasks
            .slice(-10)
            .map(
              (t) => `${t.id}\n${t.title} · ${labels[t.status]}\n${t.progress}`,
            )
            .join("\n\n")
        : "暂无任务。")
    );
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.off();
    await this.cancel();
  }
}
