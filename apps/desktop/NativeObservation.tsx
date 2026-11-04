import { useI18n } from "./i18n.js";
import React, { useEffect, useRef, useState } from "react";
import CompletionReport from "./CompletionReport.js";
import type {
  AgentObservation,
  NativeSession,
  NativeInsight,
  CompletionReport as Report,
} from "../../packages/contracts/index.js";
import {
  loadNativeInsight,
  nativeInsightFresh,
  nativeInsightInterval,
  type NativeInsightCache,
} from "./native-insight-cache.js";
function readableText(text?: string): string {
  return text && /[\p{L}\p{N}]/u.test(text) ? text.trim() : "";
}
export const nativeLabels: Record<NativeSession["status"], string> = {
  running: "正在执行",
  waiting_input: "等待处理",
  idle: "当前空闲",
  failed: "发生错误",
  unknown: "状态未知",
};
export default function NativeObservation({
  agentName,
  observation,
  sessionId,
  modelKey,
  cache,
  completion,
  retryCompletion,
  refresh,
  analyze,
  onSelect,
  onBack,
}: {
  agentName: string;
  observation?: AgentObservation;
  sessionId?: string;
  modelKey: string;
  cache: NativeInsightCache;
  completion?: Report;
  retryCompletion?: () => Promise<void>;
  refresh: () => Promise<void>;
  analyze: (id: string, force: boolean) => Promise<NativeInsight>;
  onSelect: (id: string) => void;
  onBack: () => void;
}) {
  const { t, locale, dateLocale } = useI18n();
  const session = observation?.sessions.find((item) => item.id === sessionId);
  const cacheKey = JSON.stringify([
    locale,
    session?.id,
    session?.turnId,
    session?.status,
    modelKey,
  ]);
  const [result, setResult] = useState(() => ({
    key: cacheKey,
    value: cache.get(cacheKey)?.value || null,
  }));
  const insight =
    result.key === cacheKey ? result.value : cache.get(cacheKey)?.value || null;
  const [analyzing, setAnalyzing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0),
    working = useRef(false),
    api = useRef(analyze);
  api.current = analyze;
  async function load(force = false) {
    if (!session || working.current) return;
    const cached = cache.get(cacheKey);
    if (!force && !cached?.pending && nativeInsightFresh(cached)) {
      setResult({ key: cacheKey, value: cached!.value! });
      return;
    }
    if (
      !force &&
      cached?.error &&
      Date.now() - cached.attemptedAt < nativeInsightInterval
    ) {
      setError(cached.error);
      return;
    }
    const version = generation.current;
    working.current = true;
    setAnalyzing(true);
    setError("");
    try {
      const value = await loadNativeInsight(
        cache,
        cacheKey,
        () => api.current(session.id, force),
        force,
        locale,
      );
      if (version === generation.current) setResult({ key: cacheKey, value });
    } catch (failure) {
      if (version === generation.current)
        setError(
          failure instanceof Error
            ? failure.message
            : t("暂时无法分析当前任务"),
        );
    } finally {
      if (version === generation.current) {
        working.current = false;
        setAnalyzing(false);
      }
    }
  }
  useEffect(() => {
    generation.current++;
    working.current = false;
    const cached = cache.get(cacheKey);
    setResult({ key: cacheKey, value: cached?.value || null });
    setError(cached?.error || "");
    setAnalyzing(false);
    if (!session || (session.status === "idle" && completion)) return;
    void load();
    const timer = setInterval(() => {
      if (session.status === "running") void load();
    }, 5000);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [cacheKey]);
  async function reload() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("暂时无法同步"));
    } finally {
      setBusy(false);
    }
  }
  const goal = readableText(insight?.goal);
  const currentStep = readableText(insight?.currentStep);
  const blocker = readableText(insight?.blocker);
  const nextStep = readableText(insight?.nextStep);
  const title =
    session?.taskTitle ||
    completion?.title ||
    insight?.title ||
    t("正在识别任务…");
  const currentLabel = session
    ? {
        running: t("正在处理"),
        waiting_input: t("等待你处理"),
        idle: t("最近进展"),
        failed: t("执行异常"),
        unknown: t("最近记录 · 状态待确认"),
      }[session.status]
    : t("当前进展");
  return (
    <section className="native-workspace" aria-label={t("原生会话详情")}>
      <header className="topbar">
        <h1>{agentName}</h1>
        <button className="button ghost" onClick={onBack}>
          {t("返回总控")}
        </button>
      </header>
      <div className="native-workspace-scroll">
        <div className="native-workspace-content">
          {session ? (
            <>
              <div className="native-insight-hero">
                <div className="native-task-meta">
                  <span
                    className="native-task-status"
                    data-status={session.status}
                    title={t("状态更新于 {time}", {
                      time: new Date(session.observedAt).toLocaleTimeString(
                        dateLocale,
                      ),
                    })}
                  >
                    <i aria-hidden="true" />
                    {session.status === "idle" && completion
                      ? completion.assessed
                        ? t("AI 判定已交付")
                        : t("本轮已结束")
                      : t(nativeLabels[session.status])}
                  </span>
                </div>
                <h2>{title}</h2>
                {goal && (
                  <div className="native-task-goal">
                    <span>{t("目标")}</span>
                    <p>{goal}</p>
                  </div>
                )}
              </div>
              {session.status === "idle" && completion ? (
                <CompletionReport
                  report={completion}
                  showHeading={false}
                  onRetry={
                    retryCompletion ||
                    (async () => {
                      throw Error(t("请返回总控重新生成建议。"));
                    })
                  }
                />
              ) : (
                <div
                  className="native-activity"
                  data-status={session.status}
                  aria-busy={analyzing}
                >
                  <section className="native-current">
                    <span className="native-activity-node" aria-hidden="true" />
                    <div className="native-current-heading">
                      <h3>{currentLabel}</h3>
                      <button
                        className="button ghost native-analyze-button"
                        disabled={analyzing}
                        onClick={() => void load(true)}
                        aria-label={t("重新分析")}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5" />
                        </svg>
                        {analyzing ? t("更新中…") : t("重新分析")}
                      </button>
                    </div>
                    {insight ? (
                      <p className="native-current-step">
                        {currentStep || session.progress}
                      </p>
                    ) : (
                      <div className="native-insight-loading" role="status">
                        <p className="native-current-step">
                          {analyzing
                            ? t("正在整理当前进展…")
                            : t("暂未生成任务分析")}
                        </p>
                        <span>{session.progress}</span>
                      </div>
                    )}
                    {insight && (
                      <span className="native-analysis-time">
                        {t("分析更新于 {time}", {
                          time: new Date(
                            insight.generatedAt,
                          ).toLocaleTimeString(dateLocale),
                        })}
                        {analyzing ? t(" · 后台更新中") : ""}
                      </span>
                    )}
                    {session.status === "waiting_input" && (
                      <p className="native-action-hint">
                        {t("请在 {agent} 中处理授权或补充信息。", {
                          agent: agentName,
                        })}
                      </p>
                    )}
                    {blocker && (
                      <aside className="native-blocker">
                        <span aria-hidden="true">!</span>
                        <div>
                          <h4>{t("需要关注")}</h4>
                          <p>{blocker}</p>
                        </div>
                      </aside>
                    )}
                    {error && (
                      <div className="native-analysis-error" role="alert">
                        {insight && (
                          <strong>{t("分析更新失败，保留上次结果。")}</strong>
                        )}
                        <p>{error}</p>
                      </div>
                    )}
                  </section>
                  {nextStep && (
                    <section className="native-next">
                      <span
                        className="native-activity-node"
                        aria-hidden="true"
                      />
                      <h3>{t("下一步")}</h3>
                      <p>{nextStep}</p>
                    </section>
                  )}
                </div>
              )}
              {observation?.state === "unavailable" && (
                <p className="native-sync-note" role="status">
                  {observation.message}
                </p>
              )}
              <div className="native-details-group">
                <details className="native-runtime-details">
                  <summary>{t("详情与来源")}</summary>
                  {insight && (
                    <section className="native-analysis-details">
                      {!!insight.requirements?.length && (
                        <div className="native-request-source">
                          <h4>{t("用户要求")}</h4>
                          {insight.requirements.map((text, index) => (
                            <p key={index}>{text}</p>
                          ))}
                        </div>
                      )}
                      <p>{insight.summary}</p>
                      <span className="native-analysis-source">
                        {insight.model} ·{" "}
                        {insight.basis === "public-fragments"
                          ? t("基于当前公开执行片段")
                          : t("基于会话元数据")}
                      </span>
                    </section>
                  )}
                  <dl>
                    <dt>{t("会话")}</dt>
                    <dd>{session.title}</dd>
                    <dt>{t("工作目录")}</dt>
                    <dd>{session.cwd}</dd>
                    <dt>{t("会话编号")}</dt>
                    <dd>{session.sessionId}</dd>
                    <dt>{t("状态来源")}</dt>
                    <dd>
                      {observation?.source === "run-events"
                        ? t("本地执行事件与写入进程核验")
                        : t("原生控制接口")}
                    </dd>
                    {session.eventAt && (
                      <>
                        <dt>{t("执行事件")}</dt>
                        <dd>
                          {new Date(session.eventAt).toLocaleString(dateLocale)}
                        </dd>
                      </>
                    )}
                    <dt>{t("最近观测")}</dt>
                    <dd>
                      {new Date(session.observedAt).toLocaleString(dateLocale)}
                    </dd>
                  </dl>
                  <p className="native-readonly-note">
                    {t("仅查看状态与任务分析，运行与授权在 {agent} 中处理。", {
                      agent: agentName,
                    })}
                  </p>
                </details>
              </div>
            </>
          ) : (
            <>
              <div className="native-connection-heading">
                <div>
                  <h2>{t("本机运行会话")}</h2>
                  <p>{observation?.message || t("尚未取得原生状态")}</p>
                </div>
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => void reload()}
                >
                  {busy ? t("同步中…") : t("重新同步")}
                </button>
              </div>
              {(observation?.sessions || []).map((item) => (
                <button
                  className="native-session-row"
                  key={item.id}
                  onClick={() => onSelect(item.id)}
                >
                  <span>
                    <strong>{item.taskTitle || item.title}</strong>
                    <small>{item.cwd}</small>
                  </span>
                  <span className="pill">{t(nativeLabels[item.status])}</span>
                </button>
              ))}
              {!observation?.sessions.length && (
                <p className="field-help">
                  {t(
                    "当前没有可展示的运行会话。未同步时，无法据此判断其他原生任务是否在运行。",
                  )}
                </p>
              )}
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
