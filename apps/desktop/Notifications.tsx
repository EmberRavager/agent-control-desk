import { useI18n } from "./i18n.js";
import React, { useEffect, useState } from "react";
import type {
  Notice,
  NoticeFeed,
} from "../../packages/contracts/notifications.js";
interface Props {
  feed?: NoticeFeed;
  request: (method: string, path: string, body?: unknown) => Promise<unknown>;
  onOpen: (notice: Notice) => void;
  onBack: () => void;
  onMenu: () => void;
}
export default function Notifications({
  feed,
  request,
  onOpen,
  onBack,
  onMenu,
}: Props) {
  const { t, dateLocale } = useI18n();
  const [older, setOlder] = useState<Notice[]>([]),
    [more, setMore] = useState(feed?.hasMore ?? false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [filter, setFilter] = useState<"all" | "unread">("all");
  useEffect(() => {
    if (!older.length) setMore(feed?.hasMore ?? false);
  }, [feed?.hasMore, older.length]);
  const map = new Map(older.map((n) => [n.id, n]));
  for (const n of feed?.items || []) map.set(n.id, n);
  const items = [...map.values()].sort(
    (a, b) =>
      (b.sequence || 0) - (a.sequence || 0) ||
      b.createdAt.localeCompare(a.createdAt) ||
      b.id.localeCompare(a.id),
  );
  const visible =
    filter === "unread"
      ? items.filter((n) => !n.readAt && !n.superseded)
      : items;
  async function loadMore() {
    const last = items.at(-1);
    if (!last) return;
    setBusy(true);
    setError("");
    try {
      const next = (await request(
        "GET",
        "/api/notifications?before=" + last.id,
      )) as NoticeFeed;
      setOlder([...items, ...next.items]);
      setMore(next.hasMore);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("无法加载更早消息"));
    } finally {
      setBusy(false);
    }
  }
  async function readAll() {
    const head = feed?.items[0];
    if (!head) return;
    setBusy(true);
    setError("");
    try {
      await request("POST", "/api/notifications/read", { throughId: head.id });
      setOlder((records) =>
        records.map((n) => ({
          ...n,
          readAt: n.readAt || new Date().toISOString(),
        })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : t("未能标记已读"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header className="topbar">
        <div className="row">
          <button
            className="icon mobile-toggle"
            aria-label={t("打开任务侧栏")}
            onClick={onMenu}
          >
            ☰
          </button>
          <h1>{t("消息中心")}</h1>
          <span className="notice-unread-count">
            {t("{count} 条未读", { count: feed?.unread || 0 })}
          </span>
        </div>
        <button className="button ghost" onClick={onBack}>
          {t("返回总控")}
        </button>
      </header>
      <div className="notice-scroll">
        <div className="notice-page">
          <div className="notice-toolbar">
            <div role="group" aria-label={t("消息范围")}>
              {(["all", "unread"] as const).map((value) => (
                <button
                  className={filter === value ? "selected" : ""}
                  key={value}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {value === "all" ? t("全部") : t("未读")}
                </button>
              ))}
            </div>
            <button
              className="button ghost"
              disabled={busy || !feed?.unread}
              onClick={() => void readAll()}
            >
              {t("全部已读")}
            </button>
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {!feed ? (
            <p className="loading">
              {t("当前后台尚无消息中心，请处理任务后重启 ACD。")}
            </p>
          ) : !visible.length ? (
            <div className="notice-empty">
              <span aria-hidden="true">✓</span>
              <h2>
                {filter === "unread"
                  ? t("暂时没有未读消息")
                  : t("重要进展会出现在这里")}
              </h2>
              <p>{t("需要确认、执行结束或遇到问题时，会留下一条记录。")}</p>
            </div>
          ) : (
            <div className="notice-list">
              {visible.map((n) => (
                <button
                  className={"notice-row " + (n.readAt ? "read" : "unread")}
                  key={n.id}
                  onClick={() => {
                    setOlder((records) =>
                      records.map((item) =>
                        item.id === n.id
                          ? {
                              ...item,
                              readAt: item.readAt || new Date().toISOString(),
                            }
                          : item,
                      ),
                    );
                    onOpen(n);
                  }}
                >
                  <span
                    className={"notice-symbol " + n.kind}
                    aria-hidden="true"
                  >
                    {n.kind === "attention"
                      ? "?"
                      : n.kind === "result"
                        ? "✓"
                        : "!"}
                  </span>
                  <span className="notice-copy">
                    <strong>{n.title}</strong>
                    <span className="notice-body">{n.body}</span>
                    <span className="notice-meta">
                      {n.taskId && <code>{n.taskId.slice(0, 8)}</code>}
                      {n.superseded ? (
                        <span>{t("已有更新的报告")}</span>
                      ) : (
                        !n.active && <span>{t("已处理或已更新")}</span>
                      )}
                      {n.readAt && <span>{t("已读")}</span>}
                    </span>
                  </span>
                  <span className="notice-time">
                    <time dateTime={n.createdAt}>
                      {new Date(n.createdAt).toLocaleString(dateLocale, {
                        month: "numeric",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                    {!n.readAt && <i aria-label={t("未读")} />}
                  </span>
                </button>
              ))}
            </div>
          )}
          {more && (
            <div className="notice-more">
              <button
                className="button"
                disabled={busy}
                onClick={() => void loadMore()}
              >
                {busy ? t("正在加载…") : t("加载更早消息")}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
