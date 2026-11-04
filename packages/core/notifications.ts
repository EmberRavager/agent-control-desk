import { translate } from "../i18n/index.cjs";
import { createHash } from "node:crypto";
import type { Snapshot } from "../contracts/index.js";
import type {
  Notice,
  NoticeFeed,
  NoticePreferences,
} from "../contracts/notifications.js";
import type { Store } from "./store.js";
export const noticeDefaults: NoticePreferences = {
  desktop: true,
  sound: true,
  details: false,
  background: true,
  attention: true,
  result: true,
  error: true,
};
const idFor = (key: string) => createHash("sha256").update(key).digest("hex");
export function noticePreferences(store: Store): NoticePreferences {
  return {
    ...noticeDefaults,
    ...store.get<NoticePreferences>("settings", "notifications"),
  };
}
export function projectNotices(store: Store, snapshot: Snapshot) {
  const tr = (source: string) =>
    translate(snapshot.preferences?.locale, source);
  const add = (
    key: string,
    data: Omit<Notice, "id" | "sequence" | "createdAt" | "desktop" | "active">,
  ) => {
    const id = idFor(key);
    const previous = store.get<Notice>("notifications", id);
    if (previous) {
      if (
        key.startsWith("completion:") &&
        (previous.body !== data.body || previous.title !== data.title)
      )
        store.put("notifications", id, {
          ...previous,
          body: data.body,
          title: data.title,
        });
      return;
    }
    const sequence =
      (store.get<{ value: number }>("settings", "notification-sequence")
        ?.value || 0) + 1;
    store.put("settings", "notification-sequence", { value: sequence });
    store.put("notifications", id, {
      sequence,
      ...data,
      id,
      createdAt: new Date().toISOString(),
      desktop: "pending",
    } as Notice);
  };
  for (const q of snapshot.questions.filter((q) => !q.resolved)) {
    const task = q.taskId
      ? snapshot.tasks.find((t) => t.id === q.taskId)
      : undefined;
    if (
      q.taskId &&
      (!task || (q.revision !== undefined && q.revision !== task.revision))
    )
      continue;
    add("question:" + q.id, {
      kind: "attention",
      title: q.kind === "approval" ? tr("需要确认操作") : tr("需要补充信息"),
      body: q.text.slice(0, 1800),
      questionId: q.id,
      ...(task ? { taskId: task.id, revision: task.revision } : {}),
    });
  }
  for (const task of snapshot.tasks) {
    const kind =
      task.status === "review"
        ? "attention"
        : ["failed", "blocked", "unknown"].includes(task.status)
          ? "error"
          : task.status === "waiting_input"
            ? "attention"
            : null;
    if (!kind) continue;
    if (
      task.status === "review" &&
      store.get(
        "completion-jobs",
        idFor(`task:${task.id}:${task.revision}:${task.turnId || ""}`),
      )
    )
      continue;
    if (
      task.status === "waiting_input" &&
      snapshot.questions.some(
        (q) =>
          q.taskId === task.id &&
          !q.resolved &&
          (q.revision === undefined || q.revision === task.revision),
      )
    )
      continue;
    const title =
      task.status === "review"
        ? tr("任务等待人工检查")
        : task.status === "unknown"
          ? tr("执行状态需要核对")
          : task.status === "blocked"
            ? tr("任务已阻塞")
            : task.status === "failed"
              ? tr("任务执行失败")
              : tr("任务需要你处理");
    add(`task:${task.id}:${task.revision}:${task.status}`, {
      kind,
      title,
      body: (task.title + "\n" + task.progress).slice(0, 1800),
      taskId: task.id,
      revision: task.revision,
      taskStatus: task.status,
    });
  }
  store.projectChangedReports((message) =>
    add("completion:" + message.completion!.id, {
      kind: "result",
      title: message.completion!.assessed
        ? tr("任务完成报告")
        : tr("本轮执行结果"),
      body: message.text.slice(0, 1800),
      messageId: message.id,
    }),
  );
  for (const message of snapshot.messages.filter((m) => m.attention))
    add("message:" + message.id, {
      kind: "error",
      title: tr("总控需要处理"),
      body: message.text.slice(0, 1800),
      messageId: message.id,
    });
}
function active(notice: Notice, snapshot: Snapshot) {
  if (notice.questionId) {
    const q = snapshot.questions.find((q) => q.id === notice.questionId);
    return Boolean(
      q &&
      !q.resolved &&
      (!q.taskId ||
        snapshot.tasks.some(
          (t) =>
            t.id === q.taskId &&
            (q.revision === undefined || t.revision === q.revision),
        )),
    );
  }
  if (notice.taskId)
    return snapshot.tasks.some(
      (t) =>
        t.id === notice.taskId &&
        t.revision === notice.revision &&
        t.status === notice.taskStatus,
    );
  return true;
}
function hiddenReport(store: Store, notice: Notice) {
  return Boolean(
    notice.messageId &&
    store.getMessage(notice.messageId)?.completion &&
    !store.getReadyReport(notice.messageId),
  );
}
export function noticeReport(store: Store, id: string) {
  const notice = store.get<Notice>("notifications", id);
  if (notice?.kind !== "result" || !notice.messageId) return;
  const message = store.getReadyReport(notice.messageId);
  if (message?.completion)
    return {
      ...message.completion,
      summary: message.completion.summary || message.text,
    };
}
function supersededReport(store: Store, notice: Notice) {
  const message = notice.messageId
    ? store.getMessage(notice.messageId)
    : undefined;
  const nativeId = message?.completion?.nativeId;
  return Boolean(
    nativeId && store.latestNativeReportId(nativeId) !== message!.id,
  );
}
function sorted(store: Store) {
  return store
    .list<Notice>("notifications")
    .sort(
      (a, b) =>
        (b.sequence || 0) - (a.sequence || 0) ||
        b.createdAt.localeCompare(a.createdAt) ||
        b.id.localeCompare(a.id),
    );
}
export function noticeFeed(
  store: Store,
  snapshot: Snapshot,
  before?: string,
  limit = 50,
): NoticeFeed {
  const all = sorted(store)
      .filter((notice) => !hiddenReport(store, notice))
      .map((notice) => {
        const superseded = supersededReport(store, notice);
        return {
          ...notice,
          active: !superseded && active(notice, snapshot),
          ...(superseded ? { superseded: true } : {}),
        };
      }),
    index = before ? all.findIndex((n) => n.id === before) + 1 : 0;
  if (before && index === 0) throw Error("消息位置已失效，请刷新消息中心");
  return {
    items: all.slice(index, index + limit),
    unread: all.filter((n) => !n.readAt && !n.superseded).length,
    hasMore: all.length > index + limit,
    preferences: noticePreferences(store),
  };
}
export function readNotices(
  store: Store,
  input: { ids?: string[]; throughId?: string },
) {
  let ids = input.ids || [];
  if (input.throughId) {
    const all = sorted(store),
      index = all.findIndex((n) => n.id === input.throughId);
    if (index < 0) throw Error("消息位置已失效，请刷新后重试");
    ids = all.slice(index).map((n) => n.id);
  }
  const now = new Date().toISOString();
  for (const id of ids) {
    const n = store.get<Notice>("notifications", id);
    if (n && !n.readAt) store.put("notifications", id, { ...n, readAt: now });
  }
}
export function claimNotices(store: Store, snapshot: Snapshot, ids: string[]) {
  const preferences = noticePreferences(store),
    claimed: Notice[] = [];
  for (const id of ids) {
    const n = store.get<Notice>("notifications", id);
    if (!n || n.desktop !== "pending") continue;
    const eligible =
      !n.readAt &&
      !hiddenReport(store, n) &&
      !supersededReport(store, n) &&
      active(n, snapshot) &&
      preferences.desktop &&
      preferences[n.kind];
    const next = {
      ...n,
      desktop: eligible ? ("claimed" as const) : ("suppressed" as const),
    };
    store.put("notifications", id, next);
    if (eligible) claimed.push({ ...next, active: true });
  }
  return claimed;
}
export function settleNotices(
  store: Store,
  ids: string[],
  outcome: "submitted" | "failed" | "suppressed" | "unverified",
) {
  for (const id of ids) {
    const n = store.get<Notice>("notifications", id);
    if (n?.desktop === "claimed")
      store.put("notifications", id, { ...n, desktop: outcome });
  }
}
